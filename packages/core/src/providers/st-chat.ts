/**
 * Chat Completion requests for the OpenAI-style sources, built the way SillyTavern builds them:
 * first the client's `generate_data` (`createGenerationParameters` in public/scripts/openai.js),
 * then the upstream request its server derives from it (`/generate` in
 * src/endpoints/backends/chat-completions.js). Claude and Google AI Studio have their own
 * adapters (anthropic.ts, gemini.ts).
 */

import type { ChatMessage, GenerationType } from '../prompt/types.ts';
import { postProcessPrompt, type PromptNames } from '../prompt/post-process.ts';
import {
  addAssistantPrefix,
  addOpenRouterSignatures,
  addReasoningContentToToolCalls,
  embedOpenRouterMedia,
  convertAI21Messages,
  convertCohereMessages,
  convertMistralMessages,
  convertXAIMessages,
  toWire,
  type WireMessage,
} from './converters.ts';
import { GEMINI_SAFETY } from './gemini.ts';
import { toolsForRequest, type ToolDefinition } from '../tools.ts';

/** SillyTavern `chat_completion_sources` values the OpenAI-style path handles. */
const OPENAI = 'openai';
const OPENROUTER = 'openrouter';
const CUSTOM = 'custom';

const gptSources = [OPENAI, 'azure_openai', OPENROUTER];
const seedSupportedSources = [
  OPENAI,
  'azure_openai',
  OPENROUTER,
  'mistralai',
  CUSTOM,
  'cohere',
  'groq',
  'electronhub',
  'nanogpt',
  'xai',
  'pollinations',
  'aimlapi',
  'vertexai',
  'makersuite',
  'chutes',
];
const logprobsSupportedSources = [
  OPENAI,
  'azure_openai',
  OPENROUTER,
  CUSTOM,
  'deepseek',
  'xai',
  'aimlapi',
  'chutes',
];
const logitBiasSources = [OPENAI, 'azure_openai', OPENROUTER, 'electronhub', 'chutes', CUSTOM];

/** Sources SillyTavern sends a logit bias to. */
export function supportsLogitBias(source: string): boolean {
  return logitBiasSources.includes(source);
}
const multiswipeSources = [OPENAI, 'azure_openai', CUSTOM, 'xai', 'aimlapi', 'moonshot'];
const reasoningEffortSources = [
  OPENAI,
  'azure_openai',
  CUSTOM,
  'xai',
  'aimlapi',
  OPENROUTER,
  'pollinations',
  'perplexity',
  'cometapi',
  'electronhub',
  'chutes',
  'deepseek',
  'fireworks',
];

/** SillyTavern `openai_max_stop_strings`. */
const MAX_STOP_STRINGS = 4;

/** Models that accept `reasoning_effort` through the OpenAI and Custom sources. */
const OPENAI_REASONING_EFFORT_MODELS = [
  'o1',
  'o3-mini',
  'o3-mini-2025-01-31',
  'o4-mini',
  'o4-mini-2025-04-16',
  'o3',
  'o3-2025-04-16',
  'gpt-5',
  'gpt-5-2025-08-07',
  'gpt-5-mini',
  'gpt-5-mini-2025-08-07',
  'gpt-5-nano',
  'gpt-5-nano-2025-08-07',
  'gpt-5.1',
  'gpt-5.1-2025-11-13',
  'gpt-5.1-chat-latest',
  'gpt-5.2',
  'gpt-5.2-2025-12-11',
  'gpt-5.2-chat-latest',
  'gpt-5.3-chat-latest',
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.4-mini',
  'gpt-5.4-mini-2026-03-17',
  'gpt-5.4-nano',
  'gpt-5.4-nano-2026-03-17',
  'gpt-5.5',
  'gpt-5.5-2026-04-23',
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
];
const OPENAI_REASONING_EFFORT_MAP: Record<string, string> = { min: 'minimal' };
const OPENAI_FIXED_REASONING_EFFORT: Record<string, string> = { 'gpt-5.3-chat-latest': 'medium' };
const OPENAI_VERBOSITY_MODELS = /^(?:gpt-5|gpt-6-astra)/;
const NANOGPT_REASONING_EFFORT_MAP: Record<string, string> = {
  min: 'none',
  low: 'minimal',
  medium: 'low',
  high: 'medium',
  max: 'high',
};

