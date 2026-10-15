<script lang="ts">
  import type { Lorebook } from '@bakatavern/api-client';
  import { createEntry, WorldInfoLogic, WorldInfoPosition, type WorldInfoEntry } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { invalidateBook } from '../../generation/books.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { worldInfoDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived(settings.get('worldinfo', worldInfoDefaults));
  const wi = $derived({ ...worldInfoDefaults.settings, ...prefs.settings });
  let book = $state<Lorebook | null>(null);
  let entryUid = $state<number | null>(null);
  let entry = $state<WorldInfoEntry | null>(null);
  let filter = $state('');
  let fileInput = $state<HTMLInputElement>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const entries = $derived(
    ((book?.entries ?? []) as unknown as WorldInfoEntry[]).filter((e) => {
      const q = filter.trim().toLowerCase();
      return (
        !q ||
        e.comment.toLowerCase().includes(q) ||
        e.key.some((k) => k.toLowerCase().includes(q)) ||
        e.content.toLowerCase().includes(q)
      );
    }),
  );

  function setWi(patch: Partial<typeof wi>) {
    settings.update('worldinfo', { settings: { ...wi, ...patch } });
  }

  function toggleGlobal(name: string, on: boolean) {
    const list = prefs.globalBooks.filter((n) => n !== name);
    settings.update('worldinfo', { globalBooks: on ? [...list, name] : list });
  }

  async function open(id: string) {
    book = await api.getLorebook(id);
    entryUid = null;
    entry = null;
  }

  async function createBook() {
    const name = prompt(t('wi.newName'))?.trim();
    if (!name) return;
    try {
      const created = await api.createLorebook(name);
      await library.refreshLorebooks();
      book = created;
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function importBook(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      book = await api.importLorebook(file);
      await library.refreshLorebooks();
      ui.toast(t('wi.imported', { name: book.name }), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }

  async function renameBook() {
    if (!book) return;
    const name = prompt(t('wi.renamePrompt'), book.name)?.trim();
    if (!name || name === book.name) return;
    book = await api.renameLorebook(book.id, name);
    await library.refreshLorebooks();
  }

  async function deleteBook() {
    if (!book || !confirm(t('wi.deleteConfirm', { name: book.name }))) return;
    await api.deleteLorebook(book.id);
    invalidateBook(book.id);
    book = null;
    await library.refreshLorebooks();
  }

  function select(e: WorldInfoEntry) {
    entryUid = e.uid;
    entry = structuredClone($state.snapshot(e));
  }

  async function addEntry() {
    if (!book) return;
    // Without a uid the server assigns the next free one.
    const { uid: _uid, ...fresh } = createEntry(0, { comment: t('wi.newEntry') });
    const stored = await api.upsertLorebookEntry(book.id, fresh as unknown as Record<string, unknown>);
    book = await api.getLorebook(book.id);
    invalidateBook(book.id);
    select(stored as unknown as WorldInfoEntry);
  }

  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveEntry(), 500);
  }

  async function saveEntry() {
    if (!book || !entry) return;
    try {
      await api.upsertLorebookEntry(book.id, $state.snapshot(entry) as unknown as Record<string, unknown>);
      const index = book.entries.findIndex((e) => (e as { uid?: number }).uid === entry!.uid);
      if (index >= 0) book.entries[index] = $state.snapshot(entry) as unknown as Record<string, unknown>;
      invalidateBook(book.id);
      void library.refreshLorebooks();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function deleteEntry() {
    if (!book || entryUid === null) return;
    await api.deleteLorebookEntry(book.id, entryUid);
    book = await api.getLorebook(book.id);
    invalidateBook(book.id);
    entry = null;
    entryUid = null;
  }

  const keys = (list: string[]) => list.join(', ');
  const parseKeys = (text: string) =>
    text
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
</script>

<div class="stack">
  <details>
    <summary>{t('wi.settings')}</summary>
    <div class="grid">
      <label class="field"
        ><span>{t('wi.scanDepth')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.depth}
          onchange={(e) => setWi({ depth: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.budget')}</span><input
          class="input"
          type="number"
          min="1"
          max="100"
          value={wi.budget}
          onchange={(e) => setWi({ budget: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.budgetCap')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.budgetCap}
          onchange={(e) => setWi({ budgetCap: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.minActivations')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.minActivations}
          onchange={(e) => setWi({ minActivations: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.maxRecursion')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.maxRecursionSteps}
          onchange={(e) => setWi({ maxRecursionSteps: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field">
        <span>{t('wi.strategy')}</span>
        <select
          class="select"
          value={wi.characterStrategy}
          onchange={(e) => setWi({ characterStrategy: Number(e.currentTarget.value) })}
        >
          <option value={0}>{t('wi.strategyEvenly')}</option>
          <option value={1}>{t('wi.strategyCharacter')}</option>
          <option value={2}>{t('wi.strategyGlobal')}</option>
        </select>
      </label>
    </div>
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.recursive}
        onchange={(e) => setWi({ recursive: e.currentTarget.checked })}
      />{t('wi.recursive')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.includeNames}
        onchange={(e) => setWi({ includeNames: e.currentTarget.checked })}
      />{t('wi.includeNames')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.caseSensitive}
        onchange={(e) => setWi({ caseSensitive: e.currentTarget.checked })}
      />{t('wi.caseSensitive')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.matchWholeWords}
        onchange={(e) => setWi({ matchWholeWords: e.currentTarget.checked })}
      />{t('wi.wholeWords')}</label
    >
  </details>

  {#if chat.chat}
    <label class="field">
      <span>{t('wi.chatBook')}</span>
      <select
        class="select"
        value={(chat.chat.metadata.world_info as string) ?? ''}
        onchange={(e) => chat.updateMetadata({ world_info: e.currentTarget.value || undefined })}
      >
        <option value="">{t('common.none')}</option>
        {#each library.lorebooks as b (b.id)}<option value={b.name}>{b.name}</option>{/each}
      </select>
    </label>
  {/if}

  <div class="head">
    <h3>{t('wi.books')}</h3>
    <span>
      <button
        class="icon-btn"
        title={t('wi.import')}
        aria-label={t('wi.import')}
        onclick={() => fileInput?.click()}><Icon name="upload" /></button
      >
      <button class="icon-btn" title={t('wi.new')} aria-label={t('wi.new')} onclick={createBook}
        ><Icon name="plus" /></button
      >
    </span>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={(e) => importBook(e.currentTarget.files)}
    />
  </div>
  <ul class="books">
    {#each library.lorebooks as b (b.id)}
      <li class:active={book?.id === b.id}>
        <input
          type="checkbox"
          checked={prefs.globalBooks.includes(b.name)}
          onchange={(e) => toggleGlobal(b.name, e.currentTarget.checked)}
          title={t('wi.global')}
          aria-label={t('wi.globalFor', { name: b.name })}
        />
        <button onclick={() => open(b.id)}>{b.name}<span class="faint"> · {b.entryCount}</span></button>
      </li>
    {/each}
  </ul>

  {#if book}
    <section class="book">
      <div class="head">
        <h3>{book.name}</h3>
        <span>
          <button class="icon-btn" title={t('wi.rename')} aria-label={t('wi.rename')} onclick={renameBook}
            ><Icon name="edit" /></button
          >
          <a
            class="icon-btn"
            href={api.lorebookExportUrl(book.id)}
            download
            title={t('common.export')}
            aria-label={t('common.export')}><Icon name="download" /></a
          >
          <button
            class="icon-btn"
            title={t('common.delete')}
            aria-label={t('common.delete')}
            onclick={deleteBook}><Icon name="trash" /></button
          >
        </span>
      </div>
      <div class="row">
        <input class="input" type="search" placeholder={t('wi.filter')} bind:value={filter} />
        <button class="btn" onclick={addEntry}><Icon name="plus" size={15} />{t('wi.newEntry')}</button>
      </div>
      <ul class="entries">
        {#each entries as e (e.uid)}
          <li>
            <button class:active={entryUid === e.uid} class:off={e.disable} onclick={() => select(e)}>
              <span class="dot" class:constant={e.constant}></span>
              <span class="title">{e.comment || keys(e.key) || `#${e.uid}`}</span>
            </button>
          </li>
        {/each}
      </ul>

      {#if entry}
        <div class="entry">
          <label class="field"
            ><span>{t('wi.comment')}</span><input
              class="input"
              bind:value={entry.comment}
              oninput={changed}
            /></label
          >
          <label class="field"
            ><span>{t('wi.keys')}</span><input
              class="input"
              value={keys(entry.key)}
              onchange={(ev) => {
                entry!.key = parseKeys(ev.currentTarget.value);
                changed();
              }}
            /></label
          >
          <div class="pair">
            <label class="field">
              <span>{t('wi.logic')}</span>
              <select class="select" bind:value={entry.selectiveLogic} onchange={changed}>
                <option value={WorldInfoLogic.AND_ANY}>AND ANY</option>
                <option value={WorldInfoLogic.AND_ALL}>AND ALL</option>
                <option value={WorldInfoLogic.NOT_ANY}>NOT ANY</option>
                <option value={WorldInfoLogic.NOT_ALL}>NOT ALL</option>
              </select>
            </label>
            <label class="field"
              ><span>{t('wi.secondary')}</span><input
                class="input"
                value={keys(entry.keysecondary)}
                onchange={(ev) => {
                  entry!.keysecondary = parseKeys(ev.currentTarget.value);
                  changed();
                }}
              /></label
            >
          </div>
          <label class="field"
            ><span>{t('wi.content')}</span><textarea
              class="textarea prose"
              rows="8"
              bind:value={entry.content}
              oninput={changed}></textarea></label
          >
          <div class="pair">
            <label class="field">
              <span>{t('wi.position')}</span>
              <select class="select" bind:value={entry.position} onchange={changed}>
                <option value={WorldInfoPosition.before}>{t('wi.posBefore')}</option>
                <option value={WorldInfoPosition.after}>{t('wi.posAfter')}</option>
                <option value={WorldInfoPosition.ANTop}>{t('wi.posANTop')}</option>
                <option value={WorldInfoPosition.ANBottom}>{t('wi.posANBottom')}</option>
                <option value={WorldInfoPosition.atDepth}>{t('wi.posDepth')}</option>
                <option value={WorldInfoPosition.EMTop}>{t('wi.posEMTop')}</option>
                <option value={WorldInfoPosition.EMBottom}>{t('wi.posEMBottom')}</option>
                <option value={WorldInfoPosition.outlet}>{t('wi.posOutlet')}</option>
              </select>
            </label>
            <label class="field"
              ><span>{t('wi.order')}</span><input
                class="input"
                type="number"
                bind:value={entry.order}
                onchange={changed}
              /></label
            >
          </div>
          {#if entry.position === WorldInfoPosition.atDepth}
            <div class="pair">
              <label class="field"
                ><span>{t('note.depth')}</span><input
                  class="input"
                  type="number"
                  min="0"
                  bind:value={entry.depth}
                  onchange={changed}
                /></label
              >
              <label class="field">
                <span>{t('note.role')}</span>
                <select class="select" bind:value={entry.role} onchange={changed}>
                  <option value={0}>{t('role.system')}</option>
                  <option value={1}>{t('role.user')}</option>
                  <option value={2}>{t('role.assistant')}</option>
                </select>
              </label>
            </div>
          {/if}
          {#if entry.position === WorldInfoPosition.outlet}
            <label class="field"
              ><span>{t('wi.outletName')}</span><input
                class="input"
                bind:value={entry.outletName}
                oninput={changed}
              /></label
            >
          {/if}
          <div class="pair">
            <label class="field"
              ><span>{t('wi.probability')}</span><input
                class="input"
                type="number"
                min="0"
                max="100"
                bind:value={entry.probability}
                onchange={changed}
              /></label
            >
            <label class="field"
              ><span>{t('wi.group')}</span><input
                class="input"
                bind:value={entry.group}
                oninput={changed}
              /></label
            >
          </div>
          <div class="pair">
            <label class="field"
              ><span>{t('wi.sticky')}</span><input
                class="input"
                type="number"
                min="0"
                bind:value={entry.sticky}
                onchange={changed}
              /></label
            >
            <label class="field"
              ><span>{t('wi.cooldown')}</span><input
                class="input"
                type="number"
                min="0"
                bind:value={entry.cooldown}
                onchange={changed}
              /></label
            >
          </div>
          <label class="check"
            ><input type="checkbox" bind:checked={entry.constant} onchange={changed} />{t(
              'wi.constant',
            )}</label
          >
          <label class="check"
            ><input
              type="checkbox"
              checked={!entry.disable}
              onchange={(ev) => {
                entry!.disable = !ev.currentTarget.checked;
                changed();
              }}
            />{t('wi.enabled')}</label
          >
          <label class="check"
            ><input type="checkbox" bind:checked={entry.excludeRecursion} onchange={changed} />{t(
              'wi.excludeRecursion',
            )}</label
          >
          <label class="check"
            ><input type="checkbox" bind:checked={entry.preventRecursion} onchange={changed} />{t(
              'wi.preventRecursion',
            )}</label
          >
          <button class="btn danger ghost" onclick={deleteEntry}
            ><Icon name="trash" size={15} />{t('wi.deleteEntry')}</button
          >
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 0.9rem;
  }
  details summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
    margin-bottom: 0.5rem;
  }
  details .check {
    margin-top: 0.4rem;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head span {
    display: flex;
  }
  h3 {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .books,
  .entries {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.1rem;
    max-height: 16rem;
    overflow-y: auto;
  }
  .books li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.1rem 0.3rem;
    border-radius: var(--bt-radius-sm);
  }
  .books li.active {
    background: var(--bt-surface-3);
  }
  .books input {
    accent-color: var(--bt-accent);
  }
  .books button,
  .entries button {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    padding: 0.35rem 0.3rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
  }
  .entries button.active {
    background: var(--bt-surface-3);
  }
  .entries button.off {
    opacity: 0.5;
  }
  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--bt-accent);
  }
  .dot.constant {
    background: var(--bt-dialogue);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .book {
    display: grid;
    gap: 0.6rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--bt-line);
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  .entry {
    display: grid;
    gap: 0.6rem;
    padding: 0.75rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
</style>
