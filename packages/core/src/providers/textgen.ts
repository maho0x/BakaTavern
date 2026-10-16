/**
 * Text Completion backends: port of SillyTavern's `createTextGenGenerationData`
 * (`textgen-settings.js`) and of what its server does with that body
 * (`src/endpoints/backends/text-completions.js`): the URL per backend type, the keys each
 * backend accepts, Ollama's own request shape, and the stream formats.
 */

import type { GenerationType } from '../prompt/types.ts';
import { NdjsonParser, SseParser } from './sse.ts';
import {
  errorMessage,
  type AuthScheme,
  type HttpRequestSpec,
  type ProviderAdapter,
  type StreamDecoder,
  type StreamDelta,
} from './types.ts';

/** SillyTavern `textgen_types`. */
export const TextgenType = {
  OOBA: 'ooba',
  MANCER: 'mancer',
  VLLM: 'vllm',
  APHRODITE: 'aphrodite',
  TABBY: 'tabby',
  KOBOLDCPP: 'koboldcpp',
  TOGETHERAI: 'togetherai',
  LLAMACPP: 'llamacpp',
  OLLAMA: 'ollama',
  INFERMATICAI: 'infermaticai',
  DREAMGEN: 'dreamgen',
  OPENROUTER: 'openrouter',
  FEATHERLESS: 'featherless',
  HUGGINGFACE: 'huggingface',
  GENERIC: 'generic',
} as const;

export interface TextgenTypeDefinition {
  id: string;
  name: string;
  /** Hosted services have a fixed server; local backends use the URL the user enters. */
  server?: string;
  /** Suggested URL for local backends. */
  exampleUrl?: string;
  keyRequired: boolean;
  /** SillyTavern setting holding the model (`ollama_model`, ...); none when the backend picks it. */
  modelSetting?: string;
  /** The model must be chosen (hosted services, Ollama). */
  modelRequired?: boolean;
  defaultModel?: string;
  defaultHeaders?: Record<string, string>;
}

const STHeaders = { 'HTTP-Referer': 'https://bakatavern.app', 'X-Title': 'BakaTavern' };

/** Text Completion backends, ids as in SillyTavern. */
export const textgenTypes: TextgenTypeDefinition[] = [
  { id: 'koboldcpp', name: 'KoboldCpp', exampleUrl: 'http://127.0.0.1:5001', keyRequired: false },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    exampleUrl: 'http://127.0.0.1:8080',
    keyRequired: false,
    modelSetting: 'llamacpp_model',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    exampleUrl: 'http://127.0.0.1:11434',
    keyRequired: false,
    modelSetting: 'ollama_model',
    modelRequired: true,
  },
  {
    id: 'ooba',
    name: 'Text Generation WebUI (oobabooga)',
    exampleUrl: 'http://127.0.0.1:5000',
    keyRequired: false,
    modelSetting: 'custom_model',
  },
  {
    id: 'tabby',
    name: 'TabbyAPI',
    exampleUrl: 'http://127.0.0.1:5000',
    keyRequired: false,
    modelSetting: 'tabby_model',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    exampleUrl: 'http://127.0.0.1:8000',
    keyRequired: false,
    modelSetting: 'vllm_model',
  },
  {
    id: 'aphrodite',
    name: 'Aphrodite',
    exampleUrl: 'http://127.0.0.1:2242',
    keyRequired: false,
    modelSetting: 'aphrodite_model',
  },
  {
    id: 'generic',
    name: 'Generic (OpenAI-compatible)',
    exampleUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    modelSetting: 'generic_model',
  },
  { id: 'huggingface', name: 'HuggingFace (Inference Endpoint)', keyRequired: true },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    server: 'https://openrouter.ai/api',
    keyRequired: true,
    modelSetting: 'openrouter_model',
    modelRequired: true,
    defaultModel: 'openrouter/auto',
    defaultHeaders: STHeaders,
  },
  {
    id: 'featherless',
    name: 'Featherless',
    server: 'https://api.featherless.ai/v1',
    keyRequired: true,
    modelSetting: 'featherless_model',
    modelRequired: true,
    defaultHeaders: STHeaders,
  },
  {
    id: 'infermaticai',
    name: 'InfermaticAI',
    server: 'https://api.totalgpt.ai',
    keyRequired: true,
    modelSetting: 'infermaticai_model',
    modelRequired: true,
  },
  {
    id: 'togetherai',
    name: 'TogetherAI',
    server: 'https://api.together.xyz',
    keyRequired: true,
    modelSetting: 'togetherai_model',
    modelRequired: true,
    defaultModel: 'Gryphe/MythoMax-L2-13b',
  },
  {
    id: 'dreamgen',
    name: 'DreamGen',
    server: 'https://dreamgen.com',
    keyRequired: true,
    modelSetting: 'dreamgen_model',
    modelRequired: true,
    defaultModel: 'lucid-v1-extra-large/text',
  },
  {
    id: 'mancer',
    name: 'Mancer',
    server: 'https://neuro.mancer.tech',
    keyRequired: true,
    modelSetting: 'mancer_model',
    modelRequired: true,
    defaultModel: 'mytholite',
  },
];

export function getTextgenType(id: string): TextgenTypeDefinition | undefined {
  return textgenTypes.find((t) => t.id === id);
}

/** Origins a key for this backend may be sent to. */
export function textgenOrigins(type: TextgenTypeDefinition, serverUrl?: string): string[] {
  try {
    return [new URL(type.server ?? serverUrl ?? '').origin];
  } catch {
    return [];
  }
}

/** SillyTavern's Text Completion settings (`textgenerationwebui_settings`) with their defaults. */
export type TextgenSettings = Record<string, unknown> & typeof defaultTextgenSettings;

