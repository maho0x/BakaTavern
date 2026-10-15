<script lang="ts">
  import type { Persona, PersonaInput } from '@bakatavern/api-client';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { personaDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  let selectedId = $state<string | null>(null);
  let form = $state<PersonaInput | null>(null);
  let rev = 0;
  let avatarInput = $state<HTMLInputElement>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const prefs = $derived(settings.get('persona', personaDefaults));
  const selected = $derived(library.persona(selectedId) ?? chat.persona);

  $effect(() => {
    const p = selected;
    if (!p) {
      form = null;
      return;
    }
    if (form && selectedId === p.id) return;
    selectedId = p.id;
    rev = p.rev;
    form = {
      name: p.name,
      description: p.description,
      position: p.position,
      depth: p.depth,
      role: p.role,
      lorebook: p.lorebook,
      data: p.data,
    };
  });

  async function create() {
    const name = prompt(t('persona.newName'))?.trim();
    if (!name) return;
    const created = await api.createPersona({
      name,
      description: '',
      position: 0,
      depth: 2,
      role: 0,
      lorebook: null,
      data: {},
    });
    library.personas.push(created);
    selectedId = created.id;
    form = null;
  }

  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 500);
  }

  async function save() {
    if (!selectedId || !form) return;
    try {
      const updated = await api.updatePersona(selectedId, $state.snapshot(form), rev);
      rev = updated.rev;
      library.personas = library.personas.map((p) => (p.id === updated.id ? updated : p));
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function changeAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file || !selectedId) return;
    const updated = await api.setPersonaAvatar(selectedId, file);
    rev = updated.rev;
    library.personas = library.personas.map((p) => (p.id === updated.id ? updated : p));
  }

  async function remove(persona: Persona) {
    if (!confirm(t('persona.deleteConfirm', { name: persona.name }))) return;
    await api.deletePersona(persona.id);
    library.personas = library.personas.filter((p) => p.id !== persona.id);
    selectedId = null;
    form = null;
  }

  function useForChat(persona: Persona) {
    void chat.updateMetadata({ persona: persona.id });
  }

  function useForCharacter(persona: Persona) {
    if (!chat.characterId) return;
    settings.update('persona', {
      characterPersona: { ...prefs.characterPersona, [chat.characterId]: persona.id },
    });
  }
</script>

<div class="stack">
  <div class="head">
    <h3>{t('persona.title')}</h3>
    <button class="btn" onclick={create}><Icon name="plus" size={15} />{t('persona.new')}</button>
  </div>
  {#if library.personas.length === 0}
    <p class="muted">{t('persona.empty')}</p>
  {/if}
  <ul class="list">
    {#each library.personas as persona (persona.id)}
      <li>
        <button
          class="row"
          class:active={selected?.id === persona.id}
          onclick={() => {
            selectedId = persona.id;
            form = null;
          }}
        >
          <Avatar hash={persona.avatar} name={persona.name} width={32} round />
          <span>{persona.name}</span>
          {#if chat.persona?.id === persona.id}<span class="badge">{t('persona.active')}</span>{/if}
          {#if prefs.defaultPersonaId === persona.id}<span class="badge">{t('persona.default')}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>

  {#if form && selected}
    <section class="editor">
      <div class="identity">
        <button class="avatar-btn" onclick={() => avatarInput?.click()} title={t('char.avatar')}>
          <Avatar hash={selected.avatar} name={form.name} width={56} round />
        </button>
        <input
          bind:this={avatarInput}
          type="file"
          accept="image/*"
          hidden
          onchange={(e) => changeAvatar(e.currentTarget.files)}
        />
        <label class="field grow"
          ><span>{t('char.name')}</span><input
            class="input"
            bind:value={form.name}
            oninput={changed}
          /></label
        >
      </div>
      <label class="field"
        ><span>{t('persona.description')}</span><textarea
          class="textarea prose"
          rows="6"
          bind:value={form.description}
          oninput={changed}></textarea></label
      >
      <label class="field">
        <span>{t('persona.position')}</span>
        <select class="select" bind:value={form.position} onchange={changed}>
          <option value={0}>{t('persona.inPrompt')}</option>
          <option value={2}>{t('persona.topAN')}</option>
          <option value={3}>{t('persona.bottomAN')}</option>
          <option value={4}>{t('persona.atDepth')}</option>
          <option value={9}>{t('common.none')}</option>
        </select>
      </label>
      {#if form.position === 4}
        <div class="pair">
          <label class="field"
            ><span>{t('note.depth')}</span><input
              class="input"
              type="number"
              min="0"
              bind:value={form.depth}
              onchange={changed}
            /></label
          >
          <label class="field">
            <span>{t('note.role')}</span>
            <select class="select" bind:value={form.role} onchange={changed}>
              <option value={0}>{t('role.system')}</option>
              <option value={1}>{t('role.user')}</option>
              <option value={2}>{t('role.assistant')}</option>
            </select>
          </label>
        </div>
      {/if}
      <label class="field">
        <span>{t('persona.lorebook')}</span>
        <select class="select" bind:value={form.lorebook} onchange={changed}>
          <option value={null}>{t('common.none')}</option>
          {#each library.lorebooks as book (book.id)}<option value={book.name}>{book.name}</option>{/each}
        </select>
      </label>
      <div class="actions">
        <button class="btn" disabled={!chat.chat} onclick={() => useForChat(selected)}
          >{t('persona.useInChat')}</button
        >
        <button class="btn" disabled={!chat.characterId} onclick={() => useForCharacter(selected)}
          >{t('persona.useForCharacter')}</button
        >
        <button class="btn" onclick={() => settings.update('persona', { defaultPersonaId: selected.id })}
          >{t('persona.makeDefault')}</button
        >
        <button class="btn danger ghost" onclick={() => remove(selected)}
          ><Icon name="trash" size={15} />{t('common.delete')}</button
        >
      </div>
    </section>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 0.9rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h3 {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .list {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.15rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.35rem 0.45rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
  }
  .row:hover {
    background: var(--bt-surface-2);
  }
  .row.active {
    background: var(--bt-surface-3);
  }
  .badge {
    font-size: var(--bt-size-xs);
    color: var(--bt-accent);
  }
  .editor {
    display: grid;
    gap: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--bt-line);
  }
  .identity {
    display: flex;
    gap: 0.75rem;
    align-items: end;
  }
  .avatar-btn {
    border: 0;
    background: transparent;
    padding: 0;
  }
  .grow {
    flex: 1;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
</style>
