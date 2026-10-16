/** SillyTavern Chat Completion preset (the parts that shape the prompt). Field names match ST. */

export interface PromptDefinition {
  identifier: string;
  name?: string;
  role?: 'system' | 'user' | 'assistant';
  content?: string;
  system_prompt?: boolean;
  marker?: boolean;
  /** 0 relative (in the prompt list), 1 absolute (in-chat at `injection_depth`). */
  injection_position?: number;
  injection_depth?: number;
  injection_order?: number;
  /** Generation types this prompt applies to (empty = all). */
  injection_trigger?: string[];
  forbid_overrides?: boolean;
  [extra: string]: unknown;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface PromptOrderList {
  character_id: number | string;
  order: PromptOrderEntry[];
}

export const NamesBehavior = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 } as const;

export const PostProcessing = {
  NONE: '',
  CLAUDE: 'claude',
  MERGE: 'merge',
  MERGE_TOOLS: 'merge_tools',
  SEMI: 'semi',
  SEMI_TOOLS: 'semi_tools',
  STRICT: 'strict',
  STRICT_TOOLS: 'strict_tools',
  SINGLE: 'single',
} as const;

/** Prompt order used for every character ("global" strategy). */
export const GLOBAL_PROMPT_ORDER_ID = 100001;
export const INJECTION_RELATIVE = 0;
export const INJECTION_ABSOLUTE = 1;
export const DEFAULT_INJECTION_DEPTH = 4;
export const DEFAULT_INJECTION_ORDER = 100;

export interface ChatCompletionPreset {
  prompts: PromptDefinition[];
  prompt_order: PromptOrderList[];
  openai_max_context: number;
  openai_max_tokens: number;
  wi_format: string;
  scenario_format: string;
  personality_format: string;
  group_nudge_prompt: string;
  impersonation_prompt: string;
  new_chat_prompt: string;
  new_group_chat_prompt: string;
  new_example_chat_prompt: string;
  continue_nudge_prompt: string;
  send_if_empty: string;
  names_behavior: number;
  continue_prefill: boolean;
  continue_postfix: string;
  squash_system_messages: boolean;
  assistant_prefill: string;
  assistant_impersonation: string;
  use_sysprompt: boolean;
  custom_prompt_post_processing: string;
  stream_openai: boolean;
  temp_openai: number;
  freq_pen_openai: number;
  pres_pen_openai: number;
  top_p_openai: number;
  top_k_openai: number;
  min_p_openai: number;
  top_a_openai: number;
  repetition_penalty_openai: number;
  seed: number;
  n: number;
  reasoning_effort: string;
  verbosity: string;
  show_thoughts: boolean;
  /** Ask providers with built-in web search to use it. */
  enable_web_search: boolean;
  function_calling: boolean;
  media_inlining: boolean;
  /** `auto`, `low` or `high`: the detail images are sent with. */
  inline_image_quality: string;
  /** The logit bias list in use (SillyTavern keeps the lists in its settings, `bias_presets`). */
  bias_preset_selected: string;
  [extra: string]: unknown;
}

/** A logit bias entry: text (or token ids as `[1, 2]`) and its bias. */
export interface LogitBiasEntry {
  id: string;
  text: string;
  value: number;
}

export const DEFAULT_BIAS_LIST = 'Default (none)';

/** SillyTavern's built-in logit bias lists (`default_bias_presets`). */
export const stDefaultBiasLists: Record<string, LogitBiasEntry[]> = {
  [DEFAULT_BIAS_LIST]: [],
  'Anti-bond': [
    { id: '22154f79-dd98-41bc-8e34-87015d6a0eaf', text: ' bond', value: -50 },
    { id: '8ad2d5c4-d8ef-49e4-bc5e-13e7f4690e0f', text: ' future', value: -50 },
    { id: '52a4b280-0956-4940-ac52-4111f83e4046', text: ' bonding', value: -50 },
    { id: 'e63037c7-c9d1-4724-ab2d-7756008b433b', text: ' connection', value: -25 },
  ],
};

