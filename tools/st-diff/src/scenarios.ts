/**
 * Differential test scenarios. Each one is run through SillyTavern 1.19 (recorded into
 * `baseline/<id>.json` by `pnpm record`) and through BakaTavern's core; the requests sent to the
 * model must match.
 */

import {
  collectEntries,
  createEntry,
  newRegexScript,
  toolInvocationsText,
  type RegexScript,
  type ToolDefinition,
  type ToolInvocation,
  type WorldInfoEntry,
} from '@bakatavern/core';

export type ScenarioType = 'normal' | 'continue' | 'impersonate' | 'swipe' | 'quiet' | 'raw';

/** Character card fields (`data` of a V2 card). */
export interface CardFields {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  creator_notes?: string;
  alternate_greetings?: string[];
  tags?: string[];
  extensions?: Record<string, unknown>;
}

export interface ScenarioMessage {
  /** Defaults to the persona name for user messages and the character name otherwise. */
  name?: string;
  user?: boolean;
  mes: string;
  /** Excluded from the prompt (`is_system`). */
  hidden?: boolean;
  /** Reasoning of a reply (`extra.reasoning`). */
  reasoning?: string;
  /** Other `extra` fields (attachments: `media`, `files`, ...). */
  extra?: Record<string, unknown>;
}

/** A group chat: the scenario's `card` replies, the other members are listed here. */
export interface ScenarioGroup {
  members: CardFields[];
  /** Where the replying card stands among the members (0 = first). */
  speakerIndex?: number;
  /** Names of muted members. */
  muted?: string[];
  /** SillyTavern `generation_mode`: 0 swap, 1 append, 2 append with muted members. */
  generationMode?: number;
  joinPrefix?: string;
  joinSuffix?: string;
}

/** Every member of a group scenario, in group order. */
export function groupMembers(scenario: Scenario): CardFields[] {
  const group = scenario.group;
  if (!group) return [scenario.card];
  const members = [...group.members];
  members.splice(group.speakerIndex ?? 0, 0, scenario.card);
  return members;
}

export interface PersonaFields {
  name: string;
  description: string;
  /** SillyTavern `persona_description_positions`: 0 prompt, 2 top AN, 3 bottom AN, 4 depth, 9 none. */
  position: number;
  depth: number;
  /** 0 system, 1 user, 2 assistant. */
  role: number;
}

/** SillyTavern `world_info_settings` keys. */
export interface StWorldInfoSettings {
  world_info_depth: number;
  world_info_min_activations: number;
  world_info_min_activations_depth_max: number;
  world_info_budget: number;
  world_info_budget_cap: number;
  world_info_include_names: boolean;
  world_info_recursive: boolean;
  world_info_max_recursion_steps: number;
  world_info_case_sensitive: boolean;
  world_info_match_whole_words: boolean;
  world_info_use_group_scoring: boolean;
  world_info_character_strategy: number;
  world_info_overflow_alert: boolean;
}

/**
 * Chat Completion sources the scenarios can use: the model, SillyTavern's setting for it and the
 * key in `secrets.json`. Custom talks to the mock directly; Claude and Google AI Studio go through
 * a reverse proxy; every other source keeps its real host, which the recorder points at the mock.
 */
export const stSources = {
  custom: { model: 'mock-model', modelSetting: 'custom_model', secret: 'api_key_custom' },
  claude: { model: 'claude-sonnet-4-5', modelSetting: 'claude_model', secret: 'api_key_claude' },
  makersuite: { model: 'gemini-2.5-flash', modelSetting: 'google_model', secret: 'api_key_makersuite' },
  openai: { model: 'gpt-4.1', modelSetting: 'openai_model', secret: 'api_key_openai' },
  openrouter: {
    model: 'mistralai/mistral-large',
    modelSetting: 'openrouter_model',
    secret: 'api_key_openrouter',
  },
  deepseek: { model: 'deepseek-chat', modelSetting: 'deepseek_model', secret: 'api_key_deepseek' },
  mistralai: { model: 'mistral-large-latest', modelSetting: 'mistralai_model', secret: 'api_key_mistralai' },
  xai: { model: 'grok-3', modelSetting: 'xai_model', secret: 'api_key_xai' },
  groq: { model: 'llama-3.3-70b-versatile', modelSetting: 'groq_model', secret: 'api_key_groq' },
  cohere: { model: 'command-r-plus', modelSetting: 'cohere_model', secret: 'api_key_cohere' },
  perplexity: { model: 'sonar', modelSetting: 'perplexity_model', secret: 'api_key_perplexity' },
  moonshot: { model: 'kimi-k2-0905-preview', modelSetting: 'moonshot_model', secret: 'api_key_moonshot' },
  zai: { model: 'glm-4.6', modelSetting: 'zai_model', secret: 'api_key_zai' },
  siliconflow: {
    model: 'deepseek-ai/DeepSeek-V3',
    modelSetting: 'siliconflow_model',
    secret: 'api_key_siliconflow',
  },
  minimax: { model: 'MiniMax-M2', modelSetting: 'minimax_model', secret: 'api_key_minimax' },
  fireworks: {
    model: 'accounts/fireworks/models/kimi-k2-instruct',
    modelSetting: 'fireworks_model',
    secret: 'api_key_fireworks',
  },
  chutes: { model: 'deepseek-ai/DeepSeek-V3-0324', modelSetting: 'chutes_model', secret: 'api_key_chutes' },
  nanogpt: { model: 'chatgpt-4o-latest', modelSetting: 'nanogpt_model', secret: 'api_key_nanogpt' },
  electronhub: { model: 'gpt-4o', modelSetting: 'electronhub_model', secret: 'api_key_electronhub' },
  aimlapi: { model: 'gpt-4o', modelSetting: 'aimlapi_model', secret: 'api_key_aimlapi' },
  pollinations: { model: 'openai', modelSetting: 'pollinations_model', secret: 'api_key_pollinations' },
  ai21: { model: 'jamba-large', modelSetting: 'ai21_model', secret: 'api_key_ai21' },
} as const;

export type ScenarioProvider = keyof typeof stSources;

/** Hosts of the sources with fixed endpoints (the recorder resolves them to the mock). */
export const interceptedHosts = [
  'api.openai.com',
  'openrouter.ai',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.x.ai',
  'api.groq.com',
  'api.cohere.ai',
  'api.perplexity.ai',
  'api.moonshot.ai',
  'api.z.ai',
  'api.siliconflow.com',
  'api.minimax.io',
  'api.fireworks.ai',
  'llm.chutes.ai',
  'nano-gpt.com',
  'api.electronhub.ai',
  'api.aimlapi.com',
  'gen.pollinations.ai',
  'api.ai21.com',
  // Text Completion
  'api.together.xyz',
  'api.totalgpt.ai',
  'dreamgen.com',
  'api.featherless.ai',
  'neuro.mancer.tech',
];

