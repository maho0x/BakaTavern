/**
 * TavernHelper's event functions inside a frame. Listeners live here; the page tells the frame
 * about the events it listens to (SillyTavern's and other frames') and waits until they ran.
 */

import { plain, type Transport } from './transport.ts';

type Listener = (...args: unknown[]) => unknown;

interface Registered {
  listener: Listener;
  once: boolean;
}

export class FrameEvents {
  readonly #transport: Transport;
  readonly #listeners = new Map<string, Registered[]>();

  constructor(transport: Transport) {
    this.#transport = transport;
    transport.onMessage((message) => {
      if (message.type !== 'event') return;
      void this.#run(message.event, message.args).finally(() =>
        transport.send({ type: 'event-done', id: message.id }),
      );
    });
  }

  #add(event: string, listener: Listener, where: 'first' | 'last', once: boolean) {
    let list = this.#listeners.get(event);
    if (!list) {
      list = [];
      this.#listeners.set(event, list);
      this.#transport.send({ type: 'subscribe', event });
    }
    // The same function is registered once per event, as in TavernHelper.
    if (list.some((r) => r.listener === listener)) return { stop: () => this.remove(event, listener) };
    const entry = { listener, once };
    if (where === 'first') list.unshift(entry);
    else list.push(entry);
    return { stop: () => this.remove(event, listener) };
  }

  on(event: string, listener: Listener) {
    return this.#add(event, listener, 'last', false);
  }

  makeFirst(event: string, listener: Listener) {
    return this.#add(event, listener, 'first', false);
  }

  makeLast(event: string, listener: Listener) {
    return this.#add(event, listener, 'last', false);
  }

  once(event: string, listener: Listener) {
    return this.#add(event, listener, 'last', true);
  }

  remove(event: string, listener: Listener) {
    const list = this.#listeners.get(event);
    if (!list) return;
    const next = list.filter((r) => r.listener !== listener);
    if (next.length) this.#listeners.set(event, next);
    else this.clearEvent(event);
  }

  clearEvent(event: string) {
    if (!this.#listeners.delete(event)) return;
    this.#transport.send({ type: 'unsubscribe', event });
  }

  clearListener(listener: Listener) {
    for (const event of [...this.#listeners.keys()]) this.remove(event, listener);
  }

  clearAll() {
    for (const event of [...this.#listeners.keys()]) this.clearEvent(event);
  }

  /** Emits through the page: SillyTavern's listeners and every frame's (this one's too) run. */
  async emit(event: string, args: unknown[]): Promise<void> {
    await this.#transport.request((id) => ({ type: 'emit', id, event, args: plain(args) as unknown[] }));
  }

  async #run(event: string, args: unknown[]) {
    const list = [...(this.#listeners.get(event) ?? [])];
    for (const entry of list) {
      if (entry.once) this.remove(event, entry.listener);
      try {
        await entry.listener(...args);
      } catch (error) {
        console.error(`[TavernHelper] listener of ${event} failed`, error);
      }
    }
  }
}
