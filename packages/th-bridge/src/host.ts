/**
 * The page's side of the bridge: answers the frames it shows, keeps their copy of the chat state
 * current, carries events both ways and lets frames share globals.
 */

import { plain } from './plain.ts';
import {
  BRIDGE_TAG,
  type BridgeState,
  type FrameConfig,
  type FrameKind,
  type FrameMessage,
  type GlobalShape,
  type HostMessage,
} from './protocol.ts';

export interface FrameInfo {
  name: string;
  kind: FrameKind;
  messageId?: number;
  scriptId?: string;
}

export interface Frame extends FrameInfo {
  token: string;
  element: HTMLIFrameElement | null;
  /** Events the frame listens to. */
  events: Set<string>;
}

/** What the app provides. */
export interface HostApi {
  state(): BridgeState;
  /** A frame's request (see the runtime's `transport.call` and `notify` uses). */
  call(frame: Frame, method: string, args: unknown[]): unknown;
  /** Listens to an app event; returns the way to stop. */
  on(event: string, listener: (...args: unknown[]) => Promise<void>): () => void;
  emit(event: string, args: unknown[]): Promise<void>;
  /** A frame's code failed to answer in time or threw. */
  warn?(message: string): void;
}

/** How long the page waits for a frame's listeners before going on. */
const EVENT_TIMEOUT_MS = 10_000;