/** A Text Completion scenario: backend, settings and SillyTavern's formatting templates. */
export interface TextScenario {
  /** SillyTavern `textgen_types` value. */
  type: string;
  /** One of SillyTavern's Text Completion presets to start from (built-in defaults otherwise). */
  preset?: string;
  /** Overrides of `textgenerationwebui_settings`. */
  settings?: Record<string, unknown>;
  model?: string;
  /** Instruct template (one of SillyTavern's) with overrides; instruct mode is off without one. */
  instruct?: { name: string; overrides?: Record<string, unknown> };
  /** Context template, `Default` unless given. */
  context?: { name: string; overrides?: Record<string, unknown> };
  /** System prompt; SillyTavern's default (enabled, "Neutral - Chat") unless given. */
  sysprompt?: { enabled: boolean; name?: string; content?: string; post_history?: string };
  maxContext?: number;
  maxResponse?: number;
  /** Other `power_user` options (`pin_examples`, `user_prompt_bias`, ...). */
  power?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  title: string;
  /** Text Completion instead of Chat Completion. */
  text?: TextScenario;
  /** Defaults to `custom`. */
  provider?: ScenarioProvider;
  card: CardFields;
  /** A group chat with the card as the member who replies. */
  group?: ScenarioGroup;
  /** `quiet`: a background generation (SillyTavern `generateQuietPrompt`). */
  quiet?: { prompt: string; quietToLoud?: boolean; quietName?: string };
  /** `raw`: a prompt given directly (SillyTavern `generateRaw`). */
  raw?: {
    prompt: string | { role: 'user' | 'assistant' | 'system'; content: string; name?: string }[];
    systemPrompt?: string;
    prefill?: string;
    instructOverride?: boolean;
    quietToLoud?: boolean;
  };
  /** Chat after the greeting (the card's `first_mes`, when it has one). */
  history: ScenarioMessage[];
  /** Text typed into the input box before a normal generation. */
  input?: string;
  type: ScenarioType;
  persona?: Partial<PersonaFields>;
  /** Overrides of the Chat Completion settings (SillyTavern `oai_settings` keys). */
  preset?: Record<string, unknown>;
  /** Files under SillyTavern's user folder by path (`user/images/...`), base64. */
  files?: Record<string, string>;
  /** Function tools registered before the generation (`registerFunctionTool`). */
  tools?: ToolDefinition[];
  /** SillyTavern `chat_metadata` (Author's Note, ...). */
  chatMetadata?: Record<string, unknown>;
  worldInfo?: {
    /** Lorebooks by name. */
    books: Record<string, WorldInfoEntry[]>;
    /** Globally active books. */
    global?: string[];
    /** The character's primary book. */
    character?: string;
    settings?: Partial<StWorldInfoSettings>;
  };
  regex?: {
    global?: RegexScript[];
    /** Embedded in the card (`data.extensions.regex_scripts`). */
    character?: RegexScript[];
    characterAllowed?: boolean;
    /** Embedded in the preset (`extensions.regex_scripts`). */
    preset?: RegexScript[];
    presetAllowed?: boolean;
  };
  /** SillyTavern `power_user.reasoning` overrides. */
  reasoning?: Partial<StReasoningSettings>;
  /** Replaces the content of the preset's Main Prompt. */
  mainPrompt?: string;
  /** Model to use instead of the source's default. */
  model?: string;
  /** Custom stopping strings (SillyTavern `power_user.custom_stopping_strings`). */
  stoppingStrings?: string[];
  /** Other source settings (SillyTavern `oai_settings` keys such as `reasoning_effort`). */
  sourceSettings?: Record<string, unknown>;
}

export function scenarioModel(scenario: Scenario): string {
  if (scenario.text) return scenario.text.model ?? textModels[scenario.text.type] ?? 'mock-model';
  return scenario.model ?? stSources[scenario.provider ?? 'custom'].model;
}

/** Models for the Text Completion backends that need one. */
const textModels: Record<string, string> = {
  ollama: 'llama3.1:8b',
  openrouter: 'mistralai/mistral-nemo',
  togetherai: 'Gryphe/MythoMax-L2-13b',
  infermaticai: 'Sao10K-L3.3-70B-Euryale-v2.3',
  dreamgen: 'lucid-v1-extra-large/text',
  featherless: 'Sao10K/L3-8B-Stheno-v3.2',
  mancer: 'mytholite',
};

/** Hosted Text Completion backends: their key in `secrets.json` (their hosts are intercepted). */
export const stTextSecrets: Record<string, string> = {
  openrouter: 'api_key_openrouter',
  togetherai: 'api_key_togetherai',
  infermaticai: 'api_key_infermaticai',
  dreamgen: 'api_key_dreamgen',
  featherless: 'api_key_featherless',
  mancer: 'api_key_mancer',
};

export interface StReasoningSettings {
  add_to_prompts: boolean;
  max_additions: number;
  prefix: string;
  suffix: string;
  separator: string;
}

export const stWorldInfoDefaults: StWorldInfoSettings = {
  world_info_depth: 2,
  world_info_min_activations: 0,
  world_info_min_activations_depth_max: 0,
  world_info_budget: 25,
  world_info_budget_cap: 0,
  world_info_include_names: true,
  world_info_recursive: true,
  world_info_max_recursion_steps: 0,
  world_info_case_sensitive: false,
  world_info_match_whole_words: false,
  world_info_use_group_scoring: false,
  world_info_character_strategy: 1,
  world_info_overflow_alert: false,
};

export const stReasoningDefaults: StReasoningSettings = {
  add_to_prompts: false,
  max_additions: 1,
  prefix: '<think>',
  suffix: '</think>',
  separator: '\n',
};

export const personaDefaults: PersonaFields = {
  name: 'User',
  description: '',
  position: 0,
  depth: 2,
  role: 0,
};

/** Settings applied to every scenario: a context large enough that nothing is trimmed. */
export const basePreset: Record<string, unknown> = {
  openai_max_context: 16384,
  openai_max_tokens: 300,
  // The mock answers in one piece; streaming makes no difference to the request otherwise.
  stream_openai: false,
};

const aiko: CardFields = {
  name: 'Aiko',
  description: '{{char}} is a cheerful barista at the Moonlit Café. She remembers every regular by name.',
  personality: 'cheerful, curious, a little nosy',
  scenario: '{{user}} walks into the café on a rainy evening.',
  first_mes: '*{{char}} looks up from the counter.* Welcome in, {{user}}! Rough weather out there?',
  mes_example:
    '<START>\n{{user}}: Hi!\n{{char}}: Oh, hello there! The usual?\n<START>\n{{user}}: What do you recommend?\n{{char}}: *She taps the menu.* Matcha latte, always.',
};

const history: ScenarioMessage[] = [
  { user: true, mes: 'Hi Aiko. It is pouring outside.' },
  { mes: '*She slides a towel across the counter.* Dry off first. Tea or coffee?' },
];

/** Attachment files: two 1×1 PNGs, a few bytes of an MP4 and a text file. */
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const GRAY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const attachmentFiles: Record<string, string> = {
  'user/images/Aiko/menu.png': RED_PNG,
  'user/images/Aiko/latte.png': GRAY_PNG,
  'user/images/Aiko/clip.mp4': 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
  'user/files/1760000000000_recipe.txt': Buffer.from(
    'Recipe: two shots of espresso, steamed milk, a pinch of cinnamon.',
  ).toString('base64'),
};
const withPhoto: ScenarioMessage[] = [
  ...[
    { user: true, mes: 'Hi Aiko. It is pouring outside.' },
    { mes: '*She slides a towel across the counter.* Dry off first. Tea or coffee?' },
  ],
  {
    user: true,
    mes: 'Look at this menu I found. What is on it?',
    extra: {
      media: [{ url: 'user/images/Aiko/menu.png', type: 'image', title: 'menu.png', source: 'upload' }],
      media_index: 0,
      inline_image: true,
    },
  },
];

