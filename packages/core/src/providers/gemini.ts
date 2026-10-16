import type { PromptNames } from '../prompt/post-process.ts';
import type { ChatMessage } from '../prompt/types.ts';
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

type Part = Record<string, unknown>;
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

const startsWithGroupName = (names: PromptNames, text: string) =>
  names.groupNames.some((n) => text.startsWith(`${n}: `));

function prefixName(message: ChatMessage, text: string, names: PromptNames): string {
  if (!message.name) return text;
  if (message.name === 'example_user') {
    return names.userName && !text.startsWith(`${names.userName}: `) ? `${names.userName}: ${text}` : text;
  }
  if (message.name === 'example_assistant') {
    return names.charName && !text.startsWith(`${names.charName}: `) && !startsWithGroupName(names, text)
      ? `${names.charName}: ${text}`
      : text;
  }
  return text.startsWith(`${message.name}: `) ? text : `${message.name}: ${text}`;
}

/** OpenAI-style messages → Gemini `contents` (port of SillyTavern `convertGooglePrompt`). */
export function convertGeminiMessages(
  input: readonly ChatMessage[],
  model: string,
  useSystemPrompt: boolean,
  names: PromptNames,
): { contents: Content[]; systemInstruction: { parts: { text: string }[] } } {
  const messages = input.map((m) => ({ ...m }));
  const system: string[] = [];
  if (useSystemPrompt) {
    while (messages.length > 1 && messages[0]!.role === 'system') {
      const m = messages.shift()!;
      const text = typeof m.content === 'string' ? m.content : '';
      system.push(
        m.name === 'example_user' || m.name === 'example_assistant' ? prefixName(m, text, names) : text,
      );
    }
  }
  const noPrefillModel = /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model);
  const contents: Content[] = [];
  /** Tool call id → function name, for the results that answer them. */
  const toolNames: Record<string, string> = {};
  messages.forEach((message, index) => {
    let role: Content['role'];
    if (message.role === 'assistant')
      role = noPrefillModel && index === messages.length - 1 ? 'user' : 'model';
    else role = 'user';
    const parts: Part[] = [];
    const addDataUrl = (url: string, defaultMime: string, detail?: string) => {
      if (!url?.startsWith('data:')) return;
      const [header, data] = url.split(',');
      const part: Part = {
        inlineData: { mimeType: /data:([^;]+)/.exec(header ?? '')?.[1] || defaultMime, data },
      };
      const resolution = detail === 'low' || detail === 'high' ? `media_resolution_${detail}` : null;
      if (/gemini-3/.test(model) && resolution) part.mediaResolution = { level: resolution };
      parts.push(part);
    };
    if (!Array.isArray(message.content) && message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        parts.push({
          functionCall: {
            name: call.function.name,
            args: tryParse(call.function.arguments) ?? call.function.arguments,
          },
          ...(call.signature ? { thoughtSignature: call.signature } : {}),
        });
        toolNames[call.id] = call.function.name;
      }
    } else if (!Array.isArray(message.content) && message.tool_call_id) {
      const name = toolNames[message.tool_call_id] ?? 'unknown';
      parts.push({ functionResponse: { name, response: { name, content: String(message.content ?? '') } } });
    } else {
      const items = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text' as const, text: String(message.content ?? '') }];
      for (const item of items) {
        if (item.type === 'text') parts.push({ text: prefixName(message, item.text, names) });
        else if (item.type === 'image_url')
          addDataUrl(item.image_url.url, 'image/png', item.image_url.detail);
        else if (item.type === 'video_url')
          addDataUrl(item.video_url.url, 'video/mp4', item.video_url.detail);
        else if (item.type === 'audio_url') addDataUrl(item.audio_url.url, 'audio/mpeg');
      }
    }
    // Stored thought signatures go back; Gemini 3 needs a placeholder for calls without one.
    if (/gemini-3/.test(model) || /gemini-2\.5/.test(model)) {
      for (const part of parts) {
        if (message.signature && typeof part.text === 'string') {
          part.thoughtSignature = message.signature;
        } else if (/gemini-3/.test(model)) {
          if (part.functionCall && !part.thoughtSignature) part.thoughtSignature = SKIP_SIGNATURE;
          if (
            /-image/.test(model) &&
            role === 'model' &&
            (typeof part.text === 'string' || part.inlineData)
          ) {
            part.thoughtSignature = SKIP_SIGNATURE;
          }
        }
      }
    }
    const last = contents[contents.length - 1];
    if (index > 0 && last && last.role === role) {
      for (const part of parts) {
        if (part.text) {
          const textPart = last.parts.find((p) => typeof p.text === 'string');
          if (textPart) textPart.text += '\n\n' + part.text;
          else last.parts.push(part);
        }
        if (
          part.inlineData ||
          part.functionCall ||
          part.functionResponse ||
          part.thoughtSignature ||
          part.mediaResolution
        ) {
          last.parts.push(part);
        }
      }
    } else {
      contents.push({ role, parts });
    }
  });
  return { contents, systemInstruction: { parts: system.map((text) => ({ text })) } };
}

const SKIP_SIGNATURE = 'skip_thought_signature_validator';

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const GEMINI_SAFETY = [
  'HARASSMENT',
  'HATE_SPEECH',
  'SEXUALLY_EXPLICIT',
  'DANGEROUS_CONTENT',
  'CIVIC_INTEGRITY',
].map((c) => ({
  category: `HARM_CATEGORY_${c}`,
  threshold: 'OFF',
}));

