import { describe, expect, it } from 'vitest';

import { createMacroEngine, type MacroEnv } from '../macros/index.ts';
import {
  buildChatCompletion,
  defaultChatCompletionPreset,
  examplesToMessages,
  ExtensionPromptPosition,
  InjectKeys,
  mergeMessages,
  NamesBehavior,
  parseMesExamples,
  toPromptMessages,
  type ChatCompletionInput,
  type ChatMessage,
} from './index.ts';

const engine = createMacroEngine();
const env: MacroEnv = {
  user: 'Alice',
  char: 'Seraphina',
  description: 'A forest guardian.',
  personality: 'kind',
  scenario: 'In the woods.',
  persona: 'A traveler.',
};

/** Rough counter: ~1 token per 4 chars + 4 overhead, like ST's per-message accounting. */
const count = (m: ChatMessage) =>
  Math.ceil((typeof m.content === 'string' ? m.content.length : 0) / 4) +
  4 +
  (m.name ? m.name.length + 1 : 0);

function input(overrides: Partial<ChatCompletionInput> = {}): ChatCompletionInput {
  return {
    type: 'normal',
    preset: { ...defaultChatCompletionPreset(), openai_max_context: 8000 },
    isGroup: false,
    charDescription: 'A forest guardian.',
    charPersonality: 'kind',
    scenario: 'In the woods.',
    worldInfoBefore: '',
    worldInfoAfter: '',
    bias: '',
    quietPrompt: '',
    cyclePrompt: '',
    systemPromptOverride: '',
    jailbreakPromptOverride: '',
    extensionPrompts: {},
    personaDescription: 'A traveler.',
    messages: toPromptMessages(
      [
        { name: 'Seraphina', role: 'assistant', content: 'Hello {{user}}' },
        { name: 'Alice', role: 'user', content: 'Hi!' },
      ],
      { namesBehavior: NamesBehavior.DEFAULT, userName: 'Alice', isGroup: false },
    ),
    messageExamples: [],
    pinExamples: false,
    substitute: (text, options) => engine.evaluate(text, { ...env, original: options?.original }),
    countTokens: count,
    supportsAssistantPrefill: false,
    ...overrides,
  };
}

const simplify = (messages: ChatMessage[]) =>
  messages.map((m) => `${m.role}${m.name ? `(${m.name})` : ''}: ${m.content}`);