/** Tools and a chat in which the model called them. */
const toolDefinitions: ToolDefinition[] = [
  {
    name: 'roll_dice',
    displayName: 'Roll dice',
    description: 'Rolls dice and returns the total.',
    parameters: {
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'object',
      properties: {
        sides: { type: 'number', description: 'Sides of each die' },
        count: { type: 'number', description: 'How many dice', default: 1 },
      },
      required: ['sides'],
    },
  },
  {
    name: 'get_weather',
    description: 'The weather outside the café right now.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];
const invocations: ToolInvocation[] = [
  {
    id: 'call_dice_1',
    displayName: 'Roll dice',
    name: 'roll_dice',
    parameters: '{"sides":20}',
    result: '17',
    error: false,
    signature: null,
    reasoning: null,
  },
  {
    id: 'call_weather_1',
    displayName: 'get_weather',
    name: 'get_weather',
    parameters: '{}',
    result: 'Rain, 12°C',
    error: false,
    signature: null,
    reasoning: null,
  },
];
const toolHistory = (api: string, model: string): ScenarioMessage[] => [
  ...[
    { user: true, mes: 'Hi Aiko. It is pouring outside.' },
    { mes: '*She slides a towel across the counter.* Dry off first. Tea or coffee?' },
  ],
  { user: true, mes: 'Roll a d20 for my luck, and is it still raining?' },
  {
    name: 'SillyTavern System',
    hidden: true,
    mes: toolInvocationsText(invocations),
    extra: { isSmallSys: true, tool_invocations: invocations, api, model },
  },
  { mes: 'You rolled a 17! And yes, still raining.' },
];

/** A longer chat in English and Chinese, which tokenizers count very differently. */
const bilingualHistory: ScenarioMessage[] = [
  ...history,
  { user: true, mes: '今天的雨好大，我差点没赶上末班车。' },
  { mes: '*她递过一杯热可可。* 先暖暖身子吧，末班车的事明天再说。' },
  { user: true, mes: 'Coffee. Black, no sugar. It has been a long shift at the hospital.' },
  { mes: '*She pours a steaming cup.* On the house tonight. You look like you need it.' },
  { user: true, mes: '隔壁的面包店还开着吗？我想买个可颂当明天的早餐。' },
  { mes: 'They closed an hour ago, but I saved a croissant for my favorite regular.' },
];

function entries(...list: Partial<WorldInfoEntry>[]): WorldInfoEntry[] {
  return list.map((overrides, uid) => createEntry(uid, overrides));
}

/** SillyTavern `regex_placement` values. */
const USER_INPUT = 1;
const AI_OUTPUT = 2;
const WORLD_INFO = 5;
const REASONING = 6;

function regex(scriptName: string, overrides: Partial<RegexScript>): RegexScript {
  return newRegexScript(`st-diff-${scriptName.toLowerCase().replace(/\W+/g, '-')}`, {
    scriptName,
    ...overrides,
  });
}

/**
 * A `timedWorldInfo` record for an entry, as SillyTavern stores it: the entry is found again by
 * the hash of its collected form.
 */
function timedState(book: string, entries: WorldInfoEntry[], uid: number, start: number, end: number) {
  const collected = collectEntries({ global: [{ name: book, entries }], character: [] }, 1);
  const hash = collected.find((e) => e.uid === uid)!.hash;
  return { [`${book}.${uid}`]: { hash, start, end, protected: false } };
}

const timedBook = entries(
  { comment: 'Too early', key: ['coffee'], content: 'Waits for ten messages.', delay: 10, order: 10 },
  { comment: 'Soon enough', key: ['coffee'], content: 'Waits for two messages.', delay: 2, order: 20 },
  { comment: 'Sticky', key: ['umbrella'], content: 'The umbrella stand is full.', sticky: 3, order: 30 },
  { comment: 'Cooling down', key: ['coffee'], content: 'Fresh beans arrived.', cooldown: 3, order: 40 },
);

const cafeBook = (): Record<string, WorldInfoEntry[]> => ({
  'Moonlit Café': entries(
    { comment: 'Matcha', key: ['matcha'], content: 'The matcha comes from Uji.', order: 20 },
    {
      comment: 'Towels',
      key: ['towel'],
      content: 'Wet towels pile up when the café is crowded.',
      position: 4,
      depth: 1,
      role: 1,
      order: 30,
    },
  ),
});

/** Samplers away from their defaults, so each source's handling of every parameter shows. */
const samplerPreset = {
  temp_openai: 0.8,
  freq_pen_openai: 0.1,
  pres_pen_openai: 0.2,
  top_p_openai: 0.95,
  top_k_openai: 40,
  min_p_openai: 0.05,
  top_a_openai: 0.1,
  repetition_penalty_openai: 1.05,
  seed: 7,
  openai_max_tokens: 400,
};

export const scenarios: Scenario[] = [
  {
    id: 'basic-chat',
    title: 'Card fields, example dialogue and history with the default preset',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
  },
  {
    id: 'persona-and-overrides',
    title: 'Persona description, card system prompt with {{original}}, post-history instructions',
    card: {
      ...aiko,
      system_prompt: '{{original}}\nStay in the café setting.',
      post_history_instructions: 'Reply in at most three sentences.',
    },
    history,
    input: 'Do you have anything sweet?',
    type: 'normal',
    persona: { name: 'Mika', description: '{{user}} is a tired night-shift nurse who loves pastries.' },
  },
  {
    id: 'persona-at-depth',
    title: 'Persona description injected at depth 1 as a user message',
    card: aiko,
    history,
    input: 'Surprise me.',
    type: 'normal',
    persona: { name: 'Mika', description: 'Mika is allergic to nuts.', position: 4, depth: 1, role: 1 },
  },
  {
    id: 'authors-note',
    title: "Author's Note in the chat at depth 2",
    card: aiko,
    history,
    input: 'What time do you close?',
    type: 'normal',
    chatMetadata: {
      note_prompt: '[Aiko is getting sleepy.]',
      note_interval: 1,
      note_position: 1,
      note_depth: 2,
      note_role: 0,
    },
  },
  {
    id: 'world-info',
    title: 'World Info: constant, keyword and @depth entries from a global and a character book',
    card: { ...aiko, extensions: { world: 'Moonlit Café' } },
    history,
    input: 'Is the matcha any good today?',
    type: 'normal',
    worldInfo: {
      books: {
        'Moonlit Café': entries(
          { comment: 'Café', content: 'The Moonlit Café is open until midnight.', constant: true, order: 10 },
          {
            comment: 'Matcha',
            key: ['matcha'],
            content: 'The matcha comes from Uji.',
            position: 1,
            order: 20,
          },
          {
            comment: 'Rain',
            key: ['pouring'],
            content: 'Rain makes the café crowded.',
            position: 4,
            depth: 1,
            role: 1,
            order: 30,
          },
        ),
        Town: entries({
          comment: 'Town',
          key: ['café'],
          content: 'The town of Kinosaki has hot springs.',
          order: 5,
        }),
      },
      global: ['Town'],
      character: 'Moonlit Café',
    },
  },
  {
    id: 'continue',
    title: 'Continue the last reply',
    card: aiko,
    history,
    type: 'continue',
  },
  {
    id: 'continue-prefill',
    title: 'Continue with prefill',
    card: aiko,
    history,
    type: 'continue',
    preset: { continue_prefill: true },
  },
  {
    id: 'impersonate',
    title: 'Write the user’s reply',
    card: aiko,
    history,
    type: 'impersonate',
  },
  {
    id: 'swipe',
    title: 'Swipe the last reply',
    card: aiko,
    history: [...history, { user: true, mes: 'Coffee.' }, { mes: 'Coming right up.' }],
    type: 'swipe',
  },
  {
    id: 'names-and-squash',
    title: 'Names in message content, squashed system messages, hidden message',
    card: aiko,
    history: [...history, { user: true, mes: '(this was a typo)', hidden: true }],
    input: 'Tea, then.',
    type: 'normal',
    preset: { names_behavior: 2, squash_system_messages: true },
  },
  {
    id: 'claude-basic',
    title: 'Claude: system messages folded into the conversation',
    provider: 'claude',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
  },
  {
    id: 'claude-sysprompt-prefill',
    title: 'Claude: leading system messages as the system prompt, assistant prefill',
    provider: 'claude',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { use_sysprompt: true, assistant_prefill: '*{{char}} smiles.*' },
  },
  {
    id: 'claude-continue-prefill',
    title: 'Claude: continue by prefilling the last reply',
    provider: 'claude',
    card: aiko,
    history,
    type: 'continue',
    preset: { continue_prefill: true },
  },
  {
    id: 'gemini-basic',
    title: 'Gemini: contents and safety settings',
    provider: 'makersuite',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
  },
  {
    id: 'gemini-sysprompt',
    title: 'Gemini: leading system messages as the system instruction',
    provider: 'makersuite',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { use_sysprompt: true },
  },
  {
    id: 'regex-global',
    title:
      'Global regex: user input on send, prompt-only with a depth range and macros, display-only ignored',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    regex: {
      global: [
        regex('Shout coffee', { findRegex: '/coffee/gi', replaceString: 'COFFEE', placement: [USER_INPUT] }),
        regex('Actions in parentheses', {
          findRegex: '/\\*(?<action>[^*]+)\\*/g',
          replaceString: '($<action>)',
          trimStrings: ['She '],
          placement: [AI_OUTPUT],
          promptOnly: true,
          maxDepth: 2,
        }),
        regex('Name from macro', {
          findRegex: '/{{char}}/g',
          replaceString: 'the barista ({{user}})',
          placement: [AI_OUTPUT],
          promptOnly: true,
          substituteRegex: 1,
        }),
        regex('Display only', {
          findRegex: '/Rough/',
          replaceString: 'Stormy',
          placement: [AI_OUTPUT],
          markdownOnly: true,
        }),
        regex('Disabled', {
          findRegex: '/Dry/',
          replaceString: 'Wet',
          placement: [AI_OUTPUT],
          promptOnly: true,
          disabled: true,
        }),
      ],
    },
  },
  {
    id: 'regex-embedded',
    title: 'Regex embedded in the card and the preset (allowed), applied to the history and World Info',
    card: { ...aiko, extensions: { world: 'Moonlit Café' } },
    history,
    input: 'Is the matcha any good today?',
    type: 'normal',
    worldInfo: { books: cafeBook(), character: 'Moonlit Café' },
    regex: {
      character: [
        regex('Card: Uji', {
          findRegex: '/Uji/',
          replaceString: 'Uji, Kyoto',
          placement: [WORLD_INFO],
          promptOnly: true,
        }),
      ],
      characterAllowed: true,
      preset: [
        regex('Preset: towel', {
          findRegex: '/towel/',
          replaceString: 'warm towel',
          placement: [AI_OUTPUT],
          promptOnly: true,
        }),
        regex('Preset: deep World Info only', {
          findRegex: '/crowded/',
          replaceString: 'packed',
          placement: [WORLD_INFO],
          promptOnly: true,
          minDepth: 2,
        }),
      ],
      presetAllowed: true,
    },
  },
  {
    id: 'regex-not-allowed',
    title: 'Regex embedded in the card and the preset is ignored until allowed',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    regex: {
      character: [regex('Card', { findRegex: '/towel/', replaceString: 'X', placement: [AI_OUTPUT] })],
      preset: [regex('Preset', { findRegex: '/Coffee/', replaceString: 'Y', placement: [USER_INPUT] })],
    },
  },
  {
    id: 'reasoning-in-prompt',
    title: 'Reasoning of the latest replies added to the prompt, with a reasoning regex',
    card: aiko,
    history: [
      { user: true, mes: 'Hi Aiko. It is pouring outside.' },
      {
        mes: '*She slides a towel across the counter.* Dry off first. Tea or coffee?',
        reasoning: 'They look cold. Offer something warm.',
      },
      { user: true, mes: 'Tea.' },
      { mes: 'Coming right up.', reasoning: 'Green tea, then.' },
    ],
    input: 'Thanks!',
    type: 'normal',
    reasoning: {
      add_to_prompts: true,
      max_additions: 2,
      prefix: '<think>\n',
      suffix: '\n</think>',
      separator: '\n\n',
    },
    regex: {
      global: [
        regex('Reasoning', {
          findRegex: '/warm/',
          replaceString: 'hot',
          placement: [REASONING],
          promptOnly: true,
        }),
      ],
    },
  },
  {
    id: 'continue-reasoning',
    title: 'Continue a reply that has reasoning',
    card: aiko,
    history: [history[0]!, { mes: '*She slides a towel across the counter.*', reasoning: 'Be kind.' }],
    type: 'continue',
  },
  {
    id: 'wi-inclusion-groups',
    title: 'World Info inclusion groups: priority winner, scoring, an entry in two groups',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Groups: entries(
          { comment: 'Rain A', key: ['black'], content: 'Rain A.', group: 'weather', order: 10 },
          {
            comment: 'Rain B',
            key: ['black'],
            content: 'Rain B wins its group.',
            group: 'weather',
            groupOverride: true,
            order: 20,
          },
          {
            comment: 'Rain C',
            key: ['rain'],
            content: 'Rain C.',
            group: 'weather',
            groupOverride: true,
            order: 5,
          },
          {
            comment: 'Tea and coffee',
            key: ['tea', 'coffee'],
            content: 'Both tea and coffee are served.',
            group: 'drinks',
            useGroupScoring: true,
          },
          {
            comment: 'Coffee',
            key: ['coffee'],
            content: 'Only coffee is served.',
            group: 'drinks',
            useGroupScoring: true,
          },
          { comment: 'Towels', key: ['towel'], content: 'Towels.', group: 'weather, cloth', order: 1 },
        ),
      },
      global: ['Groups'],
    },
  },
  {
    id: 'wi-timed-effects',
    title: 'World Info delay, sticky and cooldown (with timers from earlier replies)',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    chatMetadata: {
      timedWorldInfo: {
        sticky: timedState('Timers', timedBook, 2, 1, 10),
        cooldown: timedState('Timers', timedBook, 3, 1, 10),
      },
    },
    worldInfo: { books: { Timers: timedBook }, global: ['Timers'] },
  },
  {
    id: 'wi-min-activations',
    title: 'World Info minimum activations scan deeper into the chat',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Depth: entries(
          { comment: 'Black', key: ['black'], content: 'Black coffee is the house special.', order: 40 },
          { comment: 'Towel', key: ['towel'], content: 'The towels are warm.', order: 30 },
          { comment: 'Pouring', key: ['pouring'], content: 'It has rained all week.', order: 20 },
          { comment: 'Counter', key: ['counter'], content: 'The counter is oak.', order: 10 },
        ),
      },
      global: ['Depth'],
      settings: { world_info_depth: 1, world_info_min_activations: 3 },
    },
  },
  {
    id: 'wi-recursion',
    title: 'World Info recursion: levels, entries that cannot trigger or be triggered',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Recursion: entries(
          { comment: 'Café', content: 'The café keeps a cat named Mocha.', constant: true, order: 90 },
          { comment: 'Mocha', key: ['Mocha'], content: 'Mocha sleeps on the piano.', order: 80 },
          {
            comment: 'Piano',
            key: ['piano'],
            content: 'The piano is out of tune.',
            delayUntilRecursion: true,
            order: 70,
          },
          {
            comment: 'Song',
            key: ['Mocha'],
            content: 'Aiko hums a song about Mocha.',
            delayUntilRecursion: 2,
            order: 60,
          },
          {
            comment: 'Cat',
            key: ['cat'],
            content: 'Cats are not allowed.',
            excludeRecursion: true,
            order: 50,
          },
          {
            comment: 'Closed',
            content: 'An umbrella hangs by the door.',
            constant: true,
            preventRecursion: true,
            order: 40,
          },
          { comment: 'Umbrella', key: ['umbrella'], content: 'Nobody owns the umbrella.', order: 30 },
        ),
      },
      global: ['Recursion'],
    },
  },
  {
    id: 'wi-filters-decorators',
    title: 'World Info character filters, generation type triggers and @@decorators',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Filters: entries(
          {
            comment: 'Only Aiko',
            key: ['coffee'],
            content: 'For Aiko only.',
            characterFilter: { names: ['Aiko'], tags: [], isExclude: false },
            order: 70,
          },
          {
            comment: 'Not Aiko',
            key: ['coffee'],
            content: 'Never for Aiko.',
            characterFilter: { names: ['Aiko'], tags: [], isExclude: true },
            order: 60,
          },
          {
            comment: 'Someone else',
            key: ['coffee'],
            content: 'For someone else.',
            characterFilter: { names: ['Someone'], tags: [], isExclude: false },
            order: 50,
          },
          {
            comment: 'On continue',
            key: ['coffee'],
            content: 'Only when continuing.',
            triggers: ['continue'],
            order: 40,
          },
          {
            comment: 'On normal',
            key: ['coffee'],
            content: 'On normal replies.',
            triggers: ['normal'],
            order: 30,
          },
          { comment: 'Activate', content: '@@activate\nForced on.', order: 20 },
          { comment: 'Do not', content: '@@dont_activate\nNever shown.', constant: true, order: 10 },
        ),
      },
      global: ['Filters'],
    },
  },
  {
    id: 'wi-sources-outlet',
    title: 'World Info matching card fields and the persona, and an outlet used in the main prompt',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    persona: { name: 'Mika', description: '{{user}} is a tired night-shift nurse.' },
    mainPrompt: "Write {{char}}'s next reply.\n{{outlet::menu}}",
    worldInfo: {
      books: {
        Sources: entries(
          {
            comment: 'Barista',
            key: ['barista'],
            content: 'Baristas know every regular.',
            matchCharacterDescription: true,
            order: 50,
          },
          {
            comment: 'Nurse',
            key: ['nurse'],
            content: 'Nurses get a discount.',
            matchPersonaDescription: true,
            order: 40,
          },
          {
            comment: 'Rainy',
            key: ['rainy'],
            content: 'Rainy days are slow.',
            matchScenario: true,
            order: 30,
          },
          { comment: 'Not scanned', key: ['barista'], content: 'Not in the chat.', order: 20 },
          {
            comment: 'Menu',
            content: 'Today: lemon tarts.',
            constant: true,
            position: 7,
            outletName: 'menu',
            order: 10,
          },
        ),
      },
      global: ['Sources'],
    },
  },
  {
    id: 'wi-budget',
    title: 'World Info budget: entries past the cap are dropped unless they ignore the budget',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Budget: entries(
          { comment: 'Short', content: 'Short fact.', constant: true, order: 90 },
          {
            comment: 'Long',
            content:
              'This is a very long entry about the history of the Moonlit Café, its founders, the war years, the renovation, the famous espresso machine imported from Milan, and the many regulars who have sat at its counter over the decades.',
            constant: true,
            order: 80,
          },
          { comment: 'Later', content: 'Also dropped.', constant: true, order: 70 },
          {
            comment: 'Ignores',
            content: 'Kept despite the budget.',
            constant: true,
            ignoreBudget: true,
            order: 60,
          },
        ),
      },
      global: ['Budget'],
      settings: { world_info_budget_cap: 20 },
    },
  },
  {
    id: 'budget-o200k',
    title: 'A small context counted with o200k: old messages and World Info past its budget are dropped',
    provider: 'openai',
    model: 'gpt-4.1',
    card: aiko,
    history: bilingualHistory,
    input: '再来一杯，谢谢。',
    type: 'normal',
    // At least 512: SillyTavern's slider raises smaller contexts to its minimum.
    preset: { openai_max_context: 520, openai_max_tokens: 160 },
    worldInfo: {
      books: {
        Café: entries(
          {
            comment: 'Owner',
            content: '月光咖啡馆由爱子的祖母在一九六二年创办。',
            constant: true,
            order: 90,
          },
          {
            comment: 'Machine',
            content: 'The espresso machine was imported from Milan and still has its original brass levers.',
            constant: true,
            order: 80,
          },
          { comment: 'Cat', content: '店里有一只叫团子的橘猫，总在窗边睡觉。', constant: true, order: 70 },
          {
            comment: 'Hours',
            content: 'Open from seven in the morning until midnight.',
            constant: true,
            order: 60,
          },
        ),
      },
      global: ['Café'],
      settings: { world_info_budget: 10 },
    },
  },
  {
    id: 'logit-bias',
    title: 'Logit bias list: text tokenized with cl100k, token id lists as they are, empty entries skipped',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: {
      bias_preset_selected: 'st-diff',
      bias_presets: {
        'Default (none)': [],
        'st-diff': [
          { id: '1', text: ' bond', value: -50 },
          { id: '2', text: '咖啡', value: 5 },
          { id: '3', text: '[1234, 5678]', value: 10 },
          { id: '4', text: '', value: 3 },
          { id: '5', text: 'Hello world', value: -1 },
        ],
      },
    },
  },
  {
    id: 'media-openai',
    title: 'An attached image inlined for a vision model (OpenAI)',
    provider: 'openai',
    model: 'gpt-4.1',
    card: aiko,
    history: withPhoto,
    input: '',
    type: 'normal',
    files: attachmentFiles,
  },
  {
    id: 'media-claude',
    title: 'An attached image in Claude’s format, an old-style `extra.image` too',
    provider: 'claude',
    card: aiko,
    history: [
      ...withPhoto,
      { mes: 'It lists matcha and lattes.', extra: { image: 'user/images/Aiko/latte.png' } },
      { user: true, mes: 'Thanks!' },
    ],
    input: '',
    type: 'normal',
    files: attachmentFiles,
  },
  {
    id: 'media-gemini',
    title: 'Gemini: images and video inlined, low detail',
    provider: 'makersuite',
    card: aiko,
    history: [
      ...withPhoto.slice(0, -1),
      {
        user: true,
        mes: 'Here is the menu and a clip of the café.',
        extra: {
          media: [
            { url: 'user/images/Aiko/menu.png', type: 'image', title: 'menu.png' },
            { url: 'user/images/Aiko/clip.mp4', type: 'video', title: 'clip.mp4' },
          ],
        },
      },
    ],
    input: '',
    type: 'normal',
    preset: { inline_image_quality: 'low' },
    files: attachmentFiles,
  },
  {
    id: 'attachments-files-gallery',
    title: 'File text before the message, a gallery sends its shown image, titles appended',
    card: aiko,
    history: [
      {
        user: true,
        mes: 'Can you make this?',
        extra: {
          files: [
            {
              url: 'user/files/1760000000000_recipe.txt',
              size: 66,
              name: 'recipe.txt',
              created: 1760000000000,
            },
          ],
        },
      },
      {
        mes: 'Of course. Here are two photos from last time.',
        extra: {
          media: [
            { url: 'user/images/Aiko/menu.png', type: 'image', title: 'The menu' },
            {
              url: 'user/images/Aiko/latte.png',
              type: 'image',
              title: 'A cinnamon latte',
              append_title: true,
            },
          ],
          media_display: 'gallery',
          media_index: 1,
        },
      },
    ],
    input: 'Lovely!',
    type: 'normal',
    files: attachmentFiles,
  },
  {
    id: 'media-inlining-off',
    title: 'Media inlining off: images stay out, file text stays in',
    card: aiko,
    history: withPhoto,
    input: '',
    type: 'normal',
    preset: { media_inlining: false },
    files: attachmentFiles,
  },
  ...(['custom', 'claude', 'makersuite', 'mistralai', 'deepseek', 'cohere', 'openrouter'] as const).map(
    (provider): Scenario => ({
      id: `tools-${provider}`,
      title: `Tool calling (${provider}): tools offered, past calls and results in the history`,
      provider,
      card: aiko,
      history: toolHistory(provider, stSources[provider].model),
      input: 'Roll again?',
      type: 'normal',
      preset: { function_calling: true },
      tools: toolDefinitions,
    }),
  ),
  {
    id: 'tools-off',
    title: 'Function calling off: the message recording past calls stays out',
    card: aiko,
    history: toolHistory('custom', 'mock-model'),
    input: 'Roll again?',
    type: 'normal',
    tools: toolDefinitions,
  },
  {
    id: 'wi-positions',
    title: "World Info at the Author's Note, around example messages and at several depths and roles",
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    chatMetadata: {
      note_prompt: '[Keep it cozy.]',
      note_interval: 1,
      note_position: 1,
      note_depth: 2,
      note_role: 0,
    },
    worldInfo: {
      books: {
        Positions: entries(
          { comment: 'AN top', content: 'Above the note.', constant: true, position: 2, order: 60 },
          { comment: 'AN bottom', content: 'Below the note.', constant: true, position: 3, order: 50 },
          {
            comment: 'EM top',
            content: '<START>\n{{user}}: Is it raining?\n{{char}}: Cats and dogs.',
            constant: true,
            position: 5,
            order: 40,
          },
          {
            comment: 'EM bottom',
            content: '<START>\n{{user}}: Closing time?\n{{char}}: Midnight.',
            constant: true,
            position: 6,
            order: 30,
          },
          {
            comment: 'Depth 0',
            content: 'Assistant at depth 0.',
            constant: true,
            position: 4,
            depth: 0,
            role: 2,
            order: 20,
          },
          {
            comment: 'Depth 3',
            content: 'System at depth 3.',
            constant: true,
            position: 4,
            depth: 3,
            role: 0,
            order: 10,
          },
          {
            comment: 'Depth 3 user',
            content: 'User at depth 3.',
            constant: true,
            position: 4,
            depth: 3,
            role: 1,
            order: 5,
          },
        ),
      },
      global: ['Positions'],
    },
  },
  {
    id: 'wi-key-matching',
    title: 'World Info keys: case, whole words, regex, secondary logic, per-entry scan depth, macros',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    worldInfo: {
      books: {
        Keys: entries(
          {
            comment: 'Case',
            key: ['COFFEE'],
            content: 'Case sensitive miss.',
            caseSensitive: true,
            order: 90,
          },
          {
            comment: 'Case hit',
            key: ['Coffee'],
            content: 'Case sensitive hit.',
            caseSensitive: true,
            order: 85,
          },
          {
            comment: 'Whole word',
            key: ['blac'],
            content: 'Whole word miss.',
            matchWholeWords: true,
            order: 80,
          },
          { comment: 'Part of word', key: ['blac'], content: 'Part of a word.', order: 75 },
          { comment: 'Regex', key: ['/b(l|r)ack\\b/i'], content: 'Regex hit.', order: 70 },
          {
            comment: 'And all',
            key: ['coffee'],
            keysecondary: ['black', 'please'],
            selectiveLogic: 3,
            content: 'All secondary keys present.',
            order: 65,
          },
          {
            comment: 'Not any',
            key: ['coffee'],
            keysecondary: ['milk', 'sugar'],
            selectiveLogic: 2,
            content: 'No milk, no sugar.',
            order: 60,
          },
          {
            comment: 'Not all',
            key: ['coffee'],
            keysecondary: ['black', 'milk'],
            selectiveLogic: 1,
            content: 'Not both black and milk.',
            order: 55,
          },
          {
            comment: 'Deep scan',
            key: ['counter'],
            content: 'Found deep in the chat.',
            scanDepth: 4,
            order: 50,
          },
          { comment: 'Shallow', key: ['counter'], content: 'Not in the last two messages.', order: 45 },
          {
            comment: 'Macro key',
            key: ['{{char}}'],
            content: 'The character was named.',
            scanDepth: 4,
            order: 40,
          },
        ),
      },
      global: ['Keys'],
    },
  },
  ...providerScenarios(),
  ...textScenarios(),
  ...groupScenarios(),
  ...quietAndRawScenarios(),
  {
    id: 'custom-body-headers',
    title: 'Custom source: extra body fields with macros, removed keys, extra headers',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: samplerPreset,
    sourceSettings: {
      custom_include_body:
        "top_k: 50\nchat_template_kwargs:\n  enable_thinking: false\nuser: '{{user}} at the café'",
      custom_exclude_body: '- frequency_penalty\n- presence_penalty',
      custom_include_headers: "X-Character: '{{char}}'",
    },
  },
  {
    id: 'custom-post-strict',
    title: 'Custom source: strict prompt post-processing with names in content',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { custom_prompt_post_processing: 'strict', names_behavior: 1 },
  },
  {
    id: 'openrouter-routing',
    title: 'OpenRouter: provider order, quantizations, fallbacks, reasoning effort, Gemini safety',
    provider: 'openrouter',
    model: 'google/gemini-2.5-pro',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { reasoning_effort: 'high', show_thoughts: false },
    sourceSettings: {
      openrouter_middleout: 'off',
      openrouter_providers: ['DeepInfra', 'Together'],
      openrouter_allow_fallbacks: false,
      openrouter_quantizations: ['fp8'],
      openrouter_use_fallback: true,
    },
  },
  {
    id: 'openai-o3',
    title: 'OpenAI o3: max_completion_tokens, no samplers, minimal reasoning effort',
    provider: 'openai',
    model: 'o3',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { ...samplerPreset, reasoning_effort: 'min' },
    stoppingStrings: ['###'],
  },
  {
    id: 'openai-gpt-5-1',
    title: 'OpenAI GPT-5.1 without reasoning effort: temperature kept, penalties dropped, verbosity',
    provider: 'openai',
    model: 'gpt-5.1',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { ...samplerPreset, verbosity: 'low' },
    stoppingStrings: ['###'],
  },
  {
    id: 'xai-grok-4',
    title: 'xAI Grok 4: no penalties or stop strings, names written into replies',
    provider: 'xai',
    model: 'grok-4',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: { ...samplerPreset, names_behavior: 1 },
    stoppingStrings: ['###'],
  },
  {
    id: 'deepseek-reasoning-continue',
    title: 'DeepSeek: reasoning effort mapping, thinking switch and continue as a prefix',
    provider: 'deepseek',
    card: aiko,
    history,
    type: 'continue',
    preset: { reasoning_effort: 'medium', show_thoughts: true, continue_prefill: true },
  },
  {
    id: 'moonshot-kimi-k2-5',
    title: 'Moonshot Kimi K2.5: samplers dropped, continue as a partial assistant message',
    provider: 'moonshot',
    model: 'kimi-k2.5',
    card: aiko,
    history,
    type: 'continue',
    preset: { ...samplerPreset, continue_prefill: true, show_thoughts: false },
  },
  {
    id: 'claude-continue-no-prefill',
    title: 'Claude: continue without continue-prefill keeps the assistant prefill',
    provider: 'claude',
    card: aiko,
    history,
    type: 'continue',
    preset: { assistant_prefill: '*{{char}} thinks.*' },
  },
  {
    id: 'gemini-stop-strings',
    title: 'Gemini: at most five stop strings of 1-16 characters, top_k',
    provider: 'makersuite',
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: samplerPreset,
    stoppingStrings: [
      '###',
      '\n{{user}}:',
      'END',
      'This stop string is far too long',
      '<|eot|>',
      'STOP',
      'six',
    ],
  },
  {
    id: 'mistral-continue',
    title: 'Mistral: continue nudge after an assistant message becomes a user message',
    provider: 'mistralai',
    card: aiko,
    history,
    type: 'continue',
    preset: samplerPreset,
  },
];

