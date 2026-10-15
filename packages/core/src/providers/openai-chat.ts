import type { ChatMessage } from '../prompt/types.ts';
import { SseParser } from './sse.ts';
import { joinUrl } from './registry.ts';
import {
  errorMessage,
  type GenerationRequest,
  type HttpRequestSpec,
  type ProviderAdapter,
  type StreamDecoder,
  type StreamDelta,
} from './types.ts';

/** Strips fields only BakaTavern uses internally. */
function wireMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out.name = m.name;
  if (m.tool_calls) out.tool_calls = m.tool_calls.map(({ signature: _s, ...rest }) => rest);
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

export function buildOpenAIBody(request: GenerationRequest): Record<string, unknown> {
  const { provider, params } = request;
  const s = provider.samplers ?? {};
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(wireMessage),
    stream: request.stream,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  // SillyTavern sends both penalties whenever the source accepts them, zero included.
  if (s.penalties) {
    if (params.frequency_penalty !== undefined) body.frequency_penalty = params.frequency_penalty;
    if (params.presence_penalty !== undefined) body.presence_penalty = params.presence_penalty;
  }
  if (s.topK && params.top_k) body.top_k = params.top_k;
  if (s.minP && params.min_p) body.min_p = params.min_p;
  if (s.topA && params.top_a) body.top_a = params.top_a;
  if (s.repetitionPenalty && params.repetition_penalty && params.repetition_penalty !== 1) {
    body.repetition_penalty = params.repetition_penalty;
  }
  if (s.seed && params.seed !== undefined && params.seed >= 0) body.seed = params.seed;
  if (s.n && params.n && params.n > 1) body.n = params.n;
  if (s.logitBias && params.logit_bias && Object.keys(params.logit_bias).length)
    body.logit_bias = params.logit_bias;
  if (params.stop?.length) body.stop = params.stop.slice(0, 4);

  const usesCompletionTokens = provider.maxCompletionTokensModels?.test(request.model) ?? false;
  body[usesCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = params.max_tokens;

  const effort = params.reasoning_effort;
  if (provider.reasoning === 'openai' && effort && effort !== 'auto') {
    body.reasoning_effort = effort === 'min' ? 'minimal' : effort === 'max' ? 'high' : effort;
  }
  if (provider.reasoning === 'openrouter') {
    const reasoning: Record<string, unknown> = {};
    if (effort && effort !== 'auto')
      reasoning.effort = effort === 'min' ? 'minimal' : effort === 'max' ? 'high' : effort;
    if (params.include_reasoning === false) reasoning.exclude = true;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    if (params.include_reasoning) body.include_reasoning = true;
  }
  if (params.verbosity && params.verbosity !== 'auto' && provider.id === 'openai')
    body.verbosity = params.verbosity;
  if (usesCompletionTokens && provider.id === 'openai') {
    // Reasoning models reject sampling parameters.
    for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stop'])
      delete body[key];
  }
  if (request.stream && provider.id === 'openai') body.stream_options = { include_usage: true };

  Object.assign(body, request.extraBody ?? {});
  for (const key of request.excludeBody ?? []) delete body[key];
  return body;
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
    const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
    const delta = (choice?.delta ?? choice?.message ?? {}) as Record<string, unknown>;
    const out: StreamDelta = {};
    const text = delta.content ?? choice?.text;
    if (typeof text === 'string' && text) out.text = text;
    const reasoning = delta[this.#reasoningField] ?? delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
    if (typeof choice?.finish_reason === 'string') out.finishReason = choice.finish_reason;
    if (json.usage && typeof json.usage === 'object') out.usage = json.usage as Record<string, unknown>;
    return Object.keys(out).length ? [out] : [];
  }
}

export const openAIChat: ProviderAdapter = {
  buildRequest(request): HttpRequestSpec {
    const base = request.baseUrl || request.provider.baseUrl;
    return {
      url: joinUrl(base, 'chat/completions'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.provider.defaultHeaders,
        ...request.extraHeaders,
      },
      body: JSON.stringify(buildOpenAIBody(request)),
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
