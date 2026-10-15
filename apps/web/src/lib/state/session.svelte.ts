import type { ChangeEvent, User } from '@bakatavern/api-client';
import { ApiError } from '@bakatavern/api-client';
import { loadStDefaultPreset } from '@bakatavern/core';

import { api } from '../api.ts';
import { chat } from './chat.svelte.ts';
import { library } from './library.svelte.ts';
import { settings } from './settings.svelte.ts';
import { ui } from './ui.svelte.ts';

export type SessionStatus = 'loading' | 'login' | 'ready' | 'offline';

class Session {
  status = $state<SessionStatus>('loading');
  user = $state<User | null>(null);
  authRequired = $state(false);
  version = $state('');
  #unsubscribe: (() => void) | null = null;

  async boot() {
    this.status = 'loading';
    try {
      const data = await api.bootstrap();
      this.user = data.user;
      this.authRequired = data.authRequired;
      this.version = data.version;
      settings.load(data.settings);
      library.characters = data.characters;
      library.personas = data.personas;
      library.tags = data.tags;
      library.lorebooks = data.lorebooks;
      library.presets = data.presets;
      library.secrets = data.secrets;
      chat.recent = data.recentChats;
      this.status = 'ready';
      this.#listen();
      await seedPresets();
      await chat.restoreLast();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.status = 'login';
      } else {
        this.status = 'offline';
        ui.toast(`Cannot reach the BakaTavern server: ${(error as Error).message}`, 'error');
      }
    }
  }

  async login(password: string, handle?: string) {
    await api.login(password, handle);
    await this.boot();
  }

  async logout() {
    await api.logout();
    this.#unsubscribe?.();
    this.status = 'login';
  }

  /** Catches up after change events may have been missed (e.g. a phone waking up). */
  async refresh() {
    if (this.status !== 'ready') return;
    let data;
    try {
      data = await api.bootstrap();
    } catch {
      return;
    }
    settings.sync(data.settings);
    library.characters = data.characters;
    library.personas = data.personas;
    library.tags = data.tags;
    library.lorebooks = data.lorebooks;
    library.presets = data.presets;
    library.secrets = data.secrets;
    chat.recent = data.recentChats;
    await chat.resync();
  }

  #listen() {
    this.#unsubscribe?.();
    this.#unsubscribe = api.subscribe(
      (event) => void this.#onChange(event),
      () => void this.refresh(),
    );
  }

  async #onChange(event: ChangeEvent) {
    switch (event.kind) {
      case 'character':
        await library.refreshCharacters();
        if (event.id === chat.characterId && event.action === 'updated') await chat.reloadCharacter();
        break;
      case 'persona':
        await library.refreshPersonas();
        break;
      case 'lorebook':
        await library.refreshLorebooks();
        break;
      case 'preset':
        await library.refreshPresets();
        break;
      case 'secret':
        await library.refreshSecrets();
        break;
      case 'tag':
        await library.refreshTags();
        break;
      case 'settings':
        await settings.reload(event.id);
        break;
      case 'chat':
      case 'message':
        await chat.onRemoteChange(event);
        break;
      case 'job':
        await chat.onJobEvent(event);
        break;
    }
  }
}

/** Gives a new user SillyTavern's "Default" Chat Completion preset. */
async function seedPresets() {
  if (library.presets.some((p) => p.kind === 'openai')) return;
  try {
    await api.upsertPreset('openai', 'Default', await loadStDefaultPreset());
  } catch {
    // Another tab may have seeded it at the same time.
  }
  await library.refreshPresets().catch(() => {});
}

export const session = new Session();

if (typeof window !== 'undefined') {
  window.addEventListener('bt:unauthorized', () => {
    if (session.authRequired) session.status = 'login';
  });
  // A phone that slept or lost its connection may have missed a reply finishing on the server.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session.status === 'ready') void chat.recoverJobs();
  });
  window.addEventListener('online', () => void session.refresh());
}
