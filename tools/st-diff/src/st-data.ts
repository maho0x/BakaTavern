/**
 * Writes a scenario as a SillyTavern user data directory (settings, character card, chat file,
 * lorebooks), so SillyTavern starts up with exactly the scenario's state.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { getTextgenType, stringHash, type StTemplates } from '@bakatavern/core';

import {
  basePreset,
  scenarioModel,
  personaDefaults,
  stReasoningDefaults,
  stWorldInfoDefaults,
  type PersonaFields,
  type Scenario,
  type ScenarioMessage,
  stSources,
  stTextSecrets,
} from './scenarios.ts';

/** Preset file keys that SillyTavern stores under another name in `oai_settings`. */
const PRESET_TO_SETTINGS: Record<string, string> = {
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
  top_a: 'top_a_openai',
  min_p: 'min_p_openai',
  repetition_penalty: 'repetition_penalty_openai',
};

export const CHAT_NAME = 'Scenario - 2026-10-15@00h00m00s';
const SEND_DATE = 'October 15, 2026 12:00am';

export function scenarioPersona(scenario: Scenario): PersonaFields {
  return { ...personaDefaults, ...scenario.persona };
}

/** The preset as a SillyTavern preset file: the default preset with the scenario's overrides. */
export function scenarioPreset(
  defaultPreset: Record<string, unknown>,
  scenario: Scenario,
): Record<string, unknown> {
  const preset = { ...defaultPreset, ...basePreset, ...scenario.preset };
  if (scenario.mainPrompt !== undefined) {
    preset.prompts = (preset.prompts as { identifier: string }[]).map((p) =>
      p.identifier === 'main' ? { ...p, content: scenario.mainPrompt } : p,
    );
  }
  if (scenario.regex?.preset) {
    preset.extensions = {
      ...(preset.extensions as object | undefined),
      regex_scripts: scenario.regex.preset,
    };
  }
  return preset;
}

