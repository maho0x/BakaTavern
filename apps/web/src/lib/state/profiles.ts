/**
 * Connection profiles (SillyTavern's Connection Manager): the connection, presets and formatting
 * in use, saved under a name and applied in one go. Profiles keep SillyTavern's shape (its slash
 * command names as keys, presets and templates by name) so they move between the apps unchanged.
 */

import {
  fromStTokenizerKey,
  getProvider,
  getTextgenType,
  stTokenizerKey,
  type TextTokenizerSetting,
} from '@bakatavern/core';

import { api } from '../api.ts';
import { activePreset, invalidatePreset, pickPreset, textPrefs } from '../generation/pipeline.ts';
import { library } from './library.svelte.ts';
import {
  chatDefaults,
  connectionDefaults,
  formattingDefaults,
  type ChatPrefs,
  type FormattingPrefs,
  type TextConnectionPrefs,
} from './prefs.ts';
import { settings } from './settings.svelte.ts';

/** What a profile records (SillyTavern's keys); see `profileFields`. */
export interface ProfileData {
  /** Chat Completion (`cc`) or Text Completion (`tc`). */
  mode: 'cc' | 'tc';
  /** Fields left out of the profile. */
  exclude?: string[];
  [field: string]: unknown;
}

export interface ConnectionProfile extends ProfileData {
  id: string;
  name: string;
}

export interface ProfilePrefs {
  selected: string | null;
  profiles: ConnectionProfile[];
}

export const profileDefaults: ProfilePrefs = { selected: null, profiles: [] };

/**
 * What a profile records, in SillyTavern's order. `proxy-url` is BakaTavern's: the reverse proxy
 * address (SillyTavern names a proxy preset in `proxy` instead, which is kept as it is).
 */
export const profileFields = {
  cc: [
    'api',
    'preset',
    'api-url',
    'model',
    'proxy-url',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'prompt-post-processing',
    'secret-id',
  ],
  tc: [
    'api',
    'preset',
    'api-url',
    'model',
    'sysprompt',
    'sysprompt-state',
    'instruct',
    'context',
    'instruct-state',
    'tokenizer',
    'stop-strings',
    'start-reply-with',
    'reasoning-template',
    'secret-id',
  ],
} as const;

/** Fields that record an empty value (no stop strings, no reply prefix). */
const ALLOW_EMPTY = ['stop-strings', 'start-reply-with'];

const present = (profile: Record<string, unknown>, key: string) =>
  typeof profile[key] === 'string' && (profile[key] !== '' || ALLOW_EMPTY.includes(key));

/** SillyTavern's `/api` name for a Chat Completion source or Text Completion backend. */
function stApiName(mode: 'cc' | 'tc', id: string): string {
  if (mode === 'cc') return id === 'makersuite' ? 'google' : id;
  return id === 'openrouter' ? 'openrouter-text' : id;
}

function fromStApiName(mode: 'cc' | 'tc', name: string): string | undefined {
  if (mode === 'cc') {
    const id = name === 'oai' ? 'openai' : name === 'google' ? 'makersuite' : name;
    return getProvider(id) ? id : undefined;
  }
  const id = name === 'kcpp' ? 'koboldcpp' : name === 'openrouter-text' ? 'openrouter' : name;
  return getTextgenType(id) ? id : undefined;
}

const presetByName = (kind: string, name: string) =>
  library.presets.find((p) => p.kind === kind && p.name === name);

