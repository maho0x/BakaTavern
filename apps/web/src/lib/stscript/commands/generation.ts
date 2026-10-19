/**
 * Commands that generate: background prompts, replies, swipes, and what goes into the prompt
 * (SillyTavern `/gen`, `/genraw`, `/trigger`, `/inject`, ...).
 */

import {
  ArgType,
  Closure,
  ExtensionPromptPosition,
  ExtensionPromptRole,
  isFalseBoolean,
  isTrueBoolean,
  RegexPlacement,
  resolveVariable,
  type ExtensionPrompt,
  type Stscript,
} from '@bakatavern/core';

import { generateQuiet, generateRaw } from '../../generation/background.svelte.ts';
import { addInjectionSource } from '../../generation/injections.ts';
import { activeConnection } from '../../generation/pipeline.ts';
import { tokenizerFor } from '../../generation/tokenizers.ts';
import { events, eventTypes } from '../../events.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { connectionDefaults, type ConnectionPrefs } from '../../state/prefs.ts';
import { settings } from '../../state/settings.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import { findCharacter, findGroupMember } from '../lookup.ts';
import { addCommands, scripts } from '../runtime.svelte.ts';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));

/** Script injections live in the chat's metadata (SillyTavern `script_injects`). */
const SCRIPT_PROMPT_KEY = 'script_inject_';

interface ScriptInject {
  value: string;
  position: number;
  depth: number;
  scan: boolean;
  role: number;
  /** A closure's text: the injection applies when it returns true. */
  filter: string | null;
}