const OOBA_DEFAULT_ORDER = [
  'repetition_penalty',
  'presence_penalty',
  'frequency_penalty',
  'dry',
  'temperature',
  'dynamic_temperature',
  'quadratic_sampling',
  'top_n_sigma',
  'top_k',
  'top_p',
  'typical_p',
  'epsilon_cutoff',
  'eta_cutoff',
  'tfs',
  'top_a',
  'min_p',
  'adaptive_p',
  'mirostat',
  'xtc',
  'encoder_repetition_penalty',
  'no_repeat_ngram',
];
const LLAMACPP_DEFAULT_ORDER = [
  'penalties',
  'dry',
  'top_n_sigma',
  'top_k',
  'typ_p',
  'top_p',
  'min_p',
  'xtc',
  'temperature',
  'adaptive_p',
];
export const APHRODITE_DEFAULT_ORDER = [
  'dry',
  'penalties',
  'no_repeat_ngram',
  'temperature',
  'top_nsigma',
  'top_p_top_k',
  'top_a',
  'min_p',
  'tfs',
  'eta_cutoff',
  'epsilon_cutoff',
  'typical_p',
  'quadratic',
  'xtc',
];

export const defaultTextgenSettings = {
  temp: 0.7,
  temperature_last: true,
  top_p: 0.5,
  top_k: 40,
  top_a: 0,
  tfs: 1,
  epsilon_cutoff: 0,
  eta_cutoff: 0,
  typical_p: 1,
  min_p: 0,
  rep_pen: 1.2,
  rep_pen_range: 0,
  rep_pen_decay: 0,
  rep_pen_slope: 1,
  no_repeat_ngram_size: 0,
  penalty_alpha: 0,
  num_beams: 1,
  length_penalty: 1,
  min_length: 0,
  encoder_rep_pen: 1,
  freq_pen: 0,
  presence_pen: 0,
  skew: 0,
  do_sample: true,
  early_stopping: false,
  dynatemp: false,
  min_temp: 0,
  max_temp: 2.0,
  dynatemp_exponent: 1.0,
  smoothing_factor: 0.0,
  smoothing_curve: 1.0,
  dry_allowed_length: 2,
  dry_multiplier: 0.0,
  dry_base: 1.75,
  dry_sequence_breakers: '["\\n", ":", "\\"", "*"]',
  dry_penalty_last_n: 0,
  max_tokens_second: 0,
  seed: -1,
  add_bos_token: true,
  ban_eos_token: false,
  skip_special_tokens: true,
  include_reasoning: true,
  streaming: false,
  mirostat_mode: 0,
  mirostat_tau: 5,
  mirostat_eta: 0.1,
  guidance_scale: 1,
  negative_prompt: '',
  grammar_string: '',
  json_schema: null as Record<string, unknown> | null,
  json_schema_allow_empty: false,
  banned_tokens: '',
  global_banned_tokens: '',
  send_banned_tokens: true,
  sampler_priority: OOBA_DEFAULT_ORDER,
  samplers: LLAMACPP_DEFAULT_ORDER,
  samplers_priorities: APHRODITE_DEFAULT_ORDER,
  ignore_eos_token: false,
  spaces_between_special_tokens: true,
  speculative_ngram: false,
  type: 'ooba' as string,
  mancer_model: 'mytholite',
  togetherai_model: 'Gryphe/MythoMax-L2-13b',
  infermaticai_model: '',
  ollama_model: '',
  openrouter_model: 'openrouter/auto',
  openrouter_providers: [] as string[],
  openrouter_quantizations: [] as string[],
  vllm_model: '',
  aphrodite_model: '',
  dreamgen_model: 'lucid-v1-extra-large/text',
  tabby_model: '',
  llamacpp_model: '',
  sampler_order: [6, 0, 1, 3, 4, 2, 5],
  logit_bias: [] as { text?: string; value?: number }[],
  n: 1,
  server_urls: {} as Record<string, string>,
  custom_model: '',
  bypass_status_check: false,
  openrouter_allow_fallbacks: true,
  xtc_threshold: 0.1,
  xtc_probability: 0,
  nsigma: 0.0,
  min_keep: 0,
  featherless_model: '',
  generic_model: '',
  extensions: {} as Record<string, unknown>,
  adaptive_target: -0.01,
  adaptive_decay: 0.9,
};

/** Adds the default order's missing items, at their default positions (`insertMissingArrayItems`). */
function insertMissingItems(source: readonly string[], target: string[]): void {
  for (const item of source) {
    if (!target.includes(item)) target.splice(source.indexOf(item), 0, item);
  }
}

/**
 * Text Completion settings as SillyTavern holds them after loading settings or a preset: the
 * defaults for missing keys, and sampler order lists completed with newer samplers.
 */
export function normalizeTextgenSettings(raw: Record<string, unknown> | null | undefined): TextgenSettings {
  const settings = structuredClone({ ...defaultTextgenSettings, ...raw }) as TextgenSettings;
  settings.extensions = (settings.extensions as Record<string, unknown> | null) || {};
  settings.json_schema = settings.json_schema ?? null;
  if (!Array.isArray(settings.sampler_order)) settings.sampler_order = [6, 0, 1, 3, 4, 2, 5];
  if (!Array.isArray(settings.sampler_priority)) settings.sampler_priority = [...OOBA_DEFAULT_ORDER];
  insertMissingItems(OOBA_DEFAULT_ORDER, settings.sampler_priority);
  if (!Array.isArray(settings.samplers_priorities))
    settings.samplers_priorities = [...APHRODITE_DEFAULT_ORDER];
  insertMissingItems(APHRODITE_DEFAULT_ORDER, settings.samplers_priorities);
  if (!Array.isArray(settings.samplers)) settings.samplers = [...LLAMACPP_DEFAULT_ORDER];
  insertMissingItems(LLAMACPP_DEFAULT_ORDER, settings.samplers);
  if (!Array.isArray(settings.logit_bias)) settings.logit_bias = [];
  return settings;
}