/** The current connection as a profile (without id and name). */
export async function captureProfile(): Promise<ProfileData> {
  const connection = { ...connectionDefaults, ...settings.get('connection', connectionDefaults) };
  const chat = { ...chatDefaults, ...settings.get('chat', chatDefaults) };
  const formatting = { ...formattingDefaults, ...settings.get('formatting', formattingDefaults) };
  const mode = connection.api === 'text' ? 'tc' : 'cc';
  const profile: ProfileData = { mode, exclude: [] };
  const set = (key: string, value: string | null | undefined) => {
    if (typeof value === 'string' && (value || ALLOW_EMPTY.includes(key))) profile[key] = value;
  };
  if (mode === 'tc') {
    const text = textPrefs(connection);
    set('api', stApiName('tc', text.type));
    set('preset', pickPreset('textgen', text.presetId)?.name);
    set('api-url', text.serverUrls[text.type]);
    set('model', text.models[text.type]);
    set('sysprompt', pickPreset('sysprompt', formatting.syspromptId, 'Neutral - Chat')?.name);
    set('sysprompt-state', String(formatting.syspromptEnabled));
    set('instruct', pickPreset('instruct', formatting.instructId, 'Alpaca')?.name);
    set('context', pickPreset('context', formatting.contextId, 'Default')?.name);
    set('instruct-state', String(formatting.instructEnabled));
    set('tokenizer', stTokenizerKey(formatting.tokenizer as TextTokenizerSetting));
  } else {
    const id = connection.providerId;
    set('api', stApiName('cc', id));
    set('preset', pickPreset('openai', connection.presetId)?.name);
    set(id === 'custom' ? 'api-url' : 'proxy-url', connection.baseUrls[id]);
    set('model', connection.models[id] || getProvider(id)?.defaultModel);
  }
  set('stop-strings', chat.stoppingStrings.length ? JSON.stringify(chat.stoppingStrings) : '');
  set('start-reply-with', chat.promptBias);
  set('reasoning-template', chat.reasoningTemplate);
  if (mode === 'cc') set('prompt-post-processing', (await activePreset()).custom_prompt_post_processing);
  const secrets = mode === 'tc' ? textPrefs(connection).secretIds : connection.secretIds;
  set('secret-id', secrets[mode === 'tc' ? textPrefs(connection).type : connection.providerId]);

  // SillyTavern's field order.
  const ordered: ProfileData = { mode, exclude: [] };
  for (const key of profileFields[mode]) if (key in profile) ordered[key] = profile[key];
  return ordered;
}

/** SillyTavern's suggestion for a new profile's name: `<api> <model> - <preset>`, made unique. */
export function suggestProfileName(profile: ProfileData, taken: string[]): string {
  const base = `${profile.api ?? ''} ${profile.model ?? ''} - ${profile.preset ?? ''}`
    .replace(/\s+/g, ' ')
    .trim();
  let name = base;
  for (let i = 1; taken.includes(name); i++) name = `${base} (${i})`;
  return name;
}

/**
 * Applies a profile: the connection, presets, formatting and reply options it names. Returns the
 * fields that could not be applied (a preset or key that does not exist here).
 */
