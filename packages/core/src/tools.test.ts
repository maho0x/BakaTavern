import { describe, expect, it } from 'vitest';

import { consumeStream } from './generation/stream.ts';
import { adapterFor, getProvider } from './providers/index.ts';
import { toolCallingSupported, toolCallsOf, toolInvocationsText, toolsForRequest } from './tools.ts';

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const read = (provider: string, text: string) =>
  consumeStream(stream(text), adapterFor(getProvider(provider)!).createDecoder(), () => {});

describe('tool calls', () => {
  it('are collected from OpenAI-style streams', async () => {
    const output = await read(
      'openai',
      [
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"roll","arguments":""}}]}}]}',
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"sides\\":"}}]}}]}',
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"arguments":"20}"}}]},"finish_reason":"tool_calls"}]}',
      ]
        .map((e) => `data: ${e}\n\n`)
        .join(''),
    );
    expect(output.toolCalls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'roll', arguments: '{"sides":20}' } },
    ]);
  });

  it('are collected from Claude and Gemini streams', async () => {
    const claude = await read(
      'claude',
      [
        '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"roll","input":{}}}',
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"sides\\""}}',
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":6}"}}',
        '{"type":"content_block_stop","index":1}',
      ]
        .map((e) => `event: x\ndata: ${e}\n\n`)
        .join(''),
    );
    expect(claude.toolCalls).toEqual([
      { id: 'toolu_1', function: { name: 'roll', arguments: { sides: 6 } } },
    ]);

    const gemini = await read(
      'makersuite',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"roll","args":{"sides":4}},"thoughtSignature":"sig"}]}}]}\n\n',
    );
    expect(gemini.toolCalls).toMatchObject([
      { function: { name: 'roll', arguments: { sides: 4 } }, signature: 'sig' },
    ]);
  });

  it('are read from whole responses', () => {
    expect(
      toolCallsOf({
        choices: [
          { index: 0, message: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }] } },
        ],
      }),
    ).toEqual([{ id: 'a', function: { name: 'f', arguments: '{}' } }]);
    expect(toolCallsOf({ content: [{ type: 'tool_use', id: 'b', name: 'g', input: { x: 1 } }] })).toEqual([
      { id: 'b', function: { name: 'g', arguments: { x: 1 } } },
    ]);
    expect(toolCallsOf({ choices: [{ index: 0, message: { content: 'hi' } }] })).toEqual([]);
  });

  it('follow SillyTavern’s rules for support, requests and the recorded message', () => {
    expect(toolCallingSupported('openai', 'gpt-4.1', { function_calling: true })).toBe(true);
    expect(toolCallingSupported('openai', 'gpt-4.1', { function_calling: false })).toBe(false);
    expect(
      toolCallingSupported('custom', 'm', { function_calling: true, custom_prompt_post_processing: 'merge' }),
    ).toBe(false);
    expect(
      toolCallingSupported('openrouter', 'm', { function_calling: true }, { supported_parameters: [] }),
    ).toBe(false);
    expect(toolsForRequest([])).toEqual({});
    expect(
      toolsForRequest([{ name: 'roll', description: 'Rolls a die.', parameters: { type: 'object' } }]),
    ).toEqual({
      tools: [
        {
          type: 'function',
          function: { name: 'roll', description: 'Rolls a die.', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    });
    expect(
      toolInvocationsText([
        { id: '1', name: 'roll', parameters: '{"sides":6}', result: '4 & <5>' },
        { id: '2', name: 'roll', parameters: '{}', result: '1' },
      ]),
    ).toBe(
      '<details><summary>Tool calls: roll (2)</summary><pre><code class="language-json">' +
        JSON.stringify(
          [
            { id: '1', name: 'roll', parameters: { sides: 6 }, result: '4 & <5>' },
            { id: '2', name: 'roll', parameters: {}, result: 1 },
          ],
          null,
          2,
        )
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;') +
        '</code></pre></details>',
    );
  });
});
