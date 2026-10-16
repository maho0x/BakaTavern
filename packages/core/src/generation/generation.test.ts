import { describe, expect, it } from 'vitest';

import { createMacroEngine } from '../macros/index.ts';
import { defaultChatCompletionPreset } from '../prompt/index.ts';
import { getProvider, normalizeTextgenSettings } from '../providers/index.ts';
import { newRegexScript, RegexPlacement } from '../regex/index.ts';
import { estimateTokenizer } from '../tokenizers/index.ts';
import { createEntry, defaultWorldInfoSettings, WorldInfoPosition } from '../worldinfo/index.ts';
import {
  cleanUpMessage,
  trimToEndSentence,
  extractReasoning,
  greetingSwipes,
  itemizePrompt,
  PersonaPosition,
  prepareGeneration,
  type ChatCompletionOptions,
  type TextCompletionOptions,
} from './index.ts';

const macros = createMacroEngine();
const card = {
  spec: 'chara_card_v3',
  data: {
    name: 'Seraphina',
    description: '{{char}} guards the forest of Eldoria.',
    personality: 'gentle',
    scenario: '{{user}} wakes up in a glade.',
    first_mes: 'Welcome, {{user}}.',
    alternate_greetings: ['Ah, {{user}}, you are awake.'],
    mes_example: '<START>\n{{user}}: Who are you?\n{{char}}: I am the guardian.',
    system_prompt: '',
    post_history_instructions: '',
    extensions: { depth_prompt: { prompt: 'Seraphina speaks softly.', depth: 1, role: 'system' } },
  },
};

function options(overrides: Partial<ChatCompletionOptions> = {}): ChatCompletionOptions {
  return {
    type: 'normal',
    card,
    characterKey: 'Seraphina',
    characterTags: [],
    persona: {
      name: 'Alice',
      description: 'A lost traveler.',
      position: PersonaPosition.AT_DEPTH,
      depth: 2,
      role: 0,
    },
    chatId: 'chat-1',
    chatMetadata: {
      note_prompt: 'Keep it short.',
      note_interval: 1,
      note_position: 1,
      note_depth: 4,
      note_role: 0,
    },
    messages: [
      {
        name: 'Seraphina',
        role: 'assistant',
        hidden: false,
        content: 'Welcome, Alice.',
        swipeId: 0,
        swipeCount: 1,
        extra: {},
      },
      {
        name: 'Alice',
        role: 'user',
        hidden: false,
        content: 'Where is the old tower?',
        swipeId: 0,
        swipeCount: 1,
        extra: {},
      },
      {
        name: 'Alice',
        role: 'user',
        hidden: true,
        content: 'hidden note',
        swipeId: 0,
        swipeCount: 1,
        extra: {},
      },
    ],
    preset: { ...defaultChatCompletionPreset(), openai_max_context: 16000, stream_openai: true },
    connection: { provider: getProvider('openai')!, model: 'gpt-4o' },
    worldInfo: {
      settings: defaultWorldInfoSettings,
      global: [],
      character: [
        {
          name: 'Eldoria',
          entries: [
            createEntry(0, { key: ['tower'], content: 'The old tower lies north.' }),
            createEntry(1, {
              constant: true,
              content: 'Magic hums here.',
              position: WorldInfoPosition.atDepth,
              depth: 0,
            }),
          ],
        },
      ],
    },
    authorsNote: { allowWIScan: false },
    globalVariables: {},
    tokenizer: estimateTokenizer,
    macros,
    stoppingStrings: ['\n{{user}}:'],
    ...overrides,
  };
}

