/**
 * Function tools (SillyTavern's `ToolManager`): which models can call them, the `tools` sent with
 * a request, tool calls collected from replies (streamed or not) and the invocations kept in the
 * chat, whose calls and results go back into later prompts.
 *
 * Running a tool is the app's business; core only describes and parses.
 */

import type { GenerationType } from './prompt/types.ts';

/** A tool the model may call. `parameters` is a JSON schema. */
export interface ToolDefinition {
  name: string;
  displayName?: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call in a model's reply (OpenAI shape; arguments may still be an object). */
export interface ModelToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: unknown };
  /** Gemini thought signature / OpenRouter encrypted reasoning. */
  signature?: string | null;
}

/** A finished tool call as SillyTavern stores it (`extra.tool_invocations[]`). */
export interface ToolInvocation {
  id: string;
  displayName?: string;
  name: string;
  /** The arguments as a JSON string. */
  parameters: string;
  result: string;
  error?: boolean;
  signature?: string | null;
  reasoning?: string | null;
}

/** Generations stop calling tools after this many rounds (`ToolManager.RECURSE_LIMIT`). */
export const TOOL_RECURSE_LIMIT = 5;

/** Tool-call reasoning forwarding (`tool_reasoning_modes`). */
export const ToolReasoningMode = {
  DISABLED: 'disabled',
  SINCE_LAST_USER: 'since_last_user',
  ACTIVE_CHAIN: 'active_chain',
} as const;

/** Sources that forward reasoning between tool calls (`interleaved_reasoning_providers`). */
const interleavedReasoningSources = ['openrouter', 'custom'];

/** The effective reasoning forwarding mode for a source and preset. */
export function toolReasoningMode(
  source: string,
  preset: { show_thoughts?: unknown; tool_reasoning_mode?: unknown },
) {
  if (!interleavedReasoningSources.includes(source) || !preset.show_thoughts)
    return ToolReasoningMode.DISABLED;
  const mode = String(preset.tool_reasoning_mode ?? '');
  return (Object.values(ToolReasoningMode) as string[]).includes(mode) ? mode : ToolReasoningMode.DISABLED;
}

/** Whether reasoning signatures go back to the model (`isReasoningSignatureSupported`). */
export function reasoningSignatureSupported(source: string, model: string): boolean {
  return (
    source === 'vertexai' ||
    source === 'makersuite' ||
    (source === 'openrouter' && /google\/gemini/i.test(model))
  );
}

const toolSources = [
  'openai',
  'custom',
  'mistralai',
  'claude',
  'openrouter',
  'aimlapi',
  'groq',
  'cohere',
  'deepseek',
  'makersuite',
  'vertexai',
  'ai21',
  'xai',
  'pollinations',
  'moonshot',
  'fireworks',
  'cometapi',
  'chutes',
  'electronhub',
  'azure_openai',
  'zai',
  'siliconflow',
  'nanogpt',
  'workers_ai',
  'minimax',
];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Whether the model can call tools (`isToolCallingSupported`): function calling is on, the
 * post-processing keeps tool calls, and the source (or the model, when its list says) supports them.
 */
export function toolCallingSupported(
  source: string,
  model: string,
  preset: { function_calling?: unknown; custom_prompt_post_processing?: unknown },
  entry?: Record<string, unknown>,
): boolean {
  if (!preset.function_calling) return false;
  if ((source === 'openai' || source === 'azure_openai') && /^gpt-6-astra/.test(model)) return false;
  const postProcessing = String(preset.custom_prompt_post_processing ?? '');
  if (!['', 'merge_tools', 'semi_tools', 'strict_tools'].includes(postProcessing)) return false;
  if (entry) {
    switch (source) {
      case 'pollinations':
        return Boolean(entry.tools);
      case 'fireworks':
        return Boolean(entry.supports_tools);
      case 'openrouter':
        return Boolean((entry.supported_parameters as unknown[] | undefined)?.includes('tools'));
      case 'mistralai':
        return Boolean(record(entry.capabilities).function_calling);
      case 'aimlapi':
        return Boolean(
          (entry.features as unknown[] | undefined)?.includes('openai/chat-completion.function'),
        );
      case 'chutes':
        return Boolean((entry.supported_features as unknown[] | undefined)?.includes('tools'));
      case 'electronhub':
        return Boolean(record(entry.metadata).function_call);
      case 'workers_ai':
        return (
          Array.isArray(entry.properties) &&
          entry.properties.some(
            (p) => record(p).property_id === 'function_calling' && record(p).value === 'true',
          )
        );
    }
  }
  return toolSources.includes(source);
}