/** Keys a Text Completion preset file carries (connection settings are left out). */
export const textgenPresetExcludedKeys = [
  'type',
  'server_urls',
  'streaming',
  'n',
  'custom_model',
  'bypass_status_check',
  'mancer_model',
  'togetherai_model',
  'infermaticai_model',
  'ollama_model',
  'openrouter_model',
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'vllm_model',
  'aphrodite_model',
  'dreamgen_model',
  'tabby_model',
  'llamacpp_model',
  'featherless_model',
  'generic_model',
  'include_reasoning',
  'global_banned_tokens',
  'send_banned_tokens',
  'max_tokens_second',
];

/** The model a request names (`getTextGenModel`); `undefined` lets the backend decide. */
export function textgenModel(settings: TextgenSettings): string | undefined {
  switch (settings.type) {
    case 'ooba':
      return settings.custom_model || undefined;
    case 'generic':
      return settings.generic_model || undefined;
    case 'huggingface':
      return 'tgi';
    case 'tabby':
      return settings.tabby_model || undefined;
    case 'llamacpp':
      return settings.llamacpp_model || undefined;
    case 'ollama':
      if (!settings.ollama_model) throw new Error('No Ollama model selected');
      return settings.ollama_model;
    default: {
      const setting = getTextgenType(settings.type)?.modelSetting;
      return setting ? String(settings[setting] ?? '') : undefined;
    }
  }
}

/** The server a request goes to (`getTextGenServer`). */
export function textgenServer(settings: TextgenSettings): string {
  return getTextgenType(settings.type)?.server ?? settings.server_urls[settings.type] ?? '';
}

const DYNATEMP_TYPES = ['ooba', 'mancer', 'koboldcpp', 'tabby', 'llamacpp', 'aphrodite'];

function toIntArray(text: string): number[] {
  if (!text) return [];
  return text
    .split(',')
    .map((x) => parseInt(x))
    .filter((x) => !isNaN(x));
}

/** `replaceMacrosInList`: macros in a JSON array or comma separated list. */
function replaceMacrosInList(text: unknown, substitute: (text: string) => string): unknown {
  if (!text || typeof text !== 'string') return text;
  try {
    const array = JSON.parse(text) as unknown;
    if (!Array.isArray(array)) throw new Error('Not an array');
    return JSON.stringify(array.map((x) => substitute(x as string)));
  } catch {
    return text
      .split(',')
      .map((x) => substitute(x))
      .join(',');
  }
}

function parseSequenceBreakers(value: unknown): unknown {
  try {
    return JSON.parse(value as string);
  } catch {
    return typeof value === 'string' ? value.split(',') : undefined;
  }
}

/** Splits a token id list or text into token ids; `undefined` when it cannot be tokenized here. */
export type TextTokenizer = (text: string) => number[] | undefined;

/** The lines `customTokenBans` reads, after macros. */
function banSequences(
  settings: TextgenSettings,
  substitute: (text: string) => string,
  bannedInMacros: readonly string[],
): string[] {
  if (
    !settings.send_banned_tokens ||
    (!settings.banned_tokens && !settings.global_banned_tokens && !bannedInMacros.length)
  ) {
    return [];
  }
  return [
    ...String(settings.banned_tokens ?? '').split('\n'),
    ...String(settings.global_banned_tokens ?? '').split('\n'),
    ...bannedInMacros,
  ]
    .filter((x) => x.length > 0)
    .filter((x, i, all) => all.indexOf(x) === i)
    .map((x) => substitute(x));
}

/** What a logit bias entry tokenizes: `{verbatim}`, or the text after a space; nothing for id lists. */
function biasText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed.slice(1, -1);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return undefined;
  return ` ${trimmed}`;
}

/**
 * The texts banned tokens and logit bias need token ids for, so they can be tokenized
 * (asynchronously) before the request is built.
 */
export function textgenTokenizationNeeds(
  settings: TextgenSettings,
  substitute: (text: string) => string,
  bannedInMacros: readonly string[] = [],
): string[] {
  const bans = banSequences(settings, substitute, bannedInMacros).filter(
    (line) => !(line.startsWith('[') && line.endsWith(']')) && !(line.startsWith('"') && line.endsWith('"')),
  );
  const bias = Array.isArray(settings.logit_bias)
    ? settings.logit_bias.map((e) => biasText(e.text)).filter((t): t is string => t !== undefined)
    : [];
  return [...new Set([...bans, ...bias])];
}

/** Banned tokens and strings (`getCustomTokenBans`). */
export function customTokenBans(
  settings: TextgenSettings,
  substitute: (text: string) => string,
  bannedInMacros: readonly string[] = [],
  tokenize?: TextTokenizer,
): { banned_tokens: string; banned_strings: string[] } {
  const tokens: number[] = [];
  const strings: string[] = [];
  for (const line of banSequences(settings, substitute, bannedInMacros)) {
    if (line.startsWith('[') && line.endsWith(']')) {
      try {
        const ids = JSON.parse(line) as unknown;
        if (Array.isArray(ids) && ids.every((t) => Number.isInteger(t))) tokens.push(...(ids as number[]));
      } catch {
        // not a token list
      }
    } else if (line.startsWith('"') && line.endsWith('"')) {
      strings.push(line.slice(1, -1));
    } else {
      tokens.push(...(tokenize?.(line) ?? []));
    }
  }
  return {
    banned_tokens: tokens
      .filter((x, i, all) => all.indexOf(x) === i)
      .map(String)
      .join(','),
    banned_strings: strings,
  };
}