describe('prepareGeneration', () => {
  it('builds a complete OpenAI request', async () => {
    const prepared = await prepareGeneration(options());
    const texts = prepared.request.messages.map((m) => `${m.role}: ${m.content}`);
    // Injections: depth 0 after the last message, depth 1 before it; deeper ones (persona at 2,
    // Author's Note at 4) exceed this short chat and stack at the top of the history, as in SillyTavern.
    expect(texts).toEqual([
      "system: Write Seraphina's next reply in a fictional chat between Seraphina and Alice.",
      'system: The old tower lies north.',
      'system: Seraphina guards the forest of Eldoria.',
      'system: gentle',
      'system: Alice wakes up in a glade.',
      'system: [Example Chat]',
      'system: Who are you?',
      'system: I am the guardian.',
      'system: [Start a new Chat]',
      'system: Keep it short.',
      'system: A lost traveler.',
      'assistant: Welcome, Alice.',
      'system: Seraphina speaks softly.',
      'user: Where is the old tower?',
      'system: Magic hums here.',
    ]);
    expect(prepared.request.params.stop).toEqual(['\nAlice:']);
    expect(prepared.http.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse(prepared.http.body!).model).toBe('gpt-4o');
  });

  it('targets Claude with a system prompt and prefill', async () => {
    const preset = { ...defaultChatCompletionPreset(), use_sysprompt: true, assistant_prefill: 'Seraphina:' };
    const prepared = await prepareGeneration(
      options({ preset, connection: { provider: getProvider('claude')!, model: 'claude-3-7-sonnet' } }),
    );
    const body = JSON.parse(prepared.http.body!);
    expect(body.system[0].text).toContain('Write Seraphina');
    expect(body.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Seraphina:' }],
    });
    expect(prepared.http.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('records sticky world info state in chat metadata', async () => {
    const chatMetadata: Record<string, unknown> = {};
    await prepareGeneration(
      options({
        chatMetadata,
        worldInfo: {
          settings: defaultWorldInfoSettings,
          global: [],
          character: [{ name: 'B', entries: [createEntry(0, { key: ['tower'], content: 'x', sticky: 3 })] }],
        },
      }),
    );
    expect(Object.keys((chatMetadata.timedWorldInfo as { sticky: object }).sticky)).toEqual(['B.0']);
  });

  it('applies prompt-only regex scripts to the history and World Info', async () => {
    const regexScripts = [
      newRegexScript('a', {
        scriptName: 'ancient',
        findRegex: '/old/g',
        replaceString: 'ancient',
        placement: [RegexPlacement.USER_INPUT],
        promptOnly: true,
      }),
      newRegexScript('b', {
        scriptName: 'south',
        findRegex: '/north/',
        replaceString: 'south',
        placement: [RegexPlacement.WORLD_INFO],
        promptOnly: true,
      }),
      newRegexScript('c', {
        scriptName: 'display only',
        findRegex: '/Welcome/',
        replaceString: 'Hi',
        placement: [RegexPlacement.AI_OUTPUT],
        markdownOnly: true,
      }),
    ];
    const prepared = await prepareGeneration(options({ regexScripts }));
    const texts = prepared.request.messages.map((m) => m.content);
    expect(texts).toContain('Where is the ancient tower?');
    expect(texts).toContain('The old tower lies south.');
    expect(texts).toContain('Welcome, Alice.');
  });

  it('adds the latest reasoning to the prompt when enabled', async () => {
    const base = options();
    const messages = base.messages.map((m, i) => (i === 0 ? { ...m, extra: { reasoning: 'Be kind.' } } : m));
    const reasoning = {
      addToPrompts: true,
      maxAdditions: 1,
      prefix: '<think>',
      suffix: '</think>',
      separator: '\n',
    };
    const prepared = await prepareGeneration(options({ messages, reasoning }));
    expect(prepared.request.messages.map((m) => m.content)).toContain(
      '<think>Be kind.</think>\nWelcome, Alice.',
    );
    const off = await prepareGeneration(options({ messages }));
    expect(off.request.messages.map((m) => m.content)).toContain('Welcome, Alice.');
  });

  it('puts the reasoning of a continued reply before it', async () => {
    const messages = options()
      .messages.slice(0, 1)
      .map((m) => ({ ...m, extra: { reasoning: 'Plan.' } }));
    const prepared = await prepareGeneration(options({ type: 'continue', messages }));
    expect(prepared.reasoningPrefix).toEqual({ text: '<think>Plan.</think>\n', incomplete: false });
    expect(prepared.request.messages.map((m) => m.content)).toContain(
      '<think>Plan.</think>\nWelcome, Alice.',
    );
  });

  it('itemizes the prompt it built', async () => {
    const opts = options();
    const prepared = await prepareGeneration(opts);
    const itemized = await itemizePrompt(prepared, opts, estimateTokenizer);
    expect(itemized).toMatchObject({ api: 'chat', source: 'openai', tokenizer: 'estimate', padding: 0 });
    expect(itemized.items.map((i) => i.id)).toEqual(expect.arrayContaining(['main', 'chatHistory']));
    expect(itemized.total).toBe(itemized.items.reduce((sum, i) => sum + i.tokens, 0));
    expect(itemized.messages).toEqual(prepared.api === 'chat' ? prepared.prompt.messages : undefined);
    expect(itemized.worldInfo.map((e) => e.comment)).toEqual(
      prepared.worldInfo.activated.map((e) => e.comment),
    );
  });

  it('itemizes Text Completion prompts by part', async () => {
    const { preset: _preset, connection: _connection, ...common } = options();
    const opts: TextCompletionOptions = {
      ...common,
      api: 'text',
      text: {
        settings: normalizeTextgenSettings({
          type: 'koboldcpp',
          server_urls: { koboldcpp: 'http://127.0.0.1:5001' },
        }),
        maxContext: 4096,
        maxResponse: 200,
      },
    };
    const prepared = await prepareGeneration(opts);
    const itemized = await itemizePrompt(prepared, opts, estimateTokenizer);
    expect(itemized).toMatchObject({ api: 'text', source: 'koboldcpp', maxContext: 4096, padding: 64 });
    expect(itemized.prompt).toBe(prepared.api === 'text' ? prepared.prompt.prompt : undefined);
    const ids = itemized.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['storyString', 'charDescription', 'chatHistory']));
    expect(itemized.items.find((i) => i.id === 'charDescription')?.within).toBe('storyString');
  });

  it('creates greetings with macros resolved', () => {
    expect(greetingSwipes(card, macros, { user: 'Alice', char: 'Seraphina' })).toEqual([
      'Welcome, Alice.',
      'Ah, Alice, you are awake.',
    ]);
  });
});