describe('buildChatCompletion', () => {
  it('sends names as completion objects in COMPLETION mode', async () => {
    const preset = defaultChatCompletionPreset();
    preset.names_behavior = NamesBehavior.COMPLETION;
    const result = await buildChatCompletion(input({ preset }));
    expect(simplify(result.messages).slice(-2)).toEqual([
      'assistant(Seraphina): Hello Alice',
      'user(Alice): Hi!',
    ]);
  });

  it('assembles the default prompt order', async () => {
    const result = await buildChatCompletion(input());
    expect(simplify(result.messages)).toEqual([
      "system: Write Seraphina's next reply in a fictional chat between Seraphina and Alice.",
      'system: A traveler.',
      'system: A forest guardian.',
      'system: kind',
      'system: In the woods.',
      'system: [Start a new Chat]',
      // As in SillyTavern, names are only sent in "completion object" names mode.
      'assistant: Hello Alice',
      'user: Hi!',
    ]);
    expect(result.parts.map((p) => p.identifier)).toEqual([
      'main',
      'personaDescription',
      'charDescription',
      'charPersonality',
      'scenario',
      'chatHistory',
    ]);
  });

  it('applies character overrides with {{original}} and world info format', async () => {
    const preset = defaultChatCompletionPreset();
    preset.wi_format = '[Lore: {0}]';
    const result = await buildChatCompletion(
      input({
        preset,
        systemPromptOverride: 'Custom main. {{original}}',
        jailbreakPromptOverride: 'Stay in character.',
        worldInfoBefore: 'Eldoria is a forest.',
        worldInfoAfter: 'Magic exists.',
      }),
    );
    const texts = simplify(result.messages);
    expect(texts[0]).toBe(
      "system: Custom main. Write Seraphina's next reply in a fictional chat between Seraphina and Alice.",
    );
    expect(texts[1]).toBe('system: [Lore: Eldoria is a forest.]');
    expect(texts).toContain('system: [Lore: Magic exists.]');
    expect(texts.at(-1)).toBe('system: Stay in character.');
  });

  it('injects depth prompts and absolute prompt manager entries into the history', async () => {
    const preset = defaultChatCompletionPreset();
    preset.prompts.push({
      identifier: 'custom1',
      name: 'Reminder',
      role: 'user',
      content: 'Remember the forest.',
      system_prompt: false,
      injection_position: 1,
      injection_depth: 0,
    });
    preset.prompt_order[0]!.order.push({ identifier: 'custom1', enabled: true });
    const result = await buildChatCompletion(
      input({
        preset,
        extensionPrompts: {
          [InjectKeys.AUTHORS_NOTE]: {
            value: "[Author's note]",
            position: ExtensionPromptPosition.IN_CHAT,
            depth: 1,
            role: 0,
            scan: false,
          },
          [InjectKeys.worldInfoDepth(0, 0)]: {
            value: 'WI at depth 0',
            position: ExtensionPromptPosition.IN_CHAT,
            depth: 0,
            role: 0,
            scan: false,
          },
        },
      }),
    );
    // Depth 0 goes after the last message, depth 1 before it; at one depth the system role ends up last.
    expect(simplify(result.messages).slice(-5)).toEqual([
      'assistant: Hello Alice',
      "system: [Author's note]",
      'user: Hi!',
      'user: Remember the forest.',
      'system: WI at depth 0',
    ]);
  });

  it('adds example dialogues and impersonation control prompts', async () => {
    const blocks = parseMesExamples('<START>\nAlice: Hello\nSeraphina: Greetings, traveler.');
    const messageExamples = examplesToMessages(blocks, {
      userName: 'Alice',
      charName: 'Seraphina',
      groupNames: [],
      isGroup: false,
    });
    const result = await buildChatCompletion(input({ messageExamples, type: 'impersonate' }));
    const texts = simplify(result.messages);
    expect(texts).toContain('system: [Example Chat]');
    expect(texts).toContain('system(example_user): Hello');
    expect(texts).toContain('system(example_assistant): Greetings, traveler.');
    expect(texts.at(-1)).toMatch(/^system: \[Write your next reply from the point of view of Alice/);
    // Examples come after the history markers' predecessors but before the chat history.
    expect(texts.indexOf('system: [Example Chat]')).toBeLessThan(texts.indexOf('system: [Start a new Chat]'));
  });

  it('continues with a nudge (no prefill)', async () => {
    const result = await buildChatCompletion(
      input({
        type: 'continue',
        cyclePrompt: 'Hi!',
      }),
    );
    expect(simplify(result.messages).slice(-3)).toEqual([
      'assistant: Hello Alice',
      'user: Hi!',
      'system: [Continue your last message without repeating its original content.]',
    ]);
  });

  it('drops the oldest history first when the budget is tight', async () => {
    const preset = defaultChatCompletionPreset();
    preset.openai_max_context = 300;
    preset.openai_max_tokens = 150;
    const history = Array.from({ length: 20 }, (_, i) => ({
      name: i % 2 ? 'Alice' : 'Seraphina',
      role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message number ${i} with some padding text.`,
    }));
    const result = await buildChatCompletion(
      input({
        preset,
        messages: toPromptMessages(history, { namesBehavior: 0, userName: 'Alice', isGroup: false }),
      }),
    );
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain('Message number 19 with some padding text.');
    expect(contents).not.toContain('Message number 0 with some padding text.');
    expect(result.error).toBeUndefined();
  });

  it('reports when mandatory prompts exceed the budget', async () => {
    const preset = defaultChatCompletionPreset();
    preset.openai_max_context = 20;
    preset.openai_max_tokens = 10;
    const result = await buildChatCompletion(input({ preset }));
    expect(result.error).toBe('budget');
  });

  it('squashes consecutive system messages when enabled', async () => {
    const preset = defaultChatCompletionPreset();
    preset.squash_system_messages = true;
    const result = await buildChatCompletion(input({ preset }));
    expect(result.messages[0]!.content).toBe(
      "Write Seraphina's next reply in a fictional chat between Seraphina and Alice.\nA traveler.\nA forest guardian.\nkind\nIn the woods.",
    );
    expect(result.messages[1]!.content).toBe('[Start a new Chat]');
  });
});

describe('mergeMessages', () => {
  it('strict mode leaves one system message and starts with a user turn', () => {
    const merged = mergeMessages(
      [
        { role: 'system', content: 'Main' },
        { role: 'system', content: 'Example', name: 'example_assistant' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Yo', name: 'Alice' },
      ],
      { charName: 'Seraphina', userName: 'Alice', groupNames: [] },
      { strict: true, placeholders: true },
    );
    expect(merged).toEqual([
      { role: 'system', content: 'Main\n\nSeraphina: Example' },
      { role: 'user', content: "Let's get started." },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Alice: Yo' },
    ]);
  });
});
