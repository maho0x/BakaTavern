import type { MessageTokenCounter } from '../prompt/chat-completion.ts';
import type { ChatMessage } from '../prompt/types.ts';

export interface Tokenizer {
  id: TokenizerId;
  count(text: string): number;
}

export type TokenizerId = 'estimate' | 'o200k' | 'cl100k';

const encoder = new TextEncoder();
/** SillyTavern's fallback estimate: UTF-8 bytes / 3.35. */
export const BYTES_PER_TOKEN = 3.35;

export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / BYTES_PER_TOKEN);
}

export const estimateTokenizer: Tokenizer = { id: 'estimate', count: estimateTokens };

const loaded = new Map<TokenizerId, Promise<Tokenizer>>();

/** Loads a tokenizer on demand (the BPE tables are large, so they are code-split). */
export function loadTokenizer(id: TokenizerId): Promise<Tokenizer> {
  let tokenizer = loaded.get(id);
  if (!tokenizer) {
    tokenizer = (async (): Promise<Tokenizer> => {
      switch (id) {
        case 'o200k': {
          const mod = await import('gpt-tokenizer/encoding/o200k_base');
          return { id, count: (text) => mod.countTokens(text) };
        }
        case 'cl100k': {
          const mod = await import('gpt-tokenizer/encoding/cl100k_base');
          return { id, count: (text) => mod.countTokens(text) };
        }
        default:
          return estimateTokenizer;
      }
    })();
    loaded.set(id, tokenizer);
  }
  return tokenizer;
}

/** Best tokenizer this package can offer for a model. */
export function tokenizerFor(providerId: string, model: string): TokenizerId {
  const m = model.toLowerCase();
  if (/gpt-4o|gpt-4\.1|gpt-5|gpt-6|o\d|chatgpt/.test(m)) return 'o200k';
  if (/gpt-4|gpt-3\.5/.test(m)) return 'cl100k';
  if (providerId === 'openai' || providerId === 'azure_openai') return 'o200k';
  return 'estimate';
}

/** Bounded memo of string → token count. */
export class TokenCache {
  #map = new Map<string, number>();
  readonly #limit: number;

  constructor(limit = 20_000) {
    this.#limit = limit;
  }

  count(tokenizer: Tokenizer, text: string): number {
    const key = `${tokenizer.id}\u0000${text}`;
    const hit = this.#map.get(key);
    if (hit !== undefined) return hit;
    const value = tokenizer.count(text);
    if (this.#map.size >= this.#limit) this.#map.delete(this.#map.keys().next().value!);
    this.#map.set(key, value);
    return value;
  }
}

/**
 * Counts a Chat Completion message like SillyTavern's `/api/tokenizers/openai/count` minus its
 * 2-token adjustment: 3 per message + every field's tokens + 1 for a name + 3 priming tokens.
 */
export function messageTokenCounter(tokenizer: Tokenizer, cache = new TokenCache()): MessageTokenCounter {
  return (message: ChatMessage) => {
    let tokens = 3;
    for (const [key, value] of Object.entries(message)) {
      if (value === undefined || value === null) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      tokens += cache.count(tokenizer, text);
      if (key === 'name') tokens += 1;
    }
    return tokens + 3 - 2;
  };
}
