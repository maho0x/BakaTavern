/**
 * Applying SillyTavern's settings after an import. The server imports files and keeps
 * SillyTavern's `settings.json` in the `st_import` settings document, with the ids it gave the
 * imported characters, personas, lorebooks, presets and keys; this module maps those settings
 * onto BakaTavern's settings namespaces.
 */

import {
  getProvider,
  getTextgenType,
  migrateRegexScript,
  providerOrigins,
  stTokenizerIds,
  stTokenizerNumber,
  textgenOrigins,
  textgenPresetExcludedKeys,
  textgenTypes,
  uuidv4,
  type LogitBiasEntry,
  type RegexScript,
  type TextTokenizerSetting,
} from '@bakatavern/core';

import {
  chatDefaults,
  formattingDefaults,
  noteDefaults,
  textConnectionDefaults,
  worldInfoDefaults,
  type ChatPrefs,
  type ConnectionPrefs,
  type FormattingPrefs,
  type LogitBiasPrefs,
  type NotePrefs,
  type PersonaPrefs,
  type RegexPrefs,
  type TextConnectionPrefs,
  type WorldInfoPrefs,
} from '../state/prefs.ts';
import type { ConnectionProfile, ProfilePrefs } from '../state/profiles.ts';

/** The `st_import` settings document written by the server. */
export interface StImportStash {
  settings: Record<string, unknown>;
  /** SillyTavern avatar file → character id. */
  characters: Record<string, string>;
  /** Persona avatar file → persona id. */
  personas: Record<string, string>;
  /** Lorebook name → id. */
  lorebooks: Record<string, string>;
  /** `kind/name` → preset id. */
  presets: Record<string, string>;
  /** Imported keys; `stId` is SillyTavern's id for the key, which profiles refer to. */
  secrets: { id: string; provider: string; active: boolean; stId?: string | null }[];
  importedAt: number;
}

type Json = Record<string, unknown>;
const without = (data: Json, ...keys: string[]) =>
  Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)));
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** SillyTavern's model setting for each Chat Completion source (`getChatCompletionModel`). */
const MODEL_SETTINGS: Record<string, string> = {
  openai: 'openai_model',
  claude: 'claude_model',
  makersuite: 'google_model',
  openrouter: 'openrouter_model',
  ai21: 'ai21_model',
  mistralai: 'mistralai_model',
  custom: 'custom_model',
  cohere: 'cohere_model',
  perplexity: 'perplexity_model',
  groq: 'groq_model',
  siliconflow: 'siliconflow_model',
  minimax: 'minimax_model',
  electronhub: 'electronhub_model',
  chutes: 'chutes_model',
  nanogpt: 'nanogpt_model',
  deepseek: 'deepseek_model',
  aimlapi: 'aimlapi_model',
  xai: 'xai_model',
  pollinations: 'pollinations_model',
  cometapi: 'cometapi_model',
  moonshot: 'moonshot_model',
  fireworks: 'fireworks_model',
  zai: 'zai_model',
};

/** Sources whose reverse proxy SillyTavern honours (the proxy URL becomes the base URL). */
const PROXY_SOURCES = ['claude', 'openai', 'mistralai', 'makersuite', 'deepseek', 'xai', 'zai', 'moonshot'];

const SOURCE_OPTION_KEYS: Record<string, string[]> = {
  openrouter: [
    'openrouter_use_fallback',
    'openrouter_providers',
    'openrouter_quantizations',
    'openrouter_allow_fallbacks',
    'openrouter_middleout',
  ],
  nanogpt: ['nanogpt_provider', 'nanogpt_payg_override'],
};

/** A template or preset as SillyTavern used it (its settings may differ from the saved file). */
export interface StTemplateWrite {
  name: string;
  data: Record<string, unknown>;
}

/** Text Completion settings that belong to the connection rather than to presets. */
const TEXT_OPTION_KEYS = [
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'include_reasoning',
  'global_banned_tokens',
  'send_banned_tokens',
];