/** Logit bias entries → `{ tokenId: bias }` (`calculateLogitBias`). */
export function textgenLogitBias(
  entries: readonly { text?: string; value?: number }[],
  tokenize?: TextTokenizer,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const entry of entries) {
    const text = entry.text?.trim();
    if (!text) continue;
    let tokens: number[] | undefined;
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const ids = JSON.parse(text) as unknown;
        if (Array.isArray(ids) && ids.every((t) => Number.isInteger(t))) tokens = ids as number[];
      } catch {
        // not a token list
      }
    } else {
      tokens = tokenize?.(biasText(text)!);
    }
    for (const token of tokens ?? []) result[String(token)] = Number(entry.value);
  }
  return result;
}

export interface TextgenDataOptions {
  settings: TextgenSettings;
  prompt: string;
  /** Response length (SillyTavern `amount_gen`). */
  maxTokens: number;
  /** Context size (SillyTavern `max_context`). */
  maxContext: number;
  type: GenerationType;
  stoppingStrings: string[];
  substitute: (text: string) => string;
  /** Words from `{{banned "..."}}` macros. */
  bannedInMacros?: readonly string[];
  tokenize?: TextTokenizer;
  /** Ask for token probabilities (SillyTavern `request_token_probabilities`). */
  logprobs?: boolean;
  stream: boolean;
}

