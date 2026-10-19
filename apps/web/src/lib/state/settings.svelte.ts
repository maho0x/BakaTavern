import { ApiError, type SettingsDoc } from '@bakatavern/api-client';

import { api } from '../api.ts';
import { ui } from './ui.svelte.ts';

interface Namespace {
  data: Record<string, unknown>;
  rev: number;
  timer?: ReturnType<typeof setTimeout>;
  saving?: Promise<void>;
}

/**
 * User settings split into namespaces (`ui`, `chat`, `connection`, ...). Each namespace saves on
 * its own after a short debounce; a revision conflict reloads the namespace from the server.
 */
class Settings {
  #ns = $state<Record<string, Namespace>>({});

  load(docs: SettingsDoc[]) {
    const next: Record<string, Namespace> = {};
    for (const doc of docs) next[doc.namespace] = { data: doc.data, rev: doc.rev };
    this.#ns = next;
  }

  /** Takes newer server versions of the namespaces that have no unsaved local edits. */
  sync(docs: SettingsDoc[]) {
    for (const doc of docs) {
      const ns = this.#ns[doc.namespace];
      if (ns && (ns.timer || ns.rev >= doc.rev)) continue;
      this.#ns[doc.namespace] = { data: doc.data, rev: doc.rev };
    }
  }

  /** Settings of a namespace merged over `defaults` (reactive). */
  get<T extends object>(namespace: string, defaults: T): T {
    return { ...defaults, ...(this.#ns[namespace]?.data ?? {}) } as T;
  }

  /** Applies `patch` and schedules a save. */
  update(namespace: string, patch: Record<string, unknown>) {
    const ns = (this.#ns[namespace] ??= { data: {}, rev: 0 });
    ns.data = { ...ns.data, ...patch };
    clearTimeout(ns.timer);
    ns.timer = setTimeout(() => void this.#save(namespace), 400);
  }

  /** Replaces the whole namespace (keys missing from `data` go away) and schedules a save. */
  replace(namespace: string, data: Record<string, unknown>) {
    const ns = (this.#ns[namespace] ??= { data: {}, rev: 0 });
    ns.data = data;
    clearTimeout(ns.timer);
    ns.timer = setTimeout(() => void this.#save(namespace), 400);
  }

  /** Saves every pending change now (the page is being hidden or closed). */
  flushAll() {
    return Promise.all(Object.keys(this.#ns).map((namespace) => this.flush(namespace)));
  }

  async flush(namespace: string) {
    const ns = this.#ns[namespace];
    if (!ns?.timer) return;
    clearTimeout(ns.timer);
    ns.timer = undefined;
    await this.#save(namespace);
  }

  async #save(namespace: string) {
    const ns = this.#ns[namespace];
    if (!ns) return;
    ns.timer = undefined;
    try {
      const doc = await api.putSettings(namespace, $state.snapshot(ns.data), ns.rev);
      ns.rev = doc.rev;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'conflict') {
        const doc = await api.getSettings(namespace);
        this.#ns[namespace] = { data: doc.data, rev: doc.rev };
        ui.toast('Settings were changed in another window; the newer version was loaded.');
      } else {
        ui.toast(`Could not save settings: ${(error as Error).message}`, 'error');
      }
    }
  }

  /** Applies a change made by another client. */
  async reload(namespace: string) {
    try {
      const doc = await api.getSettings(namespace);
      this.#ns[namespace] = { data: doc.data, rev: doc.rev };
    } catch {
      // ignore
    }
  }
}

export const settings = new Settings();