/** Chat Completion settings with SillyTavern's `oai_settings` keys (preset plus source options). */
export type ChatSettings = Record<string, unknown>;

/** SillyTavern's defaults for the source options (`default_settings` in openai.js). */
export const defaultChatSourceSettings: ChatSettings = {
  siliconflow_endpoint: 'global',
  minimax_endpoint: 'global',
  nanogpt_provider: '',
  nanogpt_payg_override: false,
  pollinations_endpoint: 'authenticated',
  zai_endpoint: 'common',
  custom_include_body: '',
  custom_exclude_body: '',
  custom_include_headers: '',
  openrouter_use_fallback: false,
  openrouter_providers: [],
  openrouter_quantizations: [],
  openrouter_allow_fallbacks: true,
  openrouter_middleout: 'on',
  enable_web_search: false,
  request_images: false,
  request_image_aspect_ratio: '',
  request_image_resolution: '',
};

export interface ChatParamsInput {
  /** SillyTavern `chat_completion_source`. */
  source: string;
  model: string;
  type: GenerationType;
  messages: readonly ChatMessage[];
  settings: ChatSettings;
  /** Custom stopping strings with macros substituted. */
  stop: readonly string[];
  names: PromptNames;
  /** Logit bias resolved to token ids. */
  logitBias?: Record<string, number>;
  /** Ask for token probabilities (SillyTavern `request_token_probabilities`). */
  logprobs?: boolean;
  /** Function tools offered with the request. */
  tools?: readonly ToolDefinition[];
}

const num = (value: unknown) => Number(value);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Whether the reply streams (`createGenerationParameters`). */
export function chatStreams(
  settings: ChatSettings,
  type: GenerationType,
  source: string,
  model: string,
): boolean {
  const isO1 = gptSources.includes(source) && ['o1-2024-12-17', 'o1'].includes(model);
  return Boolean(settings.stream_openai) && type !== 'quiet' && !isO1;
}

/** SillyTavern `getReasoningEffort`. */
export function reasoningEffortFor(
  settings: ChatSettings,
  source: string,
  model: string,
): string | undefined {
  const effort = settings.reasoning_effort as string | undefined;
  if (!reasoningEffortSources.includes(source)) return effort;
  if (source === 'deepseek') {
    switch (effort) {
      case 'auto':
        return undefined;
      case 'min':
      case 'low':
        return 'low';
      case 'max':
        return 'max';
      default:
        return 'high';
    }
  }
  if (source === 'fireworks') {
    switch (effort) {
      case 'auto':
        return undefined;
      case 'min':
        return 'low';
      default:
        return effort;
    }
  }
  if (source === CUSTOM && /^koboldcpp\/(.+)$/.test(model)) {
    const map: Record<string, string | undefined> = {
      auto: undefined,
      min: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'xhigh',
    };
    return effort !== undefined && effort in map ? map[effort] : effort;
  }
  switch (effort) {
    case 'auto':
      return undefined;
    case 'min':
      if (source === OPENROUTER && !settings.show_thoughts) return 'none';
      if ([OPENAI, 'azure_openai'].includes(source)) {
        if (/^gpt-5\.(4|5|6)/.test(model)) return 'none';
        if (/^gpt-5/.test(model)) return 'min';
      }
      return 'low';
    case 'max':
      if ([OPENAI, 'azure_openai'].includes(source) && /^gpt-6-astra/.test(model)) return 'max';
      if ([OPENAI, 'azure_openai'].includes(source) && /^gpt-5\.6/.test(model)) return 'xhigh';
      return 'high';
    default:
      return effort;
  }
}

/**
 * The client half: SillyTavern's `generate_data` for a source. Fields left `undefined` are not
 * sent (JSON drops them), as in SillyTavern.
 */