/** The body SillyTavern's client sends for a Text Completion (`createTextGenGenerationData`). */
export function textgenGenerateData(o: TextgenDataOptions): Record<string, unknown> {
  const { settings: s, maxTokens, maxContext } = o;
  const type = s.type;
  const model = textgenModel(s);
  const isContinue = o.type === 'continue';
  const isImpersonate = o.type === 'impersonate';
  const canMultiSwipe = !isContinue && !isImpersonate && o.type !== 'quiet';
  const dynatemp = Boolean(s.dynatemp) && DYNATEMP_TYPES.includes(type);
  const { banned_tokens, banned_strings } = customTokenBans(s, o.substitute, o.bannedInMacros, o.tokenize);
  const schema = s.json_schema;
  const jsonSchema =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? s.json_schema_allow_empty || Object.keys(schema).length > 0
        ? schema
        : undefined
      : undefined;
  const stop = o.stoppingStrings;
  const logprobsNumber = type === 'vllm' || type === 'infermaticai' ? 5 : 10;
  const temperature = dynatemp ? (s.min_temp + s.max_temp) / 2 : s.temp;

  let params: Record<string, unknown> = {
    prompt: o.prompt,
    model,
    max_new_tokens: maxTokens,
    max_tokens: maxTokens,
    logprobs: o.logprobs ? logprobsNumber : undefined,
    temperature,
    top_p: s.top_p,
    typical_p: s.typical_p,
    typical: s.typical_p,
    sampler_seed: s.seed >= 0 ? s.seed : undefined,
    min_p: s.min_p,
    repetition_penalty: s.rep_pen,
    frequency_penalty: s.freq_pen,
    presence_penalty: s.presence_pen,
    top_k: s.top_k,
    skew: s.skew,
    min_length: type === 'ooba' ? s.min_length : undefined,
    minimum_message_content_tokens: type === 'dreamgen' ? s.min_length : undefined,
    min_tokens: s.min_length,
    num_beams: type === 'ooba' ? s.num_beams : undefined,
    length_penalty: type === 'ooba' ? s.length_penalty : undefined,
    early_stopping: type === 'ooba' ? s.early_stopping : undefined,
    add_bos_token: s.add_bos_token,
    dynamic_temperature: dynatemp ? true : undefined,
    dynatemp_low: dynatemp ? s.min_temp : undefined,
    dynatemp_high: dynatemp ? s.max_temp : undefined,
    dynatemp_range: dynatemp ? (s.max_temp - s.min_temp) / 2 : undefined,
    dynatemp_exponent: dynatemp ? s.dynatemp_exponent : undefined,
    smoothing_factor: s.smoothing_factor,
    smoothing_curve: s.smoothing_curve,
    dry_allowed_length: s.dry_allowed_length,
    dry_multiplier: s.dry_multiplier,
    dry_base: s.dry_base,
    dry_sequence_breakers: replaceMacrosInList(s.dry_sequence_breakers, o.substitute),
    dry_penalty_last_n: s.dry_penalty_last_n,
    max_tokens_second: s.max_tokens_second,
    sampler_priority: type === 'ooba' ? s.sampler_priority : undefined,
    samplers: type === 'llamacpp' ? s.samplers : undefined,
    stopping_strings: stop,
    stop,
    truncation_length: maxContext,
    ban_eos_token: s.ban_eos_token,
    skip_special_tokens: s.skip_special_tokens,
    include_reasoning: s.include_reasoning,
    top_a: s.top_a,
    tfs: s.tfs,
    epsilon_cutoff: ['ooba', 'mancer'].includes(type) ? s.epsilon_cutoff : undefined,
    eta_cutoff: ['ooba', 'mancer'].includes(type) ? s.eta_cutoff : undefined,
    mirostat_mode: s.mirostat_mode,
    mirostat_tau: s.mirostat_tau,
    mirostat_eta: s.mirostat_eta,
    custom_token_bans: ['aphrodite', 'mancer'].includes(type) ? toIntArray(banned_tokens) : banned_tokens,
    banned_strings,
    api_type: type,
    api_server: textgenServer(s),
    sampler_order: type === 'koboldcpp' ? s.sampler_order : undefined,
    xtc_threshold: s.xtc_threshold,
    xtc_probability: s.xtc_probability,
    nsigma: s.nsigma,
    top_n_sigma: s.nsigma,
    min_keep: s.min_keep,
    adaptive_target: s.adaptive_target,
    adaptive_decay: s.adaptive_decay,
  };
  const nonAphroditeParams = {
    rep_pen: s.rep_pen,
    rep_pen_range: s.rep_pen_range,
    repetition_decay: type === 'tabby' ? s.rep_pen_decay : undefined,
    repetition_penalty_range: s.rep_pen_range,
    encoder_repetition_penalty: type === 'ooba' ? s.encoder_rep_pen : undefined,
    no_repeat_ngram_size: type === 'ooba' ? s.no_repeat_ngram_size : undefined,
    penalty_alpha: type === 'ooba' ? s.penalty_alpha : undefined,
    temperature_last:
      type === 'ooba' || type === 'aphrodite' || type === 'tabby' ? s.temperature_last : undefined,
    speculative_ngram: type === 'tabby' ? s.speculative_ngram : undefined,
    do_sample: type === 'ooba' ? s.do_sample : undefined,
    seed: s.seed >= 0 ? s.seed : undefined,
    guidance_scale: s.guidance_scale ?? 1,
    negative_prompt: o.substitute(String(s.negative_prompt ?? '')) ?? '',
    grammar_string: s.grammar_string || undefined,
    json_schema: ['tabby', 'llamacpp'].includes(type) ? jsonSchema : undefined,
    // llama.cpp aliases, for LM Studio and the like
    repeat_penalty: s.rep_pen,
    repeat_last_n: s.rep_pen_range,
    n_predict: maxTokens,
    num_predict: maxTokens,
    num_ctx: maxContext,
    mirostat: s.mirostat_mode,
    ignore_eos: s.ban_eos_token,
    n_probs: o.logprobs ? 10 : undefined,
    rep_pen_slope: s.rep_pen_slope,
  };
  const vllmParams = {
    n: canMultiSwipe ? s.n : 1,
    ignore_eos: s.ignore_eos_token,
    spaces_between_special_tokens: s.spaces_between_special_tokens,
    seed: s.seed >= 0 ? s.seed : undefined,
  };
  const aphroditeParams = {
    n: canMultiSwipe ? s.n : 1,
    frequency_penalty: s.freq_pen,
    presence_penalty: s.presence_pen,
    repetition_penalty: s.rep_pen,
    seed: s.seed >= 0 ? s.seed : undefined,
    stop,
    temperature,
    temperature_last: s.temperature_last,
    top_p: s.top_p,
    top_k: s.top_k,
    top_a: s.top_a,
    min_p: s.min_p,
    tfs: s.tfs,
    eta_cutoff: s.eta_cutoff,
    epsilon_cutoff: s.epsilon_cutoff,
    typical_p: s.typical_p,
    smoothing_factor: s.smoothing_factor,
    smoothing_curve: s.smoothing_curve,
    ignore_eos: s.ignore_eos_token,
    min_tokens: s.min_length,
    skip_special_tokens: s.skip_special_tokens,
    spaces_between_special_tokens: s.spaces_between_special_tokens,
    guided_grammar: s.grammar_string || undefined,
    guided_json: jsonSchema || undefined,
    early_stopping: false,
    include_stop_str_in_output: false,
    dynatemp_min: dynatemp ? s.min_temp : undefined,
    dynatemp_max: dynatemp ? s.max_temp : undefined,
    dynatemp_exponent: dynatemp ? s.dynatemp_exponent : undefined,
    xtc_threshold: s.xtc_threshold,
    xtc_probability: s.xtc_probability,
    nsigma: s.nsigma,
    custom_token_bans: toIntArray(banned_tokens),
    no_repeat_ngram_size: s.no_repeat_ngram_size,
    sampler_priority:
      type === 'aphrodite' &&
      JSON.stringify(s.samplers_priorities) !== JSON.stringify(APHRODITE_DEFAULT_ORDER)
        ? s.samplers_priorities
        : undefined,
  };

  if (type === 'openrouter') {
    params.provider = s.openrouter_providers;
    params.quantizations = s.openrouter_quantizations;
    params.allow_fallbacks = s.openrouter_allow_fallbacks;
  }
  if (type === 'koboldcpp') {
    params.grammar = s.grammar_string || undefined;
    params.grammar_retain_state = s.grammar_string && isContinue ? true : undefined;
    params.trim_stop = true;
    params.dry_sequence_breakers = parseSequenceBreakers(params.dry_sequence_breakers);
  }
  if (type === 'huggingface') {
    params.top_p = Math.min(Math.max(Number(params.top_p), 0.0), 0.999);
    params.stop = Array.isArray(params.stop) ? params.stop.slice(0, 4) : [];
    nonAphroditeParams.seed = s.seed >= 0 ? s.seed : Math.floor(Math.random() * Math.pow(2, 32));
  }
  if (type === 'mancer') {
    params.n = canMultiSwipe ? s.n : 1;
    params.epsilon_cutoff = (params.epsilon_cutoff as number) / 1000;
    params.eta_cutoff = (params.eta_cutoff as number) / 1000;
    params.dynatemp_mode = params.dynamic_temperature ? 1 : 0;
    params.dynatemp_min = params.dynatemp_low;
    params.dynatemp_max = params.dynatemp_high;
    delete params.dynatemp_low;
    delete params.dynatemp_high;
    params.dry_sequence_breakers = parseSequenceBreakers(params.dry_sequence_breakers);
  }
  if (type === 'tabby' || type === 'llamacpp') params.n = canMultiSwipe ? s.n : 1;

  switch (type) {
    case 'vllm':
    case 'infermaticai':
      params = Object.assign(params, vllmParams);
      break;
    case 'aphrodite':
      params = Object.assign(params, aphroditeParams);
      break;
    default:
      params = Object.assign(params, nonAphroditeParams);
      break;
  }

  if (Array.isArray(s.logit_bias) && s.logit_bias.length)
    params.logit_bias = textgenLogitBias(s.logit_bias, o.tokenize);

  if (type === 'llamacpp' || type === 'ollama') {
    const bias = params.logit_bias as Record<string, number> | undefined;
    const logitBias: [number, number | false][] =
      bias && typeof bias === 'object' && Object.keys(bias).length
        ? Object.entries(bias).map(([key, value]) => [Number(key), value])
        : [];
    logitBias.push(...toIntArray(banned_tokens).map((x): [number, false] => [Number(x), false]));
    const breakers = parseSequenceBreakers(params.dry_sequence_breakers);
    params = Object.assign(params, {
      logit_bias: logitBias,
      grammar: s.grammar_string,
      cache_prompt: true,
      dry_sequence_breakers: breakers,
    });
    if (!Array.isArray(breakers) || breakers.length === 0) delete params.dry_sequence_breakers;
  }

  if (type === 'llamacpp' || type === 'aphrodite') {
    if (jsonSchema) {
      delete params.grammar_string;
      delete params.grammar;
      delete params.guided_grammar;
    } else {
      delete params.json_schema;
      delete params.guided_json;
    }
  }
  if (o.stream) params.stream = true;
  // What JSON would carry: no undefined values.
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

const OPENAI_KEYS = [
  'model',
  'prompt',
  'stream',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'seed',
  'logit_bias',
  'logprobs',
  'max_tokens',
  'n',
  'best_of',
];
const TOGETHERAI_KEYS = [
  'model',
  'prompt',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'repetition_penalty',
  'min_p',
  'presence_penalty',
  'frequency_penalty',
  'stream',
  'stop',
];
const INFERMATICAI_KEYS = [
  'model',
  'prompt',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'repetition_penalty',
  'stream',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'min_p',
  'seed',
  'ignore_eos',
  'n',
  'best_of',
  'min_tokens',
  'spaces_between_special_tokens',
  'skip_special_tokens',
  'logprobs',
];
const VLLM_KEYS = [
  'model',
  'prompt',
  'best_of',
  'echo',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'max_tokens',
  'n',
  'presence_penalty',
  'seed',
  'stop',
  'stream',
  'suffix',
  'temperature',
  'top_p',
  'user',
  'use_beam_search',
  'top_k',
  'min_p',
  'repetition_penalty',
  'length_penalty',
  'early_stopping',
  'stop_token_ids',
  'ignore_eos',
  'min_tokens',
  'skip_special_tokens',
  'spaces_between_special_tokens',
  'truncate_prompt_tokens',
  'include_stop_str_in_output',
  'response_format',
  'guided_json',
  'guided_regex',
  'guided_choice',
  'guided_grammar',
  'guided_decoding_backend',
  'guided_whitespace_pattern',
];
const FEATHERLESS_KEYS = VLLM_KEYS;
const OPENROUTER_KEYS = [
  'max_tokens',
  'temperature',
  'top_k',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'min_p',
  'top_a',
  'seed',
  'logit_bias',
  'model',
  'stream',
  'prompt',
  'stop',
  'provider',
  'include_reasoning',
];
const OLLAMA_KEYS = [
  'num_predict',
  'num_ctx',
  'num_batch',
  'stop',
  'temperature',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
  'top_k',
  'top_p',
  'tfs_z',
  'typical_p',
  'seed',
  'repeat_last_n',
  'min_p',
];

const pick = (body: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(body).filter(([key]) => keys.includes(key)));

/** `trimV1`: no trailing slash or `/v1`. */
export function trimV1(url: string): string {
  return String(url ?? '')
    .replace(/\/$/, '')
    .replace(/\/v1$/, '');
}

const GENERATE_PATHS: Record<string, string> = {
  dreamgen: '/api/openai/v1/completions',
  mancer: '/oai/v1/completions',
  llamacpp: '/completion',
  ollama: '/api/generate',
  openrouter: '/v1/chat/completions',
};

/**
 * What SillyTavern's server sends upstream for a client body: the URL for the backend type and
 * the body, filtered to the keys the backend accepts (or reshaped, for Ollama).
 */
export function textgenUpstream(
  data: Record<string, unknown>,
  options: { ollamaKeepAlive?: number; ollamaBatchSize?: number } = {},
): { url: string; body: Record<string, unknown> } {
  let body = { ...data };
  let server = String(body.api_server ?? '');
  if (server.includes('localhost')) {
    server = server.replace('localhost', '127.0.0.1');
    body.api_server = server;
  }
  const type = String(body.api_type);
  const url = trimV1(server) + (GENERATE_PATHS[type] ?? '/v1/completions');
  switch (type) {
    case 'togetherai':
      body = pick(body, TOGETHERAI_KEYS);
      break;
    case 'infermaticai':
      body = pick(body, INFERMATICAI_KEYS);
      break;
    case 'featherless':
      body = pick(body, FEATHERLESS_KEYS);
      break;
    case 'generic':
      body = pick(body, OPENAI_KEYS);
      if (Array.isArray(body.stop)) body.stop = body.stop.slice(0, 4);
      break;
    case 'openrouter': {
      if (Array.isArray(body.provider) && body.provider.length > 0) {
        body.provider = { allow_fallbacks: body.allow_fallbacks ?? true, order: body.provider };
      } else delete body.provider;
      if (Array.isArray(body.quantizations) && body.quantizations.length > 0) {
        body.provider ??= {};
        (body.provider as Record<string, unknown>).quantizations = body.quantizations;
      }
      body = pick(body, OPENROUTER_KEYS);
      break;
    }
    case 'vllm':
      body = pick(body, VLLM_KEYS);
      break;
    case 'ollama': {
      if ((options.ollamaBatchSize ?? -1) > 0) body.num_batch = options.ollamaBatchSize;
      body = {
        model: body.model,
        prompt: body.prompt,
        stream: body.stream ?? false,
        keep_alive: options.ollamaKeepAlive ?? -1,
        raw: true,
        options: pick(body, OLLAMA_KEYS),
      };
      break;
    }
  }
  return { url, body };
}

export interface TextgenConnection {
  type: TextgenTypeDefinition;
}

/** The HTTP request for a Text Completion body (the key is attached by the server). */
export function textgenRequest(data: Record<string, unknown>): HttpRequestSpec {
  const { url, body } = textgenUpstream(data);
  const type = getTextgenType(String(data.api_type));
  return {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...type?.defaultHeaders },
    body: JSON.stringify(body),
    auth: textgenAuth,
  };
}

