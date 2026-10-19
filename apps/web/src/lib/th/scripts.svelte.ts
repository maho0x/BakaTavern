/**
 * TavernHelper scripts: global ones in the `frontend` settings, character and preset ones inside
 * the card and the preset (`extensions.tavern_helper`, as TavernHelper stores them). They run in
 * hidden sandboxed frames once allowed.
 */

import { api } from '../api.ts';
import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { library } from '../state/library.svelte.ts';
import { connectionDefaults, frontendDefaults, type FrontendPrefs } from '../state/prefs.ts';
import { settings } from '../state/settings.svelte.ts';

export interface ScriptButton {
  name: string;
  visible: boolean;
}

export interface Script {
  type: 'script';
  enabled: boolean;
  name: string;
  id: string;
  content: string;
  info: string;
  button: { enabled: boolean; buttons: ScriptButton[] };
  data: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface ScriptFolder {
  type: 'folder';
  enabled: boolean;
  name: string;
  id: string;
  scripts: Script[];
  [extra: string]: unknown;
}

export type ScriptTree = Script | ScriptFolder;
export type ScriptSource = 'global' | 'character' | 'preset';

/** TavernHelper's settings on a card or preset: `{scripts, variables}` (older versions: pairs). */
export interface HelperSettings {
  scripts: ScriptTree[];
  variables: Record<string, unknown>;
}

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value));

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeScript(raw: unknown): Script {
  const value = obj(raw);
  // Older TavernHelper: `{type: 'script', value: {...}}` with `buttons` at the top.
  const s = value.value && typeof value.value === 'object' ? obj(value.value) : value;
  const button = obj(s.button);
  const buttons = Array.isArray(button.buttons) ? button.buttons : Array.isArray(s.buttons) ? s.buttons : [];
  return {
    ...s,
    type: 'script',
    enabled: s.enabled === true,
    name: str(s.name),
    id: str(s.id) || randomId(),
    content: str(s.content),
    info: str(s.info),
    button: {
      enabled: button.enabled !== false,
      buttons: buttons.map((b) => ({ name: str(obj(b).name), visible: obj(b).visible !== false })),
    },
    data: obj(s.data),
  };
}

export function normalizeTrees(raw: unknown): ScriptTree[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const value = obj(item);
    if (value.type === 'folder') {
      return {
        ...value,
        type: 'folder',
        enabled: value.enabled === true,
        name: str(value.name),
        id: str(value.id) || randomId(),
        scripts: (Array.isArray(value.scripts)
          ? value.scripts
          : Array.isArray(value.value)
            ? value.value
            : []
        ).map(normalizeScript),
      } satisfies ScriptFolder;
    }
    return normalizeScript(item);
  });
}

/** TavernHelper's settings from a card's or preset's extensions (with the older field names). */
export function helperSettings(extensions: unknown): HelperSettings {
  const ext = obj(extensions);
  let raw: unknown = ext.tavern_helper;
  if (Array.isArray(raw)) raw = Object.fromEntries(raw as [string, unknown][]);
  const settings = obj(raw);
  return {
    scripts: normalizeTrees(settings.scripts ?? ext.TavernHelper_scripts),
    variables: obj(settings.variables ?? ext.TavernHelper_characterScriptVariables),
  };
}

/** The scripts that run: enabled ones, in enabled folders. */
export function enabledScripts(trees: readonly ScriptTree[]): Script[] {
  return trees.flatMap((tree) =>
    tree.type === 'folder'
      ? tree.enabled
        ? tree.scripts.filter((s) => s.enabled)
        : []
      : tree.enabled
        ? [tree]
        : [],
  );
}

/** Changes one script wherever it is in a list of trees. */
export function updateScript(
  trees: readonly ScriptTree[],
  id: string,
  update: (script: Script) => Script,
): ScriptTree[] {
  return trees.map((tree) =>
    tree.type === 'folder'
      ? { ...tree, scripts: tree.scripts.map((s) => (s.id === id ? update(s) : s)) }
      : tree.id === id
        ? update(tree)
        : tree,
  );
}

export interface RunningScript {
  script: Script;
  source: ScriptSource;
}

class HelperScripts {
  /** The active Chat Completion preset's settings (loaded with the preset). */
  preset = $state<{ id: string; rev: number; settings: HelperSettings } | null>(null);

  get prefs(): FrontendPrefs {
    return { ...frontendDefaults, ...settings.get('frontend', frontendDefaults) };
  }

  update(patch: Partial<FrontendPrefs>) {
    settings.update('frontend', patch);
  }

