/**
 * Tokenizers, as SillyTavern uses them: tiktoken encodings for OpenAI models, Hugging Face
 * `tokenizer.json` files and SentencePiece models for open models and Claude, the backend's own
 * tokenizer for Text Completion, and a byte-length estimate when nothing else is available.
 *
 * File-based tokenizers run `@agnai/web-tokenizers` (the library SillyTavern's server uses, which
 * also gives the same ids as its SentencePiece library); the files come from `loadFile`.
 */

import type { MessageTokenCounter } from '../prompt/chat-completion.ts';
import type { ChatMessage } from '../prompt/types.ts';

export interface Tokenizer {
  id: string;
  count(text: string): number | Promise<number>;
  /** Token ids, where the tokenizer can give them. */
  encode?(text: string): number[] | Promise<number[]>;
}

/** Tokenizers by SillyTavern's names (`estimate` is its `NONE`). */
export const tokenizerIds = [
  'estimate',
  'o200k',
  'cl100k',
  'p50k',
  'gpt2',
  'llama',
  'llama3',
  'mistral',
  'nemo',
  'yi',
  'gemma',
  'jamba',
  'qwen2',
  'command-r',
  'command-a',
  'deepseek',
  'claude',
  'nerdstash',
  'nerdstash_v2',
] as const;

export type TokenizerId = (typeof tokenizerIds)[number];

/** Tokenizers that need a file, and the tokenizer SillyTavern falls back to when it is missing. */
export const tokenizerFiles: Partial<
  Record<TokenizerId, { file: string; format: 'json' | 'sentencepiece'; fallback?: TokenizerId }>
> = {
  llama: { file: 'llama.model', format: 'sentencepiece' },
  mistral: { file: 'mistral.model', format: 'sentencepiece' },
  yi: { file: 'yi.model', format: 'sentencepiece' },
  gemma: { file: 'gemma.model', format: 'sentencepiece' },
  jamba: { file: 'jamba.model', format: 'sentencepiece' },
  nerdstash: { file: 'nerdstash.model', format: 'sentencepiece' },
  nerdstash_v2: { file: 'nerdstash_v2.model', format: 'sentencepiece' },
  claude: { file: 'claude.json', format: 'json' },
  llama3: { file: 'llama3.json', format: 'json' },
  'command-r': { file: 'command-r.json', format: 'json', fallback: 'llama3' },
  'command-a': { file: 'command-a.json', format: 'json', fallback: 'llama3' },
  qwen2: { file: 'qwen2.json', format: 'json', fallback: 'llama3' },
  nemo: { file: 'nemo.json', format: 'json', fallback: 'llama3' },
  deepseek: { file: 'deepseek.json', format: 'json', fallback: 'llama3' },
};

/** tiktoken encodings (counted per message like OpenAI's API). */
const TIKTOKEN = new Set<string>(['o200k', 'cl100k', 'p50k', 'gpt2']);

export function isTiktoken(id: string): boolean {
  return TIKTOKEN.has(id);
}

const encoder = new TextEncoder();
/** SillyTavern's fallback estimate: UTF-8 bytes / 3.35. */
export const BYTES_PER_TOKEN = 3.35;

export function estimateTokens(text: string): number {
  return Math.ceil(encoder.encode(text).length / BYTES_PER_TOKEN);
}

export const estimateTokenizer: Tokenizer = { id: 'estimate', count: estimateTokens };

/** Reads a tokenizer file (`llama3.json`, `gemma.model` ...). */
export type TokenizerFileLoader = (file: string) => Promise<ArrayBuffer | Uint8Array>;

async function tiktoken(id: TokenizerId): Promise<Tokenizer> {
  const mod =
    id === 'o200k'
      ? await import('gpt-tokenizer/encoding/o200k_base')
      : id === 'cl100k'
        ? await import('gpt-tokenizer/encoding/cl100k_base')
        : id === 'p50k'
          ? await import('gpt-tokenizer/encoding/p50k_base')
          : await import('gpt-tokenizer/encoding/r50k_base');
  return { id, count: (text) => mod.countTokens(text), encode: (text) => mod.encode(text) };
}

async function fromFile(id: TokenizerId, loadFile: TokenizerFileLoader): Promise<Tokenizer> {
  const spec = tokenizerFiles[id]!;
  const [{ Tokenizer: WebTokenizer }, bytes] = await Promise.all([
    import('@agnai/web-tokenizers'),
    loadFile(spec.file),
  ]);
  const buffer = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  const tokenizer =
    spec.format === 'json'
      ? await WebTokenizer.fromJSON(buffer)
      : await WebTokenizer.fromSentencePiece(buffer);
  return {
    id,
    count: (text) => (text ? tokenizer.encode(text).length : 0),
    encode: (text) => Array.from(tokenizer.encode(text)),
  };
}

/**
 * Creates a tokenizer. File-based ones fall back like SillyTavern: to Llama 3 for the downloaded
 * tokenizers, then to the estimate.
 */
