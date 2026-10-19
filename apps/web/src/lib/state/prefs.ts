import {
  defaultWorldInfoSettings,
  stDefaultBiasLists,
  type LogitBiasEntry,
  type RegexScript,
  type WorldInfoSettings,
} from '@bakatavern/core';

/** Typed settings namespaces with their defaults. */

export interface UiPrefs {
  theme: 'auto' | 'night' | 'day';
  textScale: number;
  chatWidth: number;
  showTimestamps: boolean;
  showTokenCounts: boolean;
  /** Messages with several images show them all (`list`) or one at a time (`gallery`). */
  mediaDisplay: 'list' | 'gallery';
  /** Render HTML from messages (sanitized). */
  renderHtml: boolean;
  /** Allow images from other sites in messages. */
  externalMedia: boolean;
  customCss: string;
  /** The imported (SillyTavern) theme in use, if any, and the colors it sets (CSS tokens). */
  themeName: string | null;
  themeColors: Record<string, string>;
}

export const uiDefaults: UiPrefs = {
  theme: 'auto',
  textScale: 1,
  chatWidth: 46,
  showTimestamps: false,
  showTokenCounts: false,
  mediaDisplay: 'list',
  renderHtml: true,
  externalMedia: false,
  customCss: '',
  themeName: null,
  themeColors: {},
};

export interface ChatPrefs {
  sendOnEnter: boolean;
  /** "Start reply with". */
  promptBias: string;
  stoppingStrings: string[];
  /** Split `prefix … suffix` reasoning blocks off replies. */
  reasoningAutoParse: boolean;
  /** Name of the reasoning template the prefix, suffix and separator came from. */
  reasoningTemplate: string;
  /** Reasoning template (SillyTavern's default is "Think XML"). */
  reasoningPrefix: string;
  reasoningSuffix: string;
  reasoningSeparator: string;
  /** Send the reasoning of the latest replies back to the model. */
  reasoningAddToPrompts: boolean;
  reasoningMaxAdditions: number;
  /** Messages to load per page in long chats. */
  pageSize: number;
}

export const chatDefaults: ChatPrefs = {
  sendOnEnter: true,
  promptBias: '',
  stoppingStrings: [],
  reasoningAutoParse: false,
  reasoningTemplate: 'Think XML',
  reasoningPrefix: '<think>',
  reasoningSuffix: '</think>',
  reasoningSeparator: '\n',
  reasoningAddToPrompts: false,
  reasoningMaxAdditions: 1,
  pageSize: 100,
};

/** A Text Completion connection (SillyTavern's "Text Completion" API). */
export interface TextConnectionPrefs {
  /** Backend type (SillyTavern `textgen_types`). */
  type: string;
  /** Server URL per local backend type. */
  serverUrls: Record<string, string>;
  /** Selected model per backend type. */
  models: Record<string, string>;
  /** Stored key per backend type. */
  secretIds: Record<string, string>;
  /** Text Completion preset (samplers). */
  presetId: string | null;
  streaming: boolean;
  /** Context size and response length (SillyTavern `max_context`, `amount_gen`). */
  maxContext: number;
  maxResponse: number;
  /** Other backend options with SillyTavern's keys (`openrouter_providers`, `include_reasoning` ...). */
  settings: Record<string, unknown>;
}

export const textConnectionDefaults: TextConnectionPrefs = {
  type: 'koboldcpp',
  serverUrls: {},
  models: {},
  secretIds: {},
  presetId: null,
  streaming: true,
  maxContext: 8192,
  maxResponse: 350,
  settings: {},
};

export interface ConnectionPrefs {
  /** Chat Completion or Text Completion. */
  api: 'chat' | 'text';
  text: TextConnectionPrefs;
  providerId: string;
  /** Selected model per provider. */
  models: Record<string, string>;
  /** Base URL per provider (Custom, reverse proxies). */
  baseUrls: Record<string, string>;
  /** Regional endpoint per provider (e.g. SiliconFlow `cn`). */
  endpoints: Record<string, string>;
  /** Stored key per provider. */
  secretIds: Record<string, string>;
  /** Chat Completion preset id. */
  presetId: string | null;
  /** Source options per provider, with SillyTavern's keys (`openrouter_middleout`, ...). */
  sourceSettings: Record<string, Record<string, unknown>>;
  /** Custom source: YAML for extra body fields, removed body keys and extra headers. */
  customBody: { include: string; exclude: string; headers: string };
}

export const connectionDefaults: ConnectionPrefs = {
  api: 'chat',
  text: textConnectionDefaults,
  providerId: 'openai',
  models: {},
  baseUrls: {},
  endpoints: {},
  secretIds: {},
  presetId: null,
  sourceSettings: {},
  customBody: { include: '', exclude: '', headers: '' },
};

export interface PersonaPrefs {
  defaultPersonaId: string | null;
  /** Persona locked to a character. */
  characterPersona: Record<string, string>;
}

export const personaDefaults: PersonaPrefs = { defaultPersonaId: null, characterPersona: {} };

export interface WorldInfoPrefs {
  settings: WorldInfoSettings;
  /** Globally active lorebooks (by name). */
  globalBooks: string[];
  /** Additional lorebooks per character id. */
  characterExtraBooks: Record<string, string[]>;
}

