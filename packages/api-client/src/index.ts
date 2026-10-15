/**
 * Typed client for the BakaTavern HTTP API. Response types are generated from the Rust server
 * (`pnpm bindings`); see `./generated`.
 */

import type {
  AuthStatus,
  Bootstrap,
  Character,
  CharacterImportResult,
  CharacterSummary,
  Claim,
  Chat,
  ChatWithMessages,
  ChangeEvent,
  CreateChat,
  CreateSecret,
  FileRecord,
  JobInfo,
  Lorebook,
  LorebookInfo,
  Message,
  MessagePatch,
  NewMessage,
  Persona,
  PersonaInput,
  Preset,
  PresetInfo,
  SecretInfo,
  SettingsDoc,
  Tag,
  UpdateChat,
  UpdateSecret,
} from './types.ts';

export * from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Current revision, for `conflict` errors. */
  readonly rev?: number;
  /** True when the error came from the upstream provider, not from BakaTavern. */
  readonly upstream: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { rev?: number; upstream?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.rev = options.rev;
    this.upstream = options.upstream ?? false;
  }
}

/** How the server attaches a stored key to an outgoing request. */
export type SecretAuth =
  { type: 'bearer' } | { type: 'header'; name: string; prefix?: string } | { type: 'query'; name: string };

/** An outgoing request executed by the server (the secret is attached server-side). */
export interface ProxySpec {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  secretId?: string;
  auth?: SecretAuth;
}

export interface ClientOptions {
  /** API origin; same origin when empty. */
  baseUrl?: string;
  /** Per-tab id echoed in change events. */
  clientId?: string;
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
}

const json = (body: unknown) => JSON.stringify(body);

