/**
 * Commands that read and change the chat: sending messages as anyone, listing, hiding, deleting
 * and editing them, swipes, and the chat itself (SillyTavern `slash-commands.js`, `power-user.js`).
 */

import type { NewMessage } from '@bakatavern/api-client';
import {
  ArgType,
  Closure,
  extractMessageBias,
  isTrueBoolean,
  isFalseBoolean,
  RegexPlacement,
  removeMacros,
  resolveIndex,
  resolveVariable,
  stringToRange,
  type NamedArguments,
  type Stscript,
} from '@bakatavern/core';

import { macros } from '../../generation/pipeline.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import { copyText } from '../../util/clipboard.ts';
import { scriptDialogs } from '../dialogs.svelte.ts';
import { avatarKey, findCharacter, findPersona, thumbnailUrl } from '../lookup.ts';
import { addCommands } from '../runtime.svelte.ts';

const NARRATOR_NAME_KEY = 'narrator_name';
const NARRATOR_NAME_DEFAULT = 'System';
const COMMENT_NAME_DEFAULT = 'Note';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const atArg = {
  name: 'at',
  description: 'position to insert the message (index-based, a negative value counts from the end)',
  typeList: [ArgType.NUMBER],
};
const compactArg = {
  name: 'compact',
  description: 'use compact layout',
  typeList: [ArgType.BOOLEAN],
  defaultValue: 'false',
};
const returnArg = {
  name: 'return',
  description: 'The way how you want the return value to be provided',
  defaultValue: 'none',
};

/** What was sent, given back as `return=` asks (the text by default `none`). */
function returned(st: Stscript, args: NamedArguments, message: NewMessage) {
  return st.doReturn(String(args.return ?? 'none'), message, {
    toText: (m) => (m as NewMessage).swipes[0]?.content ?? '',
  });
}

function manualSwipe(text: string, extra: Record<string, unknown>) {
  return {
    content: text,
    info: { send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra },
  };
}

/** Macros as when the message is sent (SillyTavern `substituteParams`). */
const expand = (text: string) => macros.evaluate(text, chat.macroEnv());