export const worldInfoDefaults: WorldInfoPrefs = {
  settings: defaultWorldInfoSettings,
  globalBooks: [],
  characterExtraBooks: {},
};

export interface NotePrefs {
  allowWIScan: boolean;
  defaultPrompt: string;
  defaultInterval: number;
  defaultPosition: number;
  defaultDepth: number;
  defaultRole: number;
  characterNotes: Record<string, { prompt: string; position: number; enabled: boolean }>;
}

export const noteDefaults: NotePrefs = {
  allowWIScan: false,
  defaultPrompt: '',
  defaultInterval: 1,
  defaultPosition: 1,
  defaultDepth: 4,
  defaultRole: 0,
  characterNotes: {},
};

export interface RegexPrefs {
  /** Global scripts (SillyTavern `extension_settings.regex`). */
  scripts: RegexScript[];
  /** Characters whose embedded scripts may run, by character id. */
  allowedCharacters: string[];
  /** Presets whose embedded scripts may run, by preset id. */
  allowedPresets: string[];
  /** Characters and presets already asked about, so the question comes only once. */
  asked: string[];
}

export const regexDefaults: RegexPrefs = {
  scripts: [],
  allowedCharacters: [],
  allowedPresets: [],
  asked: [],
};

/**
 * Advanced Formatting: the templates in effect (presets of kind `instruct`, `context`,
 * `sysprompt`) and the power user options that shape prompts.
 */
export interface FormattingPrefs {
  instructEnabled: boolean;
  instructId: string | null;
  /** Select the instruct template named like the context template (SillyTavern `bind_to_context`). */
  bindToContext: boolean;
  contextId: string | null;
  syspromptEnabled: boolean;
  syspromptId: string | null;
  preferCharacterPrompt: boolean;
  preferCharacterJailbreak: boolean;
  collapseNewlines: boolean;
  trimSpaces: boolean;
  tokenPadding: number;
  pinExamples: boolean;
  stripExamples: boolean;
  /** Text Completion tokenizer: `auto` (SillyTavern's best match), `remote` (the backend's) or one by name. */
  tokenizer: string;
  /** SillyTavern's templates were added to the presets once. */
  seeded: boolean;
}

export const formattingDefaults: FormattingPrefs = {
  instructEnabled: false,
  instructId: null,
  bindToContext: false,
  contextId: null,
  syspromptEnabled: true,
  syspromptId: null,
  preferCharacterPrompt: true,
  preferCharacterJailbreak: true,
  collapseNewlines: false,
  trimSpaces: true,
  tokenPadding: 64,
  pinExamples: false,
  stripExamples: false,
  tokenizer: 'auto',
  seeded: false,
};

/** Chat Completion logit bias lists by name (SillyTavern `oai_settings.bias_presets`). */
export interface LogitBiasPrefs {
  lists: Record<string, LogitBiasEntry[]>;
}

export const logitBiasDefaults: LogitBiasPrefs = { lists: stDefaultBiasLists };

/** Quick Replies: which sets show where (SillyTavern `extension_settings.quickReplyV2`). */
export interface SetLink {
  set: string;
  isVisible: boolean;
}

export interface QuickReplyPrefs {
  isEnabled: boolean;
  /** All visible sets' buttons in one row. */
  isCombined: boolean;
  config: { setList: SetLink[] };
  /** By character id. */
  characterConfigs: Record<string, { setList: SetLink[] }>;
}

export const quickReplyDefaults: QuickReplyPrefs = {
  isEnabled: true,
  isCombined: false,
  config: { setList: [] },
  characterConfigs: {},
};

/** Front-end cards (TavernHelper / 酒馆助手): message pages and scripts. */
export interface FrontendPrefs {
  /** Show front-end code blocks in messages as pages. */
  enabled: boolean;
  /** Load the libraries cards expect (Vue, jQuery UI, Font Awesome) from a CDN. */
  cdn: boolean;
  /** Characters whose pages run unsandboxed, with this app's origin (trust mode). */
  trustedCharacters: string[];
  /** Characters and presets whose embedded scripts may run. */
  allowedCharacters: string[];
  allowedPresets: string[];
  /** Scripts that run everywhere (TavernHelper's global scripts, its `ScriptTree` JSON). */
  scripts: Record<string, unknown>[];
  /** Run the global scripts. */
  globalScripts: boolean;
  /** Questions already asked (`character:<id>`, `preset:<id>`). */
  asked: string[];
}

export const frontendDefaults: FrontendPrefs = {
  enabled: true,
  cdn: true,
  trustedCharacters: [],
  allowedCharacters: [],
  allowedPresets: [],
  scripts: [],
  globalScripts: true,
  asked: [],
};

/** Chat backgrounds (SillyTavern's `backgrounds/` folder and `background` setting). */
export interface BackgroundPrefs {
  /** Pictures by SillyTavern file name, with their stored file. */
  items: { name: string; hash: string }[];
  /** The one shown in every chat that has none of its own. */
  current: string | null;
  /** SillyTavern `background.fitting`. */
  fit: 'classic' | 'cover' | 'contain' | 'stretch' | 'center';
}

export const backgroundDefaults: BackgroundPrefs = { items: [], current: null, fit: 'classic' };