describe('reply cleanup', () => {
  it('trims stop strings, partial stops and wrong names', () => {
    const opts = {
      isImpersonate: false,
      isContinue: false,
      stoppingStrings: ['\nAlice:'],
      wrongName: 'Alice',
    };
    expect(cleanUpMessage('Hello there.\nAlice: hi', opts)).toBe('Hello there.');
    expect(cleanUpMessage('Hello there.\nAli', opts)).toBe('Hello there.');
    expect(cleanUpMessage('Alice: I speak for her', opts)).toBe('');
    expect(cleanUpMessage('line one   \nline two  ', opts)).toBe('line one\nline two');
  });

  it('removes leaked instruct sequences and repeated names, trims to a sentence', () => {
    const instruct = {
      stop_sequence: '<|im_end|>',
      input_sequence: '<|im_start|>user',
      output_sequence: '<|im_start|>assistant',
      last_output_sequence: '',
      sequences_as_stop_strings: true,
    };
    const opts = {
      isImpersonate: false,
      isContinue: false,
      stoppingStrings: [],
      instruct,
      charName: 'Seraphina',
    };
    expect(cleanUpMessage('Seraphina: Hello.<|im_end|>\n<|im_start|>user\nHi', opts)).toBe('Hello.');
    expect(cleanUpMessage('<|im_start|>assistant\nSure.\nSeraphina: More.', opts)).toBe('\nSure.\nMore.');
    expect(cleanUpMessage('One. Two and a half', { ...opts, trimSentences: true })).toBe('One.');
    expect(trimToEndSentence('Done! 😊 trailing')).toBe('Done! 😊');
  });

  it('extracts reasoning blocks, including unterminated ones', () => {
    expect(extractReasoning('<think>\nplan it\n</think>\nAnswer')).toEqual({
      reasoning: 'plan it',
      content: 'Answer',
      complete: true,
    });
    expect(extractReasoning('<think>\nstill thinking')).toEqual({
      reasoning: 'still thinking',
      content: '',
      complete: false,
    });
    expect(extractReasoning('No reasoning')).toBeNull();
  });
});