export const defaultPrompts: PromptDefinition[] = [
  {
    name: 'Main Prompt',
    system_prompt: true,
    role: 'system',
    content: "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
    identifier: 'main',
  },
  { name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '', identifier: 'nsfw' },
  { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
  {
    name: 'Post-History Instructions',
    system_prompt: true,
    role: 'system',
    content: '',
    identifier: 'jailbreak',
  },
  { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
  { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
  {
    identifier: 'enhanceDefinitions',
    role: 'system',
    name: 'Enhance Definitions',
    content:
      "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
    system_prompt: true,
    marker: false,
  },
  { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
  { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
  { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
  { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
];

export const defaultPromptOrder: PromptOrderEntry[] = [
  { identifier: 'main', enabled: true },
  { identifier: 'worldInfoBefore', enabled: true },
  { identifier: 'personaDescription', enabled: true },
  { identifier: 'charDescription', enabled: true },
  { identifier: 'charPersonality', enabled: true },
  { identifier: 'scenario', enabled: true },
  { identifier: 'enhanceDefinitions', enabled: false },
  { identifier: 'nsfw', enabled: true },
  { identifier: 'worldInfoAfter', enabled: true },
  { identifier: 'dialogueExamples', enabled: true },
  { identifier: 'chatHistory', enabled: true },
  { identifier: 'jailbreak', enabled: true },
];

/** SillyTavern's Chat Completion defaults. */
export function defaultChatCompletionPreset(): ChatCompletionPreset {
  return {
    prompts: structuredClone(defaultPrompts),
    prompt_order: [{ character_id: GLOBAL_PROMPT_ORDER_ID, order: structuredClone(defaultPromptOrder) }],
    openai_max_context: 4095,
    openai_max_tokens: 300,
    wi_format: '{0}',
    scenario_format: '{{scenario}}',
    personality_format: '{{personality}}',
    group_nudge_prompt: '[Write the next reply only as {{char}}.]',
    impersonation_prompt:
      "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    new_chat_prompt: '[Start a new Chat]',
    new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
    new_example_chat_prompt: '[Example Chat]',
    continue_nudge_prompt: '[Continue your last message without repeating its original content.]',
    send_if_empty: '',
    names_behavior: NamesBehavior.DEFAULT,
    continue_prefill: false,
    continue_postfix: ' ',
    squash_system_messages: false,
    assistant_prefill: '',
    assistant_impersonation: '',
    use_sysprompt: false,
    custom_prompt_post_processing: PostProcessing.NONE,
    stream_openai: true,
    temp_openai: 1,
    freq_pen_openai: 0,
    pres_pen_openai: 0,
    top_p_openai: 1,
    top_k_openai: 0,
    min_p_openai: 0,
    top_a_openai: 0,
    repetition_penalty_openai: 1,
    seed: -1,
    n: 1,
    reasoning_effort: 'auto',
    verbosity: 'auto',
    show_thoughts: true,
    enable_web_search: false,
    function_calling: false,
    media_inlining: true,
    inline_image_quality: 'auto',
    bias_preset_selected: DEFAULT_BIAS_LIST,
  };
}

/** Fills missing fields of an imported SillyTavern preset with defaults. */
/**
 * SillyTavern 1.19's shipped "Default" Chat Completion preset file (default/content/presets/openai),
 * loaded on demand. New users get it as their first preset.
 */
export async function loadStDefaultPreset(): Promise<Record<string, unknown>> {
  const module = await import('./st-default-preset.json', { with: { type: 'json' } });
  return structuredClone(module.default) as Record<string, unknown>;
}

export function normalizeChatCompletionPreset(data: Record<string, unknown>): ChatCompletionPreset {
  const base = defaultChatCompletionPreset();
  const merged = { ...base, ...data } as ChatCompletionPreset;
  if (!Array.isArray(merged.prompts) || merged.prompts.length === 0) merged.prompts = base.prompts;
  // Keep every default prompt available (ST adds missing ones on load).
  for (const prompt of base.prompts) {
    if (!merged.prompts.some((p) => p?.identifier === prompt.identifier)) merged.prompts.push(prompt);
  }
  if (!Array.isArray(merged.prompt_order) || merged.prompt_order.length === 0)
    merged.prompt_order = base.prompt_order;
  return merged;
}

/** The prompt order list for a character id (the global list by default). */
export function promptOrderFor(
  preset: ChatCompletionPreset,
  characterId: number | string = GLOBAL_PROMPT_ORDER_ID,
): PromptOrderEntry[] {
  return preset.prompt_order.find((list) => String(list.character_id) === String(characterId))?.order ?? [];
}
