/**
 * Commands that read and change settings: Author's Note, templates and presets, the API in use,
 * stop strings, reasoning, regex scripts, checkpoints, and help (SillyTavern `authors-note.js`,
 * `slash-commands.js`, `sysprompt.js`, `preset-manager.js`, `power-user.js`, `reasoning.js`,
 * `extensions/regex`, `bookmarks.js`).
 */

import {
  ArgType,
  formatReasoning,
  fuzzySearch,
  getTextgenType,
  getProvider,
  isFalseBoolean,
  isTrueBoolean,
  parseReasoningFromString,
  RegexPlacement,
  runRegexScript,
  type RegexScript,
  type Stscript,
} from '@bakatavern/core';

import { api } from '../../api.ts';
import { macros } from '../../generation/pipeline.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import {
  chatDefaults,
  connectionDefaults,
  formattingDefaults,
  noteDefaults,
  textConnectionDefaults,
  type ConnectionPrefs,
  type FormattingPrefs,
} from '../../state/prefs.ts';
import { backgrounds } from '../../state/backgrounds.svelte.ts';
import { cardScripts, regex } from '../../state/regex.svelte.ts';
import { settings } from '../../state/settings.svelte.ts';
import { ui } from '../../state/ui.svelte.ts';
import { scriptDialogs } from '../dialogs.svelte.ts';
import { addCommands } from '../runtime.svelte.ts';

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const quietArg = {
  name: 'quiet',
  description: 'Suppress the toast message on template change',
  typeList: [ArgType.BOOLEAN],
  defaultValue: 'false',
};
const forceGetArg = {
  name: 'forceGet',
  description: 'Force getting a name even if it is disabled',
  typeList: [ArgType.BOOLEAN],
  defaultValue: 'false',
};
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Author's Note ------------------------------------------------------------------------------

/** The chat's note setting, else the default (SillyTavern fills the chat's in when it opens). */
function note(key: 'prompt' | 'interval' | 'depth' | 'position' | 'role'): unknown {
  const prefs = settings.get('note', noteDefaults);
  const defaults = {
    prompt: prefs.defaultPrompt,
    interval: prefs.defaultInterval,
    depth: prefs.defaultDepth,
    position: prefs.defaultPosition,
    role: prefs.defaultRole,
  };
  return chat.chat?.metadata[`note_${key}`] ?? defaults[key];
}

const notePositions: Record<string, number> = {
  after: 0,
  scenario: 0,
  chat: 1,
  before_scenario: 2,
  before: 2,
};
const noteRoles: Record<string, number> = { system: 0, user: 1, assistant: 2 };

// Templates and presets ----------------------------------------------------------------------

const formatting = (): FormattingPrefs => ({
  ...formattingDefaults,
  ...settings.get('formatting', formattingDefaults),
});
const presetsOf = (kind: string) => library.presets.filter((p) => p.kind === kind);

/** The template in use: the chosen one, else SillyTavern's default name, else the first. */
function currentTemplate(kind: 'instruct' | 'context' | 'sysprompt') {
  const prefs = formatting();
  const id =
    kind === 'instruct' ? prefs.instructId : kind === 'context' ? prefs.contextId : prefs.syspromptId;
  const fallback = kind === 'instruct' ? 'Alpaca' : kind === 'context' ? 'Default' : 'Neutral - Chat';
  const presets = presetsOf(kind);
  return presets.find((p) => p.id === id) ?? presets.find((p) => p.name === fallback) ?? presets[0];
}

/** Templates named alike go together when instruct mode follows the context template. */
function selectTemplate(kind: 'instruct' | 'context', id: string) {
  const prefs = formatting();
  const name = presetsOf(kind).find((p) => p.id === id)?.name;
  const other = kind === 'instruct' ? 'context' : 'instruct';
  const match = presetsOf(other).find((p) => p.name === name);
  const patch: Partial<FormattingPrefs> = kind === 'instruct' ? { instructId: id } : { contextId: id };
  if (prefs.bindToContext && match) {
    if (other === 'instruct') patch.instructId = match.id;
    else patch.contextId = match.id;
  }
  settings.update('formatting', patch);
}

