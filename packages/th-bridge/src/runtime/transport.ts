/** The frame's line to the page: calls that answer, notices that don't, and what the page sends. */

import { plain } from '../plain.ts';
import { BRIDGE_TAG, type FrameMessage, type HostMessage } from '../protocol.ts';

export { plain };

export class Transport {
  readonly #token: string;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #handlers: ((message: HostMessage) => void)[] = [];

  constructor(token: string) {
    this.#token = token;
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const data = event.data as (HostMessage & { [BRIDGE_TAG]?: true; token?: string }) | null;
      if (!data || data[BRIDGE_TAG] !== true || data.token !== this.#token) return;
      if (data.type === 'result') {
        const pending = this.#pending.get(data.id);
        if (!pending) return;
        this.#pending.delete(data.id);
        if (data.error !== undefined) pending.reject(new Error(data.error));
        else pending.resolve(data.value);
        return;
      }
      for (const handler of this.#handlers) handler(data);
    });
  }

  onMessage(handler: (message: HostMessage) => void) {
    this.#handlers.push(handler);
  }

  send(message: FrameMessage) {
    window.parent.postMessage({ ...message, [BRIDGE_TAG]: true, token: this.#token }, '*');
  }

  nextId(): number {
    return this.#nextId++;
  }

  /** Sends a message the page answers with a `result` of the same id. */
  request<T = unknown>(build: (id: number) => FrameMessage): Promise<T> {
    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.send(build(id));
    });
  }

  /** Asks the page to do something and waits for its answer. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.request<T>((id) => ({ type: 'call', id, method, args: plain(args) as unknown[] }));
  }

  /** Tells the page about a change that needs no answer. */
  notify(method: string, ...args: unknown[]) {
    this.send({ type: 'notify', method, args: plain(args) as unknown[] });
  }
}
