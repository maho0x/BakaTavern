import type { Preset } from '@bakatavern/api-client';

import { api } from '../../api.ts';
import { invalidatePreset } from '../../generation/pipeline.ts';
import { t } from '../../i18n/index.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import { errorText, ui } from '../../state/ui.svelte.ts';

/**
 * Editing one preset of a kind (a template or sampler set): loads it, saves edits shortly after
 * they are made, and offers import, export, save-as and delete. `normalize` fills in defaults for
 * editing; `serialize` turns the draft back into the stored document.
 */
export class PresetEditor<T extends object> {
  preset = $state<Preset | null>(null);
  draft = $state<T | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;

  readonly kind: string;
  readonly normalize: (data: Record<string, unknown>) => T;
  readonly serialize: (draft: T) => Record<string, unknown>;

  constructor(
    kind: string,
    normalize: (data: Record<string, unknown>) => T,
    serialize: (draft: T) => Record<string, unknown> = (draft) => draft as Record<string, unknown>,
  ) {
    this.kind = kind;
    this.normalize = normalize;
    this.serialize = serialize;
  }

  get presets() {
    return library.presets.filter((p) => p.kind === this.kind);
  }

  /** Loads the preset if it is not the one being edited. */
  async load(id: string | null | undefined) {
    if (!id) {
      this.preset = null;
      this.draft = null;
      return;
    }
    if (this.preset?.id === id) return;
    await this.flush();
    const preset = await api.getPreset(id);
    this.preset = preset;
    this.draft = this.normalize(preset.data);
  }

  changed() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.save(), 500);
  }

  async flush() {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.save();
  }

  async save() {
    this.#timer = undefined;
    const preset = this.preset;
    if (!preset || !this.draft) return;
    try {
      const data = this.serialize($state.snapshot(this.draft) as T);
      const saved = await api.updatePreset(preset.id, { data, rev: preset.rev });
      if (this.preset?.id === saved.id) this.preset = saved;
      library.presets = library.presets.map((p) => (p.id === saved.id ? { ...p, rev: saved.rev } : p));
      invalidatePreset();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  /** Creates a preset; returns its id. */
  async create(name: string, data: Record<string, unknown>): Promise<string> {
    const created = await api.upsertPreset(this.kind, name, data);
    await library.refreshPresets();
    return created.id;
  }

  async saveAs(): Promise<string | null> {
    if (!this.draft) return null;
    const name = prompt(t('preset.saveAsPrompt'), `${this.preset?.name ?? 'Preset'} (copy)`)?.trim();
    if (!name) return null;
    return this.create(name, { ...this.serialize($state.snapshot(this.draft) as T), name });
  }

  async remove(): Promise<boolean> {
    const preset = this.preset;
    if (!preset || !confirm(t('preset.deleteConfirm', { name: preset.name }))) return false;
    await api.deletePreset(preset.id);
    await library.refreshPresets();
    this.preset = null;
    this.draft = null;
    return true;
  }

  export() {
    if (!this.draft || !this.preset) return;
    const data = { ...this.serialize($state.snapshot(this.draft) as T) };
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${this.preset.name}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Imports a JSON file; `check` rejects files of another kind. Returns the new preset's id. */
  async import(file: File, check: (data: Record<string, unknown>) => boolean): Promise<string | null> {
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      if (!data || typeof data !== 'object' || !check(data)) throw new Error(t('preset.wrongKind'));
      const name = (typeof data.name === 'string' && data.name.trim()) || file.name.replace(/\.json$/i, '');
      const id = await this.create(name, data);
      ui.toast(t('preset.imported', { name }), 'success');
      return id;
    } catch (error) {
      ui.toast(errorText(error), 'error');
      return null;
    }
  }
}

/** What preset pickers use of an editor, whatever it edits. */
export type PresetPickerEditor = Pick<
  PresetEditor<object>,
  'kind' | 'presets' | 'export' | 'saveAs' | 'remove' | 'import'
>;
