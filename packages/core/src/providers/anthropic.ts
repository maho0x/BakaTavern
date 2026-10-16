import { PROMPT_PLACEHOLDER, type PromptNames } from '../prompt/post-process.ts';
import type { ChatMessage, ContentPart } from '../prompt/types.ts';
import { flattenSchema } from './converters.ts';
import { joinUrl } from './registry.ts';
import { SseParser } from './sse.ts';
import {
  errorMessage,
  type GenerationRequest,
  type HttpRequestSpec,
  type ProviderAdapter,
  type StreamDecoder,
  type StreamDelta,
} from './types.ts';

type ClaudeBlock = Record<string, unknown> & { type: string };
interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: ClaudeBlock[];
}

const startsWithGroupName = (names: PromptNames, text: string) =>
  names.groupNames.some((n) => text.startsWith(`${n}: `));

function exampleName(message: ChatMessage, text: string, names: PromptNames): string {
  if (names.userName && message.name === 'example_user' && !text.startsWith(`${names.userName}: `)) {
    return `${names.userName}: ${text}`;
  }
  if (
    names.charName &&
    message.name === 'example_assistant' &&
    !text.startsWith(`${names.charName}: `) &&
    !startsWithGroupName(names, text)
  ) {
    return `${names.charName}: ${text}`;
  }
  return text;
}

/** OpenAI-style messages → Claude Messages API (port of SillyTavern `convertClaudeMessages`). */
export function convertClaudeMessages(
  input: readonly ChatMessage[],
  prefill: string,
  useSystemPrompt: boolean,
  names: PromptNames,
  useTools = false,
): { messages: ClaudeMessage[]; system: { type: 'text'; text: string }[] } {
  const messages = input.map((m) => ({ ...m }));
  const system: { type: 'text'; text: string }[] = [];
  if (useSystemPrompt) {
    let i = 0;
    for (; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role !== 'system') break;
      const text = exampleName(m, typeof m.content === 'string' ? m.content : '', names);
      system.push({ type: 'text', text });
    }
    messages.splice(0, i);
    if (messages.length === 0) messages.push({ role: 'user', content: PROMPT_PLACEHOLDER });
  }

  const converted = messages.map((message): ClaudeMessage => {
    let role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
    let blocks: ClaudeBlock[];
    if (message.role === 'assistant' && message.tool_calls) {
      blocks = message.tool_calls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeParse(tc.function.arguments),
      }));
    } else if (message.role === 'tool') {
      role = 'user';
      blocks = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
    } else {
      let name = message.name;
      let content = message.content;
      if (message.role === 'system') {
        if (typeof content === 'string') content = exampleName(message, content, names);
        name = undefined;
      }
      if (typeof content === 'string') {
        blocks = [{ type: 'text', text: name ? `${name}: ${content}` : content }];
      } else {
        blocks = content.map((part: ContentPart): ClaudeBlock => {
          if (part.type === 'image_url') {
            const url = part.image_url.url;
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: url.split(';')[0]?.split(':')[1],
                data: url.split(',')[1],
              },
            };
          }
          if (part.type === 'text')
            return { type: 'text', text: (name ? `${name}: ${part.text}` : part.text) || '​' };
          return { type: 'text', text: '' };
        });
      }
    }
    return { role, content: blocks };
  });

  // Images in assistant messages move to the following user message.
  for (let i = 0; i < converted.length; i++) {
    const m = converted[i]!;
    if (m.role === 'assistant' && m.content.some((c) => c.type === 'image')) {
      let j = i + 1;
      while (j < converted.length && converted[j]!.role !== 'user') j++;
      if (j >= converted.length) converted.splice(i + 1, 0, { role: 'user', content: [] });
      const target = converted[j >= converted.length ? i + 1 : j]!;
      target.content.push(...m.content.filter((c) => c.type === 'image'));
      m.content = m.content.filter((c) => c.type !== 'image');
    }
  }

  if (prefill) converted.push({ role: 'assistant', content: [{ type: 'text', text: prefill.trimEnd() }] });

  const merged: ClaudeMessage[] = [];
  for (const m of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push(m);
  }
  // Without tools in the request, past calls and results become plain text.
  if (!useTools) {
    for (const message of merged) {
      message.content = message.content.map((block): ClaudeBlock => {
        if (block.type === 'tool_use') return { type: 'text', text: JSON.stringify(block.input) };
        if (block.type === 'tool_result') return { type: 'text', text: block.content as string };
        return block;
      });
    }
  }
  return { messages: merged, system };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Model capabilities that change request shape (kept as data so new models are one-line updates). */
const thinkingModels = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-5|sonnet-5|fable)/;
const adaptiveModels = /^claude-(opus-4-7|opus-4-8|opus-5|sonnet-5|fable)/;
const noSamplingModels = /^claude-(opus-4-7|opus-4-8|opus-5|sonnet-5|fable)/;
const noPrefillModels = /^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8|opus-5|sonnet-5|fable)/;
const limitedSamplingModels = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/;

function thinkingBudget(maxTokens: number, effort: string | undefined, stream: boolean): number | null {
  const ratios: Record<string, number> = { low: 0.1, medium: 0.25, high: 0.5, max: 0.95 };
  if (!effort || effort === 'auto') return null;
  let budget = effort === 'min' ? 1024 : Math.floor(maxTokens * (ratios[effort] ?? 0));
  budget = Math.max(budget, 1024);
  return stream ? budget : Math.min(budget, 21333);
}

