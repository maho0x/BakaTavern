/// <reference lib="webworker" />
/**
 * Tokenizers off the main thread: counting long chats with BPE or WASM tokenizers takes long
 * enough to stutter the UI. Tokenizer files come from the server's cache (`/api/tokenizers`).
 */

import { createTokenizer, type Tokenizer, type TokenizerId } from '@bakatavern/core/tokenizers/index';

export interface TokenizerRequest {
  id: number;
  op: 'count' | 'encode';
  tokenizer: TokenizerId;
  texts: string[];
}

export interface TokenizerReply {
  id: number;
  /** The tokenizer in use (the estimate when a file could not be loaded). */
  tokenizer: string;
  /** Per text: the count or ids, `null` when the tokenizer refused it (e.g. a special token). */
  results: (number | number[] | null)[];
  error?: string;
}

const loaded = new Map<TokenizerId, Promise<Tokenizer>>();

async function loadFile(file: string): Promise<ArrayBuffer> {
  const response = await fetch(`/api/tokenizers/${encodeURIComponent(file)}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`tokenizer file ${file}: ${response.status}`);
  return response.arrayBuffer();
}

function tokenizer(id: TokenizerId): Promise<Tokenizer> {
  let promise = loaded.get(id);
  if (!promise) {
    promise = createTokenizer(id, loadFile);
    loaded.set(id, promise);
    // A file that could not be loaded is tried again on the next request.
    void promise.then((t) => {
      if (t.id === 'estimate' && id !== 'estimate') loaded.delete(id);
    });
  }
  return promise;
}

self.onmessage = async (event: MessageEvent<TokenizerRequest>) => {
  const { id, op, texts } = event.data;
  try {
    const t = await tokenizer(event.data.tokenizer);
    const results = await Promise.all(
      texts.map(async (text) => {
        try {
          return op === 'count' ? await t.count(text) : t.encode ? await t.encode(text) : null;
        } catch {
          return null;
        }
      }),
    );
    self.postMessage({ id, tokenizer: t.id, results } satisfies TokenizerReply);
  } catch (error) {
    self.postMessage({
      id,
      tokenizer: 'estimate',
      results: [],
      error: String(error),
    } satisfies TokenizerReply);
  }
};
