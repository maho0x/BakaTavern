/**
 * The tokenizers generation counts with: SillyTavern's choice for the model, run in a worker, or
 * the Text Completion backend's own tokenizer. Counts are remembered for the session, so a chat
 * is tokenized once.
 */

import {
  chatTokenizer,
  estimateTokenizer,
  estimateTokens,
  parseTextgenTokenize,
  textCountTokenizer,
  textgenTokenizeRequest,
  textIdTokenizer,
  textTokenizer,
  type TextTokenizerSetting,
  type Tokenizer,
  type TokenizerId,
} from '@bakatavern/core';

import { api } from '../api.ts';
import { formattingDefaults } from '../state/prefs.ts';
import { settings } from '../state/settings.svelte.ts';
import type { ActiveConnection, ActiveTextConnection } from './pipeline.ts';
import type { TokenizerReply, TokenizerRequest } from './tokenizer.worker.ts';

/** A bounded map that forgets the oldest entries. */
class Lru<V> {
  #map = new Map<string, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  set(key: string, value: V) {
    if (this.#map.size >= this.#limit) this.#map.delete(this.#map.keys().next().value!);
    this.#map.set(key, value);
  }
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (reply: TokenizerReply) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(new URL('./tokenizer.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<TokenizerReply>) => {
    pending.get(event.data.id)?.(event.data);
    pending.delete(event.data.id);
  };
  return worker;
}

function ask(request: Omit<TokenizerRequest, 'id'>): Promise<TokenizerReply> {
  const w = getWorker();
  if (!w)
    return Promise.resolve({ id: 0, tokenizer: 'estimate', results: request.texts.map(estimateTokens) });
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ ...request, id } satisfies TokenizerRequest);
  });
}

/** Counts are batched: texts asked for in the same tick go to the worker together. */
class WorkerTokenizer implements Tokenizer {
  readonly id: TokenizerId;
  #counts = new Lru<number | null>(50_000);
  #queue: { text: string; resolve: (count: number | null) => void }[] = [];

  constructor(id: TokenizerId) {
    this.id = id;
  }

  async count(text: string): Promise<number> {
    let count = this.#counts.get(text);
    if (count === undefined) {
      count = await new Promise<number | null>((resolve) => {
        if (!this.#queue.length) queueMicrotask(() => void this.#flush());
        this.#queue.push({ text, resolve });
      });
      this.#counts.set(text, count);
    }
    // Refused texts throw, as the tokenizer itself would.
    if (count === null) throw new Error('the tokenizer refused this text');
    return count;
  }

  async encode(text: string): Promise<number[]> {
    const reply = await ask({ op: 'encode', tokenizer: this.id, texts: [text] });
    const ids = reply.results[0];
    if (!Array.isArray(ids)) throw new Error('the tokenizer refused this text');
    return ids;
  }

  async #flush() {
    const batch = this.#queue.splice(0);
    const reply = await ask({ op: 'count', tokenizer: this.id, texts: batch.map((b) => b.text) });
    batch.forEach((item, i) => {
      const result = reply.results[i];
      item.resolve(typeof result === 'number' ? result : reply.error ? estimateTokens(item.text) : null);
    });
  }
}

const workers = new Map<TokenizerId, WorkerTokenizer>();

/** A tokenizer running in the worker (one instance per id, sharing its counts). */
export function workerTokenizer(id: TokenizerId): Tokenizer {
  if (id === 'estimate') return estimateTokenizer;
  let tokenizer = workers.get(id);
  if (!tokenizer) {
    tokenizer = new WorkerTokenizer(id);
    workers.set(id, tokenizer);
  }
  return tokenizer;
}

/**
 * The Text Completion backend's tokenizer, through the server. When the backend cannot tokenize,
 * `fallback` counts instead from then on (SillyTavern does the same).
 */
class RemoteTokenizer implements Tokenizer {
  readonly id: string;
  #connection: ActiveTextConnection;
  #fallback: Tokenizer;
  #failed = false;
  #counts = new Lru<number>(50_000);

  constructor(connection: ActiveTextConnection, fallback: Tokenizer) {
    this.#connection = connection;
    this.#fallback = fallback;
    this.id = `remote:${connection.type.id}:${connection.serverUrl}:${connection.model}`;
  }

  async #tokenize(text: string) {
    const spec = textgenTokenizeRequest(
      this.#connection.type.id,
      this.#connection.serverUrl,
      this.#connection.model,
      text,
    );
    if (!spec || this.#failed) return null;
    try {
      const body = await api.proxyJson({ ...spec, secretId: this.#connection.secretId });
      const result = parseTextgenTokenize(body);
      if (!result) throw new Error('no token count');
      return result;
    } catch {
      this.#failed = true;
      return null;
    }
  }

  async count(text: string): Promise<number> {
    if (!text) return 0;
    const cached = this.#counts.get(text);
    if (cached !== undefined) return cached;
    const result = await this.#tokenize(text);
    if (!result) return this.#fallback.count(text);
    this.#counts.set(text, result.count);
    return result.count;
  }

  async encode(text: string): Promise<number[]> {
    const result = await this.#tokenize(text);
    if (result?.ids.length) return result.ids;
    return (await this.#fallback.encode?.(text)) ?? [];
  }
}

const remotes = new Map<string, RemoteTokenizer>();

function remoteTokenizer(connection: ActiveTextConnection): Tokenizer {
  const key = `${connection.type.id}\u0000${connection.serverUrl}\u0000${connection.model}`;
  let remote = remotes.get(key);
  if (!remote) {
    // When the backend cannot tokenize after all, the model's tokenizer takes over.
    const local = textTokenizer(connection.type.id, connection.model);
    remote = new RemoteTokenizer(connection, workerTokenizer(local === 'remote' ? 'llama' : local));
    remotes.set(key, remote);
  }
  return remote;
}

function textSetting(): TextTokenizerSetting {
  return (settings.get('formatting', formattingDefaults).tokenizer ?? 'auto') as TextTokenizerSetting;
}

/** The tokenizer a generation counts with (SillyTavern's choice for the connection). */
export function tokenizerFor(connection: ActiveConnection): Tokenizer {
  if (connection.api === 'chat')
    return workerTokenizer(chatTokenizer(connection.provider.id, connection.model));
  const choice = textCountTokenizer(connection.type.id, connection.model, textSetting());
  return choice === 'remote' ? remoteTokenizer(connection) : workerTokenizer(choice);
}

/** The tokenizer for token ids in Text Completion's logit bias and banned tokens. */
export function idTokenizerFor(connection: ActiveTextConnection): Tokenizer {
  const choice = textIdTokenizer(connection.type.id, connection.model, textSetting());
  return choice === 'remote' ? remoteTokenizer(connection) : workerTokenizer(choice);
}