/** One scenario per Chat Completion source: the request body each one gets. */
function providerScenarios(): Scenario[] {
  const sources: ScenarioProvider[] = [
    'openai',
    'openrouter',
    'deepseek',
    'mistralai',
    'xai',
    'groq',
    'cohere',
    'perplexity',
    'moonshot',
    'zai',
    'siliconflow',
    'minimax',
    'fireworks',
    'chutes',
    'nanogpt',
    'electronhub',
    'aimlapi',
    'pollinations',
    'ai21',
  ];
  return sources.map((provider) => ({
    id: `source-${provider}`,
    title: `${provider}: samplers, stop strings and the request body`,
    provider,
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    preset: samplerPreset,
    stoppingStrings: ['###', '\n{{user}}:'],
  }));
}

/** Text Completion: formatting templates, prompt assembly and every backend's request. */
function textScenarios(): Scenario[] {
  const tc = (id: string, title: string, text: TextScenario, rest: Partial<Scenario> = {}): Scenario => ({
    id: `tc-${id}`,
    title,
    text,
    card: aiko,
    history,
    input: 'Coffee, please. Black.',
    type: 'normal',
    ...rest,
  });
  const longHistory: ScenarioMessage[] = [
    ...history,
    { user: true, mes: 'Coffee. Black, no sugar. It has been a long shift at the hospital.' },
    { mes: '*She pours a steaming cup.* On the house tonight. You look like you need it.' },
    { user: true, mes: 'You are a lifesaver. Is the bakery next door still open?' },
    { mes: 'They closed an hour ago, but I saved a croissant for my favorite regular.' },
  ];
  const withReasoning: ScenarioMessage[] = [
    { user: true, mes: 'Hi Aiko. It is pouring outside.' },
    {
      mes: '*She slides a towel across the counter.* Dry off first. Tea or coffee?',
      reasoning: 'They look cold. Offer something warm.',
    },
    { user: true, mes: 'Tea.' },
    { mes: 'Coming right up.', reasoning: 'Green tea, then.' },
  ];
  const cafeNote = {
    note_prompt: '[Keep the mood cozy.]',
    note_interval: 1,
    note_position: 1,
    note_depth: 1,
    note_role: 0,
  };
  return [
    tc('plain', 'No instruct mode: Default context template, examples, names and separators', {
      type: 'ooba',
    }),
    tc(
      'chatml',
      "ChatML instruct and context templates, persona and Author's Note",
      { type: 'ooba', instruct: { name: 'ChatML' }, context: { name: 'ChatML' } },
      { persona: { description: '{{user}} is a night-shift nurse.' }, chatMetadata: cafeNote },
    ),
    tc(
      'llama3-continue',
      'Llama 3 instruct: continue the last reply',
      { type: 'llamacpp', instruct: { name: 'Llama 3 Instruct' }, context: { name: 'Llama 3 Instruct' } },
      { type: 'continue', input: undefined },
    ),
    tc(
      'plain-continue',
      'No instruct mode: continue the last reply',
      { type: 'ooba' },
      { type: 'continue', input: undefined, history: longHistory },
    ),
    tc(
      'mistral-impersonate',
      'Mistral V7-Tekken instruct: write the user’s reply',
      { type: 'koboldcpp', instruct: { name: 'Mistral V7-Tekken' }, context: { name: 'Mistral V7-Tekken' } },
      { type: 'impersonate', input: undefined },
    ),
    tc(
      'plain-impersonate',
      'No instruct mode: write the user’s reply',
      { type: 'ooba' },
      { type: 'impersonate', input: undefined },
    ),
    tc(
      'alpaca-swipe',
      'Alpaca instruct: swipe the last reply',
      { type: 'ooba', instruct: { name: 'Alpaca' }, context: { name: 'Alpaca' } },
      { type: 'swipe', input: undefined, history: longHistory },
    ),
    tc(
      'story-in-chat',
      'Story string injected into the chat at depth 2 (Gemma 2), with a depth prompt',
      {
        type: 'koboldcpp',
        instruct: { name: 'Gemma 2' },
        context: {
          name: 'Gemma 2',
          overrides: { story_string_position: 1, story_string_depth: 2, story_string_role: 0 },
        },
      },
      {
        history: longHistory,
        card: {
          ...aiko,
          extensions: { depth_prompt: { prompt: '{{char}} hums while she works.', depth: 1, role: 'user' } },
        },
      },
    ),
    tc(
      'world-info',
      "World Info before/after the card, at depth and around the Author's Note; story string anchors",
      { type: 'ooba' },
      {
        card: { ...aiko, extensions: { world: 'Moonlit Café' } },
        input: 'Is the matcha any good today?',
        chatMetadata: { ...cafeNote, note_position: 0 },
        worldInfo: {
          books: {
            'Moonlit Café': entries(
              {
                comment: 'Café',
                content: 'The Moonlit Café is open until midnight.',
                constant: true,
                order: 10,
              },
              {
                comment: 'Matcha',
                key: ['matcha'],
                content: 'The matcha comes from Uji.',
                position: 1,
                order: 20,
              },
              {
                comment: 'Rain',
                key: ['pouring'],
                content: 'Rain makes the café crowded.',
                position: 4,
                depth: 1,
                order: 30,
              },
              {
                comment: 'Top',
                key: ['matcha'],
                content: 'Matcha sells out by noon.',
                position: 2,
                order: 40,
              },
              { comment: 'Bottom', key: ['matcha'], content: 'The whisk is bamboo.', position: 3, order: 50 },
              {
                comment: 'Example',
                key: ['matcha'],
                content: '{{user}}: More matcha?\n{{char}}: Always.',
                position: 5,
                order: 60,
              },
            ),
          },
          character: 'Moonlit Café',
        },
      },
    ),
    tc(
      'budget',
      'A small context: older messages and examples do not fit, token padding applies',
      { type: 'ooba', maxContext: 330, maxResponse: 100 },
      { history: longHistory },
    ),
    tc(
      'budget-instruct-continue',
      'A small context in instruct mode while continuing: the prompt is trimmed until it fits',
      {
        type: 'ooba',
        instruct: { name: 'ChatML' },
        context: { name: 'ChatML' },
        maxContext: 420,
        maxResponse: 100,
        power: { token_padding: 32 },
      },
      { history: longHistory, type: 'continue', input: undefined },
    ),
    tc(
      'budget-gpt2',
      'A small context counted with the GPT-2 tokenizer',
      { type: 'ooba', maxContext: 360, maxResponse: 100, power: { tokenizer: 1 } },
      { history: bilingualHistory },
    ),
    tc('remote-token-ids', "Banned tokens and logit bias tokenized by the backend's tokenizer", {
      type: 'llamacpp',
      settings: {
        banned_tokens: 'as a robot\n[1, 2]',
        logit_bias: [
          { text: 'coffee time', value: -5 },
          { text: '[7, 8]', value: 2 },
        ],
      },
    }),
    tc(
      'file-attachment',
      'A file attachment’s text before the message; images are not sent',
      { type: 'ooba' },
      {
        history: [
          {
            user: true,
            mes: 'Can you make this?',
            extra: {
              files: [{ url: 'user/files/1760000000000_recipe.txt', size: 66, name: 'recipe.txt' }],
              media: [{ url: 'user/images/Aiko/menu.png', type: 'image' }],
            },
          },
          { mes: 'Of course.' },
        ],
        files: attachmentFiles,
      },
    ),
    tc('koboldcpp-samplers', 'KoboldCpp: sampler order, DRY, dynamic temperature, grammar', {
      type: 'koboldcpp',
      preset: 'Universal-Light',
      settings: {
        dynatemp: true,
        min_temp: 0.5,
        max_temp: 1.5,
        dry_multiplier: 0.8,
        dry_sequence_breakers: '["\\n", ":", "{{char}}"]',
        grammar_string: 'root ::= [a-z ]+',
        seed: 42,
        banned_tokens: '"as an AI"',
      },
    }),
    tc('llamacpp-bias', 'llama.cpp: token bans and logit bias as token id lists, sampler list', {
      type: 'llamacpp',
      preset: 'Universal-Creative',
      settings: {
        banned_tokens: '[1, 2]\n"forbidden phrase"',
        logit_bias: [
          { text: '[42]', value: -1 },
          { text: '[7, 8]', value: 2 },
        ],
      },
    }),
    tc('ollama', 'Ollama: its own request shape', { type: 'ollama', instruct: { name: 'Llama 3 Instruct' } }),
    tc(
      'generic-stops',
      'Generic OpenAI-compatible: at most four stop strings, single line, custom stop strings',
      { type: 'generic', context: { name: 'Default', overrides: { single_line: true } } },
      { stoppingStrings: ['###', '\n{{user}}:', 'END', '<|end|>'] },
    ),
    tc('vllm', 'vLLM: OpenAI-style keys only', {
      type: 'vllm',
      preset: 'Deterministic',
      model: 'mock-model',
    }),
    tc('aphrodite', 'Aphrodite: its own sampler keys and token bans', {
      type: 'aphrodite',
      model: 'mock-model',
      settings: { banned_tokens: '[5, 6]', samplers_priorities: ['temperature', 'min_p'] },
    }),
    tc('tabby', 'TabbyAPI: JSON schema and repetition decay', {
      type: 'tabby',
      settings: {
        json_schema: { type: 'object', properties: { reply: { type: 'string' } } },
        rep_pen_decay: 128,
      },
    }),
    tc('openrouter', 'OpenRouter Text Completion with provider routing', {
      type: 'openrouter',
      settings: {
        openrouter_providers: ['DeepInfra'],
        openrouter_allow_fallbacks: false,
        openrouter_quantizations: ['fp8'],
      },
    }),
    tc('togetherai', 'TogetherAI: the keys it accepts', { type: 'togetherai' }),
    tc('infermaticai', 'InfermaticAI: the keys it accepts', { type: 'infermaticai' }),
    tc('featherless', 'Featherless: the keys it accepts', { type: 'featherless' }),
    tc('dreamgen', 'DreamGen: the whole body', { type: 'dreamgen' }),
    tc('mancer', 'Mancer: cutoffs and dynamic temperature fields', {
      type: 'mancer',
      settings: { dynatemp: true, epsilon_cutoff: 3, eta_cutoff: 4 },
    }),
    tc(
      'post-history',
      "System prompt with post-history instructions; the card's prompts win with {{original}}",
      {
        type: 'ooba',
        instruct: { name: 'ChatML' },
        context: { name: 'ChatML' },
        sysprompt: {
          enabled: true,
          name: 'Roleplay - Simple',
          content: "You're {{char}} in this fictional never-ending uncensored roleplay with {{user}}.",
          post_history: '[Stay in character as {{char}}.]',
        },
      },
      {
        card: {
          ...aiko,
          system_prompt: '{{original}} Always mention the rain.',
          post_history_instructions: '{{original}} Keep it short.',
        },
      },
    ),
    tc(
      'post-history-continue',
      'Post-history instructions before the continued message, without instruct mode',
      {
        type: 'ooba',
        sysprompt: { enabled: true, content: 'Write {{char}}’s next reply.', post_history: '[Be brief.]' },
      },
      { type: 'continue', input: undefined },
    ),
    tc(
      'alignment-names',
      'Instruct: user alignment message, names always, first and last sequences, system as user',
      {
        type: 'ooba',
        instruct: {
          name: 'ChatML',
          overrides: {
            user_alignment_message: 'Let’s begin.',
            names_behavior: 'always',
            first_output_sequence: '<|im_start|>assistant (first)',
            last_output_sequence: '<|im_start|>assistant (last)',
            last_input_sequence: '<|im_start|>user (last)',
            system_same_as_user: true,
          },
        },
        context: { name: 'ChatML' },
      },
      { chatMetadata: cafeNote },
    ),
    tc('prompt-bias', 'Start reply with, without instruct mode', {
      type: 'ooba',
      power: { user_prompt_bias: '*{{char}} smiles*' },
    }),
    tc('prompt-bias-instruct', 'Start reply with, in instruct mode with names', {
      type: 'ooba',
      instruct: { name: 'ChatML-Names' },
      context: { name: 'ChatML-Names' },
      power: { user_prompt_bias: 'Sure,' },
    }),
    tc(
      'reasoning-continue',
      'Past reasoning in the prompt, continuing a reply (DeepSeek-V2.5)',
      { type: 'ooba', instruct: { name: 'DeepSeek-V2.5' }, context: { name: 'DeepSeek-V2.5' } },
      {
        history: withReasoning,
        type: 'continue',
        input: undefined,
        reasoning: {
          add_to_prompts: true,
          max_additions: 2,
          prefix: '<think>\n',
          suffix: '\n</think>',
          separator: '\n\n',
        },
      },
    ),
    tc('examples-pinned', 'Pinned examples in instruct mode, examples skipped by the template', {
      type: 'ooba',
      instruct: { name: 'ChatML', overrides: { skip_examples: true } },
      context: { name: 'ChatML' },
      power: { pin_examples: true },
    }),
    tc('examples-stripped', 'Examples stripped, system prompt disabled, newlines collapsed', {
      type: 'ooba',
      sysprompt: { enabled: false },
      power: { strip_examples: true, collapse_newlines: true },
    }),
    tc('names-not-stop', 'Names not used as stop strings or forced, context stop strings', {
      type: 'ooba',
      context: {
        name: 'Minimalist',
        overrides: { names_as_stop_strings: false, use_stop_strings: true, always_force_name2: false },
      },
    }),
  ];
}

