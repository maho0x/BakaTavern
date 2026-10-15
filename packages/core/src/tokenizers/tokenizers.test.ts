import { describe, expect, it } from 'vitest';

import { estimateTokens, loadTokenizer, messageTokenCounter, tokenizerFor } from './index.ts';

describe('tokenizers', () => {
  it('estimates by UTF-8 bytes', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world!')).toBe(4);
    expect(estimateTokens('你好')).toBe(2);
  });

  it('counts with o200k and applies message overhead', async () => {
    const tokenizer = await loadTokenizer('o200k');
    expect(tokenizer.count('Hello, world!')).toBe(4);
    const count = messageTokenCounter(tokenizer);
    // 3 + tokens("user") + tokens("Hello, world!") + 3 - 2
    expect(await count({ role: 'user', content: 'Hello, world!' })).toBe(3 + 1 + 4 + 1);
    expect(await count({ role: 'user', content: 'Hello, world!', name: 'Alice' })).toBe(
      3 + 1 + 4 + 1 + 1 + 1,
    );
  });

  it('picks tokenizers by model', () => {
    expect(tokenizerFor('openai', 'gpt-5.6-terra')).toBe('o200k');
    expect(tokenizerFor('openrouter', 'openai/gpt-4-turbo')).toBe('cl100k');
    expect(tokenizerFor('claude', 'claude-sonnet-5')).toBe('estimate');
  });
});