  get globalTrees(): ScriptTree[] {
    return normalizeTrees($state.snapshot(this.prefs.scripts));
  }

  get characterSettings(): HelperSettings {
    const card = chat.character?.card as { data?: { extensions?: unknown } } | undefined;
    return helperSettings($state.snapshot(card?.data?.extensions));
  }

  get characterAllowed(): boolean {
    return !!chat.characterId && this.prefs.allowedCharacters.includes(chat.characterId);
  }

  get presetAllowed(): boolean {
    return !!this.preset && this.prefs.allowedPresets.includes(this.preset.id);
  }

  /** Scripts to run now: global, preset, then character ones, each once. */
  get running(): RunningScript[] {
    const prefs = this.prefs;
    const all: RunningScript[] = [
      ...(prefs.globalScripts
        ? enabledScripts(this.globalTrees).map((script) => ({ script, source: 'global' as const }))
        : []),
      ...(this.presetAllowed && this.preset
        ? enabledScripts(this.preset.settings.scripts).map((script) => ({
            script,
            source: 'preset' as const,
          }))
        : []),
      ...(this.characterAllowed
        ? enabledScripts(this.characterSettings.scripts).map((script) => ({
            script,
            source: 'character' as const,
          }))
        : []),
    ];
    return all.filter((item, i) => all.findIndex((other) => other.script.id === item.script.id) === i);
  }

  setGlobalTrees(trees: ScriptTree[]) {
    this.update({ scripts: trees as unknown as Record<string, unknown>[] });
  }

  /** Writes TavernHelper's settings into the open character's card. */
  async setCharacterSettings(next: HelperSettings) {
    await chat.updateCard((card) => {
      const data = (card.data ??= {});
      const extensions = { ...(data.extensions as Record<string, unknown> | undefined) };
      delete extensions.TavernHelper_scripts;
      delete extensions.TavernHelper_characterScriptVariables;
      extensions.tavern_helper = next;
      data.extensions = extensions;
    });
  }

  async setPresetSettings(next: HelperSettings) {
    const id = this.preset?.id;
    if (!id) return;
    const current = await api.getPreset(id);
    const data = structuredClone(current.data);
    data.extensions = { ...(data.extensions as Record<string, unknown> | undefined), tavern_helper: next };
    const saved = await api.updatePreset(id, { data, rev: current.rev });
    this.preset = { id, rev: saved.rev, settings: next };
    await library.refreshPresets();
  }

  /** Changes a script where it is stored. */
  async updateScript(source: ScriptSource, id: string, update: (script: Script) => Script) {
    if (source === 'global') this.setGlobalTrees(updateScript(this.globalTrees, id, update));
    else if (source === 'character') {
      const current = this.characterSettings;
      await this.setCharacterSettings({ ...current, scripts: updateScript(current.scripts, id, update) });
    } else if (this.preset) {
      const current = this.preset.settings;
      await this.setPresetSettings({ ...current, scripts: updateScript(current.scripts, id, update) });
    }
  }

  /** Loads the active preset's settings (after the preset or its selection changed). */
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
      const data = preset.data as { extensions?: unknown };
      this.preset = { id: preset.id, rev: preset.rev, settings: helperSettings(data.extensions) };
      this.#ask(`preset:${preset.id}`, this.preset.settings, 'allowedPresets', preset.id, () =>
        t('th.askPreset', { name: preset.name }),
      );
    } catch {
      // keep the previous one
    }
  }

  /** Asks once whether a newly seen character's scripts may run. */
  checkCharacter() {
    const id = chat.characterId;
    const name = chat.character?.name;
    if (!id || !name) return;
    this.#ask(`character:${id}`, this.characterSettings, 'allowedCharacters', id, () =>
      t('th.askCharacter', { name }),
    );
  }

  setAllowed(kind: 'allowedCharacters' | 'allowedPresets', id: string, allowed: boolean) {
    const list = this.prefs[kind].filter((x) => x !== id);
    this.update({ [kind]: allowed ? [...list, id] : list });
  }

  #ask(
    key: string,
    helper: HelperSettings,
    kind: 'allowedCharacters' | 'allowedPresets',
    id: string,
    question: () => string,
  ) {
    const prefs = this.prefs;
    if (!enabledScripts(helper.scripts).length || prefs[kind].includes(id) || prefs.asked.includes(key))
      return;
    this.update({ asked: [...prefs.asked, key] });
    setTimeout(() => {
      if (confirm(question())) this.setAllowed(kind, id, true);
    }, 300);
  }
}

export const helperScripts = new HelperScripts();