export function chatGenerateData(input: ChatParamsInput): Record<string, unknown> {
  const { source, model, type, settings } = input;
  let messages = toWire(input.messages);
  // DeepSeek's vision model only takes images in user messages.
  if (model.toLowerCase().includes('deepseek-v4-flash-vision-exp')) {
    messages = messages.flatMap((message) => {
      if (!['system', 'assistant'].includes(message.role) || !Array.isArray(message.content))
        return [message];
      const content = (message.content as { type?: string }[]).filter((b) => b?.type !== 'image_url');
      return content.length ? [{ ...message, content }] : [];
    });
  }
  const stream = chatStreams(settings, type, source, model);
  const n = num(settings.n);
  const canMultiSwipe =
    n > 1 && !['quiet', 'impersonate', 'continue'].includes(type) && multiswipeSources.includes(source);
  const stops = (limit?: number) => (limit && limit > 0 ? input.stop.slice(0, limit) : [...input.stop]);
  const logitBias =
    logitBiasSources.includes(source) && input.logitBias && Object.keys(input.logitBias).length
      ? input.logitBias
      : undefined;

  const data: Record<string, unknown> = {
    type,
    messages,
    model,
    temperature: num(settings.temp_openai),
    frequency_penalty: num(settings.freq_pen_openai),
    presence_penalty: num(settings.pres_pen_openai),
    top_p: num(settings.top_p_openai),
    max_tokens: settings.openai_max_tokens,
    stream,
    logit_bias: logitBias,
    stop: stops(MAX_STOP_STRINGS),
    chat_completion_source: source,
    n: canMultiSwipe ? n : undefined,
    user_name: input.names.userName,
    char_name: input.names.charName,
    group_names: input.names.groupNames,
    include_reasoning: Boolean(settings.show_thoughts),
    reasoning_effort: reasoningEffortFor(settings, source, model),
    enable_web_search: Boolean(settings.enable_web_search),
    request_images: Boolean(settings.request_images),
    request_image_resolution: String(settings.request_image_resolution),
    request_image_aspect_ratio: String(settings.request_image_aspect_ratio),
    custom_prompt_post_processing: settings.custom_prompt_post_processing,
    verbosity: settings.verbosity === 'auto' ? undefined : settings.verbosity,
  };

  if (!canMultiSwipe && input.tools?.length) Object.assign(data, toolsForRequest(input.tools));
  if (!Array.isArray(data.stop) || !(data.stop as string[]).length) delete data.stop;
  if (input.logprobs && logprobsSupportedSources.includes(source)) data.logprobs = 5;

  const isVision = ['gpt', 'vision'].every((x) => model.includes(x));
  if (gptSources.includes(source) && isVision) {
    delete data.logit_bias;
    delete data.stop;
    delete data.logprobs;
  }
  if (gptSources.includes(source) && /gpt-4.5/.test(model)) delete data.logprobs;

  switch (source) {
    case OPENROUTER:
      Object.assign(data, {
        top_k: num(settings.top_k_openai),
        min_p: num(settings.min_p_openai),
        repetition_penalty: num(settings.repetition_penalty_openai),
        top_a: num(settings.top_a_openai),
        use_fallback: settings.openrouter_use_fallback,
        provider: settings.openrouter_providers,
        quantizations: settings.openrouter_quantizations,
        allow_fallbacks: settings.openrouter_allow_fallbacks,
        middleout: settings.openrouter_middleout,
      });
      break;
    case 'nanogpt':
      Object.assign(data, {
        nanogpt_provider: settings.nanogpt_provider,
        nanogpt_payg_override: settings.nanogpt_payg_override,
      });
      break;
    case 'mistralai':
      data.safe_prompt = false;
      data.stop = stops();
      break;
    case CUSTOM:
      data.custom_url = settings.custom_url;
      break;
    case 'cohere':
      data.top_p = clamp(num(settings.top_p_openai), 0.01, 0.99);
      data.top_k = num(settings.top_k_openai);
      data.frequency_penalty = clamp(num(settings.freq_pen_openai), 0, 1);
      data.presence_penalty = clamp(num(settings.pres_pen_openai), 0, 1);
      data.stop = stops(5);
      break;
    case 'perplexity':
      data.top_k = num(settings.top_k_openai);
      data.frequency_penalty = num(settings.freq_pen_openai);
      data.presence_penalty = num(settings.pres_pen_openai);
      delete data.stop;
      break;
    case 'groq':
      delete data.logprobs;
      delete data.logit_bias;
      delete data.top_logprobs;
      delete data.n;
      break;
    case 'deepseek':
      data.top_p = (data.top_p as number) || Number.EPSILON;
      break;
    case 'xai':
      if (model.includes('grok-3-mini')) {
        delete data.presence_penalty;
        delete data.frequency_penalty;
        delete data.stop;
      } else {
        // Only grok-3-mini accepts reasoning_effort.
        delete data.reasoning_effort;
      }
      if (model.includes('grok-4') || model.includes('grok-code')) {
        delete data.presence_penalty;
        delete data.frequency_penalty;
        if (!model.includes('grok-4-fast-non-reasoning')) delete data.stop;
      }
      break;
    case 'electronhub':
      data.top_k = num(settings.top_k_openai);
      break;
    case 'chutes':
      data.min_p = num(settings.min_p_openai);
      data.top_k = num(settings.top_k_openai) > 0 ? num(settings.top_k_openai) : undefined;
      data.repetition_penalty = num(settings.repetition_penalty_openai);
      data.stop = stops();
      break;
    case 'zai':
      data.top_p = (data.top_p as number) || 0.01;
      data.stop = stops(1);
      data.zai_endpoint = settings.zai_endpoint || 'common';
      delete data.presence_penalty;
      delete data.frequency_penalty;
      break;
    case 'pollinations':
      data.pollinations_endpoint = settings.pollinations_endpoint || 'authenticated';
      break;
    case 'siliconflow':
      data.siliconflow_endpoint = settings.siliconflow_endpoint || 'global';
      break;
    case 'minimax':
      data.minimax_endpoint = settings.minimax_endpoint || 'global';
      // MiniMax rejects a temperature of zero.
      if (Number.isFinite(data.temperature))
        data.temperature = clamp(data.temperature as number, Number.EPSILON, 1);
      break;
    case 'moonshot':
      if (/kimi-k2.5/.test(model)) {
        delete data.temperature;
        delete data.top_p;
        delete data.frequency_penalty;
        delete data.presence_penalty;
      }
      break;
  }
  if (source === 'nanogpt') {
    Object.assign(data, {
      top_k: num(settings.top_k_openai),
      min_p: num(settings.min_p_openai),
      repetition_penalty: num(settings.repetition_penalty_openai),
      top_a: num(settings.top_a_openai),
    });
  }
  if (seedSupportedSources.includes(source) && num(settings.seed) >= 0) data.seed = settings.seed;

  if (
    ([OPENAI, 'azure_openai'].includes(source) && /^(o1|o3|o4)/.test(model)) ||
    (source === OPENROUTER && /^openai\/(o1|o3|o4)/.test(model))
  ) {
    data.max_completion_tokens = data.max_tokens;
    for (const key of [
      'max_tokens',
      'logprobs',
      'top_logprobs',
      'stop',
      'logit_bias',
      'temperature',
      'top_p',
      'frequency_penalty',
      'presence_penalty',
    ])
      delete data[key];
    if (/^(openai\/)?(o1)/.test(model)) {
      for (const msg of data.messages as WireMessage[]) if (msg.role === 'system') msg.role = 'user';
      delete data.n;
      delete data.tools;
      delete data.tool_choice;
    }
  }
  if (gptSources.includes(source) && /gpt-5/.test(model)) {
    data.max_completion_tokens = data.max_tokens;
    delete data.max_tokens;
    delete data.logprobs;
    delete data.top_logprobs;
    if (/gpt-5-chat-latest/.test(model)) {
      delete data.tools;
      delete data.tool_choice;
    } else if (/gpt-5\.(1|2|3|4)/.test(model) && !/chat-latest/.test(model) && !data.reasoning_effort) {
      delete data.frequency_penalty;
      delete data.presence_penalty;
      delete data.logit_bias;
      delete data.stop;
    } else {
      delete data.temperature;
      delete data.top_p;
      delete data.frequency_penalty;
      delete data.presence_penalty;
      delete data.logit_bias;
      delete data.stop;
    }
  }
  if (gptSources.includes(source) && /gpt-6-astra/.test(model)) {
    data.max_completion_tokens = data.max_tokens;
    for (const key of ['max_tokens', 'temperature', 'top_p', 'logprobs', 'top_logprobs']) delete data[key];
  }
  // Claude 5 models reject sampling parameters, also through OpenAI-compatible proxies.
  if (/claude-(fable|opus-5|sonnet-5)/.test(model)) {
    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty'])
      delete data[key];
    if (source !== 'claude') delete data.reasoning_effort;
  }
  return data;
}