/** A name from a list: exact (ignoring case) first, then the closest (Fuse defaults). */
function pickName(names: string[], wanted: string, exactFirst = true): string | undefined {
  const exact = exactFirst
    ? names.find((n) => n.toLowerCase().trim() === wanted.toLowerCase().trim())
    : undefined;
  return exact ?? fuzzySearch(names, wanted)[0];
}

/** SillyTavern's names for APIs (`CONNECT_API_MAP`), in its order, with aliases. */
function apiMap(): [string, { api: 'chat' | 'text'; id: string }][] {
  const map: [string, { api: 'chat' | 'text'; id: string }][] = [
    ['koboldcpp', { api: 'text', id: 'koboldcpp' }],
    ['kcpp', { api: 'text', id: 'koboldcpp' }],
    ['openai', { api: 'chat', id: 'openai' }],
    ['oai', { api: 'chat', id: 'openai' }],
    ['google', { api: 'chat', id: 'makersuite' }],
    ['openrouter', { api: 'chat', id: 'openrouter' }],
    ['openrouter-text', { api: 'text', id: 'openrouter' }],
  ];
  const known = new Set(map.map(([key]) => key));
  for (const id of [
    'ooba',
    'mancer',
    'vllm',
    'aphrodite',
    'tabby',
    'koboldcpp',
    'togetherai',
    'llamacpp',
    'ollama',
    'infermaticai',
    'dreamgen',
    'openrouter',
    'featherless',
    'huggingface',
    'generic',
  ]) {
    if (!known.has(id) && getTextgenType(id)) map.push([id, { api: 'text', id }]);
    known.add(id);
  }
  for (const id of [
    'openai',
    'claude',
    'openrouter',
    'ai21',
    'makersuite',
    'vertexai',
    'mistralai',
    'custom',
    'cohere',
    'perplexity',
    'groq',
    'chutes',
    'electronhub',
    'nanogpt',
    'deepseek',
    'aimlapi',
    'xai',
    'pollinations',
    'moonshot',
    'fireworks',
    'cometapi',
    'azure_openai',
    'zai',
    'siliconflow',
    'minimax',
  ]) {
    if (!known.has(id) && getProvider(id)) map.push([id, { api: 'chat', id }]);
    known.add(id);
  }
  return map;
}

// Regex scripts ------------------------------------------------------------------------------

type ScriptScope = 'global' | 'character' | 'preset';

/** Every regex script, enabled or not: global, the character's, the preset's (`getRegexScripts`). */
function allRegexScripts(): { script: RegexScript; scope: ScriptScope; index: number }[] {
  const global = regex.prefs.scripts;
  const character = chat.character ? cardScripts(chat.character.card) : [];
  const preset = regex.preset?.scripts ?? [];
  return [
    ...global.map((script, index) => ({ script, scope: 'global' as const, index })),
    ...character.map((script, index) => ({ script, scope: 'character' as const, index })),
    ...preset.map((script, index) => ({ script, scope: 'preset' as const, index })),
  ];
}

async function saveRegexScript(scope: ScriptScope, index: number, script: RegexScript) {
  const replace = (list: RegexScript[]) => list.map((s, i) => (i === index ? script : s));
  if (scope === 'global') regex.setGlobal(replace(regex.prefs.scripts));
  else if (scope === 'character' && chat.character)
    await regex.setCharacterScripts(replace(cardScripts(chat.character.card)));
  else if (scope === 'preset') await regex.setPresetScripts(replace(regex.preset?.scripts ?? []));
}

// Checkpoints --------------------------------------------------------------------------------

/** A message index from a command, the last message by default; warns when there is none. */
function messageIndex(value: unknown, context: string): number | null {
  const index = Number(value ?? chat.messages.length - 1);
  if (Number.isNaN(index)) {
    ui.toast(t('script.badMessageId'), 'warning', { title: context });
    return null;
  }
  if (!chat.messages[index]) {
    ui.toast(t('script.noMessageId', { id: index }), 'warning', { title: context });
    return null;
  }
  return index;
}

const bookmarkOf = (index: number) =>
  (chat.messages[index]?.extra as { bookmark_link?: unknown }).bookmark_link;