export async function applyProfile(profile: ConnectionProfile): Promise<string[]> {
  const skipped: string[] = [];
  const has = (key: string) => present(profile, key);
  const value = (key: string) => String(profile[key]);
  const connection = { ...connectionDefaults, ...settings.get('connection', connectionDefaults) };
  const secretExists = (id: string) => library.secrets.some((s) => s.id === id);

  if (profile.mode === 'tc') {
    const text: TextConnectionPrefs = { ...textPrefs(connection) };
    const type = has('api') ? fromStApiName('tc', value('api')) : text.type;
    if (!type) skipped.push('api');
    text.type = type ?? text.type;
    if (has('preset')) {
      const preset = presetByName('textgen', value('preset'));
      if (preset) {
        text.presetId = preset.id;
        // Selecting a preset also takes its context size and response length.
        const data = (await api.getPreset(preset.id)).data;
        if (typeof data.genamt === 'number') text.maxResponse = data.genamt;
        if (typeof data.max_length === 'number') text.maxContext = data.max_length;
      } else skipped.push('preset');
    }
    if (has('api-url')) text.serverUrls = { ...text.serverUrls, [text.type]: value('api-url') };
    if (has('model')) text.models = { ...text.models, [text.type]: value('model') };
    if (has('secret-id')) {
      if (secretExists(value('secret-id')))
        text.secretIds = { ...text.secretIds, [text.type]: value('secret-id') };
      else skipped.push('secret-id');
    }
    settings.update('connection', { api: 'text', text });

    const formatting: Partial<FormattingPrefs> = {};
    const template = (key: string, kind: string, field: 'instructId' | 'contextId' | 'syspromptId') => {
      if (!has(key)) return;
      const preset = presetByName(kind, value(key));
      if (preset) formatting[field] = preset.id;
      else skipped.push(key);
    };
    if (has('instruct-state')) formatting.instructEnabled = value('instruct-state') === 'true';
    template('instruct', 'instruct', 'instructId');
    template('context', 'context', 'contextId');
    if (has('sysprompt-state')) formatting.syspromptEnabled = value('sysprompt-state') === 'true';
    template('sysprompt', 'sysprompt', 'syspromptId');
    if (has('tokenizer')) {
      const tokenizer = fromStTokenizerKey(value('tokenizer'));
      if (tokenizer) formatting.tokenizer = tokenizer;
      else skipped.push('tokenizer');
    }
    settings.update('formatting', formatting);
  } else {
    const providerId = (has('api') ? fromStApiName('cc', value('api')) : undefined) ?? connection.providerId;
    if (has('api') && providerId !== fromStApiName('cc', value('api'))) skipped.push('api');
    const patch = {
      api: 'chat' as const,
      providerId,
      presetId: connection.presetId,
      baseUrls: { ...connection.baseUrls },
      models: { ...connection.models },
      secretIds: { ...connection.secretIds },
    };
    if (has('preset')) {
      const preset = presetByName('openai', value('preset'));
      if (preset) patch.presetId = preset.id;
      else skipped.push('preset');
    }
    if (has('api-url') && providerId === 'custom') patch.baseUrls.custom = value('api-url');
    if (has('proxy-url')) patch.baseUrls[providerId] = value('proxy-url');
    if (has('model')) patch.models[providerId] = value('model');
    if (has('secret-id')) {
      if (secretExists(value('secret-id'))) patch.secretIds[providerId] = value('secret-id');
      else skipped.push('secret-id');
    }
    settings.update('connection', patch);
    // Post-processing belongs to the preset here (SillyTavern binds it to the connection).
    if (has('prompt-post-processing')) {
      const info = pickPreset('openai', patch.presetId);
      if (info) {
        const preset = await api.getPreset(info.id);
        if (preset.data.custom_prompt_post_processing !== value('prompt-post-processing')) {
          const updated = await api.updatePreset(preset.id, {
            data: { ...preset.data, custom_prompt_post_processing: value('prompt-post-processing') },
            rev: preset.rev,
          });
          library.presets = library.presets.map((p) =>
            p.id === updated.id ? { ...p, rev: updated.rev } : p,
          );
          invalidatePreset();
        }
      }
    }
  }

  const chat: Partial<ChatPrefs> = {};
  if (has('stop-strings')) {
    try {
      const list = value('stop-strings') ? (JSON.parse(value('stop-strings')) as unknown) : [];
      chat.stoppingStrings = Array.isArray(list)
        ? list.filter((s): s is string => typeof s === 'string')
        : [];
    } catch {
      skipped.push('stop-strings');
    }
  }
  if (has('start-reply-with')) chat.promptBias = value('start-reply-with');
  if (has('reasoning-template')) {
    const preset = presetByName('reasoning', value('reasoning-template'));
    if (preset) {
      const data = (await api.getPreset(preset.id)).data;
      Object.assign(chat, {
        reasoningTemplate: preset.name,
        reasoningPrefix: String(data.prefix ?? ''),
        reasoningSuffix: String(data.suffix ?? ''),
        reasoningSeparator: String(data.separator ?? ''),
      });
    } else skipped.push('reasoning-template');
  }
  settings.update('chat', chat);
  settings.update('profiles', { selected: profile.id });
  return skipped;
}
