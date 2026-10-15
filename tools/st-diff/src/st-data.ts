/**
 * Writes a scenario as a SillyTavern user data directory (settings, character card, chat file,
 * lorebooks), so SillyTavern starts up with exactly the scenario's state.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { stringHash } from '@bakatavern/core';

import {
  basePreset,
  defaultModels,
  personaDefaults,
  stWorldInfoDefaults,
  type PersonaFields,
  type Scenario,
  type ScenarioMessage,
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
  return { ...defaultPreset, ...basePreset, ...scenario.preset };
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
      extra: {},
    };
    if (!m.user) {
      Object.assign(message, {
        swipe_id: 0,
        swipes: [m.mes],
        swipe_info: [{ send_date: SEND_DATE, extra: {} }],
      });
    }
    return message;
  });
  return [header, ...lines].map((line) => JSON.stringify(line)).join('\n');
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
) {
  const user = join(dataRoot, 'default-user');
  const avatar = `${scenario.card.name}.png`;
  for (const dir of ['characters', `chats/${scenario.card.name}`, 'worlds']) {
    mkdirSync(join(user, dir), { recursive: true });
  }

  writeFileSync(join(user, 'characters', avatar), cardPng(stCard(scenario)));
  writeFileSync(join(user, 'chats', scenario.card.name, `${CHAT_NAME}.jsonl`), chatJsonl(scenario));
  for (const [name, entries] of Object.entries(scenario.worldInfo?.books ?? {})) {
    const book = { entries: Object.fromEntries(entries.map((e) => [String(e.uid), e])) };
    writeFileSync(join(user, 'worlds', `${name}.json`), JSON.stringify(book, null, 2));
  }

  const preset = scenarioPreset(defaultPreset, scenario);
  const oai: Record<string, unknown> = { ...(baseSettings.oai_settings as Record<string, unknown>) };
  for (const [key, value] of Object.entries(preset)) oai[PRESET_TO_SETTINGS[key] ?? key] = value;
  const provider = scenario.provider ?? 'custom';
  const model = defaultModels[provider];
  Object.assign(oai, {
    preset_settings_openai: 'Default',
    chat_completion_source: provider,
    stream_openai: false,
  });
  if (provider === 'custom') Object.assign(oai, { custom_url: mockUrl, custom_model: model });
  // Claude and Google go through a reverse proxy. SillyTavern applies the selected proxy preset
  // over `reverse_proxy` when it loads, so the proxy is defined as a preset.
  let proxy: { name: string; url: string; password: string } | undefined;
  if (provider === 'claude') {
    Object.assign(oai, { claude_model: model });
    proxy = { name: 'st-diff', url: mockUrl, password: 'st-diff' };
  }
  if (provider === 'makersuite') {
    Object.assign(oai, { google_model: model });
    proxy = { name: 'st-diff', url: new URL(mockUrl).origin, password: 'st-diff' };
  }
  if (proxy) Object.assign(oai, { reverse_proxy: proxy.url, proxy_password: proxy.password });

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
  });

  const settings = {
    ...baseSettings,
    ...(proxy
      ? {
          proxies: [{ name: 'None', url: '', password: '' }, proxy],
          selected_proxy: proxy,
          // Skip the "Connecting To Proxy" confirmation, as if it had been answered before.
          accountStorage: {
            ...(baseSettings.accountStorage as Record<string, unknown> | undefined),
            [`Proxy_SkipConfirm_${stringHash(proxy.url)}`]: 'true',
          },
        }
      : {}),
    firstRun: false,
    main_api: 'openai',
    username: persona.name,
    user_avatar: 'user-default.png',
    power_user: powerUser,
    oai_settings: oai,
    world_info_settings: {
      ...(baseSettings.world_info_settings as Record<string, unknown>),
      ...stWorldInfoDefaults,
      ...scenario.worldInfo?.settings,
      world_info: { globalSelect: scenario.worldInfo?.global ?? [] },
    },
  };
  writeFileSync(join(user, 'settings.json'), JSON.stringify(settings, null, 2));
}