/** The chat as SillyTavern stores it: greeting first, then the scenario's history. */
export function scenarioChat(scenario: Scenario): ScenarioMessage[] {
  const greeting = scenario.card.first_mes ? [{ mes: scenario.card.first_mes }] : [];
  return [...greeting, ...scenario.history];
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A tiny PNG with the card in a `chara` text chunk. */
function cardPng(card: object): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 2;
  // Four rows: filter byte 0, then four grey RGB pixels.
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(4 * 3, 0x80)]);
  const pixels = deflateSync(Buffer.concat([row, row, row, row]));
  const text = Buffer.from(
    `chara\0${Buffer.from(JSON.stringify(card), 'utf8').toString('base64')}`,
    'latin1',
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', pixels),
    chunk('tEXt', text),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The card in SillyTavern's stored shape (V1 fields on top, V2 `data`). */
export function stCard(scenario: Scenario) {
  const c = scenario.card;
  const data = {
    name: c.name,
    description: c.description ?? '',
    personality: c.personality ?? '',
    scenario: c.scenario ?? '',
    first_mes: c.first_mes ?? '',
    mes_example: c.mes_example ?? '',
    creator_notes: c.creator_notes ?? '',
    system_prompt: c.system_prompt ?? '',
    post_history_instructions: c.post_history_instructions ?? '',
    alternate_greetings: c.alternate_greetings ?? [],
    tags: c.tags ?? [],
    creator: 'st-diff',
    character_version: '1',
    extensions: {
      talkativeness: '0.5',
      fav: false,
      world: '',
      depth_prompt: { prompt: '', depth: 4, role: 'system' },
      ...(scenario.regex?.character ? { regex_scripts: scenario.regex.character } : {}),
      ...c.extensions,
    },
  };
  return {
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
    creatorcomment: data.creator_notes,
    avatar: 'none',
    chat: CHAT_NAME,
    talkativeness: '0.5',
    fav: false,
    tags: data.tags,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
    create_date: '2026-10-15T00:00:00.000Z',
  };
}

function chatJsonl(scenario: Scenario): string {
  const persona = scenarioPersona(scenario);
  const header = {
    user_name: persona.name,
    character_name: scenario.card.name,
    create_date: '2026-10-15@00h00m00s',
    chat_metadata: { ...scenario.chatMetadata },
  };
  const lines = scenarioChat(scenario).map((m) => {
    const message: Record<string, unknown> = {
      name: m.name ?? (m.user ? persona.name : scenario.card.name),
      is_user: !!m.user,
      is_system: !!m.hidden,
      send_date: SEND_DATE,
      mes: m.mes,
      extra: { ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...m.extra },
    };
    if (!m.user) {
      Object.assign(message, {
        swipe_id: 0,
        swipes: [m.mes],
        swipe_info: [{ send_date: SEND_DATE, extra: message.extra }],
      });
    }
    return message;
  });
  return [header, ...lines].map((line) => JSON.stringify(line)).join('\n');
}

const findTemplate = (list: StTemplates[keyof StTemplates], name: string) => {
  const template = list.find((t) => t.name === name);
  if (!template) throw new Error(`no SillyTavern template named ${name}`);
  return template.data;
};

/**
 * A Text Completion scenario's SillyTavern settings: `textgenerationwebui_settings`, the formatting
 * templates and the power user options, as both sides of the comparison use them.
 */
export function scenarioTextSettings(scenario: Scenario, templates: StTemplates, mockOrigin: string) {
  const text = scenario.text!;
  const type = getTextgenType(text.type);
  const preset = text.preset ? findTemplate(templates.textgen, text.preset) : {};
  const settings: Record<string, unknown> = {
    ...preset,
    preset: text.preset ?? 'Default',
    type: text.type,
    server_urls: type?.server ? {} : { [text.type]: mockOrigin },
    streaming: false,
    ...(type?.modelSetting ? { [type.modelSetting]: scenarioModel(scenario) } : {}),
    ...text.settings,
  };
  const instruct = text.instruct
    ? { ...findTemplate(templates.instruct, text.instruct.name), ...text.instruct.overrides }
    : undefined;
  const contextName = text.context?.name ?? 'Default';
  const context = { ...findTemplate(templates.context, contextName), ...text.context?.overrides };
  const sysprompt = {
    name: 'Neutral - Chat',
    content: "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
    post_history: '',
    ...text.sysprompt,
    enabled: text.sysprompt?.enabled ?? true,
  };
  return {
    settings,
    instruct,
    instructName: text.instruct?.name,
    context,
    contextName,
    sysprompt,
    maxContext: text.maxContext ?? 8192,
    maxResponse: text.maxResponse ?? 300,
    power: { token_padding: 64, ...text.power },
  };
}

/**
 * Writes `<dataRoot>/default-user/...` for the scenario. `baseSettings` is SillyTavern's default
 * `settings.json`; `defaultPreset` its default Chat Completion preset file.
 */
export function writeStData(
  dataRoot: string,
  scenario: Scenario,
  baseSettings: Record<string, unknown>,
  defaultPreset: Record<string, unknown>,
  mockUrl: string,
  templates?: StTemplates,
) {
  const user = join(dataRoot, 'default-user');
  const avatar = `${scenario.card.name}.png`;
  for (const dir of ['characters', `chats/${scenario.card.name}`, 'worlds']) {
    mkdirSync(join(user, dir), { recursive: true });
  }

  writeFileSync(join(user, 'characters', avatar), cardPng(stCard(scenario)));
  writeFileSync(join(user, 'chats', scenario.card.name, `${CHAT_NAME}.jsonl`), chatJsonl(scenario));
  for (const [path, base64] of Object.entries(scenario.files ?? {})) {
    mkdirSync(join(user, dirname(path)), { recursive: true });
    writeFileSync(join(user, path), Buffer.from(base64, 'base64'));
  }
  for (const [name, entries] of Object.entries(scenario.worldInfo?.books ?? {})) {
    const book = { entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])) };
    writeFileSync(join(user, 'worlds', `${name}.json`), JSON.stringify(book, null, 2));
  }

  const preset = scenarioPreset(defaultPreset, scenario);
  const oai: Record<string, unknown> = { ...(baseSettings.oai_settings as Record<string, unknown>) };
  for (const [key, value] of Object.entries(preset)) oai[PRESET_TO_SETTINGS[key] ?? key] = value;
  const provider = scenario.provider ?? 'custom';
  const source = stSources[provider];
  Object.assign(oai, {
    preset_settings_openai: 'Default',
    chat_completion_source: provider,
    stream_openai: false,
    [source.modelSetting]: scenarioModel(scenario),
    ...scenario.sourceSettings,
  });
  if (provider === 'custom') Object.assign(oai, { custom_url: mockUrl });
  // Claude and Google go through a reverse proxy. SillyTavern applies the selected proxy preset
  // over `reverse_proxy` when it loads, so the proxy is defined as a preset.
  let proxy: { name: string; url: string; password: string } | undefined;
  if (provider === 'claude') proxy = { name: 'st-diff', url: mockUrl, password: 'st-diff' };
  if (provider === 'makersuite')
    proxy = { name: 'st-diff', url: new URL(mockUrl).origin, password: 'st-diff' };
  if (proxy) Object.assign(oai, { reverse_proxy: proxy.url, proxy_password: proxy.password });
  // Other sources call their real host (resolved to the mock) with a key from secrets.json.
  const secretKey = scenario.text ? stTextSecrets[scenario.text.type] : source.secret;
  const secrets = {
    _migrated: true,
    ...(secretKey
      ? { [secretKey]: [{ id: 'st-diff', value: 'st-diff-key', label: 'st-diff', active: true }] }
      : {}),
  };
  writeFileSync(join(user, 'secrets.json'), JSON.stringify(secrets, null, 2));

  const persona = scenarioPersona(scenario);
  const powerUser = { ...(baseSettings.power_user as Record<string, unknown>) };
  Object.assign(powerUser, {
    personas: { 'user-default.png': persona.name },
    persona_descriptions: {
      'user-default.png': {
        description: persona.description,
        position: persona.position,
        depth: persona.depth,
        role: persona.role,
        lorebook: '',
        connections: [],
        title: '',
      },
    },
    persona_description: persona.description,
    persona_description_position: persona.position,
    persona_description_depth: persona.depth,
    persona_description_role: persona.role,
    persona_description_lorebook: '',
    default_persona: null,
    auto_load_chat: false,
    custom_stopping_strings: JSON.stringify(scenario.stoppingStrings ?? []),
    custom_stopping_strings_macro: true,
    reasoning: {
      name: 'st-diff',
      auto_parse: false,
      auto_expand: false,
      show_hidden: false,
      ...stReasoningDefaults,
      ...scenario.reasoning,
    },
  });
  let textSettings: Record<string, unknown> = {};
  if (scenario.text) {
    const tc = scenarioTextSettings(scenario, templates!, new URL(mockUrl).origin);
    Object.assign(powerUser, {
      instruct: tc.instruct
        ? { ...tc.instruct, enabled: true, preset: tc.instructName }
        : { ...(powerUser.instruct as object), enabled: false },
      context: { ...tc.context, preset: tc.contextName },
      sysprompt: tc.sysprompt,
      // SillyTavern keeps these context template options at the top level.
      always_force_name2: tc.context.always_force_name2 ?? true,
      trim_sentences: tc.context.trim_sentences ?? false,
      single_line: tc.context.single_line ?? false,
      // The estimate both sides share (no tokenizer server).
      tokenizer: 0,
      ...tc.power,
    });
    textSettings = {
      main_api: 'textgenerationwebui',
      max_context: tc.maxContext,
      amount_gen: tc.maxResponse,
      textgenerationwebui_settings: tc.settings,
    };
  }
  const regex = scenario.regex;
  const extensionSettings = {
    ...(baseSettings.extension_settings as Record<string, unknown>),
    regex: regex?.global ?? [],
    character_allowed_regex: regex?.characterAllowed ? [avatar] : [],
    preset_allowed_regex: regex?.presetAllowed ? { openai: ['Default'] } : {},
  };

  // Questions SillyTavern asks once, marked as answered so that nothing waits for a click: the
  // "Connecting To Proxy" confirmation and the "allow embedded regex scripts" prompts.
  const accountStorage: Record<string, unknown> = {
    ...(baseSettings.accountStorage as Record<string, unknown> | undefined),
    [`AlertRegex_${avatar}`]: 'true',
    AlertRegex_openai_Default: 'true',
  };
  if (proxy) accountStorage[`Proxy_SkipConfirm_${stringHash(proxy.url)}`] = 'true';
  const settings = {
    ...baseSettings,
    accountStorage,
    ...(proxy ? { proxies: [{ name: 'None', url: '', password: '' }, proxy], selected_proxy: proxy } : {}),
    firstRun: false,
    main_api: 'openai',
    username: persona.name,
    user_avatar: 'user-default.png',
    power_user: powerUser,
    extension_settings: extensionSettings,
    oai_settings: oai,
    world_info_settings: {
      ...(baseSettings.world_info_settings as Record<string, unknown>),
      ...stWorldInfoDefaults,
      ...scenario.worldInfo?.settings,
      world_info: { globalSelect: scenario.worldInfo?.global ?? [] },
    },
    ...textSettings,
  };
  writeFileSync(join(user, 'settings.json'), JSON.stringify(settings, null, 2));
}