export function registerChatCommands(st: Stscript) {
  const insert = async (message: NewMessage, at: unknown) => {
    const index = resolveIndex(at, chat.messages.length);
    await chat.insertMessages([message], Number.isNaN(index) ? undefined : index);
  };

  st.commands
    .add({
      name: 'send',
      helpString: 'Adds a user message to the chat log without triggering a generation.',
      rawQuotes: true,
      namedArgumentList: [compactArg, atArg, { name: 'name', description: 'display name' }, returnArg],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        const text = str(value).trim();
        const bias = await extractMessageBias(text);
        const name = 'name' in args ? str(args.name) : chat.userName;
        const persona = 'name' in args ? findPersona(name) : undefined;
        let content = expand(chat.applyRegex(text, RegexPlacement.USER_INPUT));
        if (bias) content = removeMacros(content);
        const message: NewMessage = {
          role: 'user',
          name,
          swipes: [{ content, info: {} }],
          sendDate: new Date().toISOString(),
          extra: { isSmallSys: isTrueBoolean(str(args.compact)), ...(bias ? { bias } : {}) },
          data: persona?.sourceFile ? { force_avatar: thumbnailUrl(persona.sourceFile) } : {},
        };
        await insert(message, args.at);
        return returned(st, args, message);
      },
    })
    .add({
      name: 'sendas',
      helpString: 'Sends a message as a specific character (it does not reply).',
      rawQuotes: true,
      namedArgumentList: [
        { name: 'name', description: 'Character name', isRequired: true },
        { name: 'avatar', description: 'Character avatar override' },
        compactArg,
        atArg,
        returnArg,
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        let name = str(args.name).trim();
        if (!name) name = chat.character?.name ?? '';
        const text = chat.applyRegex(str(value).trim(), RegexPlacement.SLASH_COMMAND, {
          characterOverride: name,
        });
        const bias = await extractMessageBias(text);
        const character = findCharacter(name);
        const avatarCharacter = args.avatar ? findCharacter(str(args.avatar)) : character;
        if (args.avatar && !avatarCharacter) {
          ui.toast(t('script.avatarNotFound', { name: str(args.avatar) }), 'warning');
          return '';
        }
        // The open character itself needs no avatar of its own (SillyTavern `getNameAndAvatarForMessage`).
        const isCurrent = !chat.group && avatarCharacter && avatarCharacter.id === chat.characterId;
        const file = avatarCharacter ? avatarKey(avatarCharacter) : 'img/ai4.png';
        const extra = {
          bias: bias.trim().length ? bias : null,
          gen_id: Date.now(),
          isSmallSys: isTrueBoolean(str(args.compact)),
          api: 'manual',
          model: 'slash command',
        };
        const message: NewMessage = {
          role: 'assistant',
          name: character?.name || name || avatarCharacter?.name || '',
          characterId: avatarCharacter?.id,
          hidden: Boolean(bias) && !removeMacros(text).length,
          swipes: [manualSwipe(expand(text), extra)],
          sendDate: new Date().toISOString(),
          extra,
          data: isCurrent ? {} : { force_avatar: thumbnailUrl(file), original_avatar: file },
        };
        await insert(message, args.at);
        return returned(st, args, message);
      },
    })
    .add({
      name: 'sys',
      aliases: ['nar'],
      helpString: 'Sends a message as the system narrator.',
      rawQuotes: true,
      namedArgumentList: [
        { name: 'name', description: 'name of the narrator' },
        compactArg,
        atArg,
        returnArg,
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        const text = str(value);
        const name =
          args.name !== undefined
            ? str(args.name)
            : str(chat.chat?.metadata[NARRATOR_NAME_KEY]) || NARRATOR_NAME_DEFAULT;
        const bias = await extractMessageBias(text);
        const extra = {
          type: 'narrator',
          bias: bias.trim().length ? bias : null,
          gen_id: Date.now(),
          isSmallSys: isTrueBoolean(str(args.compact)),
          api: 'manual',
          model: 'slash command',
        };
        const message: NewMessage = {
          role: 'system',
          name,
          hidden: Boolean(bias) && !removeMacros(text).length,
          swipes: [{ content: expand(text.trim()), info: {} }],
          sendDate: new Date().toISOString(),
          extra,
        };
        await insert(message, args.at);
        return returned(st, args, message);
      },
    })
    .add({
      name: 'comment',
      helpString: 'Adds a note to the chat that is not sent to the model.',
      rawQuotes: true,
      namedArgumentList: [compactArg, atArg, returnArg],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        const message: NewMessage = {
          role: 'assistant',
          name: COMMENT_NAME_DEFAULT,
          hidden: true,
          swipes: [{ content: expand(str(value).trim()), info: {} }],
          sendDate: new Date().toISOString(),
          extra: {
            type: 'comment',
            gen_id: Date.now(),
            isSmallSys: isTrueBoolean(str(args.compact)),
            api: 'manual',
            model: 'slash command',
          },
        };
        await insert(message, args.at);
        return returned(st, args, message);
      },
    })
    .add({
      name: 'sysname',
      helpString: 'Sets the name of the narrator for /sys messages (System when empty).',
      unnamedArgumentList: [{ description: 'name' }],
      callback: async (_, value) => {
        const name = str(value) || NARRATOR_NAME_DEFAULT;
        await chat.updateMetadata({ [NARRATOR_NAME_KEY]: name });
        ui.toast(t('script.narratorName', { name }));
        return '';
      },
    })
    .add({
      name: 'echo',
      helpString: 'Shows the text as a notification and passes it down the pipe.',
      rawQuotes: true,
      namedArgumentList: [
        { name: 'title', description: 'title of the toast message' },
        {
          name: 'severity',
          description: 'severity level of the toast message',
          defaultValue: 'info',
          enumList: ['info', 'warning', 'error', 'success'],
        },
        {
          name: 'timeout',
          description: 'time in milliseconds to display the toast message',
          typeList: [ArgType.NUMBER],
        },
        {
          name: 'escapeHtml',
          description: 'whether to escape HTML in the toast message',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        },
        {
          name: 'awaitDismissal',
          description: 'wait for the toast message to be dismissed before continuing',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
        {
          name: 'onClick',
          description: 'a closure to call when the toast is clicked',
          typeList: [ArgType.CLOSURE],
        },
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: (args, value) => {
        if (value === '') return '';
        const text = String(value);
        let severity = str(args.severity) || 'info';
        if (!['error', 'warning', 'success', 'info'].includes(severity)) {
          ui.toast(t('script.badSeverity', { severity }), 'warning');
          severity = 'info';
        }
        const timeout = parseInt(str(args.timeout), 10);
        const onClick = args.onClick;
        if (onClick !== undefined && !(onClick instanceof Closure))
          ui.toast(t('script.badOnClick'), 'warning');
        return new Promise((resolve) => {
          ui.toast(text, severity as 'info', {
            title: args.title ? str(args.title) : undefined,
            html: args.escapeHtml !== undefined && !isTrueBoolean(str(args.escapeHtml)),
            timeout: Number.isNaN(timeout) ? undefined : timeout,
            onclick: onClick instanceof Closure ? () => void onClick.execute() : undefined,
            onhidden: () => resolve(text),
          });
          if (!isTrueBoolean(str(args.awaitDismissal))) resolve(text);
        });
      },
    })
    .add({
      name: 'messages',
      aliases: ['message'],
      helpString: 'Returns the specified message or range of messages as a string.',
      namedArgumentList: [
        {
          name: 'names',
          description: 'show message author names',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'on',
        },
        {
          name: 'hidden',
          description: 'include hidden messages',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'off',
        },
        { name: 'role', description: 'filter messages by role', enumList: ['system', 'assistant', 'user'] },
      ],
      unnamedArgumentList: [
        {
          description: 'message index (starts with 0) or range',
          typeList: [ArgType.NUMBER, ArgType.RANGE],
          isRequired: true,
        },
      ],
      callback: (args, value) => {
        const names = !isFalseBoolean(str(args.names));
        const hidden = isTrueBoolean(str(args.hidden));
        const role = args.role as string | undefined;
        const range = stringToRange(value, 0, chat.messages.length - 1);
        if (!range) return '';
        if (role && !['system', 'assistant', 'user'].includes(role))
          throw new Error(`Invalid role provided. Expected one of: system, assistant, user. Got: ${role}`);
        const out: string[] = [];
        for (let i = range.start; i <= range.end; i++) {
          const m = chat.messages[i];
          if (!m) continue;
          const narrator = (m.extra as { type?: unknown }).type === 'narrator';
          const isUser = m.role === 'user';
          if (role === 'system' && !(narrator && !isUser)) continue;
          if (role === 'assistant' && (narrator || isUser)) continue;
          if (role === 'user' && (narrator || !isUser)) continue;
          if (!hidden && m.hidden) continue;
          const text = m.swipes[m.swipeId]?.content ?? '';
          out.push(names ? `${m.name}: ${text}` : text);
        }
        return out.join('\n\n');
      },
    })
    .add({
      name: 'setinput',
      helpString: 'Puts text into the message box.',
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: (_, value) => {
        chat.draft = str(value);
        return value;
      },
    });

  const hideCommand = (name: string, hidden: boolean) =>
    st.commands.add({
      name,
      helpString: hidden
        ? 'Hides a chat message (or a range) from the prompt.'
        : 'Puts a hidden chat message (or a range) back into the prompt.',
      namedArgumentList: [{ name: 'name', description: 'only messages from this character or persona' }],
      unnamedArgumentList: [
        { description: 'message index (starts with 0) or range', typeList: [ArgType.NUMBER, ArgType.RANGE] },
      ],
      callback: async (args, value) => {
        const last = chat.messages.length - 1;
        const range = value ? stringToRange(value, 0, last) : { start: last, end: last };
        if (!range) return '';
        await chat.setHiddenRange(range.start, range.end, hidden, str(args.name).trim());
        return '';
      },
    });
  hideCommand('hide', true);
  hideCommand('unhide', false);

  const cut = async (args: NamedArguments, value: unknown) => {
    const range = stringToRange(value, 0, chat.messages.length - 1);
    if (!range) {
      ui.toast(t('script.cutRange'), 'warning');
      return '';
    }
    return chat.deleteRange(
      range.start,
      range.end,
      args.toolcalls === undefined || isTrueBoolean(str(args.toolcalls)),
    );
  };
  const toolCallsArg = {
    name: 'toolcalls',
    description: 'also delete associated tool-call messages',
    typeList: [ArgType.BOOLEAN],
    defaultValue: 'true',
  };
  st.commands
    .add({
      name: 'cut',
      helpString: 'Cuts the specified message or continuous chunk from the chat.',
      namedArgumentList: [toolCallsArg],
      unnamedArgumentList: [
        { description: 'number or range', typeList: [ArgType.NUMBER, ArgType.RANGE], isRequired: true },
      ],
      callback: cut,
    })
    .add({
      name: 'del',
      aliases: ['delete', 'delmode'],
      helpString: 'Deletes the last N messages.',
      namedArgumentList: [toolCallsArg],
      unnamedArgumentList: [{ description: 'optional number', typeList: [ArgType.NUMBER] }],
      callback: async (args, value) => {
        const text = str(value);
        if (text && Number.isNaN(Number(text))) {
          ui.toast(t('script.delNumber'), 'warning');
          return '';
        }
        // (There is no separate deletion mode: the message menu deletes single messages.)
        if (!text) return '';
        const count = Number(text);
        if (count < 1) return '';
        if (count > chat.messages.length) {
          ui.toast(t('script.delTooMany', { count: chat.messages.length }), 'warning');
          return '';
        }
        return cut(args, `${chat.messages.length - count}-${chat.messages.length - 1}`);
      },
    })
    .add({
      name: 'delname',
      aliases: ['cancel'],
      helpString: 'Deletes all messages attributed to a specified name.',
      unnamedArgumentList: [{ description: 'name', isRequired: true }],
      callback: async (_, value) => {
        if (!value) return '';
        const name = findCharacter(str(value))?.name || str(value);
        const indexes = chat.messages.flatMap((m, i) => (m.name === name ? [i] : []));
        if (!indexes.length) return '';
        for (const i of indexes.reverse()) await chat.deleteRange(i, i, false);
        ui.toast(t('script.deletedFrom', { count: indexes.length, name }));
        return '';
      },
    })
    .add({
      name: 'delswipe',
      aliases: ['swipedel'],
      helpString:
        'Deletes a swipe from the last chat message (the current one when no 1-based index is given).',
      unnamedArgumentList: [{ description: '1-based swipe id', typeList: [ArgType.NUMBER] }],
      callback: async (_, value) => {
        const swipe = value && !Number.isNaN(Number(value)) ? Number(value) - 1 : null;
        try {
          return String(await chat.deleteSwipe(swipe));
        } catch (error) {
          ui.toast((error as Error).message, 'warning');
          return 'undefined';
        }
      },
    })
    .add({
      name: 'addswipe',
      aliases: ['swipeadd'],
      helpString: 'Adds a swipe to the last chat message.',
      namedArgumentList: [
        { name: 'switch', description: 'switch to the new swipe', typeList: [ArgType.BOOLEAN] },
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        if (!chat.messages.length) {
          ui.toast(t('script.noMessages'), 'warning');
          return '';
        }
        if (!value) return '';
        try {
          return String(await chat.addSwipe(str(value), isTrueBoolean(str(args.switch))));
        } catch (error) {
          ui.toast((error as Error).message, 'warning');
          return '';
        }
      },
    })
    .add({
      name: 'message-role',
      helpString: "Gets or sets a message's role (user, assistant or system).",
      namedArgumentList: [
        {
          name: 'at',
          description: 'message index (a negative value counts from the end)',
          typeList: [ArgType.NUMBER],
        },
      ],
      unnamedArgumentList: [{ description: 'role', enumList: ['user', 'assistant', 'system'] }],
      callback: async (args, value) => {
        const index = resolveIndex(args.at ?? chat.messages.length - 1, chat.messages.length);
        const message = chat.messages[index];
        if (!message) {
          ui.toast(t('script.noMessageAt'), 'warning');
          return '';
        }
        const role = str(value).trim().toLowerCase();
        if (!['user', 'assistant', 'system'].includes(role)) {
          return (message.extra as { type?: unknown }).type === 'narrator'
            ? 'system'
            : message.role === 'user'
              ? 'user'
              : 'assistant';
        }
        await chat.setMessageRole(index, role as 'user');
        return role;
      },
    })
    .add({
      name: 'message-name',
      helpString: "Gets or sets a message's author name.",
      namedArgumentList: [
        {
          name: 'at',
          description: 'message index (a negative value counts from the end)',
          typeList: [ArgType.NUMBER],
        },
      ],
      unnamedArgumentList: [{ description: 'name' }],
      callback: async (args, value) => {
        const index = resolveIndex(args.at ?? chat.messages.length - 1, chat.messages.length);
        const message = chat.messages[index];
        if (!message) {
          ui.toast(t('script.noMessageAt'), 'warning');
          return '';
        }
        const name = str(value).trim();
        if (!name) return message.name;
        const data = { ...(message.data as Record<string, unknown>) };
        let newName = name;
        if (message.role === 'user') {
          const persona = findPersona(name);
          if (persona) newName = persona.name;
          data.force_avatar = persona?.sourceFile ? thumbnailUrl(persona.sourceFile) : 'img/ai4.png';
        } else {
          const character = findCharacter(name);
          if (character) {
            newName = character.name;
            data.force_avatar = thumbnailUrl(avatarKey(character));
            data.original_avatar = avatarKey(character);
          } else {
            data.force_avatar = data.original_avatar = 'img/ai4.png';
          }
        }
        await chat.updateMessageFields(index, { name: newName, data });
        return newName;
      },
    });

  // The chat itself
  st.commands
    .add({
      name: 'getchatname',
      helpString: 'Returns the name of the current chat.',
      callback: () => chat.chat?.title ?? '',
    })
    .add({
      name: 'renamechat',
      helpString: 'Renames the current chat.',
      unnamedArgumentList: [{ description: 'new chat name', isRequired: true }],
      callback: async (_, value) => {
        if (!value) {
          ui.toast(t('script.renameNeedsName'), 'warning');
          return '';
        }
        if (!chat.chat) {
          ui.toast(t('script.noChat'), 'warning');
          return '';
        }
        await chat.renameChat(str(value));
        ui.toast(t('script.renamed', { name: str(value) }), 'success');
        return '';
      },
    })
    .add({
      name: 'delchat',
      helpString: 'Deletes the current chat.',
      callback: async () => {
        if (chat.chat) await chat.deleteChat(chat.chat.id);
        return '';
      },
    })
    .add({
      name: 'closechat',
      helpString: 'Closes the current chat.',
      callback: () => {
        chat.close();
        return '';
      },
    })
    .add({
      name: 'newchat',
      helpString: 'Starts a new chat with the current character or group.',
      namedArgumentList: [
        {
          name: 'delete',
          description: 'delete the current chat',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      callback: async (args) => {
        const current = chat.chat?.id;
        await chat.newChat();
        if (current && isTrueBoolean(str(args.delete))) await chat.deleteChat(current);
        return '';
      },
    })
    .add({
      name: 'forcesave',
      helpString: 'Saves the chat now (BakaTavern saves every change as it happens).',
      callback: async () => {
        await chat.flushVariables();
        return '';
      },
    })
    .add({
      name: 'chat-reload',
      helpString: 'Reloads the current chat.',
      callback: async () => {
        await chat.resync();
        return '';
      },
    })
    .add({
      name: 'chat-render',
      helpString: 'Renders the chat again (BakaTavern always shows the whole chat).',
      callback: () => '',
    })
    .add({
      name: 'chat-jump',
      aliases: ['chat-scrollto', 'floor-teleport'],
      helpString: 'Scrolls the chat to the message with the given index.',
      unnamedArgumentList: [
        { description: 'message index (starts with 0)', typeList: [ArgType.NUMBER], isRequired: true },
      ],
      callback: (_, value) => {
        const index = Number(value);
        if (Number.isNaN(index) || index < 0 || index >= chat.messages.length) {
          ui.toast(t('script.badIndex', { index: str(value), max: chat.messages.length }), 'warning');
          return '';
        }
        document
          .querySelector(`article.message[data-index="${index}"]`)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return '';
      },
    });

  // Dialogs
  const okArg = { name: 'okButton', description: 'text for the OK button', defaultValue: 'OK' };
  st.commands
    .add({
      name: 'popup',
      helpString: 'Shows a popup with the provided text (HTML is allowed) and waits until it is closed.',
      namedArgumentList: [
        { name: 'header', description: 'header text' },
        okArg,
        { name: 'cancelButton', description: 'text for the Cancel button' },
        {
          name: 'result',
          description: 'return 1 for OK, 0 for Cancel and an empty string when closed',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
        { name: 'wide', description: 'wide popup', typeList: [ArgType.BOOLEAN] },
        { name: 'large', description: 'large popup', typeList: [ArgType.BOOLEAN] },
      ],
      unnamedArgumentList: [{ description: 'popup text', isRequired: true }],
      callback: async (args, value) => {
        const result = await scriptDialogs.open({
          kind: 'popup',
          header: typeof args.header === 'string' ? args.header : null,
          body: str(value),
          okButton: typeof args.okButton === 'string' ? args.okButton : t('script.ok'),
          cancelButton: typeof args.cancelButton === 'string' ? args.cancelButton : null,
          wide: isTrueBoolean(str(args.wide)) || isTrueBoolean(str(args.large)),
        });
        return String(isTrueBoolean(str(args.result)) ? (result ?? '') : value);
      },
    })
    .add({
      name: 'input',
      aliases: ['prompt'],
      helpString: 'Asks for text and passes it down the pipe.',
      namedArgumentList: [
        { name: 'default', description: 'default value of the input field' },
        { name: 'large', description: 'show large input field', typeList: [ArgType.BOOLEAN] },
        { name: 'wide', description: 'show wide input field', typeList: [ArgType.BOOLEAN] },
        okArg,
        { name: 'rows', description: 'number of rows for the input field', typeList: [ArgType.NUMBER] },
        { name: 'placeholder', description: 'placeholder text for the input field' },
        { name: 'onSuccess', description: 'closure to run when OK is pressed', typeList: [ArgType.CLOSURE] },
        {
          name: 'onCancel',
          description: 'closure to run when the input is cancelled',
          typeList: [ArgType.CLOSURE],
        },
      ],
      unnamedArgumentList: [{ description: 'text to display' }],
      callback: async (args, value) => {
        const rows =
          typeof args.rows === 'string' && !Number.isNaN(Number(args.rows)) ? Number(args.rows) : 4;
        const result = await scriptDialogs.open({
          kind: 'input',
          body: str(value),
          initial: typeof args.default === 'string' ? args.default : '',
          rows,
          placeholder: typeof args.placeholder === 'string' ? args.placeholder : null,
          okButton: typeof args.okButton === 'string' ? args.okButton : t('script.ok'),
          wide: isTrueBoolean(str(args.wide)) || isTrueBoolean(str(args.large)),
        });
        const cancelled = result === null || result === '';
        const handler = cancelled ? args.onCancel : args.onSuccess;
        if (handler !== undefined) {
          if (!(handler instanceof Closure))
            throw new Error(
              `argument '${cancelled ? 'onCancel' : 'onSuccess'}' must be a closure for command /input`,
            );
          await handler.execute();
        }
        return String(result || '');
      },
    })
    .add({
      name: 'buttons',
      helpString:
        'Shows buttons and passes the label of the one pressed down the pipe (a JSON list with multiple=true).',
      namedArgumentList: [
        {
          name: 'labels',
          description: 'button labels (a JSON list, or a variable holding one)',
          isRequired: true,
        },
        {
          name: 'multiple',
          description: 'allow selecting several buttons',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        try {
          const raw: unknown = JSON.parse(
            String(resolveVariable(str(args.labels), args._scope, st.variables)),
          );
          if (!Array.isArray(raw) || !raw.length) return '';
          const buttons = raw.map(
            (b) => (typeof b === 'string' ? { text: b } : b) as { text?: unknown; tooltip?: unknown },
          );
          if (!buttons.every((b) => typeof b === 'object' && b && typeof b.text === 'string' && b.text))
            return '';
          const multiple = isTrueBoolean(str(args.multiple));
          const result = await scriptDialogs.open({
            kind: 'buttons',
            body: str(value),
            buttons: buttons.map((b) => ({
              text: b.text as string,
              tooltip: typeof b.tooltip === 'string' ? b.tooltip : undefined,
            })),
            multiple,
          });
          return multiple
            ? JSON.stringify(Array.isArray(result) ? result : [])
            : typeof result === 'string'
              ? result
              : '';
        } catch {
          return '';
        }
      },
    })
    .add({
      name: 'clipboard-get',
      helpString: 'Gets the text from the clipboard (secure contexts only).',
      callback: async () => {
        if (!navigator.clipboard) {
          ui.toast(t('script.noClipboard'), 'warning');
          return '';
        }
        try {
          return await navigator.clipboard.readText();
        } catch {
          ui.toast(t('script.clipboardDenied'), 'warning');
          return '';
        }
      },
    })
    .add({
      name: 'clipboard-set',
      helpString: 'Copies the text to the clipboard.',
      unnamedArgumentList: [{ description: 'text to copy to the clipboard', isRequired: true }],
      callback: async (_, value) => {
        await copyText(str(value));
        return '';
      },
    })
    .add({
      name: 'is-mobile',
      helpString: 'Returns true on phones and tablets.',
      callback: () => String(ui.narrow),
    })
    .add({
      name: 'beep',
      aliases: ['ding'],
      helpString: 'Plays a short sound.',
      callback: () => {
        try {
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          oscillator.connect(context.destination);
          oscillator.frequency.value = 880;
          oscillator.start();
          oscillator.stop(context.currentTime + 0.12);
        } catch {
          // no audio
        }
        return '';
      },
    });
}

addCommands(registerChatCommands);