export async function createTokenizer(id: TokenizerId, loadFile?: TokenizerFileLoader): Promise<Tokenizer> {
  if (id === 'estimate') return estimateTokenizer;
  if (isTiktoken(id)) return tiktoken(id);
  const spec = tokenizerFiles[id];
  if (!spec || !loadFile) return estimateTokenizer;
  try {
    return await fromFile(id, loadFile);
  } catch {
    if (spec.fallback) {
      const fallback = await createTokenizer(spec.fallback, loadFile);
      return { ...fallback, id };
    }
    return estimateTokenizer;
  }
}

const loaded = new Map<string, Promise<Tokenizer>>();

/** `createTokenizer`, loaded once per id. */
export function loadTokenizer(id: TokenizerId, loadFile?: TokenizerFileLoader): Promise<Tokenizer> {
  let tokenizer = loaded.get(id);
  if (!tokenizer) {
    tokenizer = createTokenizer(id, loadFile);
    loaded.set(id, tokenizer);
    // A failed load (e.g. offline) is tried again next time.
    tokenizer
      .then((t) => t.id === 'estimate' && id !== 'estimate' && loaded.delete(id))
      .catch(() => loaded.delete(id));
  }
  return tokenizer;
}

/** Bounded memo of string → token count. */
export class TokenCache {
  #map = new Map<string, number>();
  readonly #limit: number;

  constructor(limit = 20_000) {
    this.#limit = limit;
  }

  count(tokenizer: Tokenizer, text: string): number | Promise<number> {
    const key = `${tokenizer.id}\u0000${text}`;
    const hit = this.#map.get(key);
    if (hit !== undefined) return hit;
    const store = (value: number) => {
      if (this.#map.size >= this.#limit) this.#map.delete(this.#map.keys().next().value!);
      this.#map.set(key, value);
      return value;
    };
    const value = tokenizer.count(text);
    return typeof value === 'number' ? store(value) : value.then(store);
  }
}

/** A count that throws (tiktoken refuses special tokens such as `<|endoftext|>`) as `undefined`. */
async function tryCount(cache: TokenCache, tokenizer: Tokenizer, text: string): Promise<number | undefined> {
  try {
    return await cache.count(tokenizer, text);
  } catch {
    return undefined;
  }
}

/**
 * Counts a Chat Completion message like SillyTavern's `countTokensOpenAIAsync`: tiktoken encodings
 * count 3 per message, every field, 1 for a name and 3 priming tokens; other tokenizers count the
 * fields joined by blank lines. Two tokens are taken off, except for Claude (`full`).
 */
export function messageTokenCounter(tokenizer: Tokenizer, cache = new TokenCache()): MessageTokenCounter {
  return async (message: ChatMessage) =>
    (await countMessage(tokenizer, cache, message)) - (tokenizer.id === 'claude' ? 0 : 2);
}

async function countMessage(tokenizer: Tokenizer, cache: TokenCache, message: object): Promise<number> {
  const values = Object.entries(message).filter(([, v]) => v !== undefined && v !== null);
  const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  if (isTiktoken(tokenizer.id)) {
    let tokens = 3;
    for (const [key, value] of values) {
      const count = await tryCount(cache, tokenizer, text(value));
      if (count === undefined) break;
      tokens += count + (key === 'name' ? 1 : 0);
    }
    return tokens + 3;
  }
  const joined = values.map(([, v]) => text(v)).join('\n\n');
  return (await tryCount(cache, tokenizer, joined)) ?? estimateTokens(joined);
}

/**
 * Counts text in Chat Completion mode outside the prompt manager (World Info, extensions): as a
 * message with only content and no adjustment (SillyTavern's `counterWrapperOpenAIAsync`).
 */
export function chatTextCounter(
  tokenizer: Tokenizer,
  cache = new TokenCache(),
): (text: string) => Promise<number> {
  return async (text) => (text ? countMessage(tokenizer, cache, { content: text }) : 0);
}

/** Counts plain text (Text Completion); errors count as 0 like SillyTavern's encode endpoints. */
export function textCounter(
  tokenizer: Tokenizer,
  cache = new TokenCache(),
): (text: string) => Promise<number> {
  return async (text) => (text ? ((await tryCount(cache, tokenizer, text)) ?? 0) : 0);
}

/**
 * Chat Completion logit bias from a bias list (SillyTavern's `/api/backends/chat-completions/bias`):
 * token id lists as they are, other text through the model's tokenizer. Entries the tokenizer
 * refuses are skipped.
 */
export async function chatLogitBias(
  entries: readonly { text?: string; value?: number }[],
  encode: (text: string) => number[] | Promise<number[]>,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const entry of entries) {
    if (!entry?.text) continue;
    let tokens: number[] | undefined;
    const trimmed = entry.text.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const ids = JSON.parse(entry.text) as unknown;
        if (Array.isArray(ids) && ids.every((x) => typeof x === 'number')) tokens = ids as number[];
      } catch {
        // tokenized as text
      }
    }
    try {
      tokens ??= await encode(entry.text);
    } catch {
      continue;
    }
    for (const token of tokens) result[String(token)] = entry.value as number;
  }
  return result;
}

export * from './models.ts';