/**
 * A random 32-character hex id. Unlike `crypto.randomUUID()`, this also works outside secure
 * contexts, e.g. when a phone opens the server over plain HTTP on the LAN.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class BakaClient {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly #fetch: typeof fetch;
  readonly #onUnauthorized?: () => void;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.clientId = options.clientId ?? randomId();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#onUnauthorized = options.onUnauthorized;
  }

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async #raw(
    method: string,
    path: string,
    body?: BodyInit,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.#fetch(this.url(path), {
      method,
      body,
      signal,
      credentials: 'include',
      headers: { 'x-bt-client': '1', 'x-bt-client-id': this.clientId, ...headers },
    });
    if (!response.ok && !response.headers.has('x-bt-upstream')) {
      throw await toError(response, this.#onUnauthorized);
    }
    return response;
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#raw(
      method,
      path,
      body === undefined ? undefined : json(body),
      body === undefined ? {} : { 'content-type': 'application/json' },
      signal,
    );
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async #upload<T>(
    path: string,
    files: (File | Blob)[],
    fields: Record<string, string> = {},
    method = 'POST',
  ): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const file of files) form.append('file', file, file instanceof File ? file.name : 'upload');
    const response = await this.#raw(method, path, form);
    return (await response.json()) as T;
  }

  // Auth
  me = () => this.request<AuthStatus>('GET', '/api/auth/me');
  login = (password: string, handle?: string) =>
    this.request<AuthStatus>('POST', '/api/auth/login', { password, handle });
  logout = () => this.request<void>('POST', '/api/auth/logout');
  changePassword = (current: string | undefined, next: string) =>
    this.request<void>('POST', '/api/auth/password', { current, new: next });
  bootstrap = () => this.request<Bootstrap>('GET', '/api/bootstrap');

  // Settings
  getSettings = (ns: string) => this.request<SettingsDoc>('GET', `/api/settings/${encodeURIComponent(ns)}`);
  putSettings = (ns: string, data: Record<string, unknown>, rev?: number) =>
    this.request<SettingsDoc>('PUT', `/api/settings/${encodeURIComponent(ns)}`, { data, rev });

  // Characters
  listCharacters = () => this.request<CharacterSummary[]>('GET', '/api/characters');
  getCharacter = (id: string) => this.request<Character>('GET', `/api/characters/${id}`);
  createCharacter = (card: Record<string, unknown>, avatar?: string) =>
    this.request<Character>('POST', '/api/characters', { card, avatar });
  updateCharacter = (id: string, card: Record<string, unknown>, rev?: number) =>
    this.request<Character>('PUT', `/api/characters/${id}`, { card, rev });
  deleteCharacter = (id: string) => this.request<void>('DELETE', `/api/characters/${id}`);
  duplicateCharacter = (id: string) => this.request<Character>('POST', `/api/characters/${id}/duplicate`);
  setCharacterTags = (id: string, tagIds: string[]) =>
    this.request<Character>('PUT', `/api/characters/${id}/tags`, tagIds);
  setCharacterAvatar = (id: string, file: File | Blob) =>
    this.#upload<Character>(`/api/characters/${id}/avatar`, [file], {}, 'PUT');
  importCharacters = (files: (File | Blob)[]) =>
    this.#upload<CharacterImportResult>('/api/characters/import', files);
  characterExportUrl = (id: string, format: 'png' | 'json' = 'png') =>
    this.url(`/api/characters/${id}/export?format=${format}`);

  // Chats and messages
  listChats = (characterId: string) => this.request<Chat[]>('GET', `/api/characters/${characterId}/chats`);
  recentChats = (limit = 20) => this.request<Chat[]>('GET', `/api/chats/recent?limit=${limit}`);
  createChat = (body: CreateChat) => this.request<ChatWithMessages>('POST', '/api/chats', body);
  getChat = (id: string) => this.request<Chat>('GET', `/api/chats/${id}`);
  updateChat = (id: string, patch: UpdateChat) => this.request<Chat>('PATCH', `/api/chats/${id}`, patch);
  deleteChat = (id: string) => this.request<void>('DELETE', `/api/chats/${id}`);
  branchChat = (id: string, upTo: number, title?: string) =>
    this.request<Chat>('POST', `/api/chats/${id}/branch`, { upTo, title });
  importChat = (file: File | Blob, characterId: string) =>
    this.#upload<Chat>('/api/chats/import', [file], { characterId });
  chatExportUrl = (id: string, format: 'jsonl' | 'txt' = 'jsonl') =>
    this.url(`/api/chats/${id}/export?format=${format}`);

  messages = (
    chatId: string,
    query: { before?: number; limit?: number; from?: number; to?: number } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return this.request<Message[]>('GET', `/api/chats/${chatId}/messages${qs ? `?${qs}` : ''}`);
  };
  addMessages = (chatId: string, messages: NewMessage[], at?: number) =>
    this.request<Message[]>('POST', `/api/chats/${chatId}/messages`, { messages, at });
  updateMessage = (id: string, patch: MessagePatch, rev?: number) =>
    this.request<Message>('PATCH', `/api/messages/${id}`, { ...patch, rev });
  deleteMessages = (chatId: string, body: { ids?: string[]; from?: number }) =>
    this.request<{ removed: number }>('DELETE', `/api/chats/${chatId}/messages`, body);
  moveMessage = (chatId: string, messageId: string, to: number) =>
    this.request<void>('POST', `/api/chats/${chatId}/messages/${messageId}/move`, { to });

  // Personas
  listPersonas = () => this.request<Persona[]>('GET', '/api/personas');
  createPersona = (input: PersonaInput) => this.request<Persona>('POST', '/api/personas', input);
  updatePersona = (id: string, input: PersonaInput, rev?: number) =>
    this.request<Persona>('PUT', `/api/personas/${id}`, { ...input, rev });
  deletePersona = (id: string) => this.request<void>('DELETE', `/api/personas/${id}`);
  setPersonaAvatar = (id: string, file: File | Blob) =>
    this.#upload<Persona>(`/api/personas/${id}/avatar`, [file], {}, 'PUT');
  setDefaultPersona = (id: string | null) => this.request<void>('PUT', '/api/personas/default', { id });

  // World Info
  listLorebooks = () => this.request<LorebookInfo[]>('GET', '/api/lorebooks');
  getLorebook = (id: string) => this.request<Lorebook>('GET', `/api/lorebooks/${id}`);
  createLorebook = (name: string, entries: Record<string, unknown>[] = [], data?: Record<string, unknown>) =>
    this.request<Lorebook>('POST', '/api/lorebooks', { name, entries, data });
  replaceLorebook = (
    id: string,
    entries: Record<string, unknown>[],
    data?: Record<string, unknown>,
    rev?: number,
  ) => this.request<Lorebook>('PUT', `/api/lorebooks/${id}`, { entries, data, rev });
  renameLorebook = (id: string, name: string) =>
    this.request<Lorebook>('PATCH', `/api/lorebooks/${id}`, { name });
  deleteLorebook = (id: string) => this.request<void>('DELETE', `/api/lorebooks/${id}`);
  upsertLorebookEntry = (id: string, entry: Record<string, unknown>) =>
    this.request<Record<string, unknown>>('PUT', `/api/lorebooks/${id}/entries`, entry);
  deleteLorebookEntry = (id: string, uid: number) =>
    this.request<void>('DELETE', `/api/lorebooks/${id}/entries/${uid}`);
  importLorebook = (file: File | Blob, name?: string) =>
    this.#upload<Lorebook>('/api/lorebooks/import', [file], name ? { name } : {});
  lorebookExportUrl = (id: string) => this.url(`/api/lorebooks/${id}/export`);

  // Presets
  listPresets = (kind?: string) =>
    this.request<PresetInfo[]>('GET', `/api/presets${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
  getPreset = (id: string) => this.request<Preset>('GET', `/api/presets/${id}`);
  upsertPreset = (kind: string, name: string, data: Record<string, unknown>) =>
    this.request<Preset>('PUT', '/api/presets', { kind, name, data });
  updatePreset = (id: string, patch: { name?: string; data?: Record<string, unknown>; rev?: number }) =>
    this.request<Preset>('PATCH', `/api/presets/${id}`, patch);
  deletePreset = (id: string) => this.request<void>('DELETE', `/api/presets/${id}`);

  // Secrets and tags
  listSecrets = () => this.request<SecretInfo[]>('GET', '/api/secrets');
  createSecret = (body: CreateSecret) => this.request<SecretInfo>('POST', '/api/secrets', body);
  updateSecret = (id: string, body: UpdateSecret) =>
    this.request<SecretInfo>('PATCH', `/api/secrets/${id}`, body);
  deleteSecret = (id: string) => this.request<void>('DELETE', `/api/secrets/${id}`);
  listTags = () => this.request<Tag[]>('GET', '/api/tags');
  createTag = (name: string) => this.request<Tag>('POST', '/api/tags', { name });
  updateTag = (tag: Tag) => this.request<Tag>('PUT', `/api/tags/${tag.id}`, tag);
  deleteTag = (id: string) => this.request<void>('DELETE', `/api/tags/${id}`);

  // Files
  uploadFile = (file: File | Blob) => this.#upload<FileRecord>('/api/files', [file]);
  fileUrl = (hash: string) => this.url(`/api/files/${hash}`);
  thumbUrl = (hash: string, width = 256) => this.url(`/api/thumbs/${hash}?w=${width}`);

  // Outgoing requests
  /** Performs a request through the server proxy and returns the upstream response. */
  proxy = (spec: ProxySpec, signal?: AbortSignal) =>
    this.#raw('POST', '/api/proxy', json(spec), { 'content-type': 'application/json' }, signal);

  async proxyJson<T>(spec: ProxySpec, signal?: AbortSignal): Promise<T> {
    const response = await this.proxy(spec, signal);
    const text = await response.text();
    if (!response.ok) throw upstreamError(response.status, text);
    return JSON.parse(text) as T;
  }

  /** Starts a durable generation job; the response streams the upstream bytes. */
  /** Starts a durable generation job. Pass your own `id` to be able to abort it before it answers. */
  async startJob(
    spec: ProxySpec & { id?: string; chatId?: string; meta?: Record<string, unknown> },
    signal?: AbortSignal,
  ) {
    const response = await this.#raw(
      'POST',
      '/api/llm/jobs',
      json(spec),
      { 'content-type': 'application/json' },
      signal,
    );
    return { jobId: response.headers.get('x-bt-job-id') ?? '', response };
  }

  /** Re-attaches to a job from a byte offset (running jobs stream live; finished ones replay). */
  resumeJob = (id: string, offset = 0, signal?: AbortSignal) =>
    this.#raw('GET', `/api/llm/jobs/${id}/stream?offset=${offset}`, undefined, {}, signal);
  jobInfo = (id: string) => this.request<JobInfo>('GET', `/api/llm/jobs/${id}`);
  listJobs = (chatId?: string) =>
    this.request<JobInfo[]>('GET', `/api/llm/jobs${chatId ? `?chatId=${chatId}` : ''}`);
  /** Asks for the exclusive right to store a finished job's result (see the server docs). */
  claimJob = (id: string) => this.request<Claim>('POST', `/api/llm/jobs/${id}/claim`);
  ackJob = (id: string) => this.request<void>('POST', `/api/llm/jobs/${id}/ack`);
  abortJob = (id: string) => this.request<void>('DELETE', `/api/llm/jobs/${id}`);

  /**
   * Subscribes to change events from other tabs and devices. Returns an unsubscribe function.
   * `onResync` runs when events may have been missed: the server fell behind, or the connection
   * dropped (a sleeping phone) and came back. The server does not replay missed events.
   */
  subscribe(onEvent: (event: ChangeEvent) => void, onResync?: () => void): () => void {
    let source: EventSource | null = null;
    let stopped = false;
    let dropped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      source = new EventSource(this.url('/api/events'), { withCredentials: true });
      source.addEventListener('change', (e) => {
        const event = JSON.parse((e as MessageEvent<string>).data) as ChangeEvent;
        if (event.origin !== this.clientId) onEvent(event);
      });
      source.addEventListener('resync', () => onResync?.());
      source.addEventListener('open', () => {
        if (dropped) onResync?.();
        dropped = false;
      });
      source.addEventListener('error', () => {
        dropped = true;
        // The browser retries dropped connections, but gives up on HTTP errors (a restarting server).
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          clearTimeout(timer);
          timer = setTimeout(connect, 3000);
        }
      });
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
    };
  }
}

export function upstreamError(status: number, body: string): ApiError {
  let message = body.slice(0, 500) || `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const err = parsed.error;
    message = (typeof err === 'string' ? err : err?.message) ?? parsed.message ?? message;
  } catch {
    // not JSON
  }
  return new ApiError(status, 'upstream_error', message, { upstream: true });
}

async function toError(response: Response, onUnauthorized?: () => void): Promise<ApiError> {
  let code = 'http_error';
  let message = `HTTP ${response.status}`;
  let rev: number | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; rev?: number } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    rev = body.error?.rev;
  } catch {
    // not JSON
  }
  if (response.status === 401) onUnauthorized?.();
  return new ApiError(response.status, code, message, { rev });
}