export interface StSettingsPatch {
  connection: Partial<Omit<ConnectionPrefs, 'text'>> & { text?: Partial<TextConnectionPrefs> };
  formatting: Partial<FormattingPrefs>;
  logitbias: Partial<LogitBiasPrefs>;
  profiles: Partial<ProfilePrefs>;
  /** Templates and the Text Completion preset in effect, to be saved under their names. */
  templates: {
    instruct?: StTemplateWrite;
    context?: StTemplateWrite;
    sysprompt?: StTemplateWrite;
    textgen?: StTemplateWrite;
  };
  chat: Partial<ChatPrefs>;
  worldinfo: Partial<WorldInfoPrefs>;
  note: Partial<NotePrefs>;
  persona: Partial<PersonaPrefs>;
  regex: Partial<RegexPrefs>;
  variables: Record<string, unknown>;
  /** Imported keys and the addresses they may be sent to. */
  secretOrigins: { id: string; origins: string[] }[];
}

/** Maps SillyTavern's settings (and the ids of the imported data) onto BakaTavern settings. */
export function mapStSettings(stash: StImportStash, current: { regex: RegexPrefs }): StSettingsPatch {
  const st = obj(stash.settings);
  const oai = obj(st.oai_settings);
  const power = obj(st.power_user);
  const extensions = obj(st.extension_settings);
  const characterId = (avatar: unknown) => stash.characters[str(avatar)];

  // Connection: source, models, Custom URL, reverse proxy, endpoints, keys, preset.
  const source = str(oai.chat_completion_source);
  const models: Record<string, string> = {};
  for (const [id, key] of Object.entries(MODEL_SETTINGS)) {
    const model = str(oai[key]);
    if (model && model !== 'OR_Website') models[id] = model;
  }
  const baseUrls: Record<string, string> = {};
  if (str(oai.custom_url)) baseUrls.custom = str(oai.custom_url);
  if (str(oai.reverse_proxy) && PROXY_SOURCES.includes(source)) baseUrls[source] = str(oai.reverse_proxy);
  const endpoints: Record<string, string> = {};
  for (const id of ['zai', 'siliconflow', 'minimax', 'pollinations']) {
    const endpoint = str(oai[`${id}_endpoint`]);
    if (endpoint) endpoints[id] = endpoint;
  }
  const secretIds: Record<string, string> = {};
  for (const secret of stash.secrets) {
    if (secret.active || !secretIds[secret.provider]) secretIds[secret.provider] = secret.id;
  }
  const sourceSettings: Record<string, Record<string, unknown>> = {};
  for (const [id, keys] of Object.entries(SOURCE_OPTION_KEYS)) {
    const options = Object.fromEntries(keys.filter((k) => k in oai).map((k) => [k, oai[k]]));
    if (Object.keys(options).length) sourceSettings[id] = options;
  }
  const presetId = stash.presets[`openai/${str(oai.preset_settings_openai)}`];
  const connection: StSettingsPatch['connection'] = {
    ...(source && getProvider(source) ? { providerId: source } : {}),
    models,
    baseUrls,
    endpoints,
    secretIds,
    sourceSettings,
    customBody: {
      include: str(oai.custom_include_body),
      exclude: str(oai.custom_exclude_body),
      headers: str(oai.custom_include_headers),
    },
    ...(presetId ? { presetId } : {}),
  };

  // Text Completion: backend, addresses, models, keys and samplers.
  const tg = obj(st.textgenerationwebui_settings);
  const textType = getTextgenType(str(tg.type)) ? str(tg.type) : textConnectionDefaults.type;
  const textModels: Record<string, string> = {};
  for (const type of textgenTypes) {
    const model = type.modelSetting ? str(tg[type.modelSetting]) : '';
    if (model) textModels[type.id] = model;
  }
  const serverUrls = Object.fromEntries(
    Object.entries(obj(tg.server_urls)).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && !!e[1],
    ),
  );
  const textPresetName = str(tg.preset) || 'Imported';
  const text: Partial<TextConnectionPrefs> = {
    type: textType,
    serverUrls,
    models: textModels,
    secretIds,
    streaming: bool(tg.streaming, textConnectionDefaults.streaming),
    maxContext: num(st.max_context, textConnectionDefaults.maxContext),
    maxResponse: num(st.amount_gen, textConnectionDefaults.maxResponse),
    settings: Object.fromEntries(TEXT_OPTION_KEYS.filter((k) => k in tg).map((k) => [k, tg[k]])),
  };
  const textPreset: Json = { ...tg, genamt: text.maxResponse, max_length: text.maxContext };
  for (const key of [...textgenPresetExcludedKeys, 'preset', 'stopping_strings', 'server_urls'])
    delete textPreset[key];
  if (str(st.main_api)) connection.api = st.main_api === 'textgenerationwebui' ? 'text' : 'chat';
  connection.text = text;

  // Advanced formatting: templates in effect and power user options.
  const instruct = obj(power.instruct);
  const context = obj(power.context);
  const sysprompt = obj(power.sysprompt);
  const templates: StSettingsPatch['templates'] = {};
  if (Object.keys(instruct).length) {
    const name = str(instruct.preset) || str(instruct.name) || 'Imported';
    templates.instruct = {
      name,
      data: { ...without(instruct, 'enabled', 'preset', 'bind_to_context'), name },
    };
  }
  if (Object.keys(context).length) {
    const name = str(context.preset) || str(context.name) || 'Imported';
    templates.context = {
      name,
      data: {
        ...without(context, 'preset'),
        // SillyTavern keeps these with the other power user options.
        always_force_name2: bool(power.always_force_name2, true),
        trim_sentences: bool(power.trim_sentences, false),
        single_line: bool(power.single_line, false),
        name,
      },
    };
  }
  if (Object.keys(sysprompt).length) {
    const name = str(sysprompt.name) || 'Imported';
    templates.sysprompt = { name, data: { ...without(sysprompt, 'enabled'), name } };
  }
  if (Object.keys(tg).length) templates.textgen = { name: textPresetName, data: textPreset };
  const formatting: Partial<FormattingPrefs> = {
    instructEnabled: bool(instruct.enabled, formattingDefaults.instructEnabled),
    bindToContext: bool(instruct.bind_to_context, formattingDefaults.bindToContext),
    syspromptEnabled: bool(sysprompt.enabled, formattingDefaults.syspromptEnabled),
    preferCharacterPrompt: bool(power.prefer_character_prompt, formattingDefaults.preferCharacterPrompt),
    preferCharacterJailbreak: bool(
      power.prefer_character_jailbreak,
      formattingDefaults.preferCharacterJailbreak,
    ),
    collapseNewlines: bool(power.collapse_newlines, formattingDefaults.collapseNewlines),
    trimSpaces: bool(power.trim_spaces, formattingDefaults.trimSpaces),
    tokenPadding: num(power.token_padding, formattingDefaults.tokenPadding),
    pinExamples: bool(power.pin_examples, formattingDefaults.pinExamples),
    stripExamples: bool(power.strip_examples, formattingDefaults.stripExamples),
    tokenizer: stTokenizerIds[num(power.tokenizer, 99)] ?? formattingDefaults.tokenizer,
  };

  // Chat: "start reply with", stop strings, reasoning.
  let stoppingStrings: string[] = [];
  try {
    const parsed = JSON.parse(str(power.custom_stopping_strings, '[]')) as unknown;
    if (Array.isArray(parsed))
      stoppingStrings = parsed.filter((s): s is string => typeof s === 'string' && !!s);
  } catch {
    // keep none
  }
  const reasoning = obj(power.reasoning);
  const chat: Partial<ChatPrefs> = {
    promptBias: str(power.user_prompt_bias),
    stoppingStrings,
    reasoningAutoParse: bool(reasoning.auto_parse, chatDefaults.reasoningAutoParse),
    reasoningTemplate: str(reasoning.name, chatDefaults.reasoningTemplate),
    reasoningAddToPrompts: bool(reasoning.add_to_prompts, chatDefaults.reasoningAddToPrompts),
    reasoningMaxAdditions: num(reasoning.max_additions, chatDefaults.reasoningMaxAdditions),
    reasoningPrefix: str(reasoning.prefix, chatDefaults.reasoningPrefix),
    reasoningSuffix: str(reasoning.suffix, chatDefaults.reasoningSuffix),
    reasoningSeparator: str(reasoning.separator, chatDefaults.reasoningSeparator),
  };

  // World Info: activation settings, global books, characters' extra books.
  const wi = obj(st.world_info_settings);
  const d = worldInfoDefaults.settings;
  const lore = obj(wi.world_info);
  const characterExtraBooks: Record<string, string[]> = {};
  for (const entry of Array.isArray(lore.charLore) ? lore.charLore : []) {
    const id = characterId(obj(entry).name);
    const books = obj(entry).extraBooks;
    if (id && Array.isArray(books)) characterExtraBooks[id] = books.map(String);
  }
  const worldinfo: Partial<WorldInfoPrefs> = {
    settings: {
      depth: num(wi.world_info_depth, d.depth),
      minActivations: num(wi.world_info_min_activations, d.minActivations),
      minActivationsDepthMax: num(wi.world_info_min_activations_depth_max, d.minActivationsDepthMax),
      budget: num(wi.world_info_budget, d.budget),
      budgetCap: num(wi.world_info_budget_cap, d.budgetCap),
      includeNames: bool(wi.world_info_include_names, d.includeNames),
      recursive: bool(wi.world_info_recursive, d.recursive),
      maxRecursionSteps: num(wi.world_info_max_recursion_steps, d.maxRecursionSteps),
      caseSensitive: bool(wi.world_info_case_sensitive, d.caseSensitive),
      matchWholeWords: bool(wi.world_info_match_whole_words, d.matchWholeWords),
      useGroupScoring: bool(wi.world_info_use_group_scoring, d.useGroupScoring),
      characterStrategy: num(wi.world_info_character_strategy, d.characterStrategy),
      overflowAlert: bool(wi.world_info_overflow_alert, d.overflowAlert),
    },
    globalBooks: Array.isArray(lore.globalSelect) ? lore.globalSelect.map(String) : [],
    characterExtraBooks,
  };

  // Author's Note defaults and character notes.
  const noteSettings = obj(extensions.note);
  const characterNotes: NotePrefs['characterNotes'] = {};
  for (const entry of Array.isArray(noteSettings.chara) ? noteSettings.chara : []) {
    const e = obj(entry);
    const id = characterId(e.name);
    if (id)
      characterNotes[id] = {
        prompt: str(e.prompt),
        position: num(e.position, 0),
        enabled: bool(e.useChara, false),
      };
  }
  const note: Partial<NotePrefs> = {
    allowWIScan: bool(noteSettings.allowWIScan, noteDefaults.allowWIScan),
    defaultPrompt: str(noteSettings.default),
    defaultInterval: num(noteSettings.defaultInterval, noteDefaults.defaultInterval),
    defaultPosition: num(noteSettings.defaultPosition, noteDefaults.defaultPosition),
    defaultDepth: num(noteSettings.defaultDepth, noteDefaults.defaultDepth),
    defaultRole: num(noteSettings.defaultRole, noteDefaults.defaultRole),
    characterNotes,
  };

  // Personas locked to characters.
  const characterPersona: Record<string, string> = {};
  for (const [avatar, description] of Object.entries(obj(power.persona_descriptions))) {
    const personaId = stash.personas[avatar];
    const connections = obj(description).connections;
    if (!personaId || !Array.isArray(connections)) continue;
    for (const connection of connections) {
      const c = obj(connection);
      const id = c.type === 'character' ? characterId(c.id) : undefined;
      if (id) characterPersona[id] = personaId;
    }
  }

  // Regex scripts and which embedded ones may run (added after any scripts already here).
  const imported = (Array.isArray(extensions.regex) ? extensions.regex : []).map((s) =>
    migrateRegexScript(s as Partial<RegexScript>, uuidv4),
  );
  const known = new Set(current.regex.scripts.map((s) => s.id));
  const allowedCharacters = (
    Array.isArray(extensions.character_allowed_regex) ? extensions.character_allowed_regex : []
  )
    .map((avatar) => characterId(avatar))
    .filter((id): id is string => !!id);
  const allowedPresets = Object.entries(obj(extensions.preset_allowed_regex)).flatMap(([api, names]) =>
    (Array.isArray(names) ? names : [])
      .map((name) => stash.presets[`${api}/${str(name)}`])
      .filter((id): id is string => !!id),
  );
  const regex: Partial<RegexPrefs> = {
    scripts: [...current.regex.scripts, ...imported.filter((s) => !known.has(s.id))],
    allowedCharacters: [...new Set([...current.regex.allowedCharacters, ...allowedCharacters])],
    allowedPresets: [...new Set([...current.regex.allowedPresets, ...allowedPresets])],
  };

  // Global variables (SillyTavern keeps them as JSON strings).
  const variables: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(obj(obj(extensions.variables).global))) {
    try {
      variables[name] = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      variables[name] = value;
    }
  }

  // Imported keys may be sent to their provider (or the Custom URL / reverse proxy in use), and
  // Text Completion keys to their backend's server.
  const secretOrigins = stash.secrets.flatMap((secret) => {
    const provider = getProvider(secret.provider);
    const type = getTextgenType(secret.provider);
    const origins = [
      ...(provider ? providerOrigins(provider, baseUrls[secret.provider]) : []),
      ...(type ? textgenOrigins(type, serverUrls[secret.provider]) : []),
    ];
    return origins.length ? [{ id: secret.id, origins: [...new Set(origins)] }] : [];
  });

  // Logit bias lists (the presets name the one they use).
  const lists: Record<string, LogitBiasEntry[]> = {};
  for (const [name, entries] of Object.entries(obj(oai.bias_presets))) {
    if (!Array.isArray(entries)) continue;
    lists[name] = entries
      .map((e) => obj(e))
      .map((e) => ({ id: str(e.id) || uuidv4(), text: str(e.text), value: num(e.value, 0) }));
  }

  // Connection profiles: proxy presets become addresses, keys BakaTavern's ids.
  const manager = obj(extensions.connectionManager);
  const proxies = Array.isArray(st.proxies) ? st.proxies.map(obj) : [];
  const keys = new Map(stash.secrets.filter((k) => k.stId).map((k) => [k.stId, k.id]));
  const profiles: ConnectionProfile[] = (Array.isArray(manager.profiles) ? manager.profiles : [])
    .map(obj)
    .filter((p) => str(p.id) && str(p.name) && (p.mode === 'cc' || p.mode === 'tc'))
    .map((p) => {
      const profile = { ...p } as ConnectionProfile;
      const proxy = proxies.find((x) => str(x.name) === str(p.proxy) && str(x.url));
      if (proxy) profile['proxy-url'] = str(proxy.url);
      if (typeof p['secret-id'] === 'string') {
        const id = keys.get(p['secret-id']);
        if (id) profile['secret-id'] = id;
        else delete profile['secret-id'];
      }
      return profile;
    });
  const selectedProfile = str(manager.selectedProfile);

  return {
    connection,
    formatting,
    logitbias: Object.keys(lists).length ? { lists } : {},
    profiles: profiles.length
      ? { profiles, selected: profiles.some((p) => p.id === selectedProfile) ? selectedProfile : null }
      : {},
    templates,
    chat,
    worldinfo,
    note,
    persona: { characterPersona },
    regex,
    variables,
    secretOrigins,
  };
}

