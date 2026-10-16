import { joinUrl } from './registry.ts';
import { SseParser } from './sse.ts';
import { chatGenerateData, chatUpstream, defaultChatSourceSettings, type ChatSettings } from './st-chat.ts';
import {
  errorMessage,
  type GenerationRequest,
  type HttpRequestSpec,
  type ProviderAdapter,
  type StreamDecoder,
  type StreamDelta,
} from './types.ts';

/** SillyTavern-keyed settings for a request built from plain parameters (e.g. a connection test). */
export function settingsFromParams(request: GenerationRequest): ChatSettings {
  const p = request.params;
  return {
    temp_openai: p.temperature ?? 1,
    freq_pen_openai: p.frequency_penalty ?? 0,
    pres_pen_openai: p.presence_penalty ?? 0,
    top_p_openai: p.top_p ?? 1,
    top_k_openai: p.top_k ?? 0,
    min_p_openai: p.min_p ?? 0,
    top_a_openai: p.top_a ?? 0,
    repetition_penalty_openai: p.repetition_penalty ?? 1,
    openai_max_tokens: p.max_tokens,
    stream_openai: request.stream,
    seed: p.seed ?? -1,
    n: p.n ?? 1,
    reasoning_effort: p.reasoning_effort ?? 'auto',
    verbosity: p.verbosity ?? 'auto',
    show_thoughts: p.include_reasoning ?? true,
    custom_prompt_post_processing: '',
  };
}

/** The upstream request SillyTavern would send for this generation (OpenAI-style sources). */
export function buildOpenAIRequest(request: GenerationRequest): {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const { provider } = request;
  const data = chatGenerateData({
    source: provider.id,
    model: request.model,
    type: request.type ?? 'normal',
    messages: request.messages,
    settings: { ...defaultChatSourceSettings, ...(request.settings ?? settingsFromParams(request)) },
    stop: request.params.stop ?? [],
    names: request.names,
    logitBias: request.params.logit_bias,
    tools: request.tools,
  });
  return chatUpstream(data, {
    baseUrl: request.baseUrl || provider.baseUrl,
    includeBody: request.extraBody,
    excludeBody: request.excludeBody,
    includeHeaders: request.extraHeaders,
  });
}

/** The request body alone (tests and tools). */
export function buildOpenAIBody(request: GenerationRequest): Record<string, unknown> {
  return buildOpenAIRequest(request).body;
}

class OpenAIDecoder implements StreamDecoder {
  #sse = new SseParser();
  readonly #reasoningField: string;

  constructor(reasoningField = 'reasoning_content') {
    this.#reasoningField = reasoningField;
  }

  push(chunk: Uint8Array | string): StreamDelta[] {
    return this.#sse.push(chunk).flatMap((e) => this.#event(e.data));
  }

  end(): StreamDelta[] {
    return this.#sse.end().flatMap((e) => this.#event(e.data));
  }

  #event(data: string): StreamDelta[] {
    if (data === '[DONE]') return [];
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    if (json.error) return [{ error: errorMessage(json) }];
    const event: StreamDelta = { event: json };
    const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
    const delta = (choice?.delta ?? choice?.message ?? {}) as Record<string, unknown>;
    const out: StreamDelta = {};
    const text = delta.content ?? choice?.text;
    if (typeof text === 'string' && text) out.text = text;
    const reasoning = delta[this.#reasoningField] ?? delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (typeof choice?.finish_reason === 'string') out.finishReason = choice.finish_reason;
    if (json.usage && typeof json.usage === 'object') out.usage = json.usage as Record<string, unknown>;
    return Object.keys(out).length ? [event, out] : [event];
  }
}

export const openAIChat: ProviderAdapter = {
  buildRequest(request): HttpRequestSpec {
    const upstream = buildOpenAIRequest(request);
    return {
      url: upstream.url,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.provider.defaultHeaders,
        ...upstream.headers,
      },
      body: JSON.stringify(upstream.body),
      auth: request.provider.auth,
    };
  },
  createDecoder: () => new OpenAIDecoder(),
  parseResponse(body) {
    const json = body as Record<string, unknown>;
    if (json?.error) return { error: errorMessage(json) };
    const choice = (json?.choices as Record<string, unknown>[] | undefined)?.[0];
    const message = (choice?.message ?? {}) as Record<string, unknown>;
    return {
      text:
        typeof message.content === 'string'
          ? message.content
          : typeof choice?.text === 'string'
            ? choice.text
            : '',
      reasoning: String(message.reasoning_content ?? message.reasoning ?? '') || undefined,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    };
  },
};

export function openAIDecoderFor(reasoningField?: string): StreamDecoder {
  return new OpenAIDecoder(reasoningField);
}

export { joinUrl };
