/**
 * Cohere's v2 chat API, which SillyTavern uses for the Cohere source. The request body comes from
 * the shared SillyTavern port (st-chat.ts); responses have Cohere's own shape.
 */

import { buildOpenAIRequest } from './openai-chat.ts';
import { SseParser } from './sse.ts';
import {
  errorMessage,
  type HttpRequestSpec,
  type ProviderAdapter,
  type StreamDecoder,
  type StreamDelta,
} from './types.ts';

class CohereDecoder implements StreamDecoder {
  #sse = new SseParser();

  push(chunk: Uint8Array | string): StreamDelta[] {
    return this.#sse.push(chunk).flatMap((e) => this.#event(e.data));
  }

  end(): StreamDelta[] {
    return this.#sse.end().flatMap((e) => this.#event(e.data));
  }

  #event(data: string): StreamDelta[] {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    if (json.error || (json.message && typeof json.message === 'string'))
      return [{ error: errorMessage(json) }];
    const event: StreamDelta = { event: json };
    const delta = (json.delta ?? {}) as {
      message?: { content?: { text?: string }; tool_plan?: string };
      finish_reason?: string;
    };
    const out: StreamDelta = {};
    // SillyTavern shows the tool plan when there is no text.
    const text = delta.message?.content?.text || delta.message?.tool_plan;
    if (typeof text === 'string' && text) out.text = text;
    if (json.type === 'message-end' && typeof delta.finish_reason === 'string')
      out.finishReason = delta.finish_reason;
    return Object.keys(out).length ? [event, out] : [event];
  }
}

export const cohere: ProviderAdapter = {
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
  createDecoder: () => new CohereDecoder(),
  parseResponse(body) {
    const json = body as Record<string, unknown>;
    if (json?.error) return { error: errorMessage(json) };
    const message = (json?.message ?? {}) as { content?: { text?: string }[]; tool_plan?: string };
    return {
      text: message.content?.[0]?.text || message.tool_plan || '',
      finishReason: typeof json?.finish_reason === 'string' ? json.finish_reason : undefined,
    };
  },
};
