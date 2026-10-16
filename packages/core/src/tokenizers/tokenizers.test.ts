import { describe, expect, it } from 'vitest';

import {
  chatTextCounter,
  chatTokenizer,
  chatTokenizerModel,
  createTokenizer,
  estimateTokens,
  messageTokenCounter,
  textCounter,
  textCountTokenizer,
  textIdTokenizer,
  textTokenizer,
  tokenizerForModelName,
} from './index.ts';

/** A tiny Hugging Face `tokenizer.json`: one token per known word. */
const wordLevel = new TextEncoder().encode(
  JSON.stringify({
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [],
    normalizer: null,
    pre_tokenizer: { type: 'Whitespace' },
    post_processor: null,
    decoder: null,
    model: { type: 'WordLevel', vocab: { '[UNK]': 0, hello: 1, world: 2, '!': 3 }, unk_token: '[UNK]' },
  }),
);

describe('tokenizers', () => {
  it('estimates like SillyTavern', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world!')).toBe(4);
    expect(estimateTokens('你好')).toBe(2);
  });

  it('counts Chat Completion messages per message with tiktoken, as joined text otherwise', async () => {
    const o200k = await createTokenizer('o200k');
    const message = { role: 'user' as const, content: 'Hello there!', name: 'Alice' };
    // 3 per message + role + content + name (+1) + 3 priming, minus 2.
    expect(await messageTokenCounter(o200k)(message)).toBe(3 + 1 + 3 + 1 + 1 + 3 - 2);
    // World Info text is counted as a message with only content.
    expect(await chatTextCounter(o200k)('Hello there!')).toBe(3 + 3 + 3);
    // tiktoken refuses special tokens: the message keeps its overhead only.
    expect(await messageTokenCounter(o200k)({ role: 'user', content: 'x <|endoftext|>' })).toBe(
      3 + 1 + 3 - 2,
    );
    expect(await textCounter(o200k)('x <|endoftext|>')).toBe(0);

    const words = await createTokenizer('claude', async () => wordLevel);
    expect(words.id).toBe('claude');
    // "user\n\nhello world !" → [UNK] hello world ! ; Claude counts are not adjusted.
    expect(await messageTokenCounter(words)({ role: 'user', content: 'hello world !' })).toBe(4);
  });

  it('falls back like SillyTavern when a tokenizer file is missing', async () => {
    const missing = async () => {
      throw new Error('offline');
    };
    expect((await createTokenizer('gemma', missing)).id).toBe('estimate');
    // Downloaded tokenizers use Llama 3's when they are missing.
    const qwen = await createTokenizer('qwen2', async (file) => {
      if (file === 'llama3.json') return wordLevel;
      throw new Error('offline');
    });
    expect(qwen.id).toBe('qwen2');
    expect(await qwen.count('hello world')).toBe(2);
  });

  it('picks the tokenizer SillyTavern uses for a model', () => {
    expect(chatTokenizer('openai', 'gpt-4.1')).toBe('o200k');
    expect(chatTokenizer('openai', 'gpt-5.6-terra')).toBe('o200k');
    expect(chatTokenizer('openai', 'gpt-4-turbo')).toBe('cl100k');
    expect(chatTokenizer('custom', 'my-local-model')).toBe('cl100k');
    expect(chatTokenizer('custom', 'deepseek-chat')).toBe('deepseek');
    expect(chatTokenizer('claude', 'claude-sonnet-5')).toBe('claude');
    expect(chatTokenizer('makersuite', 'gemini-3.7-flash')).toBe('gemma');
    expect(chatTokenizer('mistralai', 'open-mistral-nemo')).toBe('nemo');
    expect(chatTokenizer('cohere', 'command-a-03-2025')).toBe('command-a');
    expect(chatTokenizer('openrouter', 'meta-llama/llama-3.3-70b', { tokenizer: 'Llama3' })).toBe('llama3');
    expect(chatTokenizerModel('openrouter', 'anthropic/claude-sonnet-4.5')).toBe('claude');
    expect(chatTokenizer('groq', 'qwen-qwq-32b')).toBe('qwen2');
    expect(tokenizerForModelName('text-davinci-003')).toBe('p50k');
    expect(tokenizerForModelName('text-curie-001')).toBe('gpt2');

    expect(textTokenizer('koboldcpp', '', { remote: true })).toBe('remote');
    expect(textTokenizer('koboldcpp', 'Mistral-Nemo-12B')).toBe('mistral');
    expect(textTokenizer('ollama', 'llama2:13b')).toBe('llama');
    expect(textTokenizer('ollama', 'llama-3.1-8b')).toBe('llama3');
    expect(textTokenizer('dreamgen', 'lucid-v1-extra-large/text')).toBe('llama3');
    expect(textTokenizer('openrouter', 'qwen/qwen-2.5', { info: { tokenizer: 'Qwen' } })).toBe('qwen2');
  });

  it('picks Text Completion tokenizers for counting and for token ids like SillyTavern', () => {
    expect(textCountTokenizer('koboldcpp', '', 'auto')).toBe('remote');
    expect(textCountTokenizer('ollama', 'llama-3.1-8b', 'auto')).toBe('llama3');
    expect(textCountTokenizer('ollama', 'llama-3.1-8b', 'remote')).toBe('estimate');
    expect(textCountTokenizer('ooba', '', 'gpt2')).toBe('gpt2');
    // Token ids come from the backend whenever it can tokenize, whatever the setting.
    expect(textIdTokenizer('llamacpp', '', 'gpt2')).toBe('remote');
    expect(textIdTokenizer('ollama', '', 'mistral')).toBe('mistral');
    // Tokenizers without ids (GPT-2, the estimate) leave Llama's.
    expect(textIdTokenizer('ollama', 'llama-3.1-8b', 'gpt2')).toBe('llama');
    expect(textIdTokenizer('ollama', 'llama-3.1-8b', 'auto')).toBe('llama');
    expect(textIdTokenizer('dreamgen', 'lucid-v1-max/text', 'auto')).toBe('llama3');
  });
});