export interface StExportInput {
  /** File names the export gives characters and personas (`/api/export/st/names`). */
  names: { characters: Record<string, string>; personas: Record<string, string> };
  connection: ConnectionPrefs;
  chat: ChatPrefs;
  worldinfo: WorldInfoPrefs;
  note: NotePrefs;
  persona: PersonaPrefs;
  regex: RegexPrefs;
  variables: Record<string, unknown>;
  /** Chat Completion preset id → name. */
  presetNames: Record<string, string>;
  formatting?: FormattingPrefs;
  logitbias?: LogitBiasPrefs;
  profiles?: ProfilePrefs;
  /** The templates and Text Completion preset in effect. */
  templates?: StSettingsPatch['templates'];
}

/** BakaTavern settings as SillyTavern's `settings.json` (the reverse of `mapStSettings`). */
export function toStSettings(input: StExportInput): Record<string, unknown> {
  const { connection, chat, worldinfo, note, regex, names } = input;
  const avatar = (characterId: string) => names.characters[characterId];

  const oai: Json = {};
  if (connection.providerId) oai.chat_completion_source = connection.providerId;
  for (const [id, key] of Object.entries(MODEL_SETTINGS)) {
    if (connection.models[id]) oai[key] = connection.models[id];
  }
  if (connection.baseUrls.custom) oai.custom_url = connection.baseUrls.custom;
  const proxy = connection.baseUrls[connection.providerId];
  if (proxy && PROXY_SOURCES.includes(connection.providerId)) oai.reverse_proxy = proxy;
  for (const [id, endpoint] of Object.entries(connection.endpoints)) oai[`${id}_endpoint`] = endpoint;
  for (const options of Object.values(connection.sourceSettings ?? {})) Object.assign(oai, options);
  oai.custom_include_body = connection.customBody?.include ?? '';
  oai.custom_exclude_body = connection.customBody?.exclude ?? '';
  oai.custom_include_headers = connection.customBody?.headers ?? '';
  const preset = connection.presetId ? input.presetNames[connection.presetId] : undefined;
  if (preset) oai.preset_settings_openai = preset;
  if (input.logitbias) oai.bias_presets = input.logitbias.lists;

  const personaDescriptions: Record<string, Json> = {};
  for (const [characterId, personaId] of Object.entries(input.persona.characterPersona)) {
    const file = names.personas[personaId];
    const character = avatar(characterId);
    if (!file || !character) continue;
    const entry = (personaDescriptions[file] ??= { connections: [] });
    (entry.connections as Json[]).push({ type: 'character', id: character });
  }

  // Text Completion
  const text = { ...textConnectionDefaults, ...connection.text };
  const tg: Json = { ...input.templates?.textgen?.data, ...text.settings };
  delete tg.genamt;
  delete tg.max_length;
  Object.assign(tg, {
    type: text.type,
    server_urls: text.serverUrls,
    streaming: text.streaming,
    preset: input.templates?.textgen?.name ?? 'Default',
  });
  for (const type of textgenTypes) {
    if (type.modelSetting && text.models[type.id]) tg[type.modelSetting] = text.models[type.id];
  }
  const formatting = { ...formattingDefaults, ...input.formatting };
  const t = input.templates ?? {};
  const contextData = obj(t.context?.data);
  const formattingSettings: Json = {
    instruct: {
      ...t.instruct?.data,
      enabled: formatting.instructEnabled,
      preset: t.instruct?.name,
      bind_to_context: formatting.bindToContext,
    },
    context: {
      ...without(contextData, 'always_force_name2', 'trim_sentences', 'single_line'),
      preset: t.context?.name,
    },
    sysprompt: { ...t.sysprompt?.data, enabled: formatting.syspromptEnabled, name: t.sysprompt?.name },
    always_force_name2: bool(contextData.always_force_name2, true),
    trim_sentences: bool(contextData.trim_sentences, false),
    single_line: bool(contextData.single_line, false),
    prefer_character_prompt: formatting.preferCharacterPrompt,
    prefer_character_jailbreak: formatting.preferCharacterJailbreak,
    collapse_newlines: formatting.collapseNewlines,
    trim_spaces: formatting.trimSpaces,
    token_padding: formatting.tokenPadding,
    pin_examples: formatting.pinExamples,
    strip_examples: formatting.stripExamples,
    tokenizer: stTokenizerNumber(formatting.tokenizer as TextTokenizerSetting),
  };

  const s = worldinfo.settings;
  return {
    main_api: connection.api === 'text' ? 'textgenerationwebui' : 'openai',
    max_context: text.maxContext,
    amount_gen: text.maxResponse,
    textgenerationwebui_settings: tg,
    oai_settings: oai,
    power_user: {
      ...formattingSettings,
      user_prompt_bias: chat.promptBias,
      custom_stopping_strings: JSON.stringify(chat.stoppingStrings),
      reasoning: {
        name: chat.reasoningTemplate,
        auto_parse: chat.reasoningAutoParse,
        add_to_prompts: chat.reasoningAddToPrompts,
        max_additions: chat.reasoningMaxAdditions,
        prefix: chat.reasoningPrefix,
        suffix: chat.reasoningSuffix,
        separator: chat.reasoningSeparator,
      },
      persona_descriptions: personaDescriptions,
    },
    world_info_settings: {
      world_info: {
        globalSelect: worldinfo.globalBooks,
        charLore: Object.entries(worldinfo.characterExtraBooks)
          .filter(([id]) => avatar(id))
          .map(([id, extraBooks]) => ({ name: avatar(id), extraBooks })),
      },
      world_info_depth: s.depth,
      world_info_min_activations: s.minActivations,
      world_info_min_activations_depth_max: s.minActivationsDepthMax,
      world_info_budget: s.budget,
      world_info_budget_cap: s.budgetCap,
      world_info_include_names: s.includeNames,
      world_info_recursive: s.recursive,
      world_info_max_recursion_steps: s.maxRecursionSteps,
      world_info_case_sensitive: s.caseSensitive,
      world_info_match_whole_words: s.matchWholeWords,
      world_info_use_group_scoring: s.useGroupScoring,
      world_info_character_strategy: s.characterStrategy,
      world_info_overflow_alert: s.overflowAlert,
    },
    extension_settings: {
      regex: regex.scripts,
      character_allowed_regex: regex.allowedCharacters.map(avatar).filter(Boolean),
      preset_allowed_regex: {
        openai: regex.allowedPresets.map((id) => input.presetNames[id]).filter(Boolean),
      },
      note: {
        default: note.defaultPrompt,
        defaultInterval: note.defaultInterval,
        defaultPosition: note.defaultPosition,
        defaultDepth: note.defaultDepth,
        defaultRole: note.defaultRole,
        allowWIScan: note.allowWIScan,
        chara: Object.entries(note.characterNotes)
          .filter(([id]) => avatar(id))
          .map(([id, n]) => ({
            name: avatar(id),
            prompt: n.prompt,
            useChara: n.enabled,
            position: n.position,
          })),
      },
      variables: {
        global: Object.fromEntries(Object.entries(input.variables).map(([k, v]) => [k, JSON.stringify(v)])),
      },
      connectionManager: {
        profiles: input.profiles?.profiles ?? [],
        selectedProfile: input.profiles?.selected ?? null,
      },
    },
  };
}