function token(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class BridgeHost {
  readonly #api: HostApi;
  readonly #frames = new Map<string, Frame>();
  /** App events relayed to frames, with the way to stop listening. */
  readonly #relays = new Map<string, () => void>();
  readonly #globals = new Map<string, { shape: GlobalShape; owner: string }>();
  readonly #waiting = new Map<string, () => void>();
  /** Calls into a global's owner: host id → the frame that asked and its id. */
  readonly #globalCalls = new Map<number, { token: string; id: number }>();
  #nextId = 1;
  #viewport = 0;
  readonly #onMessage = (event: MessageEvent) => this.#receive(event);

  constructor(api: HostApi) {
    this.#api = api;
    window.addEventListener('message', this.#onMessage);
  }

  dispose() {
    window.removeEventListener('message', this.#onMessage);
    for (const stop of this.#relays.values()) stop();
    this.#relays.clear();
    this.#frames.clear();
  }

  /** Prepares a frame: what its document starts with. Attach the iframe once it exists. */
  open(info: FrameInfo, viewportHeight: number): FrameConfig {
    const frame: Frame = { ...info, token: token(), element: null, events: new Set() };
    this.#frames.set(frame.token, frame);
    this.#viewport = viewportHeight;
    return {
      ...info,
      token: frame.token,
      state: this.#api.state(),
      viewportHeight,
      globals: Object.fromEntries([...this.#globals].map(([name, g]) => [name, g.shape])),
    };
  }

  attach(frameToken: string, element: HTMLIFrameElement) {
    const frame = this.#frames.get(frameToken);
    if (frame) frame.element = element;
  }

  /** The frame is gone: its listeners and the globals it owned go with it. */
  close(frameToken: string) {
    const frame = this.#frames.get(frameToken);
    if (!frame) return;
    this.#frames.delete(frameToken);
    for (const [name, global] of this.#globals) if (global.owner === frameToken) this.#globals.delete(name);
    for (const event of frame.events) this.#unrelay(event);
  }

  get frames(): readonly Frame[] {
    return [...this.#frames.values()];
  }

  /** Sends every frame the current state (after the chat or variables changed). */
  broadcastState(state: BridgeState = this.#api.state()) {
    if (!this.#frames.size) return;
    for (const frame of this.#frames.values()) this.#post(frame, { type: 'state', state });
  }

  setViewport(height: number) {
    this.#viewport = height;
    for (const frame of this.#frames.values()) this.#post(frame, { type: 'viewport', height });
  }

  get viewport() {
    return this.#viewport;
  }

  /** Runs an event's listeners in the frames that listen to it (the app's events reach them by itself). */
  async deliver(event: string, args: unknown[], frames: readonly Frame[] = this.frames) {
    const listening = frames.filter((frame) => frame.events.has(event));
    if (!listening.length) return;
    const data = plain(args) as unknown[];
    // Listeners read the state the event is about (a frame may have just changed it).
    const state = this.#api.state();
    for (const frame of listening) this.#post(frame, { type: 'state', state });
    await Promise.all(
      listening.map(
        (frame) =>
          new Promise<void>((resolve) => {
            const id = this.#nextId++;
            const done = () => {
              clearTimeout(timer);
              this.#waiting.delete(`${frame.token}:${id}`);
              resolve();
            };
            const timer = setTimeout(() => {
              this.#api.warn?.(`${frame.name} did not finish handling ${event}`);
              done();
            }, EVENT_TIMEOUT_MS);
            this.#waiting.set(`${frame.token}:${id}`, done);
            this.#post(frame, { type: 'event', id, event, args: data });
          }),
      ),
    );
  }

  #post(frame: Frame, message: HostMessage) {
    frame.element?.contentWindow?.postMessage({ ...message, [BRIDGE_TAG]: true, token: frame.token }, '*');
  }

  #relay(event: string) {
    if (this.#relays.has(event)) return;
    this.#relays.set(
      event,
      this.#api.on(event, (...args) => this.deliver(event, args)),
    );
  }

  #unrelay(event: string) {
    if ([...this.#frames.values()].some((f) => f.events.has(event))) return;
    this.#relays.get(event)?.();
    this.#relays.delete(event);
  }

  async #receive(event: MessageEvent) {
    const data = event.data as (FrameMessage & { [BRIDGE_TAG]?: true; token?: string }) | null;
    if (!data || data[BRIDGE_TAG] !== true || typeof data.token !== 'string') return;
    const frame = this.#frames.get(data.token);
    // Only the frame given this token may speak with it.
    if (!frame?.element || event.source !== frame.element.contentWindow) return;
    switch (data.type) {
      case 'ready':
        return;
      case 'height':
        if (frame.element && Number.isFinite(data.height))
          frame.element.style.height = `${Math.ceil(data.height)}px`;
        return;
      case 'subscribe':
        frame.events.add(data.event);
        this.#relay(data.event);
        return;
      case 'unsubscribe':
        frame.events.delete(data.event);
        this.#unrelay(data.event);
        return;
      case 'event-done':
        this.#waiting.get(`${frame.token}:${data.id}`)?.();
        return;
      case 'emit': {
        try {
          await this.#api.emit(data.event, data.args);
        } finally {
          this.#post(frame, { type: 'result', id: data.id });
        }
        return;
      }
      case 'notify':
        try {
          await this.#api.call(frame, data.method, data.args);
        } catch (error) {
          this.#api.warn?.(`${frame.name}: ${data.method} failed: ${String(error)}`);
        }
        return;
      case 'call': {
        try {
          const value = await this.#api.call(frame, data.method, data.args);
          // The state first: once the frame's await returns, its copy shows what the call changed.
          this.#post(frame, { type: 'state', state: this.#api.state() });
          this.#post(frame, { type: 'result', id: data.id, value: plain(value) });
        } catch (error) {
          this.#post(frame, {
            type: 'result',
            id: data.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case 'global': {
        this.#globals.set(data.name, { shape: data.shape, owner: frame.token });
        for (const other of this.#frames.values()) {
          if (other !== frame) this.#post(other, { type: 'global', name: data.name, shape: data.shape });
        }
        return;
      }
      case 'global-call': {
        const owner = this.#frames.get(this.#globals.get(data.name)?.owner ?? '');
        if (!owner) {
          this.#post(frame, { type: 'result', id: data.id, error: `${data.name} is not available` });
          return;
        }
        const id = this.#nextId++;
        this.#globalCalls.set(id, { token: frame.token, id: data.id });
        this.#post(owner, { type: 'global-call', id, name: data.name, fn: data.fn, args: data.args });
        return;
      }
      case 'global-result': {
        const call = this.#globalCalls.get(data.id);
        this.#globalCalls.delete(data.id);
        const asker = call && this.#frames.get(call.token);
        if (asker) this.#post(asker, { type: 'result', id: call.id, value: data.value, error: data.error });
        return;
      }
    }
  }
}
