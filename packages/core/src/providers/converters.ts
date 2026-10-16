/**
 * Message conversions SillyTavern's server applies for particular providers
 * (src/prompt-converters.js). They work on copies; inputs are left untouched.
 */

import { PROMPT_PLACEHOLDER, type PromptNames } from '../prompt/post-process.ts';
import type { ChatMessage } from '../prompt/types.ts';
import { sha512Hex } from '../util/sha512.ts';

/** A message as sent to an OpenAI-style API (may carry provider flags such as `prefix`). */
export type WireMessage = Record<string, unknown> & { role: string; content: unknown; name?: string };

const startsWithGroupName = (names: PromptNames, text: string) =>
  names.groupNames.some((n) => text.startsWith(`${n}: `));

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Copies messages into wire form (SillyTavern's `getChat` fields). */
export function toWire(messages: readonly ChatMessage[]): WireMessage[] {
  return messages.map((m) => {
    const out: WireMessage = { role: m.role, content: m.content };
    if (m.name) out.name = m.name;
    if (m.tool_calls)
      out.tool_calls = m.tool_calls.map((call) => ({ ...call, function: { ...call.function } }));
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.signature) out.signature = m.signature;
    if (m.reasoning) out.reasoning = m.reasoning;
    return out;
  });
}

/**
 * A tool's JSON schema with `$defs` references resolved (`flattenSchema`); Google's APIs also lose
 * keywords they reject.
 */
export function flattenSchema(schema: unknown, source: string): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const copy = structuredClone(schema) as Record<string, unknown>;
  const google = source === 'vertexai' || source === 'makersuite';
  const definitions = (copy.$defs ?? {}) as Record<string, unknown>;
  delete copy.$defs;
  const resolve = (value: unknown, parents: string[]): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => resolve(item, parents));
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/$defs/')) {
      const name = obj.$ref.split('/').pop()!;
      if (parents.includes(name)) return {};
      return definitions[name] ? resolve(structuredClone(definitions[name]), [...parents, name]) : {};
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (google && ['default', 'additionalProperties', 'exclusiveMinimum', 'propertyNames'].includes(key))
        continue;
      result[key] = resolve(obj[key], parents);
    }
    return result;
  };
  const flat = resolve(copy, []) as Record<string, unknown>;
  delete flat.$schema;
  return flat;
}

/** DeepSeek's reasoner wants a `reasoning_content` on tool call messages. */
export function addReasoningContentToToolCalls(messages: WireMessage[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls) || 'reasoning_content' in message) continue;
    message.reasoning_content = '';
  }
}

/** Reasoning signatures as OpenRouter's `reasoning_details` (`addOpenRouterSignatures`). */
export function addOpenRouterSignatures(messages: WireMessage[], model: string): void {
  const format = /google\/gemini/.test(model)
    ? 'google-gemini-v1'
    : /anthropic\/claude/.test(model)
      ? 'anthropic-claude-v1'
      : /openai\/gpt/.test(model)
        ? 'openai-responses-v1'
        : /x-ai\/grok/.test(model)
          ? 'xai-responses-v1'
          : 'unknown';
  for (const message of messages) {
    const details: Record<string, unknown>[] = [];
    const add = (data: unknown, id?: string) => {
      if (typeof data !== 'string' || !data) return;
      details.push({
        index: details.length,
        id: id || `signature-${details.length}`,
        type: 'reasoning.encrypted',
        data,
        format,
      });
    };
    if (typeof message.signature === 'string') {
      add(message.signature);
      delete message.signature;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as Record<string, unknown>[]) {
        if (typeof call.signature === 'string') {
          add(call.signature, call.id as string);
          delete call.signature;
        }
      }
    }
    if (details.length) message.reasoning_details = details;
  }
}

/** Audio in OpenRouter's `input_audio` form (`embedOpenRouterMedia`). */
export function embedOpenRouterMedia(messages: WireMessage[]): void {
  const formats: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Record<string, unknown>[]) {
      const audio = part?.audio_url as { url?: string } | undefined;
      if (part?.type === 'audio_url' && audio?.url?.startsWith('data:')) {
        const [header, data] = audio.url.split(',');
        const mime = /data:([^;]+)/.exec(header ?? '')?.[1] || 'audio/mpeg';
        part.type = 'input_audio';
        part.input_audio = { format: formats[mime] || 'mp3', data };
        delete part.audio_url;
      }
    }
  }
}

/** Marks a trailing assistant message as a prefill (`prefix` or `partial`), unless tools are in play. */
export function addAssistantPrefix(prompt: WireMessage[], tools: unknown, property: string): WireMessage[] {
  if (!prompt.length) return prompt;
  const hasAnyTools = (Array.isArray(tools) && tools.length > 0) || prompt.some((x) => x.role === 'tool');
  if (!hasAnyTools && prompt[prompt.length - 1]!.role === 'assistant')
    prompt[prompt.length - 1]![property] = true;
  return prompt;
}