const thinkingConfigModels = (m: string) =>
  (/^gemini-2\.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) ||
  /^gemini-3[.\d]*-(flash|pro)/.test(m);

function thinkingBudget(
  maxTokens: number,
  effort: string | undefined,
  model: string,
): number | string | undefined {
  if (!effort || effort === 'auto') return -1;
  if (/^gemini-3/.test(model)) return effort === 'min' || effort === 'low' ? 'low' : 'high';
  if (effort === 'min') return /pro/.test(model) ? 128 : 0;
  const ratios: Record<string, number> = { low: 0.1, medium: 0.25, high: 0.5, max: 1 };
  const cap = /pro/.test(model) ? 32768 : 24576;
  return Math.min(Math.floor(maxTokens * (ratios[effort] ?? 0.25)), cap);
}

export function buildGeminiBody(request: GenerationRequest): Record<string, unknown> {
  const { params, model } = request;
  const useSystemPrompt = !!request.useSystemPrompt && !/gemma-3/.test(model);
  const converted = convertGeminiMessages(request.messages, model, useSystemPrompt, request.names);
  const generationConfig: Record<string, unknown> = {
    stopSequences: geminiStops(params.stop),
    candidateCount: 1,
    maxOutputTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    topK: params.top_k || undefined,
    seed: params.seed !== undefined && params.seed >= 0 ? params.seed : undefined,
  };
  if (/gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model)) {
    delete generationConfig.temperature;
    delete generationConfig.topP;
    delete generationConfig.topK;
    delete generationConfig.candidateCount;
  }
  if (thinkingConfigModels(model)) {
    const budget = thinkingBudget(params.max_tokens, params.reasoning_effort, model);
    const thinkingConfig: Record<string, unknown> = { includeThoughts: !!params.include_reasoning };
    if (typeof budget === 'number') thinkingConfig.thinkingBudget = budget;
    if (typeof budget === 'string') thinkingConfig.thinkingLevel = budget;
    generationConfig.thinkingConfig = thinkingConfig;
  }
  for (const key of Object.keys(generationConfig))
    if (generationConfig[key] === undefined) delete generationConfig[key];
  const body: Record<string, unknown> = {
    contents: converted.contents,
    safetySettings: GEMINI_SAFETY,
    generationConfig,
  };
  if (useSystemPrompt && converted.systemInstruction.parts.length)
    body.systemInstruction = converted.systemInstruction;
  if (request.tools?.length && !/gemma-3/.test(model)) {
    const declarations = request.tools.map((tool) => {
      const parameters = { ...tool.parameters };
      delete parameters.$schema;
      const properties = parameters.properties as Record<string, unknown> | undefined;
      const empty = properties && Object.keys(properties).length === 0;
      return { name: tool.name, description: tool.description, ...(empty ? {} : { parameters }) };
    });
    body.tools = [{ function_declarations: declarations }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  Object.assign(body, request.extraBody ?? {});
  for (const key of request.excludeBody ?? []) delete body[key];
  return body;
}

function deltaFrom(json: Record<string, unknown>): StreamDelta {
  if (json.error) return { error: errorMessage(json) };
  const candidate = (json.candidates as Record<string, unknown>[] | undefined)?.[0];
  const parts =
    ((candidate?.content as Record<string, unknown> | undefined)?.parts as Part[] | undefined) ?? [];
  const out: StreamDelta = {};
  const text = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  const reasoning = parts
    .filter((p) => p.thought && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  const signature = parts.find((p) => typeof p.thoughtSignature === 'string')?.thoughtSignature as
    string | undefined;
  if (text) out.text = text;
  if (reasoning) out.reasoning = reasoning;
  if (signature) out.signature = signature;
  if (typeof candidate?.finishReason === 'string') out.finishReason = candidate.finishReason;
  const blocked = (json.promptFeedback as Record<string, unknown> | undefined)?.blockReason;
  if (blocked) out.error = `The prompt was blocked: ${String(blocked)}`;
  if (json.usageMetadata) out.usage = json.usageMetadata as Record<string, unknown>;
  return out;
}

class GeminiDecoder implements StreamDecoder {
  #sse = new SseParser();

  push(chunk: Uint8Array | string): StreamDelta[] {
    return this.#sse.push(chunk).flatMap((e) => this.#event(e.data));
  }

  end(): StreamDelta[] {
    return this.#sse.end().flatMap((e) => this.#event(e.data));
  }

  #event(data: string): StreamDelta[] {
    try {
      const json = JSON.parse(data);
      return [{ event: json }, deltaFrom(json)];
    } catch {
      return [];
    }
  }
}

export const gemini: ProviderAdapter = {
  buildRequest(request): HttpRequestSpec {
    const base = request.baseUrl || request.provider.baseUrl;
    const action = request.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const version = request.provider.apiVersion ? `${request.provider.apiVersion}/` : '';
    return {
      url: joinUrl(base, `${version}models/${request.model}:${action}`),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...request.provider.defaultHeaders,
        ...request.extraHeaders,
      },
      body: JSON.stringify(buildGeminiBody(request)),
      auth: request.provider.auth,
    };
  },
  createDecoder: () => new GeminiDecoder(),
  parseResponse: (body) => deltaFrom(body as Record<string, unknown>),
};

/** SillyTavern keeps the first five stop strings and drops those outside 1-16 characters. */
function geminiStops(stop: readonly string[] | undefined): string[] | undefined {
  const kept = (stop ?? []).slice(0, 5).filter((x) => x.length >= 1 && x.length <= 16);
  return kept.length ? kept : undefined;
}