/** Group chats: the replying member's prompt with the others' cards, names and notes. */
function groupScenarios(): Scenario[] {
  const ren: CardFields = {
    name: 'Ren',
    description: '{{char}} fixes motorbikes two streets away and drops by for espresso.',
    personality: 'gruff, kind-hearted',
    scenario: '{{char}} is drying his jacket by the heater.',
    mes_example: '<START>\n{{user}}: Busy day?\n{{char}}: Three bikes and a scooter. *He grins.*',
    extensions: { depth_prompt: { prompt: '{{char}} speaks in short sentences.', depth: 2, role: 'system' } },
  };
  const mei: CardFields = {
    name: 'Mei',
    description: '{{char}} bakes the croissants for the café.',
    personality: 'shy, precise',
    mes_example: '{{user}}: Smells great.\n{{char}}: The dough needs another hour.',
    extensions: {
      depth_prompt: { prompt: '{{char}} is tired from the night shift.', depth: 1, role: 'user' },
    },
  };
  // Group greetings are stored with their macros expanded (SillyTavern expands an unexpanded
  // `{{char}}` in the first message to nothing when a group chat opens).
  const aikoMember: CardFields = { ...aiko, first_mes: '' };
  const groupHistory: ScenarioMessage[] = [
    { name: 'Aiko', mes: '*She looks up from the counter.* Welcome in, User! Rough weather out there?' },
    { user: true, mes: 'Evening, everyone.' },
    { name: 'Ren', mes: 'Evening. *He nods at the window.* Some storm.', reasoning: 'Keep it short.' },
    {
      name: 'Aiko',
      mes: '*She sets down two cups.* Tea for you, espresso for Ren.',
      reasoning: 'Serve everyone.',
    },
    { name: 'Mei', mes: 'I saved a croissant for whoever wants it.', reasoning: 'Be generous.' },
  ];
  const membersPrompt =
    "Write {{char}}'s next reply in a group chat with {{user}}. Members: {{group}}. Unmuted: {{groupNotMuted}}. Others: {{notChar}}. {{charIfNotGroup}}.";
  const join = { joinPrefix: '[<FIELDNAME> of {{char}}]\n', joinSuffix: '\n[/{{char}}]' };
  const base = { history: groupHistory, input: 'Ren, how is the bike?', type: 'normal' as const };
  return [
    {
      id: 'group-swap',
      title: "Group, swap mode: the speaker's card, member names on messages, group macros and nudge",
      card: ren,
      group: { members: [aikoMember, mei], speakerIndex: 1 },
      mainPrompt: membersPrompt,
      ...base,
    },
    {
      id: 'group-append',
      title: 'Group, join cards: prefix and suffix with <FIELDNAME>, every unmuted member’s depth prompt',
      card: aikoMember,
      group: { members: [ren, mei], muted: ['Mei'], generationMode: 1, ...join },
      persona: { description: '{{user}} is a night-shift nurse.' },
      mainPrompt: membersPrompt,
      ...base,
    },
    {
      id: 'group-append-muted',
      title: 'Group, join cards including muted members, scenario and examples overridden by the chat',
      card: ren,
      group: { members: [aikoMember, mei], speakerIndex: 2, muted: ['Mei'], generationMode: 2, ...join },
      chatMetadata: { scenario: '{{char}} and friends are snowed in.' },
      ...base,
    },
    {
      id: 'group-reasoning',
      title: 'Group: only the speaker’s own past reasoning goes into the prompt',
      card: aikoMember,
      group: { members: [ren, mei] },
      reasoning: { add_to_prompts: true, max_additions: 3 },
      ...base,
      input: 'Aiko, another tea please.',
    },
    {
      id: 'group-impersonate',
      title: 'Group: write the user’s reply (no group nudge)',
      card: mei,
      group: { members: [aikoMember, ren], speakerIndex: 2 },
      history: groupHistory,
      type: 'impersonate',
    },
    {
      id: 'group-swipe',
      title: 'Group: swipe the last member’s reply',
      card: mei,
      group: { members: [aikoMember, ren], speakerIndex: 2, generationMode: 1 },
      history: groupHistory,
      type: 'swipe',
    },
    {
      id: 'group-claude',
      title: 'Group on Claude: member names stay in the content',
      provider: 'claude',
      card: ren,
      group: { members: [aikoMember, mei], speakerIndex: 1 },
      ...base,
    },
    {
      id: 'tc-group-chatml',
      title: 'Text Completion group: ChatML with names forced for groups, member stop strings',
      text: {
        type: 'ooba',
        instruct: { name: 'ChatML', overrides: { names_behavior: 'force' } },
        context: { name: 'ChatML' },
      },
      card: ren,
      group: { members: [aikoMember, mei], speakerIndex: 1 },
      ...base,
    },
    {
      id: 'tc-group-plain',
      title: 'Text Completion group without instruct mode: joined cards and examples, member stop strings',
      text: { type: 'ooba' },
      card: aikoMember,
      group: { members: [ren, mei], generationMode: 1, ...join },
      ...base,
    },
    {
      id: 'tc-group-continue',
      title: 'Text Completion group: continue the last member’s reply (Alpaca)',
      text: { type: 'ooba', instruct: { name: 'Alpaca' }, context: { name: 'Alpaca' } },
      card: mei,
      group: { members: [aikoMember, ren], speakerIndex: 2 },
      history: groupHistory,
      type: 'continue',
    },
  ];
}