// -------------------------------------------------------------------------------------------------
// Server half

export interface UpstreamOptions {
  /** Base URL in place of the source's default (Custom URL, reverse proxy, regional endpoint). */
  baseUrl: string;
  /** Custom source: fields added to the body (see `includeFromYaml`). */
  includeBody?: Record<string, unknown>;
  /** Custom source: keys removed from the body (see `excludeFromYaml`). */
  excludeBody?: readonly string[];
  /** Custom source: extra headers. */
  includeHeaders?: Record<string, string>;
}

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Fields from a parsed "include body" or "include headers" setting, as SillyTavern's
 * `mergeObjectWithYaml` reads them: an object, or a list of objects merged in order.
 */
export function includeFromYaml(parsed: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(parsed)) {
    for (const item of parsed)
      if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(out, item);
  } else if (parsed && typeof parsed === 'object') {
    Object.assign(out, parsed);
  }
  return out;
}

/** Keys from a parsed "exclude body" setting (`excludeKeysByYaml`): a list, an object's keys or one key. */
export function excludeFromYaml(parsed: unknown): string[] {
  if (Array.isArray(parsed)) return parsed.map(String);
  if (parsed && typeof parsed === 'object') return Object.keys(parsed);
  if (typeof parsed === 'string') return [parsed];
  return [];
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

/**
 * The server half: the request SillyTavern's server sends upstream for `generate_data`.
 * `names` are the prompt names (`getPromptNames`).
 */
/** The request's tools as most sources take them. */
function toolParams(data: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(data.tools) && data.tools.length > 0
    ? { tools: data.tools, tool_choice: data.tool_choice }
    : {};
}

export function chatUpstream(data: Record<string, unknown>, options: UpstreamOptions): UpstreamRequest {
  const source = String(data.chat_completion_source);
  const names: PromptNames = {
    charName: String(data.char_name || ''),
    userName: String(data.user_name || ''),
    groupNames: Array.isArray(data.group_names) ? (data.group_names as unknown[]).map(String) : [],
  };
  let messages = data.messages as WireMessage[];
  if (data.custom_prompt_post_processing) {
    messages = postProcessPrompt(
      messages as ChatMessage[],
      String(data.custom_prompt_post_processing),
      names,
    ) as WireMessage[];
  }
  const stop = Array.isArray(data.stop) && (data.stop as unknown[]).length ? data.stop : undefined;
  const base = options.baseUrl;

  switch (source) {
    case 'mistralai':
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          model: data.model,
          messages: convertMistralMessages(messages, names),
          temperature: data.temperature,
          top_p: data.top_p,
          frequency_penalty: data.frequency_penalty,
          presence_penalty: data.presence_penalty,
          max_tokens: data.max_tokens,
          stream: data.stream,
          safe_prompt: data.safe_prompt,
          random_seed: data.seed === -1 ? undefined : data.seed,
          stop,
          ...toolParams(data),
        },
      };
    case 'cohere': {
      const body: Record<string, unknown> = {
        stream: Boolean(data.stream),
        model: data.model,
        messages: convertCohereMessages(messages, names),
        temperature: data.temperature,
        max_tokens: data.max_tokens,
        k: data.top_k,
        p: data.top_p,
        seed: data.seed,
        stop_sequences: data.stop,
        frequency_penalty: data.frequency_penalty,
        presence_penalty: data.presence_penalty,
        documents: [],
        // Cohere takes OpenAI's tool format, without `$schema`.
        tools: Array.isArray(data.tools)
          ? (structuredClone(data.tools) as Record<string, Record<string, Record<string, unknown>>>[]).map(
              (tool) => {
                if (tool?.function?.parameters?.$schema) delete tool.function.parameters.$schema;
                return tool;
              },
            )
          : [],
      };
      if (String(data.model).endsWith('08-2024')) body.safety_mode = 'OFF';
      return { url: join(base, 'chat'), headers: {}, body };
    }
    case 'ai21':
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages: convertAI21Messages(messages, names),
          model: data.model,
          max_tokens: data.max_tokens,
          temperature: data.temperature,
          top_p: data.top_p,
          stop: data.stop,
          stream: data.stream,
          tools: data.tools,
        },
      };
    case 'deepseek': {
      const bodyParams: Record<string, unknown> = {};
      if (num(data.logprobs) > 0) {
        bodyParams.top_logprobs = data.logprobs;
        bodyParams.logprobs = true;
      }
      if (Array.isArray(data.tools) && data.tools.length > 0) {
        // DeepSeek refuses empty `required` lists.
        bodyParams.tools = (
          structuredClone(data.tools) as Record<string, Record<string, Record<string, unknown>>>[]
        ).map((tool) => {
          const required = tool?.function?.parameters?.required;
          if (Array.isArray(required) && required.length === 0) delete tool.function!.parameters!.required;
          return tool;
        });
        bodyParams.tool_choice = data.tool_choice;
      }
      const processed = addAssistantPrefix(
        postProcessPrompt(messages as ChatMessage[], 'semi_tools', names) as WireMessage[],
        bodyParams.tools,
        'prefix',
      );
      addReasoningContentToToolCalls(processed);
      if (data.include_reasoning && data.reasoning_effort)
        bodyParams.reasoning_effort = data.reasoning_effort;
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages: processed,
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          stream: data.stream,
          presence_penalty: data.presence_penalty,
          frequency_penalty: data.frequency_penalty,
          top_p: data.top_p,
          stop: data.stop,
          seed: data.seed,
          thinking: { type: data.include_reasoning ? 'enabled' : 'disabled' },
          ...bodyParams,
        },
      };
    }
    case 'xai': {
      const bodyParams: Record<string, unknown> = {};
      if (num(data.logprobs) > 0) {
        bodyParams.top_logprobs = data.logprobs;
        bodyParams.logprobs = true;
      }
      if (stop) bodyParams.stop = stop;
      if (data.reasoning_effort)
        bodyParams.reasoning_effort = data.reasoning_effort === 'high' ? 'high' : 'low';
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages: convertXAIMessages(messages, names),
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          max_completion_tokens: data.max_completion_tokens,
          stream: data.stream,
          presence_penalty: data.presence_penalty,
          frequency_penalty: data.frequency_penalty,
          top_p: data.top_p,
          seed: data.seed,
          n: data.n,
          ...toolParams(data),
          ...bodyParams,
        },
      };
    }
    case 'aimlapi': {
      const bodyParams: Record<string, unknown> = {};
      if (num(data.logprobs) > 0) {
        bodyParams.top_logprobs = data.logprobs;
        bodyParams.logprobs = true;
      }
      if (stop) bodyParams.stop = stop;
      if (data.reasoning_effort) bodyParams.reasoning_effort = data.reasoning_effort;
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages,
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          stream: data.stream,
          presence_penalty: data.presence_penalty,
          frequency_penalty: data.frequency_penalty,
          top_p: data.top_p,
          seed: data.seed,
          n: data.n,
          ...toolParams(data),
          ...bodyParams,
        },
      };
    }
    case 'electronhub': {
      const bodyParams: Record<string, unknown> = {};
      if (data.enable_web_search) bodyParams.web_search = true;
      if (data.reasoning_effort) bodyParams.reasoning_effort = data.reasoning_effort;
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages,
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          stream: data.stream,
          presence_penalty: data.presence_penalty,
          frequency_penalty: data.frequency_penalty,
          top_p: data.top_p,
          top_k: data.top_k,
          logit_bias: data.logit_bias,
          seed: data.seed,
          ...toolParams(data),
          ...bodyParams,
        },
      };
    }
    case 'minimax':
      // MiniMax rejects consecutive messages with the same role.
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages: postProcessPrompt(messages as ChatMessage[], 'merge_tools', names),
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.model === 'M2-her' ? Math.min(num(data.max_tokens), 2048) : data.max_tokens,
          stream: data.stream,
          top_p: data.top_p,
          stop: data.stop,
          ...toolParams(data),
        },
      };
    case 'chutes': {
      const bodyParams: Record<string, unknown> = {};
      if (num(data.logprobs) > 0) {
        bodyParams.top_logprobs = data.logprobs;
        bodyParams.logprobs = true;
      }
      return {
        url: join(base, 'chat/completions'),
        headers: {},
        body: {
          messages,
          model: data.model,
          temperature: data.temperature,
          max_tokens: data.max_tokens,
          stream: data.stream,
          presence_penalty: data.presence_penalty,
          frequency_penalty: data.frequency_penalty,
          repetition_penalty: data.repetition_penalty,
          min_p: data.min_p,
          top_p: data.top_p,
          top_k: data.top_k,
          seed: data.seed,
          stop: data.stop,
          reasoning_effort: data.reasoning_effort,
          logit_bias: data.logit_bias,
          ...toolParams(data),
          ...bodyParams,
        },
      };
    }
  }
  return genericUpstream(source, data, messages, names, options);
}