/** Prefixes example and named messages with their speaker (`convertMistralMessages`). */
export function convertMistralMessages(messages: WireMessage[], names: PromptNames): WireMessage[] {
  // Mistral takes short tool call ids only.
  const sanitizeToolId = (id: unknown) => sha512Hex(String(id)).slice(0, 9);
  for (const msg of messages) {
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls as Record<string, unknown>[]) call.id = sanitizeToolId(call.id);
    }
    if ('tool_call_id' in msg && msg.role === 'tool') msg.tool_call_id = sanitizeToolId(msg.tool_call_id);
    const content = text(msg.content);
    if (msg.role === 'system' && msg.name === 'example_assistant') {
      if (
        names.charName &&
        !content.startsWith(`${names.charName}: `) &&
        !startsWithGroupName(names, content)
      ) {
        msg.content = `${names.charName}: ${content}`;
      }
      delete msg.name;
    }
    if (msg.role === 'system' && msg.name === 'example_user') {
      if (names.userName && !text(msg.content).startsWith(`${names.userName}: `)) {
        msg.content = `${names.userName}: ${text(msg.content)}`;
      }
      delete msg.name;
    }
    if (msg.name && msg.role !== 'system' && !text(msg.content).startsWith(`${msg.name}: `)) {
      msg.content = `${msg.name}: ${text(msg.content)}`;
      delete msg.name;
    }
  }
  // A user message right after a tool result joins the previous user message.
  let rerun = true;
  while (rerun) {
    rerun = false;
    for (let i = 0; i < messages.length - 1; i++) {
      if (messages[i]!.role === 'tool' && messages[i + 1]!.role === 'user') {
        const lastUser = messages.slice(0, i).findLastIndex((m) => m.role === 'user' && m.content);
        if (lastUser !== -1) {
          messages[lastUser]!.content =
            `${text(messages[lastUser]!.content)}\n\n${text(messages[i + 1]!.content)}`;
          messages.splice(i + 1, 1);
          rerun = true;
        }
      }
    }
  }
  // A system message right after an assistant message becomes a user message.
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i]!.role === 'assistant' && messages[i + 1]!.role === 'system')
      messages[i + 1]!.role = 'user';
  }
  return messages;
}

/** Cohere has no message names: they go into the text (`convertCohereMessages`). */
export function convertCohereMessages(messages: WireMessage[], names: PromptNames): WireMessage[] {
  if (messages.length === 0) messages.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
  messages.forEach((msg, index) => {
    if (Array.isArray(msg.tool_calls)) {
      if (index > 0 && messages[index - 1]!.role === 'assistant') {
        msg.content = messages[index - 1]!.content;
        messages.splice(index - 1, 1);
      } else {
        const calls = msg.tool_calls as { function?: { name?: string } }[];
        msg.content = `I'm going to call a tool for that: ${calls.map((tc) => tc?.function?.name).join(', ')}`;
      }
    }
    if (msg.name) {
      const content = text(msg.content);
      if (msg.role === 'system' && msg.name === 'example_assistant') {
        if (
          names.charName &&
          !content.startsWith(`${names.charName}: `) &&
          !startsWithGroupName(names, content)
        ) {
          msg.content = `${names.charName}: ${content}`;
        }
      }
      if (msg.role === 'system' && msg.name === 'example_user') {
        if (names.userName && !text(msg.content).startsWith(`${names.userName}: `)) {
          msg.content = `${names.userName}: ${text(msg.content)}`;
        }
      }
      if (msg.role !== 'system' && !text(msg.content).startsWith(`${msg.name}: `)) {
        msg.content = `${msg.name}: ${text(msg.content)}`;
      }
      delete msg.name;
    }
  });
  return messages;
}

/**
 * AI21 takes one leading system message and alternating turns (`convertAI21Messages`).
 */
export function convertAI21Messages(input: WireMessage[], names: PromptNames): WireMessage[] {
  const messages = input;
  let i: number;
  let systemPrompt = '';
  for (i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'system') break;
    if (
      names.userName &&
      msg.name === 'example_user' &&
      !text(msg.content).startsWith(`${names.userName}: `)
    ) {
      msg.content = `${names.userName}: ${text(msg.content)}`;
    }
    if (
      names.charName &&
      msg.name === 'example_assistant' &&
      !text(msg.content).startsWith(`${names.charName}: `) &&
      !startsWithGroupName(names, text(msg.content))
    ) {
      msg.content = `${names.charName}: ${text(msg.content)}`;
    }
    systemPrompt += `${text(msg.content)}\n\n`;
  }
  messages.splice(0, i);
  if (messages.length === 0) messages.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
  if (systemPrompt) messages.unshift({ role: 'system', content: systemPrompt.trim() });
  for (const msg of messages) {
    if ('name' in msg) {
      if (msg.role !== 'system' && !text(msg.content).startsWith(`${msg.name}: `)) {
        msg.content = `${msg.name}: ${text(msg.content)}`;
      }
      delete msg.name;
    }
  }
  const merged: WireMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role)
      last.content = `${text(last.content)}\n\n${text(message.content)}`;
    else merged.push(message);
  }
  return merged;
}

/** xAI ignores names: speakers are written into assistant and example messages (`convertXAIMessages`). */
export function convertXAIMessages(messages: WireMessage[], names: PromptNames): WireMessage[] {
  for (const msg of messages) {
    if (!msg.name || msg.role === 'user') continue;
    const content = text(msg.content);
    const charRule =
      !!names.charName && !content.startsWith(`${names.charName}: `) && !startsWithGroupName(names, content);
    const rules = [
      { role: 'assistant', condition: charRule },
      { role: 'system', name: 'example_assistant', condition: charRule },
      {
        role: 'system',
        name: 'example_user',
        condition: !!names.userName && !content.startsWith(`${names.userName}: `),
      },
    ];
    const rule = rules.find((r) => msg.role === r.role && (!r.name || msg.name === r.name) && r.condition);
    if (rule) {
      const prefix = msg.role === 'system' && msg.name === 'example_user' ? names.userName : names.charName;
      msg.content = `${prefix}: ${content}`;
    }
    delete msg.name;
  }
  return messages;
}
