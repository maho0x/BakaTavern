import { describe, expect, it } from 'vitest';

import { normalizeContextTemplate, normalizeInstructTemplate } from '../prompt/instruct.ts';
import {
  customTokenBans,
  normalizeTextgenSettings,
  parseTextgenModels,
  textgenAdapter,
  textgenGenerateData,
  textgenModelsRequest,
  textgenSupports,
  textgenUpstream,
  textgenLogitBias,
} from './textgen.ts';

const same = (text: string) => text;
const decode = (type: string, chunks: string[]) => {
  const decoder = textgenAdapter(type).createDecoder();
  const deltas = [...chunks.flatMap((c) => decoder.push(c)), ...decoder.end()];
  return {
    text: deltas.map((d) => d.text ?? '').join(''),
    reasoning: deltas.map((d) => d.reasoning ?? '').join(''),
    finish: deltas.find((d) => d.finishReason)?.finishReason,
    error: deltas.find((d) => d.error)?.error,
  };
};

describe('Text Completion backends', () => {
  it('completes sampler order lists with newer samplers, like SillyTavern on load', () => {
    const settings = normalizeTextgenSettings({ samplers: ['top_k', 'temperature'], sampler_order: 'bad' });
    expect(settings.samplers.slice(0, 4)).toEqual(['penalties', 'dry', 'top_n_sigma', 'top_k']);
    expect(settings.samplers).toContain('adaptive_p');
    expect(settings.sampler_order).toEqual([6, 0, 1, 3, 4, 2, 5]);
    // Defaults are copied, not shared.
    settings.sampler_priority.push('mine');
    expect(normalizeTextgenSettings({}).sampler_priority).not.toContain('mine');
  });

  it('sends what each backend accepts', () => {
    const body = textgenGenerateData({
      settings: normalizeTextgenSettings({
        type: 'generic',
        server_urls: { generic: 'http://localhost:1234/v1' },
      }),
      prompt: 'Hi',
      maxTokens: 50,
      maxContext: 4096,
      type: 'normal',
      stoppingStrings: ['a', 'b', 'c', 'd', 'e'],
      substitute: same,
      stream: true,
    });
    expect(body.api_server).toBe('http://localhost:1234/v1');
    const { url, body: upstream } = textgenUpstream(body);
    expect(url).toBe('http://127.0.0.1:1234/v1/completions');
    expect(upstream.stop).toEqual(['a', 'b', 'c', 'd']);
    expect(Object.keys(upstream).sort()).toEqual(
      [
        'frequency_penalty',
        'max_tokens',
        'presence_penalty',
        'prompt',
        'stop',
        'stream',
        'temperature',
        'top_p',
      ].sort(),
    );

    const ollama = textgenUpstream({
      api_type: 'ollama',
      api_server: 'http://127.0.0.1:11434',
      model: 'm',
      prompt: 'p',
      num_ctx: 8,
      top_k: 3,
      rep_pen: 1,
    });
    expect(ollama.url).toBe('http://127.0.0.1:11434/api/generate');
    expect(ollama.body).toEqual({
      model: 'm',
      prompt: 'p',
      stream: false,
      keep_alive: -1,
      raw: true,
      options: { num_ctx: 8, top_k: 3 },
    });
  });

  it('turns token bans and logit bias into token ids where it can', () => {
    const settings = normalizeTextgenSettings({
      banned_tokens: '[1, 2]\n"a phrase"\nwords',
      global_banned_tokens: '{{char}}',
    });
    expect(
      customTokenBans(
        settings,
        (t) => t.replace('{{char}}', '"Aiko"'),
        [],
        (t) => (t === 'words' ? [9] : undefined),
      ),
    ).toEqual({
      banned_tokens: '1,2,9',
      banned_strings: ['a phrase', 'Aiko'],
    });
    expect(
      textgenLogitBias(
        [
          { text: '[5, 6]', value: -2 },
          { text: 'hello', value: 1 },
        ],
        (t) => (t === ' hello' ? [7] : undefined),
      ),
    ).toEqual({
      5: -2,
      6: -2,
      7: 1,
    });
  });

  it('reads OpenAI-style, llama.cpp and Ollama streams', () => {
    expect(
      decode('koboldcpp', [
        'data: {"choices":[{"text":"Hel","index":0}]}\n\n',
        'data: {"choices":[{"text":"lo","index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ]),
    ).toMatchObject({ text: 'Hello', finish: 'stop' });
    expect(
      decode('llamacpp', [
        'data: {"content":"Hi","stop":false}\n\n',
        'data: {"content":"!","stop":true,"stop_type":"eos"}\n\n',
      ]),
    ).toMatchObject({
      text: 'Hi!',
      finish: 'eos',
    });
    expect(
      decode('ollama', [
        '{"thinking":"hmm","done":false}\n{"response":"Yo',
        '","done":false}\n{"response":"","done":true}\n',
      ]),
    ).toMatchObject({
      text: 'Yo',
      reasoning: 'hmm',
      finish: 'stop',
    });
    expect(decode('ooba', ['data: {"error":{"message":"No model loaded"}}\n\n']).error).toBe(
      'No model loaded',
    );
    expect(textgenAdapter('ollama').parseResponse({ response: 'Done.', thinking: 'ok' })).toEqual({
      text: 'Done.',
      reasoning: 'ok',
    });
    expect(textgenAdapter('ooba').parseResponse({ choices: [{ text: 'Plain' }] }).text).toBe('Plain');
  });

  it('lists models from each backend’s status endpoint', () => {
    expect(textgenModelsRequest('ollama', 'http://127.0.0.1:11434/')?.url).toBe(
      'http://127.0.0.1:11434/api/tags',
    );
    expect(textgenModelsRequest('tabby', 'http://127.0.0.1:5000/v1')?.url).toBe(
      'http://127.0.0.1:5000/v1/model/list',
    );
    expect(textgenModelsRequest('togetherai', '')?.url).toBe('https://api.together.xyz/api/models?&info');
    expect(parseTextgenModels('ollama', { models: [{ name: 'llama3:8b' }] })).toEqual(['llama3:8b']);
    expect(parseTextgenModels('togetherai', [{ name: 'a/b' }])).toEqual(['a/b']);
    expect(parseTextgenModels('ooba', { data: [{ id: 'x' }] })).toEqual(['x']);
  });

  it('knows which backend offers which setting', () => {
    expect(textgenSupports('generic', 'top_k')).toBe(false);
    expect(textgenSupports('ooba', 'top_k')).toBe(true);
    expect(textgenSupports('koboldcpp', 'sampler_order')).toBe(true);
    expect(textgenSupports('vllm', 'dry')).toBe(false);
    expect(textgenSupports('vllm', 'temp')).toBe(true);
  });
});

describe('formatting templates', () => {
  it('migrates old instruct templates', () => {
    const template = normalizeInstructTemplate({
      separator_sequence: '</s>',
      names: true,
      input_sequence: '### Q:',
    });
    expect(template).toMatchObject({
      output_suffix: '</s>',
      names_behavior: 'always',
      input_sequence: '### Q:',
      wrap: true,
    });
    expect(template).not.toHaveProperty('names');
    expect(normalizeInstructTemplate({ names: false, names_force_groups: true }).names_behavior).toBe(
      'force',
    );
  });

  it('adds story string anchors to context templates from before positions existed', () => {
    const old = normalizeContextTemplate({
      story_string: '{{#if description}}{{description}}\n{{/if}}{{trim}}',
    });
    expect(old.story_string).toBe(
      '{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}{{trim}}',
    );
    const current = normalizeContextTemplate({ story_string: '{{description}}', story_string_position: '1' });
    expect(current.story_string).toBe('{{description}}');
    expect(current.story_string_position).toBe(1);
  });
});