const textgenAuth: AuthScheme = { type: 'bearer' };

/** Parses streamed and complete Text Completion responses. */
export function textgenAdapter(type: string): Pick<ProviderAdapter, 'createDecoder' | 'parseResponse'> {
  return {
    createDecoder: () => (type === 'ollama' ? ollamaDecoder() : sseDecoder()),
    parseResponse(body: unknown): StreamDelta {
      const data = (body ?? {}) as Record<string, unknown>;
      if (typeof body === 'string') return { text: body };
      if (data.error) return { error: errorMessage(data) };
      const choice = (data.choices as Record<string, unknown>[] | undefined)?.[0];
      const text =
        (choice?.text as string | undefined) ??
        ((choice?.message as Record<string, unknown> | undefined)?.content as string | undefined) ??
        (data.content as string | undefined) ??
        (data.response as string | undefined) ??
        ((data as unknown as Record<string, unknown>[])[0]?.content as string | undefined) ??
        '';
      const reasoning =
        type === 'openrouter'
          ? (choice?.reasoning as string | undefined)
          : type === 'ollama'
            ? data.thinking
            : '';
      return { text: String(text ?? ''), reasoning: String(reasoning ?? '') || undefined };
    },
  };
}

function streamError(data: Record<string, unknown>): string | undefined {
  const error = data.error as Record<string, unknown> | string | undefined;
  const message =
    (typeof error === 'object' ? error?.message : undefined) || error || data.message || data.detail;
  return message ? (typeof message === 'string' ? message : JSON.stringify(message)) : undefined;
}

