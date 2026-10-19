import type { ChangeEvent, User } from '@bakatavern/api-client';
import { ApiError } from '@bakatavern/api-client';
import { loadStDefaultPreset, loadStTemplates } from '@bakatavern/core';

import { api } from '../api.ts';
import { events, eventTypes } from '../events.ts';
import { t } from '../i18n/index.svelte.ts';
import { applyStImport } from '../migration/apply.ts';
import { chat } from './chat.svelte.ts';
import { library } from './library.svelte.ts';
import { formattingDefaults } from './prefs.ts';
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
      library.groups = data.groups;
      library.personas = data.personas;
      library.tags = data.tags;
      library.lorebooks = data.lorebooks;
      library.presets = data.presets;
      library.secrets = data.secrets;
      chat.recent = data.recentChats;
      this.status = 'ready';
      this.#listen();
      await seedPresets();
      await applyPendingImport();
      await chat.restoreLast();
      await events.emit(eventTypes.APP_READY);
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
    library.groups = data.groups;
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
        if (chat.members.some((m) => m.id === event.id)) await chat.reloadGroup();
        break;
      case 'group':
        await library.refreshGroups();
        if (event.id === chat.groupId && event.action === 'updated') await chat.reloadGroup();
        if (event.id === chat.groupId && event.action === 'deleted') chat.close();
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

/** Applies SillyTavern settings an import left behind (e.g. from `bakatavern import-st`). */
export async function applyPendingImport() {
  try {
    if (await applyStImport()) ui.toast(t('import.settingsApplied'), 'success');
  } catch (error) {
    ui.toast(t('import.settingsFailed', { message: (error as Error).message }), 'error');
  }
}

/**
 * Gives a new user SillyTavern's "Default" Chat Completion preset and, once, its formatting
 * templates and Text Completion presets (names that exist already are left alone).
 */
async function seedPresets() {
  let changed = false;
  if (!library.presets.some((p) => p.kind === 'openai')) {
    try {
      await api.upsertPreset('openai', 'Default', await loadStDefaultPreset());
      changed = true;
    } catch {
      // Another tab may have seeded it at the same time.
    }
  }
  if (!settings.get('formatting', formattingDefaults).seeded) {
    try {
      const templates = await loadStTemplates();
      const presets = (['context', 'instruct', 'sysprompt', 'reasoning', 'textgen'] as const).flatMap(
        (kind) => templates[kind].map((t) => ({ kind, name: t.name, data: t.data })),
      );
      await api.seedPresets(presets);
      settings.update('formatting', { seeded: true });
      changed = true;
    } catch {
      // Tried again on the next start.
    }
  }
  if (changed) await library.refreshPresets().catch(() => {});
}

export const session = new Session();

if (typeof window !== 'undefined') {
  window.addEventListener('bt:unauthorized', () => {
    if (session.authRequired) session.status = 'login';
  });
  // A phone that slept or lost its connection may have missed a reply finishing on the server.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session.status === 'ready') void chat.recoverJobs();
    // Changes waiting for their save go now: the page may not come back.
    if (document.visibilityState === 'hidden') void settings.flushAll();
  });
  window.addEventListener('online', () => void session.refresh());
}