export function buildClaudeBody(request: GenerationRequest): Record<string, unknown> {
  const { params, model } = request;
  const useTools = !!request.tools?.length;
  const converted = convertClaudeMessages(
    request.messages,
    request.assistantPrefill ?? '',
    !!request.useSystemPrompt,
    request.names,
    useTools,
  );
  const body: Record<string, unknown> = {
    messages: converted.messages,
    model,
    max_tokens: params.max_tokens,
    stop_sequences: params.stop ?? [],
    temperature: params.temperature,
    top_p: params.top_p,
    top_k: params.top_k,
    stream: request.stream,
  };
  if (request.useSystemPrompt && converted.system.length) body.system = converted.system;
  if (useTools) {
    body.tool_choice = { type: 'auto' };
    body.tools = request.tools!.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: flattenSchema(tool.parameters, 'claude'),
    }));
  }
  if (limitedSamplingModels.test(model)) {
    if ((params.top_p ?? 1) < 1) delete body.temperature;
    else delete body.top_p;
  }
  if (noSamplingModels.test(model)) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }
  let thinking = false;
  const effort = params.reasoning_effort;
  if (thinkingModels.test(model)) {
    if (adaptiveModels.test(model)) {
      if (effort && effort !== 'auto') {
        thinking = true;
        body.thinking = { type: 'adaptive', ...(params.include_reasoning ? { display: 'summarized' } : {}) };
        body.output_config = { effort: effort === 'min' ? 'low' : effort };
        delete body.top_k;
      } else if (params.include_reasoning) {
        thinking = true;
        body.thinking = { type: 'adaptive', display: 'summarized' };
      }
    } else {
      const budget = thinkingBudget(params.max_tokens, effort, request.stream);
      if (budget !== null) {
        thinking = true;
        if (params.max_tokens <= 1024) body.max_tokens = params.max_tokens + 1024;
        body.thinking = { type: 'enabled', budget_tokens: budget };
        delete body.temperature;
        delete body.top_p;
        delete body.top_k;
      }
    }
  }
  const last = converted.messages[converted.messages.length - 1];
  if ((thinking || noPrefillModels.test(model)) && last?.role === 'assistant') last.role = 'user';
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  Object.assign(body, request.extraBody ?? {});
  for (const key of request.excludeBody ?? []) delete body[key];
  return body;
}

/** The beta features SillyTavern asks Claude for. */
function betaHeaders(request: GenerationRequest): string[] {
  const betas = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
  if (request.tools?.length) betas.push('tools-2024-05-16');
  return betas;
}

class ClaudeDecoder implements StreamDecoder {
  #sse = new SseParser();

  push(chunk: Uint8Array | string): StreamDelta[] {
    return this.#sse.push(chunk).flatMap((e) => this.#event(e.event, e.data));
  }

  end(): StreamDelta[] {
    return this.#sse.end().flatMap((e) => this.#event(e.event, e.data));
  }

  #event(event: string, data: string): StreamDelta[] {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(data);
    } catch {
      return [];
    }
    const type = (json.type as string) ?? event;
    if (type === 'error') return [{ error: errorMessage(json) }];
    return [{ event: json }, ...this.#deltas(type, json)];
  }

  #deltas(type: string, json: Record<string, unknown>): StreamDelta[] {
    if (type === 'content_block_delta') {
      const delta = json.delta as Record<string, unknown>;
      if (delta.type === 'text_delta') return [{ text: String(delta.text ?? '') }];
      if (delta.type === 'thinking_delta') return [{ reasoning: String(delta.thinking ?? '') }];
      if (delta.type === 'signature_delta') return [{ signature: String(delta.signature ?? '') }];
    }
    if (type === 'content_block_start') {
      const block = json.content_block as Record<string, unknown>;
      if (block?.type === 'text' && block.text) return [{ text: String(block.text) }];
      if (block?.type === 'thinking' && block.thinking) return [{ reasoning: String(block.thinking) }];
    }
    if (type === 'message_delta') {
      const delta = json.delta as Record<string, unknown>;
      const out: StreamDelta = {};
      if (typeof delta?.stop_reason === 'string') out.finishReason = delta.stop_reason;
      if (json.usage) out.usage = json.usage as Record<string, unknown>;
      return [out];
    }
    return [];
  }
}

export const anthropic: ProviderAdapter = {
  buildRequest(request): HttpRequestSpec {
    const base = request.baseUrl || request.provider.baseUrl;
    return {
      url: joinUrl(base, 'messages'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.provider.defaultHeaders,
        'anthropic-beta': betaHeaders(request).join(','),
        ...request.extraHeaders,
      },
      body: JSON.stringify(buildClaudeBody(request)),
      auth: request.provider.auth,
    };
  },
  createDecoder: () => new ClaudeDecoder(),
  parseResponse(body) {
    const json = body as Record<string, unknown>;
    if (json?.type === 'error' || json?.error) return { error: errorMessage(json) };
    const blocks = (json?.content as Record<string, unknown>[] | undefined) ?? [];
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join(''),
      reasoning:
        blocks
          .filter((b) => b.type === 'thinking')
          .map((b) => String(b.thinking ?? ''))
          .join('') || undefined,
      signature: blocks.find((b) => b.type === 'thinking')?.signature as string | undefined,
      finishReason: json?.stop_reason as string | undefined,
    };
  },
};