/** Generations that may call tools (`canPerformToolCalls`). */
export function canCallTools(type: GenerationType, supported: boolean): boolean {
  return supported && !['impersonate', 'quiet', 'continue'].includes(type);
}

/** Tools as sent in a request (`registerFunctionToolsOpenAI`). */
export function toolsForRequest(tools: readonly ToolDefinition[]): Record<string, unknown> {
  if (!tools.length) return {};
  return {
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: 'auto',
  };
}

const INPUT_DELTA_KEY = '__input_json_delta';

/** Merges a streamed piece of a tool call into what came before (`#applyToolCallDelta`). */
function applyDelta(target: Record<string, unknown>, delta: Record<string, unknown>) {
  for (const key of Object.keys(delta)) {
    if (key === '__proto__' || key === 'constructor') continue;
    const value = delta[key];
    const current = target[key];
    if (value === null || value === undefined) {
      if (current) continue;
      target[key] = value;
    } else if (typeof value === 'string') {
      // Some providers repeat these in full on every chunk.
      if (key === 'id' || key === 'name' || key === 'type') {
        if (!current) target[key] = value;
      } else if (typeof current === 'string') target[key] = current + value;
      else target[key] = value;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) target[key] = {};
      applyDelta(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Collects tool calls from a streamed reply, event by event (`parseToolCalls`): OpenAI deltas,
 * Cohere tool events, Claude `tool_use` blocks with their JSON deltas, Gemini function calls.
 */
export class ToolCallCollector {
  /** Per choice, the calls so far (SillyTavern's `streamingProcessor.toolCalls`). */
  readonly calls: Record<string, unknown>[][] = [];

  #at(choice: number, index: number): Record<string, unknown> {
    const list = (this.calls[choice] ??= []);
    return (list[index] ??= {});
  }

  push(event: unknown, signatures: Record<string, string> = {}) {
    const parsed = record(event);
    if (Array.isArray(parsed.choices)) {
      for (const choice of parsed.choices.map(record)) {
        const index = typeof choice.index === 'number' ? choice.index : null;
        const deltas = record(choice.delta).tool_calls;
        if (index === null || !choice.delta || !Array.isArray(deltas)) continue;
        this.calls[index] ??= [];
        for (const delta of deltas.map(record)) {
          const callIndex = Number(delta.index) >= 0 ? Number(delta.index) : deltas.indexOf(delta);
          if (Number.isNaN(callIndex)) continue;
          const target = this.#at(index, callIndex);
          applyDelta(target, delta);
          if (typeof target.id === 'string' && Object.hasOwn(signatures, target.id)) {
            target.signature = signatures[target.id];
          }
        }
      }
    }
    const cohereEvents = ['message-start', 'tool-call-start', 'tool-call-delta', 'tool-call-end'];
    if (cohereEvents.includes(String(parsed.type)) && typeof record(parsed.delta).message === 'object') {
      applyDelta(this.#at(0, Number(parsed.index ?? 0)), record(record(parsed.delta).message));
    }
    if (typeof parsed.content_block === 'object' && record(parsed.content_block).type === 'tool_use') {
      applyDelta(this.#at(0, Number(parsed.index ?? 0)), record(parsed.content_block));
    }
    if (typeof parsed.delta === 'object') {
      const target = this.calls[0]?.[Number(parsed.index ?? 0)];
      const delta = record(parsed.delta);
      if (target && delta.type === 'input_json_delta') {
        target[INPUT_DELTA_KEY] = String(target[INPUT_DELTA_KEY] ?? '') + String(delta.partial_json ?? '');
      }
    }
    if (parsed.type === 'content_block_stop') {
      const target = this.calls[0]?.[Number(parsed.index ?? 0)];
      const json = target?.[INPUT_DELTA_KEY];
      if (target && typeof json === 'string' && json) {
        try {
          const input = JSON.parse(json) as unknown;
          delete target[INPUT_DELTA_KEY];
          applyDelta(target, { input });
        } catch {
          // left as it is, like SillyTavern
        }
      }
    }
    if (Array.isArray(parsed.candidates)) {
      parsed.candidates.forEach((candidate, choice) => {
        const parts = record(record(candidate).content).parts;
        if (!Array.isArray(parts)) return;
        for (const part of parts.map(record)) {
          if (!part.functionCall) continue;
          const target = this.#at(choice, this.calls[choice]?.length ?? 0);
          if (part.thoughtSignature) target.thoughtSignature = part.thoughtSignature;
          applyDelta(target, record(part.functionCall));
        }
      });
    }
  }
}

let idCounter = 0;
const randomId = () =>
  `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * The tool calls in a reply (`#getToolCallsFromData`): collected stream calls, or a whole response
 * from OpenAI-style, Claude, Gemini or Cohere APIs.
 */
export function toolCallsOf(data: unknown): ModelToolCall[] {
  const isClaude = (c: unknown): boolean =>
    Array.isArray(c)
      ? c.filter(Boolean).every(isClaude)
      : Boolean(record(c).input && record(c).name && record(c).id);
  const isGoogle = (c: unknown): boolean =>
    Array.isArray(c) ? c.filter(Boolean).every(isGoogle) : Boolean(record(c).name && record(c).args);
  const fromClaude = (c: Record<string, unknown>): ModelToolCall => ({
    id: String(c.id),
    function: { name: String(c.name), arguments: c.input },
  });
  const fromGoogle = (c: Record<string, unknown>, signature: unknown = null): ModelToolCall => ({
    id: randomId(),
    function: { name: String(c.name), arguments: c.args },
    signature: (signature as string | null) ?? null,
  });

  if (Array.isArray(data) && data.length > 0 && Array.isArray(data[0])) {
    const first = data[0] as unknown[];
    if (isClaude(first)) return first.filter(Boolean).map((c) => fromClaude(record(c)));
    if (isGoogle(first))
      return first.filter(Boolean).map((c) => fromGoogle(record(c), record(c).thoughtSignature));
    const nested = record(first[0]).tool_calls;
    if (typeof nested === 'object' && nested)
      return (Array.isArray(nested) ? nested : [nested]) as ModelToolCall[];
    return first as ModelToolCall[];
  }
  const body = record(data);
  const responseParts = record(body.responseContent).parts;
  if (Array.isArray(responseParts)) {
    return responseParts
      .map(record)
      .filter((p) => p.functionCall)
      .map((p) => fromGoogle(record(p.functionCall), p.thoughtSignature));
  }
  // Gemini's raw response
  const candidateParts = record(record((body.candidates as unknown[] | undefined)?.[0]).content).parts;
  if (Array.isArray(candidateParts)) {
    return candidateParts
      .map(record)
      .filter((p) => p.functionCall)
      .map((p) => fromGoogle(record(p.functionCall), p.thoughtSignature));
  }
  if (Array.isArray(body.choices)) {
    const choice = body.choices.map(record).find((c) => c.index === 0);
    const message = record(choice?.message);
    if (choice && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls as ModelToolCall[];
      if (Array.isArray(message.reasoning_details)) {
        for (const call of calls) {
          const detail = (message.reasoning_details as unknown[]).map(record).find((d) => d.id === call.id);
          if (detail?.type === 'reasoning.encrypted' && detail.data) call.signature = String(detail.data);
        }
      }
      return calls;
    }
  }
  if (Array.isArray(body.content)) {
    return body.content
      .map(record)
      .filter((c) => c.type === 'tool_use')
      .map(fromClaude);
  }
  const cohere = record(body.message).tool_calls;
  if (typeof cohere === 'object' && cohere)
    return (Array.isArray(cohere) ? cohere : [cohere]) as ModelToolCall[];
  return [];
}

/** The arguments as SillyTavern keeps them: JSON text. */
export function toolArguments(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(' ', '&nbsp;');

const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The text of the message that records tool calls (`#formatToolInvocationMessage`). */
export function toolInvocationsText(invocations: readonly ToolInvocation[]): string {
  const data = invocations.map((i) => ({
    ...i,
    parameters: tryParse(i.parameters),
    result: tryParse(i.result),
  }));
  const counts = new Map<string, number>();
  for (const i of data) {
    const name = i.displayName || i.name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} (${count})` : name)).join(', ');
  return (
    `<details><summary>${escapeHtml(`Tool calls: ${names}`)}</summary>` +
    `<pre><code class="language-json">${escapeHtml(JSON.stringify(data, null, 2))}</code></pre></details>`
  );
}