export function registerSettingsCommands(st: Stscript) {
  // Author's Note
  const noteNumber =
    (key: 'depth' | 'interval', label: 'depth' | 'frequency') => async (_args: unknown, value: unknown) => {
      const text = str(value);
      if (text) {
        const number = Number(text);
        if (Number.isNaN(number)) {
          ui.toast(t('script.notANumber'), 'error');
          return '';
        }
        await chat.updateMetadata({ [`note_${key}`]: Math.abs(number) });
        ui.toast(t(label === 'depth' ? 'script.noteDepth' : 'script.noteFrequency'), 'success');
      }
      return str(note(key));
    };

  st.commands
    .add({
      name: 'note',
      helpString:
        "Sets an author's note for the currently selected chat if specified and returns the current note.",
      unnamedArgumentList: [{ description: 'text' }],
      callback: async (_args, value) => {
        const text = str(value);
        if (text) {
          if (!chat.chat) return '';
          await chat.updateMetadata({ note_prompt: text });
          ui.toast(t('script.noteText'), 'success');
        }
        return str(note('prompt'));
      },
    })
    .add({
      name: 'note-depth',
      aliases: ['depth'],
      helpString:
        "Sets an author's note depth for in-chat positioning if specified and returns the current depth.",
      unnamedArgumentList: [{ description: 'number', typeList: [ArgType.NUMBER] }],
      callback: noteNumber('depth', 'depth'),
    })
    .add({
      name: 'note-frequency',
      aliases: ['freq', 'note-freq'],
      helpString: "Sets an author's note insertion frequency if specified and returns the current frequency.",
      unnamedArgumentList: [{ description: 'number', typeList: [ArgType.NUMBER] }],
      callback: noteNumber('interval', 'frequency'),
    })
    .add({
      name: 'note-position',
      aliases: ['pos', 'note-pos'],
      helpString: "Sets an author's note position if specified and returns the current position.",
      unnamedArgumentList: [{ description: 'position', enumList: ['before', 'after', 'chat'] }],
      callback: async (_args, value) => {
        const text = str(value);
        if (text) {
          const position = notePositions[text.trim().toLowerCase()];
          if (position === undefined) {
            ui.toast(t('script.badNotePosition'), 'error');
            return '';
          }
          await chat.updateMetadata({ note_position: position });
          ui.toast(t('script.notePosition'), 'info');
        }
        return (
          Object.keys(notePositions).find((key) => notePositions[key] === Number(note('position'))) ?? ''
        );
      },
    })
    .add({
      name: 'note-role',
      helpString: "Sets an author's note chat insertion role if specified and returns the current role.",
      unnamedArgumentList: [{ description: 'role', enumList: ['system', 'user', 'assistant'] }],
      callback: async (_args, value) => {
        const text = str(value);
        if (text) {
          const role = noteRoles[text.trim().toLowerCase()];
          if (role === undefined) {
            ui.toast(t('script.badNoteRole'), 'error');
            return '';
          }
          await chat.updateMetadata({ note_role: role });
          ui.toast(t('script.noteRole'), 'info');
        }
        return Object.keys(noteRoles).find((key) => noteRoles[key] === Number(note('role'))) ?? '';
      },
    });

  // Templates
  const setInstruct = (enabled: boolean) => {
    settings.update('formatting', { instructEnabled: enabled });
    return '';
  };
  const setSysprompt = (enabled: boolean) => {
    settings.update('formatting', { syspromptEnabled: enabled });
    return '';
  };

  st.commands
    .add({
      name: 'instruct',
      helpString:
        'Selects instruct mode template by name. Enables instruct mode if not already enabled. Gets the current instruct template if no name is provided and instruct mode is enabled or forceGet=true is passed.',
      namedArgumentList: [quietArg, forceGetArg],
      unnamedArgumentList: [{ description: 'instruct template name' }],
      callback: (args, value) => {
        const name = str(value);
        if (!name) {
          return formatting().instructEnabled || isTrueBoolean(str(args.forceGet))
            ? (currentTemplate('instruct')?.name ?? '')
            : '';
        }
        const quiet = isTrueBoolean(str(args.quiet));
        const found = fuzzySearch(presetsOf('instruct'), name, { keys: ['name'] })[0];
        if (!found) {
          if (!quiet) ui.toast(t('script.noInstruct', { name }), 'warning');
          return '';
        }
        if (found.id !== currentTemplate('instruct')?.id || !formatting().instructId) {
          selectTemplate('instruct', found.id);
          if (!quiet) ui.toast(t('script.instructSelected', { name: found.name }), 'info');
        }
        if (!formatting().instructEnabled) {
          setInstruct(true);
          if (!quiet) ui.toast(t('script.instructOn'), 'info');
        }
        return found.name;
      },
    })
    .add({
      name: 'instruct-on',
      helpString: 'Enables instruct mode.',
      callback: () => setInstruct(true),
    })
    .add({
      name: 'instruct-off',
      helpString: 'Disables instruct mode',
      callback: () => setInstruct(false),
    })
    .add({
      name: 'instruct-state',
      aliases: ['instruct-toggle'],
      helpString:
        'Gets the current instruct mode state. If an argument is provided, it will set the instruct mode state.',
      unnamedArgumentList: [{ description: 'instruct mode state', typeList: [ArgType.BOOLEAN] }],
      callback: (_args, value) => {
        if (value && typeof value === 'string') setInstruct(isTrueBoolean(value));
        return String(formatting().instructEnabled);
      },
    })
    .add({
      name: 'context',
      helpString: 'Selects context template by name. Gets the current template if no name is provided',
      namedArgumentList: [quietArg],
      unnamedArgumentList: [{ description: 'context template name' }],
      callback: (args, value) => {
        const name = str(value);
        if (!name) return currentTemplate('context')?.name ?? '';
        const quiet = isTrueBoolean(str(args.quiet));
        const found = fuzzySearch(presetsOf('context'), name, { keys: ['name'] })[0];
        if (!found) {
          if (!quiet) ui.toast(t('script.noContext', { name }), 'warning');
          return '';
        }
        selectTemplate('context', found.id);
        if (!quiet) ui.toast(t('script.contextSelected', { name: found.name }), 'info');
        return found.name;
      },
    })
    .add({
      name: 'sysprompt',
      aliases: ['system-prompt'],
      helpString:
        'Selects a system prompt by name, using fuzzy search to find the closest match. Gets the current system prompt if no name is provided and sysprompt is enabled or forceGet=true is passed.',
      namedArgumentList: [quietArg, forceGetArg],
      unnamedArgumentList: [{ description: 'system prompt name' }],
      callback: (args, value) => {
        if (!formatting().syspromptEnabled && !isTrueBoolean(str(args.forceGet))) return '';
        const name = str(value);
        if (!name) return currentTemplate('sysprompt')?.name ?? '';
        const quiet = isTrueBoolean(str(args.quiet));
        const presets = presetsOf('sysprompt');
        const found = pickName(
          presets.map((p) => p.name),
          name,
        );
        const preset = presets.find((p) => p.name === found);
        if (!preset) {
          if (!quiet) ui.toast(t('script.noSysprompt', { name }), 'warning');
          return '';
        }
        settings.update('formatting', { syspromptId: preset.id, syspromptEnabled: true });
        if (!quiet) ui.toast(t('script.syspromptSelected', { name: preset.name }), 'success');
        return preset.name;
      },
    })
    .add({
      name: 'sysprompt-on',
      aliases: ['sysprompt-enable'],
      helpString: 'Enables system prompt.',
      callback: () => setSysprompt(true),
    })
    .add({
      name: 'sysprompt-off',
      aliases: ['sysprompt-disable'],
      helpString: 'Disables system prompt',
      callback: () => setSysprompt(false),
    })
    .add({
      name: 'sysprompt-state',
      aliases: ['sysprompt-toggle'],
      helpString:
        'Gets the current system prompt state. If an argument is provided, it will set the system prompt state.',
      unnamedArgumentList: [{ description: 'system prompt state', typeList: [ArgType.BOOLEAN] }],
      callback: (_args, value) => {
        if (value && typeof value === 'string') setSysprompt(isTrueBoolean(value));
        return String(formatting().syspromptEnabled);
      },
    });

  // The API and its preset
  st.commands
    .add({
      name: 'preset',
      helpString:
        'Sets a preset by name for the current API. Gets the current preset if no name is provided.',
      unnamedArgumentList: [{ description: 'name' }],
      callback: async (_args, value) => {
        const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
        const text = prefs.api === 'text';
        const presets = presetsOf(text ? 'textgen' : 'openai');
        const selectedId = text ? prefs.text?.presetId : prefs.presetId;
        const current =
          presets.find((p) => p.id === selectedId) ??
          (text ? presets.find((p) => p.name === 'Default') : undefined) ??
          presets[0];
        const name = str(value);
        if (!name || !presets.length) return current?.name ?? '';
        const found = pickName(
          presets.map((p) => p.name),
          name,
        );
        const preset = presets.find((p) => p.name === found);
        if (!preset) return current?.name ?? '';
        if (preset.id !== current?.id) {
          if (text) {
            const textPrefs = { ...textConnectionDefaults, ...prefs.text, presetId: preset.id };
            const data = (await api.getPreset(preset.id)).data as Record<string, unknown>;
            if (typeof data.genamt === 'number') textPrefs.maxResponse = data.genamt;
            if (typeof data.max_length === 'number') textPrefs.maxContext = data.max_length;
            settings.update('connection', { text: textPrefs });
          } else {
            settings.update('connection', { presetId: preset.id });
          }
        }
        return preset.name;
      },
    })
    .add({
      name: 'api',
      helpString:
        'Connect to an API. If no argument is provided, it will return the currently connected API.',
      namedArgumentList: [
        {
          name: 'quiet',
          description: 'Suppress the toast message on connection',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'API to connect to' }],
      callback: (args, value) => {
        const prefs = settings.get<ConnectionPrefs>('connection', connectionDefaults);
        const map = apiMap();
        const wanted = str(value).trim().toLowerCase();
        if (!wanted) {
          const id =
            prefs.api === 'text' ? (prefs.text?.type ?? textConnectionDefaults.type) : prefs.providerId;
          return map.find(([, target]) => target.api === prefs.api && target.id === id)?.[0] ?? '';
        }
        const target = map.find(([key]) => key === wanted)?.[1];
        if (!target) {
          ui.toast(t('script.badApi', { api: str(value) }), 'error');
          return '';
        }
        if (target.api === 'text') {
          settings.update('connection', {
            api: 'text',
            text: { ...textConnectionDefaults, ...prefs.text, type: target.id },
          });
        } else {
          settings.update('connection', { api: 'chat', providerId: target.id });
        }
        if (!isTrueBoolean(str(args.quiet))) ui.toast(t('script.apiSet', { api: wanted }), 'success');
        return '';
      },
    })
    .add({
      name: 'stop-strings',
      aliases: ['stopping-strings', 'custom-stopping-strings', 'custom-stop-strings'],
      helpString:
        'Sets a list of custom stopping strings. Gets the list if no value is provided. Use a "force" argument to force set an empty value.',
      namedArgumentList: [
        {
          name: 'force',
          description: 'force set a value if empty',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'list of strings', typeList: [ArgType.LIST] }],
      callback: (args, value) => {
        const force = isTrueBoolean(str(args.force ?? false));
        let text = str(value).trim();
        const current = () => JSON.stringify(settings.get('chat', chatDefaults).stoppingStrings);
        if (!force && !text) return current();
        if (force && !text) text = '[]';
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // reported below
        }
        if (!parsed || !Array.isArray(parsed)) {
          throw new Error('Invalid list format. The value must be a JSON-serialized array of strings.');
        }
        settings.update('chat', { stoppingStrings: parsed.map((x) => String(x)) });
        return current();
      },
    })
    .add({
      name: 'start-reply-with',
      helpString:
        'Sets a "Start Reply With". Gets the current value if no value is provided. Use a "force" argument to force set an empty value.',
      namedArgumentList: [
        {
          name: 'force',
          description: 'force set a value if empty',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'value' }],
      callback: (args, value) => {
        const force = isTrueBoolean(str(args.force ?? false));
        if (!force && !value) return settings.get('chat', chatDefaults).promptBias;
        settings.update('chat', { promptBias: str(value) });
        return str(value);
      },
    });

  // Reasoning
  const reasoningTemplate = () => {
    const prefs = settings.get('chat', chatDefaults);
    return {
      prefix: prefs.reasoningPrefix,
      suffix: prefs.reasoningSuffix,
      separator: prefs.reasoningSeparator,
    };
  };

  st.commands
    .add({
      name: 'reasoning-get',
      aliases: ['get-reasoning'],
      helpString:
        'Get the contents of a reasoning block of a message. Returns an empty string if the message does not have a reasoning block.',
      unnamedArgumentList: [
        {
          description: 'Message ID. If not provided, the message ID of the last message is used.',
          typeList: [ArgType.NUMBER],
        },
      ],
      callback: (_args, value) => {
        const parsed = parseInt(str(value), 10);
        const message = chat.messages[Number.isNaN(parsed) ? chat.messages.length - 1 : parsed];
        return str((message?.extra as { reasoning?: unknown } | undefined)?.reasoning);
      },
    })
    .add({
      name: 'reasoning-set',
      aliases: ['set-reasoning'],
      helpString: 'Set the reasoning block of a message. Returns the reasoning block content.',
      namedArgumentList: [
        {
          name: 'at',
          description: 'Message ID. If not provided, the message ID of the last message is used.',
          typeList: [ArgType.NUMBER],
        },
        {
          name: 'collapse',
          description: 'Whether to collapse the reasoning block.',
          typeList: [ArgType.BOOLEAN],
        },
      ],
      unnamedArgumentList: [{ description: 'Reasoning block content.' }],
      callback: async (args, value) => {
        const at = Number(args.at);
        const index = !Number.isNaN(at) && args.at !== undefined ? at : chat.messages.length - 1;
        const message = chat.messages[index];
        if (!message) return '';
        const reasoning = str(value);
        const extra = { ...(message.extra as Record<string, unknown>), reasoning, reasoning_type: 'manual' };
        await chat.updateMessageFields(index, { extra });
        return reasoning;
      },
    })
    .add({
      name: 'reasoning-parse',
      aliases: ['parse-reasoning'],
      helpString: 'Extracts the reasoning block from a string using the Reasoning Formatting settings.',
      namedArgumentList: [
        {
          name: 'regex',
          description: 'Whether to apply regex scripts to the reasoning content.',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        },
        {
          name: 'return',
          description: 'Whether to return the parsed reasoning or the content without reasoning',
          defaultValue: 'reasoning',
          enumList: ['reasoning', 'content'],
        },
        {
          name: 'strict',
          description:
            'Whether to require the reasoning block to be at the beginning of the string (excluding whitespaces).',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'true',
        },
      ],
      unnamedArgumentList: [{ description: 'input string' }],
      callback: (args, value) => {
        if (!value || typeof value !== 'string') return '';
        const template = reasoningTemplate();
        if (!template.prefix || !template.suffix) {
          ui.toast(t('script.reasoningTemplate'), 'warning');
          return value;
        }
        if (typeof args.return !== 'string' || !['reasoning', 'content'].includes(args.return)) {
          ui.toast(t('script.reasoningReturn', { type: str(args.return) }), 'warning');
        }
        const content = args.return === 'content';
        const parsed = parseReasoningFromString(value, template, {
          strict: !isFalseBoolean(str(args.strict ?? '')),
          trimSpaces: formatting().trimSpaces,
        });
        if (!parsed) return content ? value : '';
        if (content) return parsed.content;
        return isFalseBoolean(str(args.regex ?? ''))
          ? parsed.reasoning
          : chat.applyRegex(parsed.reasoning, RegexPlacement.REASONING);
      },
    })
    .add({
      name: 'reasoning-format',
      aliases: ['format-reasoning'],
      helpString:
        'Formats reasoning and content into a single string using Reasoning Formatting settings. Useful for preparing text that can be parsed with /reasoning-parse.',
      namedArgumentList: [
        { name: 'reasoning', description: 'The reasoning/thinking text to format', isRequired: true },
      ],
      unnamedArgumentList: [{ description: 'The main content text' }],
      callback: (args, value) => {
        const template = reasoningTemplate();
        if (!template.prefix || !template.suffix) {
          ui.toast(t('script.reasoningTemplate'), 'warning');
          return '';
        }
        const reasoning = str(args.reasoning);
        if (!reasoning) {
          ui.toast(t('script.reasoningNeeded'), 'warning');
          return '';
        }
        return formatReasoning(reasoning, str(value), template, (text) =>
          macros.evaluate(text, chat.macroEnv()),
        );
      },
    });

  // Regex scripts
  const findScript = (name: string) =>
    allRegexScripts().find((s) => s.script.scriptName.toLowerCase() === name.toLowerCase());
  st.commands
    .add({
      name: 'regex',
      helpString: 'Runs a Regex extension script by name on the provided string. The script must be enabled.',
      namedArgumentList: [{ name: 'name', description: 'script name', isRequired: true }],
      unnamedArgumentList: [{ description: 'input' }],
      callback: (args, value) => {
        const text = str(value);
        if (!args.name) {
          ui.toast(t('script.regexNeedsName'), 'warning');
          return text;
        }
        const name = str(args.name);
        const found = findScript(name);
        if (!found) {
          ui.toast(t('script.noRegex', { name }), 'warning');
          return text;
        }
        if (found.script.disabled) {
          ui.toast(t('script.regexDisabled', { name }), 'warning');
          return text;
        }
        return runRegexScript(found.script, text, chat.regexSubstitute());
      },
    })
    .add({
      name: 'regex-state',
      helpString: 'Returns the current state of a regex script.',
      unnamedArgumentList: [{ description: 'script name', isRequired: true }],
      callback: (_args, value) => {
        const name = str(value);
        if (!name) {
          ui.toast(t('script.regexNeedsName'), 'warning');
          return '';
        }
        const found = findScript(name);
        if (!found) {
          ui.toast(t('script.noRegex', { name }), 'warning');
          return '';
        }
        return found.script.disabled ? 'false' : 'true';
      },
    })
    .add({
      name: 'regex-toggle',
      helpString: 'Toggles the state of a specified regex script.',
      namedArgumentList: [
        {
          name: 'state',
          description: "Explicitly set the state of the script ('on' to enable, 'off' to disable).",
          defaultValue: 'toggle',
          enumList: ['on', 'off', 'toggle'],
        },
        {
          name: 'quiet',
          description: 'Suppress the toast message script toggled',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      unnamedArgumentList: [{ description: 'script name', isRequired: true }],
      callback: async (args, value) => {
        if (typeof value !== 'string') throw new Error('Script name must be a string.');
        const found = findScript(value);
        if (!found) {
          ui.toast(t('script.noRegex', { name: value }), 'warning');
          return '';
        }
        const state = str(args.state);
        const disabled = isTrueBoolean(state) ? false : isFalseBoolean(state) ? true : !found.script.disabled;
        await saveRegexScript(found.scope, found.index, { ...found.script, disabled });
        if (!isTrueBoolean(str(args.quiet))) {
          ui.toast(t(disabled ? 'script.regexOff' : 'script.regexOn', { name: value }), 'success');
        }
        return found.script.scriptName || '';
      },
    });

  // Branches and checkpoints
  st.commands
    .add({
      name: 'branch-create',
      helpString:
        'Create a new branch from the selected message. If no message id is provided, will use the last message. After creating the branch, the branch chat will be automatically opened.',
      unnamedArgumentList: [{ description: 'Message ID', typeList: [ArgType.NUMBER] }],
      callback: async (args, value) => {
        const index = messageIndex(
          args.mesId ?? (value === '' ? undefined : value),
          t('script.createBranch'),
        );
        if (index === null) return '';
        await chat.branch(index);
        return chat.chat?.title ?? '';
      },
    })
    .add({
      name: 'checkpoint-create',
      helpString:
        'Create a new checkpoint for the selected message with the provided name. If no message id is provided, will use the last message. Leave the checkpoint name empty to auto-generate one.',
      namedArgumentList: [{ name: 'mesId', description: 'Message ID', typeList: [ArgType.NUMBER] }],
      unnamedArgumentList: [{ description: 'Checkpoint name' }],
      callback: async (args, value) => {
        const index = messageIndex(args.mesId, t('script.createCheckpoint'));
        if (index === null) return '';
        if (typeof value !== 'string') {
          ui.toast(t('script.checkpointName'), 'warning');
          return '';
        }
        const name = value || chat.checkpointTitle();
        await chat.checkpoint(index, name);
        return name;
      },
    })
    .add({
      name: 'checkpoint-go',
      helpString:
        'Open the checkpoint linked to the selected message. If no message id is provided, will use the last message.',
      unnamedArgumentList: [{ description: 'Message ID', typeList: [ArgType.NUMBER] }],
      callback: async (args, value) => {
        const index = messageIndex(
          args.mesId ?? (value === '' ? undefined : value),
          t('script.openCheckpoint'),
        );
        if (index === null) return '';
        const link = bookmarkOf(index);
        if (!link) {
          ui.toast(t('script.noCheckpoint'), 'warning');
          return '';
        }
        await chat.openChatByTitle(str(link));
        return str(link);
      },
    })
    .add({
      name: 'checkpoint-exit',
      helpString: 'Exit the checkpoint chat. If not in a checkpoint chat, returns empty string.',
      callback: async () => {
        const main = str(chat.chat?.metadata.main_chat);
        if (!main || !chat.chats.some((c) => c.title === main)) return '';
        await chat.openChatByTitle(main);
        return main;
      },
    })
    .add({
      name: 'checkpoint-parent',
      helpString:
        'Get the name of the parent chat for this checkpoint. If not in a checkpoint chat, returns empty string.',
      callback: () => str(chat.chat?.metadata.main_chat),
    })
    .add({
      name: 'checkpoint-get',
      helpString:
        'Get the name of the checkpoint linked to the selected message. If no message id is provided, will use the last message. If no checkpoint is linked, the result will be empty.',
      unnamedArgumentList: [{ description: 'Message ID', typeList: [ArgType.NUMBER] }],
      callback: (args, value) => {
        const index = messageIndex(
          args.mesId ?? (value === '' ? undefined : value),
          t('script.getCheckpoint'),
        );
        if (index === null) return '';
        return str(bookmarkOf(index));
      },
    })
    .add({
      name: 'checkpoint-list',
      helpString: 'List all existing checkpoints in this chat. The value will be a JSON array.',
      namedArgumentList: [
        {
          name: 'links',
          description: 'Get a list of all links / chat names of the checkpoints, instead of the message ids',
          typeList: [ArgType.BOOLEAN],
          defaultValue: 'false',
        },
      ],
      callback: (args) => {
        const links = isTrueBoolean(str(args.links));
        return JSON.stringify(
          chat.messages.flatMap((_m, i) => {
            const link = bookmarkOf(i);
            return link ? [links ? link : i] : [];
          }),
        );
      },
    });

  // Backgrounds
  st.commands
    .add({
      name: 'bg',
      aliases: ['background'],
      helpString:
        'Sets a background according to the provided filename. Partial names allowed. If no background is provided, this will return the currently selected background.',
      unnamedArgumentList: [{ description: 'background filename' }],
      callback: async (_args, value) => {
        const wanted = str(value);
        if (!wanted) return backgrounds.prefs.current ?? '';
        const [found] = fuzzySearch(backgrounds.prefs.items, wanted, { keys: ['name'] });
        if (!found) {
          ui.toast(t('script.noBackground', { name: wanted }), 'error');
          return '';
        }
        // Like a click in SillyTavern's list: a chat with its own background keeps it locked.
        if (chat.chat?.metadata.custom_background) await backgrounds.setChat(found.name);
        else backgrounds.setCurrent(found.name);
        return '';
      },
    })
    .add({
      name: 'lockbg',
      aliases: ['bglock'],
      helpString: 'Locks a background for the currently selected chat',
      callback: async () => {
        if (!chat.chat) {
          ui.toast(t('script.lockBgNeedsChat'), 'warning');
          return '';
        }
        await backgrounds.setChat(backgrounds.prefs.current);
        return '';
      },
    })
    .add({
      name: 'unlockbg',
      aliases: ['bgunlock'],
      helpString: 'Unlocks a background for the currently selected chat',
      callback: async () => {
        await backgrounds.setChat(null);
        return '';
      },
    });

  // Help
  st.commands.add({
    name: '?',
    aliases: ['help'],
    helpString: 'Get help on macros, chat formatting and commands.',
    unnamedArgumentList: [{ description: 'help topic', enumList: ['slash', 'macros', 'format', 'hotkeys'] }],
    callback: async () => {
      const rows = st.commands
        .list()
        .map((command) => {
          const names = [command.name, ...(command.aliases ?? [])]
            .map((n) => `<code>/${escapeHtml(n)}</code>`)
            .join(' ');
          return `<li>${names} – ${escapeHtml(command.helpString ?? '')}</li>`;
        })
        .join('');
      await scriptDialogs.open({
        kind: 'popup',
        header: t('script.helpTitle'),
        body: `<p>${escapeHtml(t('script.helpIntro'))}</p><ul>${rows}</ul>`,
        okButton: t('script.ok'),
        cancelButton: null,
        wide: true,
      });
      return '';
    },
  });
}

addCommands(registerSettingsCommands);
