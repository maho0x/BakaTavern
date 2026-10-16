import { describe, expect, it } from 'vitest';

import {
  adapterFor,
  buildClaudeBody,
  buildGeminiBody,
  buildOpenAIBody,
  getProvider,
  parseModels,
  providerOrigins,
  SseParser,
} from './index.ts';
import type { GenerationRequest } from './types.ts';

const names = { charName: 'Seraphina', userName: 'Alice', groupNames: [] };

function request(providerId: string, overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    provider: getProvider(providerId)!,
    model: 'test-model',
    stream: true,
    messages: [
      { role: 'system', content: 'Main prompt' },
      { role: 'system', content: 'Hi', name: 'example_user' },
      { role: 'assistant', content: 'Hello Alice' },
      { role: 'user', content: 'Hi!' },
    ],
    params: { temperature: 0.8, top_p: 0.9, top_k: 40, max_tokens: 500, stop: ['\nAlice:'] },
    names,
    ...overrides,
  };
}

/** Decoded deltas without the raw events they come with. */
const content = (deltas: { event?: unknown }[]) => deltas.filter((d) => !('event' in d));

describe('SSE parsing', () => {
  it('handles split chunks, CRLF and event names', () => {
    const parser = new SseParser();
    expect(parser.push('event: ping\r\ndata: {"a":')).toEqual([]);
    expect(parser.push('1}\r\n\r\ndata: x\n')).toEqual([{ event: 'ping', data: '{"a":1}' }]);
    expect(parser.push('data: y\n\n')).toEqual([{ event: 'message', data: 'x\ny' }]);
    expect(parser.push(': comment\n\n')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });
});

describe('OpenAI-compatible', () => {
  it('builds the body with provider-specific samplers', () => {
    const body = buildOpenAIBody(
      request('openrouter', {
        params: {
          ...request('openrouter').params,
          min_p: 0.05,
          reasoning_effort: 'high',
          include_reasoning: true,
        },
      }),
    );
    expect(body).toMatchObject({
      model: 'test-model',
      temperature: 0.8,
      top_k: 40,
      min_p: 0.05,
      max_tokens: 500,
      stop: ['\nAlice:'],
    });
    // As SillyTavern: OpenRouter always says whether to include the reasoning.
    expect(body.reasoning).toEqual({ exclude: false, effort: 'high' });
    const openai = buildOpenAIBody(request('openai', { model: 'gpt-5.6-terra' }));
    expect(openai.max_completion_tokens).toBe(500);
    expect(openai.temperature).toBeUndefined();
    expect(openai.top_k).toBeUndefined();
  });

  it('decodes content, reasoning and errors from the stream', () => {
    const decoder = adapterFor(getProvider('deepseek')!).createDecoder();
    const deltas = decoder.push(
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    expect(content(deltas)).toEqual([
      { reasoning: 'think' },
      { text: 'Hel' },
      { text: 'lo', finishReason: 'stop' },
    ]);
    expect(content(decoder.push('data: {"error":{"message":"rate limited"}}\n\n'))).toEqual([
      { error: 'rate limited' },
    ]);
  });
});

describe('Anthropic', () => {
  it('moves system messages to the system prompt and merges turns', () => {
    const body = buildClaudeBody(request('claude', { useSystemPrompt: true, assistantPrefill: 'Sure, ' }));
    expect(body.system).toEqual([
      { type: 'text', text: 'Main prompt' },
      { type: 'text', text: 'Alice: Hi' },
    ]);
    expect(body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Hello Alice' }] },
      { role: 'user', content: [{ type: 'text', text: 'Hi!' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure,' }] },
    ]);
    expect(body).toMatchObject({ max_tokens: 500, stop_sequences: ['\nAlice:'], temperature: 0.8 });
  });

  it('enables thinking budgets and drops samplers', () => {
    const body = buildClaudeBody(
      request('claude', {
        model: 'claude-sonnet-4-5',
        params: { max_tokens: 4000, temperature: 1, reasoning_effort: 'medium' },
      }),
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(body.temperature).toBeUndefined();
  });

  it('decodes text, thinking and stop reasons', () => {
    const decoder = adapterFor(getProvider('claude')!).createDecoder();
    const stream = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    ].join('');
    expect(content(decoder.push(stream))).toEqual([
      { reasoning: 'hmm' },
      { text: 'Hi' },
      { finishReason: 'end_turn', usage: { output_tokens: 3 } },
    ]);
  });
});

describe('Gemini', () => {
  it('converts roles, system instruction and generation config', () => {
    const body = buildGeminiBody(request('makersuite', { model: 'gemini-2.0-flash', useSystemPrompt: true }));
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Main prompt' }, { text: 'Alice: Hi' }] });
    expect(body.contents).toEqual([
      { role: 'model', parts: [{ text: 'Hello Alice' }] },
      { role: 'user', parts: [{ text: 'Hi!' }] },
    ]);
    expect(body.generationConfig).toEqual({
      stopSequences: ['\nAlice:'],
      candidateCount: 1,
      maxOutputTokens: 500,
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
    });
  });

  it('builds the streaming URL and decodes thoughts', () => {
    const spec = adapterFor(getProvider('makersuite')!).buildRequest(
      request('makersuite', { model: 'gemini-2.5-pro' }),
    );
    expect(spec.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
    expect(spec.auth).toEqual({ type: 'header', name: 'x-goog-api-key' });
    const decoder = adapterFor(getProvider('makersuite')!).createDecoder();
    const deltas = decoder.push(
      'data: {"candidates":[{"content":{"parts":[{"text":"plan","thought":true},{"text":"Answer"}]}}]}\n\n',
    );
    expect(content(deltas)).toEqual([{ text: 'Answer', reasoning: 'plan' }]);
  });
});

describe('models and origins', () => {
  it('parses model lists', () => {
    expect(
      parseModels(getProvider('makersuite')!, {
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    ).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextLength: 1048576, maxOutput: undefined },
    ]);
    expect(
      parseModels(getProvider('openrouter')!, {
        data: [
          { id: 'b/m', name: 'B' },
          { id: 'a/m', context_length: 8192 },
        ],
      }).map((m) => m.id),
    ).toEqual(['a/m', 'b/m']);
  });

  it('lists the origins a key may be sent to', () => {
    expect(providerOrigins(getProvider('siliconflow')!)).toEqual([
      'https://api.siliconflow.com',
      'https://api.siliconflow.cn',
    ]);
    expect(providerOrigins(getProvider('custom')!, 'http://127.0.0.1:5001/v1')).toEqual([
      'http://127.0.0.1:5001',
    ]);
  });
});
