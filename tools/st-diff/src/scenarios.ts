/**
 * Differential test scenarios. Each one is run through SillyTavern 1.19 (recorded into
 * `baseline/<id>.json` by `pnpm record`) and through BakaTavern's core; the requests sent to the
 * model must match.
 */

import { createEntry, type WorldInfoEntry } from '@bakatavern/core';

export type ScenarioType = 'normal' | 'continue' | 'impersonate' | 'swipe';

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

/** Chat Completion source: Custom (OpenAI-compatible), Claude or Google AI Studio. */
export type ScenarioProvider = 'custom' | 'claude' | 'makersuite';

export const defaultModels: Record<ScenarioProvider, string> = {
  custom: 'mock-model',
  claude: 'claude-sonnet-4-5',
  makersuite: 'gemini-2.5-flash',
};

export interface Scenario {
  id: string;
  title: string;
  /** Defaults to `custom`. */
  provider?: ScenarioProvider;
  card: CardFields;
  /** Chat after the greeting (the card's `first_mes`, when it has one). */
  history: ScenarioMessage[];
  /** Text typed into the input box before a normal generation. */
  input?: string;
  type: ScenarioType;
  persona?: Partial<PersonaFields>;
  /** Overrides of the Chat Completion settings (SillyTavern `oai_settings` keys). */
  preset?: Record<string, unknown>;
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

function entries(...list: Partial<WorldInfoEntry>[]): WorldInfoEntry[] {
  return list.map((overrides, uid) => createEntry(uid, overrides));
}

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
];
