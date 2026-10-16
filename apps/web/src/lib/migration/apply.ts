import { api } from '../api.ts';
import { library } from '../state/library.svelte.ts';
import {
  connectionDefaults,
  logitBiasDefaults,
  noteDefaults,
  personaDefaults,
  regexDefaults,
  textConnectionDefaults,
  worldInfoDefaults,
  type TextConnectionPrefs,
} from '../state/prefs.ts';
import { profileDefaults } from '../state/profiles.ts';
import { settings } from '../state/settings.svelte.ts';
import { mapStSettings, type StImportStash } from './st-settings.ts';

const NAMESPACE = 'st_import';

/**
 * Applies SillyTavern settings left by an import (see crates/bt-server/src/st_import.rs), then
 * clears them. Returns whether there was anything to apply.
 */
export async function applyStImport(): Promise<boolean> {
  const stash = settings.get<Partial<StImportStash>>(NAMESPACE, {});
  if (!stash.settings) return false;
  const full: StImportStash = {
    characters: {},
    personas: {},
    lorebooks: {},
    presets: {},
    secrets: [],
    importedAt: 0,
    ...stash,
    settings: stash.settings,
  };
  const patch = mapStSettings(full, { regex: settings.get('regex', regexDefaults) });

  // The templates and Text Completion preset SillyTavern was using, saved under their names.
  const ids: Record<string, string> = {};
  for (const [kind, template] of Object.entries(patch.templates)) {
    if (!template) continue;
    try {
      ids[kind] = (await api.upsertPreset(kind, template.name, template.data)).id;
    } catch {
      // keep the current one
    }
  }
  if (Object.keys(ids).length) await library.refreshPresets().catch(() => {});
  settings.update('formatting', {
    ...patch.formatting,
    ...(ids.instruct ? { instructId: ids.instruct } : {}),
    ...(ids.context ? { contextId: ids.context } : {}),
    ...(ids.sysprompt ? { syspromptId: ids.sysprompt } : {}),
  });

  // Maps keyed by provider or character are merged with what is already set here.
  const connection = settings.get('connection', connectionDefaults);
  const text = { ...textConnectionDefaults, ...connection.text };
  const importedText: Partial<TextConnectionPrefs> = patch.connection.text ?? {};
  settings.update('connection', {
    ...patch.connection,
    text: {
      ...text,
      ...importedText,
      serverUrls: { ...text.serverUrls, ...importedText.serverUrls },
      models: { ...text.models, ...importedText.models },
      secretIds: { ...text.secretIds, ...importedText.secretIds },
      settings: { ...text.settings, ...importedText.settings },
      ...(ids.textgen ? { presetId: ids.textgen } : {}),
    },
    models: { ...connection.models, ...patch.connection.models },
    baseUrls: { ...connection.baseUrls, ...patch.connection.baseUrls },
    endpoints: { ...connection.endpoints, ...patch.connection.endpoints },
    secretIds: { ...connection.secretIds, ...patch.connection.secretIds },
    sourceSettings: { ...connection.sourceSettings, ...patch.connection.sourceSettings },
  });
  settings.update('chat', patch.chat);
  if (patch.logitbias.lists) {
    const current = settings.get('logitbias', logitBiasDefaults);
    settings.update('logitbias', { lists: { ...current.lists, ...patch.logitbias.lists } });
  }
  if (patch.profiles.profiles) {
    const current = { ...profileDefaults, ...settings.get('profiles', profileDefaults) };
    const imported = new Set(patch.profiles.profiles.map((p) => p.id));
    settings.update('profiles', {
      profiles: [...current.profiles.filter((p) => !imported.has(p.id)), ...patch.profiles.profiles],
      selected: patch.profiles.selected ?? current.selected,
    });
  }
  const worldinfo = settings.get('worldinfo', worldInfoDefaults);
  settings.update('worldinfo', {
    ...patch.worldinfo,
    globalBooks: [...new Set([...worldinfo.globalBooks, ...(patch.worldinfo.globalBooks ?? [])])],
    characterExtraBooks: { ...worldinfo.characterExtraBooks, ...patch.worldinfo.characterExtraBooks },
  });
  const note = settings.get('note', noteDefaults);
  settings.update('note', {
    ...patch.note,
    characterNotes: { ...note.characterNotes, ...patch.note.characterNotes },
  });
  const persona = settings.get('persona', personaDefaults);
  settings.update('persona', {
    characterPersona: { ...persona.characterPersona, ...patch.persona.characterPersona },
  });
  settings.update('regex', patch.regex);
  settings.update('variables', {
    ...(settings.get('variables', {}) as Record<string, unknown>),
    ...patch.variables,
  });
  for (const namespace of [
    'connection',
    'formatting',
    'logitbias',
    'profiles',
    'chat',
    'worldinfo',
    'note',
    'persona',
    'regex',
    'variables',
  ])
    await settings.flush(namespace);

  for (const { id, origins } of patch.secretOrigins) {
    await api.updateSecret(id, { allowedOrigins: origins }).catch(() => {});
  }
  // Applied: keep only when it happened.
  await api.putSettings(NAMESPACE, { appliedAt: Date.now() });
  await settings.reload(NAMESPACE);
  return true;
}
