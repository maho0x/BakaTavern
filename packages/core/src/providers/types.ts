import type { ChatMessage } from '../prompt/types.ts';
import type { PromptNames } from '../prompt/post-process.ts';

export type ProtocolFamily = 'openai-chat' | 'anthropic' | 'gemini';

/** How the server attaches a stored key (mirrors the server's `SecretAuth`). */
export type AuthScheme =
  { type: 'bearer' } | { type: 'header'; name: string; prefix?: string } | { type: 'query'; name: string };

export interface ProviderDefinition {
  /** SillyTavern `chat_completion_source` id. */
  id: string;
  name: string;
  family: ProtocolFamily;
  /** Default base URL; `endpoints` lists regional alternatives. */
  baseUrl: string;
  /**
   * API version path segment added after the base URL (Gemini: `v1beta`). Kept separate so that a
   * reverse proxy is entered as its root, as in SillyTavern.
   */
  apiVersion?: string;
  endpoints?: Record<string, string>;
  auth: AuthScheme;
  /** Path for listing models (GET), relative to the base URL. */
  modelsPath?: string;
  keyRequired: boolean;
  defaultHeaders?: Record<string, string>;
  /** Which OpenAI-style sampler fields the provider accepts beyond the basics. */
  samplers?: {
    topK?: boolean;
    minP?: boolean;
    topA?: boolean;
    repetitionPenalty?: boolean;
    penalties?: boolean;
    seed?: boolean;
    logitBias?: boolean;
    n?: boolean;
  };
  /** Reasoning knob shape. */
  reasoning?: 'openai' | 'openrouter' | 'none';
  /** Field carrying reasoning text in stream deltas (`reasoning_content` or `reasoning`). */
  reasoningField?: 'reasoning_content' | 'reasoning';
  /** Default model id suggested in the UI. */
  defaultModel?: string;
  /** Models that require `max_completion_tokens` (OpenAI reasoning models). */
  maxCompletionTokensModels?: RegExp;
}

export interface SamplerParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  top_a?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  max_tokens: number;
  stop?: string[];
  seed?: number;
  n?: number;
  logit_bias?: Record<string, number>;
  reasoning_effort?: string;
  verbosity?: string;
  include_reasoning?: boolean;
}

export interface GenerationRequest {
  provider: ProviderDefinition;
  /** Base URL to use (custom endpoint, regional endpoint or reverse proxy). */
  baseUrl?: string;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  params: SamplerParams;
  /** Claude: text to prefill the assistant turn with. */
  assistantPrefill?: string;
  /** Claude/Gemini: send leading system messages as the system prompt. */
  useSystemPrompt?: boolean;
  names: PromptNames;
  extraBody?: Record<string, unknown>;
  excludeBody?: string[];
  extraHeaders?: Record<string, string>;
}

/** An HTTP request ready for the server proxy (the secret is attached server-side). */
export interface HttpRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  auth: AuthScheme;
}

/** Incremental output of a generation. */
export interface StreamDelta {
  text?: string;
  reasoning?: string;
  /** Provider signature for the reasoning (Claude/Gemini). */
  signature?: string;
  finishReason?: string;
  error?: string;
  /** Raw usage block, when the provider reports it. */
  usage?: Record<string, unknown>;
}

export interface StreamDecoder {
  push(chunk: Uint8Array | string): StreamDelta[];
  end(): StreamDelta[];
}

export interface ProviderAdapter {
  buildRequest(request: GenerationRequest): HttpRequestSpec;
  createDecoder(): StreamDecoder;
  /** Parses a non-streamed response body. */
  parseResponse(body: unknown): StreamDelta;
}

/** Extracts a human readable message from a provider error body. */
export function errorMessage(body: unknown, fallback = 'Unknown error'): string {
  if (typeof body === 'string') {
    try {
      return errorMessage(JSON.parse(body), body.slice(0, 500) || fallback);
    } catch {
      return body.slice(0, 500) || fallback;
    }
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const error = b.error ?? (b.detail as Record<string, unknown> | undefined)?.error ?? b.detail;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const message = e.message ?? e.code ?? e.type;
      if (message) return String(message);
    }
    if (typeof b.message === 'string') return b.message;
  }
  return fallback;
}
