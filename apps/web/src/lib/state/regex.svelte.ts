import { ApiError, type Character } from '@bakatavern/api-client';
import { activeRegexScripts, type RegexScript } from '@bakatavern/core';

import { api } from '../api.ts';
import { invalidatePreset } from '../generation/pipeline.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from './chat.svelte.ts';
import { library } from './library.svelte.ts';
import { connectionDefaults, regexDefaults, type RegexPrefs } from './prefs.ts';
import { settings } from './settings.svelte.ts';

/** Regex scripts embedded in a character card (`data.extensions.regex_scripts`). */
export function cardScripts(card: unknown): RegexScript[] {
  const scripts = (card as { data?: { extensions?: { regex_scripts?: unknown } } } | null)?.data?.extensions
    ?.regex_scripts;
  return Array.isArray(scripts) ? (scripts as RegexScript[]) : [];
}

/** Regex scripts embedded in a preset (`extensions.regex_scripts`). */
export function presetScripts(data: unknown): RegexScript[] {
  const scripts = (data as { extensions?: { regex_scripts?: unknown } } | null)?.extensions?.regex_scripts;
  return Array.isArray(scripts) ? (scripts as RegexScript[]) : [];
}

/**
 * Regex scripts: global ones live in the `regex` settings, character and preset ones inside the
 * card and the preset (as in SillyTavern), and run only once allowed.
 */
class RegexStore {
  /** The active Chat Completion preset and its embedded scripts. */
  preset = $state<{ id: string; name: string; rev: number; scripts: RegexScript[] } | null>(null);

  get prefs(): RegexPrefs {
    return settings.get('regex', regexDefaults);
  }

  /** Scripts in effect with this character: global, preset, then character. */
  scriptsFor(character: Character | null | undefined): RegexScript[] {
    const prefs = this.prefs;
    return activeRegexScripts({
      global: prefs.scripts,
      preset: this.preset?.scripts,
      presetAllowed: !!this.preset && prefs.allowedPresets.includes(this.preset.id),
      character: character ? cardScripts(character.card) : [],
      characterAllowed: !!character && prefs.allowedCharacters.includes(character.id),
    });
  }

  setGlobal(scripts: RegexScript[]) {
    settings.update('regex', { scripts });
  }

  /** Replaces the open character's scripts; editing them allows them, as in SillyTavern. */
  async setCharacterScripts(scripts: RegexScript[]) {
    const id = chat.character?.id;
    if (!id) return;
    await chat.updateCard((card) => {
      const data = (card.data ??= {});
      data.extensions = {
        ...(data.extensions as Record<string, unknown> | undefined),
        regex_scripts: scripts,
      };
    });
    this.setAllowed('allowedCharacters', id, true);
  }

  /** Replaces the active preset's scripts (retried once when the preset changed elsewhere). */
  async setPresetScripts(scripts: RegexScript[]) {
    const id = this.preset?.id;
    if (!id) return;
    const write = async () => {
      const current = await api.getPreset(id);
      const data = structuredClone(current.data);
      data.extensions = {
        ...(data.extensions as Record<string, unknown> | undefined),
        regex_scripts: scripts,
      };
      await api.updatePreset(id, { data, rev: current.rev });
    };
    try {
      await write();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'conflict')) throw error;
      await write();
    }
    invalidatePreset();
    await library.refreshPresets();
    await this.syncPreset();
    this.setAllowed('allowedPresets', id, true);
  }

  setAllowed(kind: 'allowedCharacters' | 'allowedPresets', id: string, allowed: boolean) {
    const list = this.prefs[kind].filter((x) => x !== id);
    settings.update('regex', { [kind]: allowed ? [...list, id] : list });
  }

  /** Loads the active preset's embedded scripts (after the preset or its selection changed). */
  async syncPreset() {
    const prefs = settings.get('connection', connectionDefaults);
    const presets = library.presets.filter((p) => p.kind === 'openai');
    const info = presets.find((p) => p.id === prefs.presetId) ?? presets[0];
    if (!info) {
      this.preset = null;
      return;
    }
    if (this.preset?.id === info.id && this.preset.rev === info.rev) return;
    try {
      const preset = await api.getPreset(info.id);
      this.preset = {
        id: preset.id,
        name: preset.name,
        rev: preset.rev,
        scripts: presetScripts(preset.data),
      };
      this.#ask(`preset:${preset.id}`, this.preset.scripts, 'allowedPresets', preset.id, () =>
        t('regex.askPreset', { name: preset.name }),
      );
    } catch {
      // keep the previous state; the next change retries
    }
  }

  /** Asks once whether a newly seen character's embedded scripts may run. */
  checkCharacter(character: Character) {
    this.#ask(
      `character:${character.id}`,
      cardScripts(character.card),
      'allowedCharacters',
      character.id,
      () => t('regex.askCharacter', { name: character.name }),
    );
  }

  #ask(
    key: string,
    scripts: RegexScript[],
    kind: 'allowedCharacters' | 'allowedPresets',
    id: string,
    question: () => string,
  ) {
    const prefs = this.prefs;
    if (!scripts.length || prefs[kind].includes(id) || prefs.asked.includes(key)) return;
    settings.update('regex', { asked: [...prefs.asked, key] });
    // Let the chat render first; the question is about what happens next.
    setTimeout(() => {
      if (confirm(question())) this.setAllowed(kind, id, true);
    }, 300);
  }
}

export const regex = new RegexStore();