/** Generations outside the chat flow: quiet prompts and raw prompts (scripts and plugins use them). */
function quietAndRawScenarios(): Scenario[] {
  const chatml = { type: 'ooba', instruct: { name: 'ChatML' }, context: { name: 'ChatML' } };
  const summarize = { prompt: 'Summarize the chat so far in one sentence.' };
  const messages = [
    { role: 'user' as const, content: 'Name three teas, {{user}}.' },
    { role: 'assistant' as const, content: 'Green, black and oolong.' },
    { role: 'user' as const, content: 'Which one does {{char}} like?', name: 'Guest' },
  ];
  return [
    {
      id: 'quiet',
      title: 'Quiet prompt: a background instruction at the end',
      card: aiko,
      history,
      type: 'quiet',
      quiet: summarize,
    },
    {
      id: 'tc-quiet',
      title: 'Text Completion quiet prompt in instruct mode',
      text: chatml,
      card: aiko,
      history,
      type: 'quiet',
      quiet: summarize,
    },
    {
      id: 'tc-quiet-loud',
      title: 'Text Completion quiet prompt answered in character',
      text: { type: 'ooba' },
      card: aiko,
      history,
      type: 'quiet',
      quiet: { prompt: 'Say goodnight.', quietToLoud: true },
    },
    {
      id: 'raw',
      title: 'Raw prompt: messages, system prompt and prefill as given',
      card: aiko,
      history,
      type: 'raw',
      raw: { prompt: messages, systemPrompt: 'You are {{char}}. Be brief.', prefill: 'Well,' },
    },
    {
      id: 'tc-raw',
      title: 'Text Completion raw prompt in instruct mode',
      text: chatml,
      card: aiko,
      history,
      type: 'raw',
      raw: { prompt: messages, systemPrompt: 'You are {{char}}.', prefill: 'Hmm,' },
    },
    {
      id: 'tc-raw-plain',
      title: 'Text Completion raw text prompt without instruct formatting',
      text: chatml,
      card: aiko,
      history,
      type: 'raw',
      raw: { prompt: 'Write a haiku about rain.', instructOverride: true },
    },
  ];
}