function sseDecoder(): StreamDecoder {
  const parser = new SseParser();
  const decode = (events: { data: string }[]): StreamDelta[] => {
    const deltas: StreamDelta[] = [];
    for (const event of events) {
      if (event.data === '[DONE]') continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const error = streamError(data);
      if (error) {
        deltas.push({ error });
        continue;
      }
      const choice = (data.choices as Record<string, unknown>[] | undefined)?.[0];
      // Further choices (multiple swipes) are not used yet.
      if (Number(choice?.index) > 0 || Number(data.index) > 0) continue;
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const text = (choice?.text as string) || (data.content as string) || (delta?.content as string) || '';
      const reasoning = (choice?.reasoning ?? choice?.thinking ?? '') as string;
      const finishReason = (choice?.finish_reason ?? (data.stop ? data.stop_type : undefined)) as
        string | undefined;
      if (text || reasoning || finishReason) {
        deltas.push({
          ...(text ? { text } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(finishReason ? { finishReason } : {}),
        });
      }
    }
    return deltas;
  };
  return { push: (chunk) => decode(parser.push(chunk)), end: () => decode(parser.end()) };
}

function ollamaDecoder(): StreamDecoder {
  const parser = new NdjsonParser();
  const decode = (lines: unknown[]): StreamDelta[] =>
    lines.flatMap((line): StreamDelta[] => {
      const data = (line ?? {}) as Record<string, unknown>;
      if (data.error) return [{ error: String(data.error) }];
      const text = String(data.response ?? '');
      const reasoning = String(data.thinking ?? '');
      const finishReason = data.done ? String(data.done_reason ?? 'stop') : undefined;
      if (!text && !reasoning && !finishReason) return [];
      return [
        {
          ...(text ? { text } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(finishReason ? { finishReason } : {}),
        },
      ];
    });
  return { push: (chunk) => decode(parser.push(chunk)), end: () => decode(parser.end()) };
}

/** Model list request for a backend (SillyTavern's status check), `null` when there is none. */
export function textgenModelsRequest(typeId: string, serverUrl: string): HttpRequestSpec | null {
  const type = getTextgenType(typeId);
  const base = trimV1(type?.server ?? serverUrl);
  if (!base) return null;
  const paths: Record<string, string> = {
    dreamgen: '/api/openai/v1/models',
    mancer: '/oai/v1/models',
    tabby: '/v1/model/list',
    togetherai: '/api/models?&info',
    ollama: '/api/tags',
    huggingface: '/info',
  };
  return {
    url: base + (paths[typeId] ?? '/v1/models'),
    method: 'GET',
    headers: { ...type?.defaultHeaders },
    auth: textgenAuth,
  };
}

/** Model ids from a backend's model list (the status response, rewrapped like SillyTavern). */
export function parseTextgenModels(typeId: string, body: unknown): string[] {
  let data = (body ?? {}) as Record<string, unknown>;
  if (typeId === 'togetherai' && Array.isArray(body)) {
    data = { data: (body as Record<string, unknown>[]).map((x) => ({ id: x.name, ...x })) };
  }
  if (typeId === 'ollama' && Array.isArray(data.models)) {
    data = { data: (data.models as Record<string, unknown>[]).map((x) => ({ id: x.name, ...x })) };
  }
  if (typeId === 'huggingface') data = { data: [] };
  if (!Array.isArray(data.data)) return [];
  return (data.data as Record<string, unknown>[])
    .map((x) => x.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Which backends offer a setting (SillyTavern's `data-tg-type` on its controls). `except` lists
 * the backends that do not; settings missing here are offered everywhere.
 */
const SAMPLER_TYPES: Record<string, { only?: string[]; except?: string[] }> = {
  top_k: { except: ['generic'] },
  typical_p: { except: ['generic'] },
  min_p: { except: ['generic'] },
  rep_pen: { except: ['generic'] },
  skip_special_tokens: { except: ['generic'] },
  banned_tokens: { except: ['generic'] },
  top_a: { except: ['generic', 'llamacpp'] },
  tfs: { except: ['generic', 'llamacpp'] },
  n: { only: ['mancer', 'vllm', 'aphrodite', 'tabby', 'infermaticai', 'llamacpp'] },
  epsilon_cutoff: { only: ['ooba', 'mancer', 'aphrodite'] },
  eta_cutoff: { only: ['ooba', 'mancer', 'aphrodite'] },
  nsigma: { only: ['ooba', 'aphrodite', 'koboldcpp', 'llamacpp'] },
  min_keep: { only: ['llamacpp'] },
  rep_pen_range: { only: ['ooba', 'koboldcpp', 'tabby', 'ollama', 'llamacpp'] },
  rep_pen_slope: { only: ['koboldcpp'] },
  rep_pen_decay: { only: ['tabby'] },
  encoder_rep_pen: { only: ['ooba'] },
  no_repeat_ngram_size: { only: ['aphrodite', 'ooba'] },
  skew: { only: ['tabby', 'aphrodite'] },
  min_length: { only: ['mancer', 'ooba', 'tabby', 'dreamgen', 'infermaticai', 'aphrodite'] },
  max_tokens_second: { only: ['ooba'] },
  adaptive_target: { only: ['koboldcpp', 'llamacpp', 'ooba', 'tabby'] },
  smoothing_factor: { only: ['mancer', 'ooba', 'koboldcpp', 'aphrodite', 'tabby'] },
  smoothing_curve: { only: ['mancer', 'ooba', 'koboldcpp', 'aphrodite'] },
  xtc: { only: ['koboldcpp', 'aphrodite', 'mancer', 'tabby', 'ooba', 'llamacpp'] },
  dry: { only: ['aphrodite', 'mancer', 'ooba', 'koboldcpp', 'tabby', 'llamacpp', 'dreamgen'] },
  dry_penalty_last_n: { only: ['llamacpp', 'koboldcpp', 'tabby', 'aphrodite'] },
  dynatemp: { only: ['ooba', 'mancer', 'koboldcpp', 'tabby', 'llamacpp', 'aphrodite'] },
  mirostat: { only: ['ooba', 'infermaticai', 'koboldcpp', 'llamacpp', 'tabby'] },
  penalty_alpha: { only: ['ooba'] },
  do_sample: { only: ['ooba'] },
  add_bos_token: { only: ['ooba', 'tabby'] },
  ban_eos_token: { only: ['ooba', 'llamacpp', 'tabby', 'koboldcpp', 'dreamgen'] },
  ignore_eos_token: { only: ['vllm', 'aphrodite', 'infermaticai'] },
  spaces_between_special_tokens: { only: ['vllm', 'aphrodite', 'infermaticai'] },
  include_reasoning: { only: ['openrouter'] },
  temperature_last: { only: ['ooba', 'aphrodite', 'tabby'] },
  speculative_ngram: { only: ['tabby'] },
  seed: {
    only: [
      'mancer',
      'ooba',
      'koboldcpp',
      'vllm',
      'aphrodite',
      'llamacpp',
      'ollama',
      'infermaticai',
      'huggingface',
      'generic',
    ],
  },
  guidance_scale: { only: ['ooba', 'tabby'] },
  grammar_string: { only: ['ooba', 'aphrodite', 'tabby', 'koboldcpp', 'llamacpp'] },
  json_schema: { only: ['tabby', 'llamacpp', 'aphrodite'] },
  sampler_order: { only: ['koboldcpp'] },
  samplers: { only: ['llamacpp'] },
  sampler_priority: { only: ['ooba'] },
  samplers_priorities: { only: ['aphrodite'] },
};

/** Whether a backend type uses a Text Completion setting (or a group: `dry`, `xtc`, `mirostat` ...). */
export function textgenSupports(type: string, setting: string): boolean {
  const rule = SAMPLER_TYPES[setting];
  if (!rule) return true;
  if (rule.only) return rule.only.includes(type);
  return !rule.except?.includes(type);
}

/**
 * The request that tokenizes text with the backend's own tokenizer (SillyTavern's
 * `/api/tokenizers/remote/textgenerationwebui/encode`), `null` for backends without one.
 */
export function textgenTokenizeRequest(
  type: string,
  serverUrl: string,
  model: string,
  text: string,
): HttpRequestSpec | null {
  const base = trimV1(serverUrl);
  const post = (path: string, body: object): HttpRequestSpec => ({
    url: base + path,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    auth: textgenAuth,
  });
  switch (type) {
    case 'tabby':
      return post('/v1/token/encode', { text, add_bos_token: false, encode_special_tokens: false });
    case 'koboldcpp':
      return post('/api/extra/tokencount', { prompt: text, special: false });
    case 'llamacpp':
      return post('/tokenize', { model, content: text });
    case 'vllm':
      return post('/tokenize', { model, prompt: text });
    case 'aphrodite':
      return post('/v1/tokenize', { model, prompt: text });
    case 'ooba':
      return post('/v1/internal/encode', { text });
    default:
      return null;
  }
}

/** Token count and ids from a backend's tokenize response. */
export function parseTextgenTokenize(body: unknown): { count: number; ids: number[] } | null {
  const data = (body ?? {}) as Record<string, unknown>;
  const tokens = data.tokens as unknown[] | undefined;
  const count = data.length ?? data.count ?? data.value ?? tokens?.length;
  if (typeof count !== 'number') return null;
  const ids = (data.tokens ?? data.ids ?? []) as unknown[];
  return { count, ids: ids.filter((id): id is number => typeof id === 'number') };
}
