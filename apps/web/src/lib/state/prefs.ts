import { defaultWorldInfoSettings, type WorldInfoSettings } from '@bakatavern/core';

/** Typed settings namespaces with their defaults. */

export interface UiPrefs {
  theme: 'auto' | 'night' | 'day';
  textScale: number;
  chatWidth: number;
  showTimestamps: boolean;
  showTokenCounts: boolean;
  /** Render HTML from messages (sanitized). */
  renderHtml: boolean;
  /** Allow images from other sites in messages. */
  externalMedia: boolean;
  customCss: string;
}

export const uiDefaults: UiPrefs = {
  theme: 'auto',
  textScale: 1,
  chatWidth: 46,
  showTimestamps: false,
  showTokenCounts: false,
  renderHtml: true,
  externalMedia: false,
  customCss: '',
};

export interface ChatPrefs {
  sendOnEnter: boolean;
  /** "Start reply with". */
  promptBias: string;
  stoppingStrings: string[];
  reasoningAutoParse: boolean;
  reasoningPrefix: string;
  reasoningSuffix: string;
  /** Messages to load per page in long chats. */
  pageSize: number;
}

export const chatDefaults: ChatPrefs = {
  sendOnEnter: true,
  promptBias: '',
  stoppingStrings: [],
  reasoningAutoParse: false,
  reasoningPrefix: '<think>\n',
  reasoningSuffix: '\n</think>',
  pageSize: 100,
};

export interface ConnectionPrefs {
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
}

export const connectionDefaults: ConnectionPrefs = {
  providerId: 'openai',
  models: {},
  baseUrls: {},
  endpoints: {},
  secretIds: {},
  presetId: null,
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