/** Waits until no reply is being written (SillyTavern waits up to 10 s). */
async function whenIdle(command: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (chat.busy) {
    if (Date.now() > deadline) {
      ui.toast(t('script.busy', { command }), 'warning');
      return false;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** Runs a generation command; with `await=true` the script waits for it. */
async function later(args: Record<string, unknown>, command: string, run: () => Promise<unknown>) {
  const done = (async () => {
    await new Promise((r) => setTimeout(r, 1));
    if (await whenIdle(command)) await run();
  })().catch((error) => ui.toast(t('chat.generationFailed', { message: (error as Error).message }), 'error'));
  if (isTrueBoolean(str(args.await))) await done;
  return '';
}

/** Stop strings given to `/gen` (a JSON list, a variable holding one, or text). */
function ephemeralStops(value: unknown, args: Record<string, unknown>, st: Stscript): string[] | undefined {
  if (value === undefined) return undefined;
  const text = String(resolveVariable(str(value), args._scope as never, st.variables));
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // a single string
  }
  return text ? [text] : undefined;
}

export function registerGenerationCommands(st: Stscript) {
  const length = (args: Record<string, unknown>) =>
    Number(resolveVariable(str(args.length ?? ''), args._scope as never, st.variables) ?? 0) || 0;

  st.commands
    .add({
      name: 'gen',
      helpString: 'Generates text from a prompt, with the chat as context, and passes it down the pipe.',
      namedArgumentList: [
        { name: 'lock', description: 'lock user input during generation', typeList: [ArgType.BOOLEAN] },
        { name: 'name', description: 'in-prompt character name for instruct mode', defaultValue: 'System' },
        { name: 'length', description: 'API response length in tokens', typeList: [ArgType.NUMBER] },
        {
          name: 'as',
          description: 'role of the output prompt',
          defaultValue: 'system',
          enumList: ['system', 'char'],
        },
        { name: 'stop', description: 'stop strings for this generation (a JSON list)' },
        {
          name: 'trim',
          description: 'trim the reply to the last complete sentence',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'prompt', isRequired: true }],
      callback: async (args, value) => {
        chat.draft = '';
        const name = args.name ? str(args.name) : undefined;
        const character = name ? findCharacter(name) : null;
        try {
          return await generateQuiet({
            prompt: str(value),
            toLoud: (args.as || 'system') === 'char',
            name: character?.name ?? name,
            responseLength: length(args),
            trimToSentence: isTrueBoolean(str(args.trim)),
            characterId: chat.group ? character?.id : undefined,
            stop: ephemeralStops(args.stop, args, st),
          });
        } catch (error) {
          ui.toast((error as Error).message, 'error', { title: t('script.apiError') });
          return '';
        }
      },
    })
    .add({
      name: 'genraw',
      helpString: 'Generates text from the prompt alone (no chat or character) and passes it down the pipe.',
      namedArgumentList: [
        { name: 'lock', description: 'lock user input during generation', typeList: [ArgType.BOOLEAN] },
        {
          name: 'instruct',
          description: 'use instruct mode',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'on',
        },
        { name: 'stop', description: 'stop strings for this generation (a JSON list)' },
        {
          name: 'as',
          description: 'role of the output prompt',
          defaultValue: 'system',
          enumList: ['system', 'char'],
        },
        { name: 'system', description: 'system prompt at the start' },
        { name: 'prefill', description: 'prefill prompt at the end' },
        { name: 'length', description: 'API response length in tokens', typeList: [ArgType.NUMBER] },
        {
          name: 'trim',
          description: 'trim {{user}} and {{char}} prefixes from the output',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'on',
        },
      ],
      unnamedArgumentList: [{ description: 'prompt', isRequired: true }],
      callback: async (args, value) => {
        if (!value) return '';
        chat.draft = '';
        const resolve = (v: unknown) => str(resolveVariable(str(v ?? ''), args._scope, st.variables));
        try {
          return await generateRaw({
            prompt: str(value),
            instructOverride: isFalseBoolean(str(args.instruct)),
            quietToLoud: (args.as || 'system') === 'char',
            systemPrompt: resolve(args.system),
            prefill: resolve(args.prefill),
            responseLength: length(args),
            trimNames: !isFalseBoolean(str(args.trim)),
            stop: ephemeralStops(args.stop, args, st),
          });
        } catch (error) {
          ui.toast((error as Error).message, 'error', { title: t('script.apiError') });
          return '';
        }
      },
    })
    .add({
      name: 'sysgen',
      helpString: 'Generates text from a prompt and sends it as a narrator message.',
      namedArgumentList: [
        {
          name: 'trim',
          description: 'trim the reply to the last complete sentence',
          typeList: [ArgType.BOOLEAN],
        },
      ],
      unnamedArgumentList: [{ description: 'prompt', isRequired: true }],
      callback: async (args, value) => {
        chat.draft = '';
        if (!value) {
          ui.toast(t('script.needPrompt'), 'warning');
          return '';
        }
        const text = await generateQuiet({
          prompt: str(value),
          trimToSentence: isTrueBoolean(str(args.trim)),
        });
        const sys = st.commands.get('sys')!;
        return sys.callback!(args, chat.applyRegex(text, RegexPlacement.SLASH_COMMAND));
      },
    })
    .add({
      name: 'trigger',
      helpString: 'Triggers a reply (in a group, from the given member).',
      namedArgumentList: [
        {
          name: 'await',
          description: 'wait for the reply',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [
        {
          description: 'group member index (starts with 0) or name',
          typeList: [ArgType.NUMBER, ArgType.STRING],
        },
      ],
      callback: (args, value) =>
        later(args, 'trigger', async () => {
          chat.draft = '';
          if (chat.group && value) {
            const id = groupMemberId(str(value));
            if (id) return chat.trigger(id);
          }
          await chat.generate('normal');
        }),
    })
    .add({
      name: 'continue',
      aliases: ['cont'],
      helpString: 'Continues the last message in the chat.',
      namedArgumentList: [
        {
          name: 'await',
          description: 'wait for the reply',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'prompt' }],
      callback: (args) => later(args, 'continue', () => chat.generate('continue')),
    })
    .add({
      name: 'regenerate',
      aliases: ['regen'],
      helpString: 'Regenerates the last message.',
      namedArgumentList: [
        {
          name: 'await',
          description: 'wait for the reply',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      callback: (args) => later(args, 'regenerate', () => chat.regenerate()),
    })
    .add({
      name: 'swipe',
      helpString: 'Swipes the last message (right generates a new swipe at the end).',
      namedArgumentList: [
        {
          name: 'await',
          description: 'wait for the swipe',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
        {
          name: 'direction',
          description: 'swipe direction',
          defaultValue: 'right',
          enumList: ['left', 'right'],
        },
      ],
      callback: (args) =>
        later(args, 'swipe', async () => {
          const last = chat.messages.at(-1);
          if (last) await chat.swipe(last.id, args.direction === 'left' ? -1 : 1);
        }),
    })
    .add({
      name: 'impersonate',
      aliases: ['imp'],
      helpString: 'Writes your next message for you (into the message box).',
      namedArgumentList: [
        {
          name: 'await',
          description: 'wait for the text',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'prompt' }],
      callback: (args) => later(args, 'impersonate', () => chat.generate('impersonate')),
    })
    .add({
      name: 'ask',
      helpString: 'Asks another character a question in this chat; their reply is added.',
      namedArgumentList: [
        { name: 'name', description: 'character name', isRequired: true },
        {
          name: 'return',
          description: 'The way how you want the return value to be provided',
          defaultValue: 'pipe',
        },
      ],
      unnamedArgumentList: [{ description: 'prompt' }],
      callback: async (args, value) => {
        chat.draft = '';
        if (chat.group) {
          ui.toast(t('script.askGroup'), 'warning');
          return '';
        }
        if (!args.name) {
          ui.toast(t('script.askName'), 'warning');
          return '';
        }
        const character = findCharacter(str(args.name));
        if (!character) {
          ui.toast(t('script.noSuchCharacter'), 'error');
          return '';
        }
        if (value)
          await st.commands.get('send')!.callback!(
            args,
            chat.applyRegex(str(value).trim(), RegexPlacement.SLASH_COMMAND),
          );
        ui.toast(t('script.asking', { name: character.name }));
        const message = await chat.askCharacter(character.id);
        return st.doReturn(str(args.return ?? 'pipe'), message, {
          toText: (m) =>
            m ? ((m as typeof message)!.swipes[(m as typeof message)!.swipeId]?.content ?? '') : '',
        });
      },
    })
    .add({
      name: 'stop',
      aliases: ['generate-stop'],
      helpString: 'Stops the reply being written; returns true if there was one.',
      callback: () => {
        const running = chat.busy;
        chat.stop();
        return String(running);
      },
    })
    .add({
      name: 'tokens',
      helpString: 'Counts the tokens of the text with the current tokenizer.',
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (_, value) => {
        const connection = activeConnection();
        if (!connection) return '0';
        return String(await tokenizerFor(connection).count(str(value)));
      },
    })
    .add({
      name: 'trimtokens',
      helpString: 'Trims the text to the given number of tokens, from the start or the end.',
      namedArgumentList: [
        {
          name: 'limit',
          description: 'number of tokens to keep',
          typeList: [ArgType.NUMBER],
          isRequired: true,
        },
        {
          name: 'direction',
          description: 'which end of the text to keep',
          defaultValue: 'end',
          enumList: ['start', 'end'],
        },
      ],
      unnamedArgumentList: [{ description: 'text', isRequired: true }],
      callback: async (args, value) => {
        const text = str(value);
        if (!text) return '';
        const limit = Number(resolveVariable(str(args.limit), args._scope, st.variables));
        if (Number.isNaN(limit)) return text;
        if (limit <= 0) return '';
        const connection = activeConnection();
        if (!connection) return text;
        const tokenizer = tokenizerFor(connection);
        const count = await tokenizer.count(text);
        if (count <= limit) return text;
        const direction = str(args.direction) || 'end';
        // Proportionally, like SillyTavern does when it cannot decode tokens.
        const keep = Math.floor(text.length * (limit / count));
        return direction === 'start' ? text.substring(0, keep) : text.substring(text.length - keep);
      },
    })
    .add({
      name: 'model',
      helpString: 'Gets or sets the model of the current connection.',
      namedArgumentList: [
        {
          name: 'quiet',
          description: 'suppress the toast message',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'model name' }],
      callback: (args, value) => {
        const connection = activeConnection();
        if (!connection) return '';
        const model = str(value).trim();
        if (!model) return connection.model;
        const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
        if (connection.api === 'text') {
          const text = { ...prefs.text, models: { ...prefs.text?.models, [connection.type.id]: model } };
          settings.update('connection', { text });
        } else {
          settings.update('connection', { models: { ...prefs.models, [connection.provider.id]: model } });
        }
        if (!isTrueBoolean(str(args.quiet))) ui.toast(t('script.modelSet', { model }), 'success');
        return model;
      },
    });

  // Injections
  const positions: Record<string, number> = {
    before: ExtensionPromptPosition.BEFORE_PROMPT,
    after: ExtensionPromptPosition.IN_PROMPT,
    chat: ExtensionPromptPosition.IN_CHAT,
    none: ExtensionPromptPosition.NONE,
  };
  const roles: Record<string, number> = {
    system: ExtensionPromptRole.SYSTEM,
    user: ExtensionPromptRole.USER,
    assistant: ExtensionPromptRole.ASSISTANT,
  };
  const injects = () => ({
    ...((chat.chat?.metadata.script_injects as Record<string, ScriptInject> | undefined) ?? {}),
  });
  const saveInjects = (next: Record<string, ScriptInject>) => chat.updateMetadata({ script_injects: next });

  st.commands
    .add({
      name: 'inject',
      helpString: 'Injects text into the prompt; the same id replaces it, empty text removes it.',
      namedArgumentList: [
        { name: 'id', description: 'injection ID or variable name pointing to ID' },
        {
          name: 'position',
          description: 'injection position',
          defaultValue: 'after',
          enumList: ['before', 'after', 'chat', 'none'],
        },
        { name: 'depth', description: 'injection depth', typeList: [ArgType.NUMBER], defaultValue: '4' },
        {
          name: 'scan',
          description: 'include injection content into World Info scans',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
        {
          name: 'role',
          description: 'role for in-chat injections',
          defaultValue: 'system',
          enumList: ['system', 'user', 'assistant'],
        },
        {
          name: 'ephemeral',
          description: 'remove injection after generation',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
        {
          name: 'filter',
          description: 'if a filter is defined, the injection only applies when it returns true',
          typeList: [ArgType.CLOSURE],
        },
      ],
      unnamedArgumentList: [{ description: 'text' }],
      callback: async (args, value) => {
        const id = str(args.id) || Math.random().toString(36).substring(2);
        const position = positions[str(args.position || 'after')] ?? positions.after!;
        const depthValue = Number(args.depth ?? 4);
        const depth = Number.isNaN(depthValue) ? 4 : depthValue;
        const roleValue =
          typeof args.role === 'string' ? args.role.toLowerCase().trim() : Number(args.role ?? 0);
        const role = roles[roleValue as string] ?? ExtensionPromptRole.SYSTEM;
        const filter = args.filter instanceof Closure ? args.filter.rawText : null;
        if (args.filter && !str(filter).trim())
          throw new Error('Failed to parse the filter argument. Make sure it is a valid non-empty closure.');
        const text = str(value);
        const next = injects();
        if (text)
          next[id] = { value: text, position, depth, scan: isTrueBoolean(str(args.scan)), role, filter };
        else delete next[id];
        await saveInjects(next);
        if (isTrueBoolean(str(args.ephemeral))) {
          let removed = false;
          const remove = async () => {
            if (removed) return;
            removed = true;
            offEnded();
            offStopped();
            const current = injects();
            delete current[id];
            await saveInjects(current);
          };
          const offEnded = events.once(eventTypes.GENERATION_ENDED, remove);
          const offStopped = events.once(eventTypes.GENERATION_STOPPED, remove);
        }
        return id;
      },
    })
    .add({
      name: 'listinjects',
      helpString: 'Lists the script injections of the current chat.',
      namedArgumentList: [
        {
          name: 'return',
          description: 'The way how you want the return value to be provided',
          defaultValue: 'popup-html',
        },
      ],
      callback: (args) => {
        const names = Object.fromEntries(Object.entries(positions).map(([k, v]) => [v, k.toUpperCase()]));
        return st.doReturn(str(args.return ?? 'popup-html'), injects(), {
          toText: (all) =>
            `### Script injections:\n${
              Object.entries(all as Record<string, ScriptInject>)
                .map(
                  ([id, i]) =>
                    `* **${id}**: <code>${i.value}</code> (${names[i.position] ?? 'unknown'}, depth: ${i.depth}, scan: ${i.scan ?? false}, role: ${i.role ?? 0})`,
                )
                .join('\n') || 'No script injections for the current chat'
            }`,
        });
      },
    })
    .add({
      name: 'flushinject',
      aliases: ['flushinjects'],
      helpString: 'Removes a script injection (all of them without an id).',
      unnamedArgumentList: [{ description: 'injection ID or a variable name pointing to ID' }],
      callback: async (_, value) => {
        const current = injects();
        if (!Object.keys(current).length) return '';
        const id = str(value);
        for (const key of Object.keys(current)) if (!id || key === id) delete current[key];
        await saveInjects(current);
        return '';
      },
    });

  // Script injections go into every prompt (those with a filter when it returns true).
  addInjectionSource(async ({ metadata }) => {
    const all = (metadata.script_injects ?? {}) as Record<string, ScriptInject>;
    const out: Record<string, ExtensionPrompt> = {};
    for (const [id, inject] of Object.entries(all)) {
      if (inject.filter) {
        const result = await scripts.run(inject.filter, { handleExecutionErrors: false }).catch(() => null);
        if (!isTrueBoolean(str(result?.pipe))) continue;
      }
      out[`${SCRIPT_PROMPT_KEY}${id}`] = {
        value: inject.value,
        position: inject.position,
        depth: inject.depth,
        scan: inject.scan,
        role: inject.role,
      };
    }
    return out;
  });
}

/** A group member by index or name (SillyTavern `findGroupMemberId`). */
export function groupMemberId(arg: string): string | undefined {
  return findGroupMember(arg)?.characterId;
}

addCommands(registerGenerationCommands);
