<script lang="ts">
  import { uuidv4 } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import {
    applyProfile,
    captureProfile,
    profileDefaults,
    profileFields,
    suggestProfileName,
    type ConnectionProfile,
    type ProfileData,
  } from '../../state/profiles.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived({ ...profileDefaults, ...settings.get('profiles', profileDefaults) });
  const selected = $derived(prefs.profiles.find((p) => p.id === prefs.selected) ?? null);
  const save = (patch: Partial<typeof prefs>) => settings.update('profiles', patch);

  /** The profile being created or updated, with the fields to keep. */
  let draft = $state<{
    profile: ProfileData;
    name: string;
    id: string | null;
  } | null>(null);

  const fieldLabel = (key: string) => t(`profile.field.${key}` as MessageKey);
  /** Values as people read them: key labels instead of ids. */
  function shown(key: string, value: unknown): string {
    if (key === 'secret-id') return library.secrets.find((s) => s.id === value)?.label ?? String(value);
    if (value === '') return t('profile.empty');
    return String(value);
  }

  async function select(id: string) {
    const profile = prefs.profiles.find((p) => p.id === id);
    if (!profile) {
      save({ selected: null });
      return;
    }
    try {
      const skipped = await applyProfile($state.snapshot(profile) as ConnectionProfile);
      if (skipped.length)
        ui.toast(t('profile.partly', { fields: skipped.map(fieldLabel).join(', ') }), 'error');
      else ui.toast(t('profile.applied', { name: profile.name }), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function startCreate() {
    const profile = await captureProfile();
    const name = suggestProfileName(
      profile,
      prefs.profiles.map((p) => p.name),
    );
    draft = { profile, name, id: null };
  }

  /** Records the current connection into the selected profile, keeping what it leaves out. */
  async function startUpdate() {
    if (!selected) return;
    const profile = await captureProfile();
    profile.exclude = [...(selected.exclude ?? [])];
    draft = { profile, name: selected.name, id: selected.id };
  }

  function toggleField(key: string, keep: boolean) {
    if (!draft) return;
    const exclude = (draft.profile.exclude ?? []).filter((k) => k !== key);
    draft.profile.exclude = keep ? exclude : [...exclude, key];
  }

  function finish() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return;
    if (prefs.profiles.some((p) => p.name === name && p.id !== draft!.id)) {
      ui.toast(t('profile.exists', { name }), 'error');
      return;
    }
    const captured = $state.snapshot(draft.profile);
    const profile: ConnectionProfile = { id: draft.id ?? uuidv4(), name, ...captured };
    for (const key of profile.exclude ?? []) delete profile[key];
    const profiles = draft.id
      ? prefs.profiles.map((p) => (p.id === draft!.id ? profile : p))
      : [...prefs.profiles, profile];
    save({ profiles, selected: profile.id });
    ui.toast(t(draft.id ? 'profile.updated' : 'profile.created', { name }), 'success');
    draft = null;
  }

  function rename() {
    if (!selected) return;
    const name = prompt(t('profile.renamePrompt'), selected.name)?.trim();
    if (!name || name === selected.name) return;
    if (prefs.profiles.some((p) => p.name === name)) {
      ui.toast(t('profile.exists', { name }), 'error');
      return;
    }
    save({ profiles: prefs.profiles.map((p) => (p.id === selected.id ? { ...p, name } : p)) });
  }

  function remove() {
    if (!selected || !confirm(t('profile.deleteConfirm', { name: selected.name }))) return;
    save({ profiles: prefs.profiles.filter((p) => p.id !== selected.id), selected: null });
  }
</script>

<div class="profiles">
  <div class="row">
    <select
      class="select"
      value={prefs.selected ?? ''}
      onchange={(e) => void select(e.currentTarget.value)}
      aria-label={t('profile.select')}
    >
      <option value="">{t('profile.none')}</option>
      {#each prefs.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
    <button
      class="icon-btn"
      title={t('profile.create')}
      aria-label={t('profile.create')}
      onclick={startCreate}><Icon name="plus" /></button
    >
    <button
      class="icon-btn"
      title={t('profile.update')}
      aria-label={t('profile.update')}
      disabled={!selected}
      onclick={startUpdate}><Icon name="refresh" /></button
    >
    <button
      class="icon-btn"
      title={t('profile.rename')}
      aria-label={t('profile.rename')}
      disabled={!selected}
      onclick={rename}><Icon name="edit" /></button
    >
    <button
      class="icon-btn"
      title={t('common.delete')}
      aria-label={t('common.delete')}
      disabled={!selected}
      onclick={remove}><Icon name="trash" /></button
    >
  </div>
</div>

<Modal
  open={!!draft}
  title={draft?.id ? t('profile.update') : t('profile.create')}
  onclose={() => (draft = null)}
>
  {#if draft}
    <label class="field"
      ><span>{t('profile.name')}</span><input
        class="input"
        bind:value={draft.name}
        onkeydown={(e) => e.key === 'Enter' && finish()}
      /></label
    >
    <p class="hint">{t('profile.fieldsHint')}</p>
    <ul class="fields">
      {#each profileFields[draft.profile.mode] as key (key)}
        {#if key in draft.profile}
          <li>
            <label class="check">
              <input
                type="checkbox"
                checked={!draft.profile.exclude?.includes(key)}
                onchange={(e) => toggleField(key, e.currentTarget.checked)}
              />
              <span class="key">{fieldLabel(key)}</span>
              <span class="value">{shown(key, draft.profile[key])}</span>
            </label>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (draft = null)}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={!draft?.name.trim()} onclick={finish}>{t('common.save')}</button>
  {/snippet}
</Modal>

<style>
  .row {
    display: flex;
    gap: 0.2rem;
    align-items: center;
  }
  .row .select {
    flex: 1;
    min-width: 0;
  }
  .hint {
    margin: 0.75rem 0 0.4rem;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .fields {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.3rem;
  }
  .fields .check {
    display: grid;
    grid-template-columns: auto 9rem 1fr;
    align-items: baseline;
    gap: 0.5rem;
  }
  .key {
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-sm);
  }
  .value {
    font-size: var(--bt-size-sm);
    overflow-wrap: anywhere;
  }
</style>