/** Sources served by SillyTavern's generic OpenAI-compatible path. */
function genericUpstream(
  source: string,
  data: Record<string, unknown>,
  input: WireMessage[],
  names: PromptNames,
  options: UpstreamOptions,
): UpstreamRequest {
  let messages = input;
  const headers: Record<string, string> = {};
  let bodyParams: Record<string, unknown> = {};
  switch (source) {
    case OPENAI:
    case CUSTOM:
      bodyParams = { logprobs: data.logprobs, top_logprobs: undefined };
      if (num(bodyParams.logprobs) > 0) {
        bodyParams.top_logprobs = bodyParams.logprobs;
        bodyParams.logprobs = true;
      }
      if (source === CUSTOM) {
        Object.assign(bodyParams, options.includeBody);
        Object.assign(headers, options.includeHeaders);
      }
      break;
    case OPENROUTER: {
      bodyParams = {
        transforms: openRouterTransforms(data.middleout),
        plugins: data.enable_web_search ? [{ id: 'web' }] : [],
        reasoning: { exclude: !data.include_reasoning },
      };
      if (num(data.logprobs) > 0) {
        bodyParams.top_logprobs = data.logprobs;
        bodyParams.logprobs = true;
      }
      if (data.min_p !== undefined) bodyParams.min_p = data.min_p;
      if (data.top_a !== undefined) bodyParams.top_a = data.top_a;
      if (data.repetition_penalty !== undefined) bodyParams.repetition_penalty = data.repetition_penalty;
      if (Array.isArray(data.provider) && data.provider.length > 0) {
        bodyParams.provider = { allow_fallbacks: data.allow_fallbacks ?? true, order: data.provider ?? [] };
      }
      if (Array.isArray(data.quantizations) && data.quantizations.length > 0) {
        bodyParams.provider ??= {};
        (bodyParams.provider as Record<string, unknown>).quantizations = data.quantizations;
      }
      if (data.use_fallback) bodyParams.route = 'fallback';
      if (data.reasoning_effort)
        (bodyParams.reasoning as Record<string, unknown>).effort = data.reasoning_effort;
      if (data.verbosity) bodyParams.verbosity = data.verbosity;
      if (/google\/gemini/.test(String(data.model))) bodyParams.safety_settings = GEMINI_SAFETY;
      break;
    }
    case 'perplexity':
      bodyParams = { reasoning_effort: data.reasoning_effort };
      messages = postProcessPrompt(messages as ChatMessage[], 'strict', names) as WireMessage[];
      break;
    case 'fireworks':
      if (data.reasoning_effort) bodyParams.reasoning_effort = data.reasoning_effort;
      break;
    case 'nanogpt':
      if (data.nanogpt_provider) headers['X-Provider'] = String(data.nanogpt_provider);
      if (data.nanogpt_payg_override) {
        headers['X-Billing-Mode'] = 'paygo';
        bodyParams.billing_mode = 'paygo';
      }
      if (data.enable_web_search && !/:online$/.test(String(data.model)))
        data = { ...data, model: `${data.model}:online` };
      if (data.min_p !== undefined) bodyParams.min_p = data.min_p;
      if (data.top_a !== undefined) bodyParams.top_a = data.top_a;
      if (data.repetition_penalty !== undefined) bodyParams.repetition_penalty = data.repetition_penalty;
      if (data.reasoning_effort) {
        bodyParams.reasoning = { effort: NANOGPT_REASONING_EFFORT_MAP[String(data.reasoning_effort)] };
      }
      break;
    case 'pollinations': {
      const anonymous = data.pollinations_endpoint === 'anonymous';
      bodyParams = { seed: data.seed ?? Math.floor(Math.random() * 99999999) };
      if (!anonymous) bodyParams.reasoning_effort = data.reasoning_effort;
      break;
    }
    case 'moonshot':
      bodyParams = { thinking: { type: data.include_reasoning ? 'enabled' : 'disabled' } };
      addAssistantPrefix(messages, undefined, 'partial');
      break;
    case 'cometapi':
      bodyParams = { reasoning_effort: data.reasoning_effort };
      break;
    case 'zai':
      headers['Accept-Language'] = 'en-US,en';
      bodyParams = { thinking: { type: data.include_reasoning ? 'enabled' : 'disabled' } };
      break;
  }
  // A few of OpenAI's reasoning models take a reasoning effort.
  if (data.reasoning_effort && (source === CUSTOM || source === OPENAI)) {
    const model = String(data.model);
    if (OPENAI_REASONING_EFFORT_MODELS.includes(model)) {
      const effort = String(data.reasoning_effort);
      bodyParams.reasoning_effort =
        OPENAI_FIXED_REASONING_EFFORT[model] ?? OPENAI_REASONING_EFFORT_MAP[effort] ?? effort;
    }
    if (source === CUSTOM && /^koboldcpp\/(.+)$/.test(model))
      bodyParams.reasoning_effort = data.reasoning_effort;
  }
  if (
    data.verbosity &&
    (source === CUSTOM || source === OPENAI) &&
    OPENAI_VERBOSITY_MODELS.test(String(data.model))
  ) {
    bodyParams.verbosity = data.verbosity;
  }
  if (Array.isArray(data.stop) && data.stop.length > 0) bodyParams.stop = data.stop;
  Object.assign(bodyParams, toolParams(data));
  if (source === OPENROUTER) {
    embedOpenRouterMedia(messages);
    addOpenRouterSignatures(messages, String(data.model));
  }

  const body: Record<string, unknown> = {
    messages,
    model: data.model,
    temperature: data.temperature,
    max_tokens: data.max_tokens,
    max_completion_tokens: data.max_completion_tokens,
    stream: data.stream,
    presence_penalty: data.presence_penalty,
    frequency_penalty: data.frequency_penalty,
    top_p: data.top_p,
    top_k: data.top_k,
    stop: data.stop,
    logit_bias: data.logit_bias,
    seed: data.seed,
    n: data.n,
    ...bodyParams,
  };
  if (source === CUSTOM) for (const key of options.excludeBody ?? []) delete body[key];
  return { url: join(options.baseUrl, 'chat/completions'), headers, body };
}

function openRouterTransforms(middleout: unknown): string[] | undefined {
  switch (middleout) {
    case 'on':
      return ['middle-out'];
    case 'off':
      return [];
    default:
      return undefined;
  }
}
