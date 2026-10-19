<script lang="ts">
  import { ApiError, type Lorebook } from '@bakatavern/api-client';
  import { createEntry, type WorldInfoEntry } from '@bakatavern/core';
  import { SvelteSet } from 'svelte/reactivity';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { invalidateBook } from '../../generation/books.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { DebouncedSave } from '../../state/pending-saves.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import EntryEditor from './EntryEditor.svelte';
  import {
    entrySorts,
    entryTitle,
    matchesQuery,
    placementBadge,
    sortEntries,
    strategyOf,
    type EntrySort,
  } from './entries.ts';

  const SORT_KEY = 'bt.wiSort';

  let book = $state<Lorebook | null>(null);
  let entries = $state<WorldInfoEntry[]>([]);
  let selectedUid = $state<number | null>(null);
  let query = $state('');
  let sort = $state<EntrySort>(savedSort());
  const checked = new SvelteSet<number>();
  // Pending saves per entry: bookkeeping, not something the page shows.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const savers = new Map<number, DebouncedSave>();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const selected = $derived(entries.find((e) => e.uid === selectedUid) ?? null);
  const shown = $derived(
    sortEntries(
      entries.filter((e) => matchesQuery(e, query)),
      sort,
    ),
  );
  const otherBooks = $derived(library.lorebooks.filter((b) => b.id !== book?.id));
  const allShownChecked = $derived(shown.length > 0 && shown.every((e) => checked.has(e.uid)));

  function savedSort(): EntrySort {
    try {
      const value = localStorage.getItem(SORT_KEY);
      if (entrySorts.some((s) => s.value === value)) return value as EntrySort;
    } catch {
      // storage unavailable
    }
    return 'order';
  }

  function setSort(value: EntrySort) {
    sort = value;
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      // storage unavailable
    }
  }

  $effect(() => {
    const id = ui.editingLorebookId;
    if (!id) {
      book = null;
      entries = [];
      return;
    }
    void load(id);
  });

  async function load(id: string) {
    try {
      const loaded = await api.getLorebook(id);
      book = loaded;
      entries = loaded.entries as unknown as WorldInfoEntry[];
      selectedUid = null;
      query = '';
      checked.clear();
    } catch (error) {
      ui.toast(errorText(error), 'error');
      ui.editingLorebookId = null;
    }
  }

  async function close() {
    await flushAll();
    ui.editingLorebookId = null;
  }

  async function switchBook(id: string) {
    await flushAll();
    ui.editingLorebookId = id;
  }

  // -----------------------------------------------------------------------------------------
  // Writing entries: each edit saves that entry alone, a moment after typing stops.

  function afterWrite() {
    if (!book) return;
    invalidateBook(book.id);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void library.refreshLorebooks(), 800);
  }

  function patch(uid: number, changes: Partial<WorldInfoEntry>) {
    const entry = entries.find((e) => e.uid === uid);
    if (!entry) return;
    Object.assign(entry, changes);
    changed(uid);
  }

  function changed(uid: number) {
    let saver = savers.get(uid);
    if (!saver) savers.set(uid, (saver = new DebouncedSave(() => saveEntry(uid), 400)));
    saver.schedule();
  }

  async function saveEntry(uid: number) {
    const entry = entries.find((e) => e.uid === uid);
    if (!book || !entry) return;
    try {
      await api.upsertLorebookEntry(book.id, $state.snapshot(entry) as unknown as Record<string, unknown>);
      afterWrite();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function flushAll() {
    for (const saver of [...savers.values()]) await saver.flush();
  }

  async function insert(fields: Partial<WorldInfoEntry>) {
    if (!book) return;
    // Without a uid the server assigns the next free one.
    const { uid: _uid, ...fresh } = { ...createEntry(0), ...fields };
    const stored = (await api.upsertLorebookEntry(
      book.id,
      fresh as unknown as Record<string, unknown>,
    )) as unknown as WorldInfoEntry;
    entries.push(stored);
    selectedUid = stored.uid;
    afterWrite();
  }

  async function addEntry() {
    try {
      await insert({ comment: t('wi.newEntry') });
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function duplicateEntry(entry: WorldInfoEntry) {
    try {
      const copy = structuredClone($state.snapshot(entry)) as WorldInfoEntry;
      await insert({ ...copy, comment: t('wi.copyOf', { name: entryTitle(copy) }) });
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function deleteEntry(entry: WorldInfoEntry) {
    if (!book || !confirm(t('wi.deleteEntryConfirm', { name: entryTitle(entry) }))) return;
    try {
      savers.get(entry.uid)?.cancel();
      savers.delete(entry.uid);
      await api.deleteLorebookEntry(book.id, entry.uid);
      entries = entries.filter((e) => e.uid !== entry.uid);
      checked.delete(entry.uid);
      selectedUid = null;
      afterWrite();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  // -----------------------------------------------------------------------------------------
  // Bulk changes replace the whole book, starting from its latest stored version.

  async function bulk(transform: (list: WorldInfoEntry[]) => WorldInfoEntry[]) {
    if (!book) return;
    const id = book.id;
    await flushAll();
    for (let attempt = 0; ; attempt++) {
      const fresh = await api.getLorebook(id);
      const next = transform(fresh.entries as unknown as WorldInfoEntry[]);
      try {
        const saved = await api.replaceLorebook(
          id,
          next as unknown as Record<string, unknown>[],
          fresh.data,
          fresh.rev,
        );
        book = saved;
        entries = saved.entries as unknown as WorldInfoEntry[];
        break;
      } catch (error) {
        if (attempt > 0 || !(error instanceof ApiError && error.code === 'conflict')) throw error;
      }
    }
    afterWrite();
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  const setEnabled = (on: boolean) =>
    run(() => bulk((list) => list.map((e) => (checked.has(e.uid) ? { ...e, disable: !on } : e))));

  function deleteChecked() {
    if (!confirm(t('wi.deleteSelectedConfirm', { count: checked.size }))) return;
    void run(async () => {
      await bulk((list) => list.filter((e) => !checked.has(e.uid)));
      if (selectedUid !== null && checked.has(selectedUid)) selectedUid = null;
      checked.clear();
    });
  }

  function transfer(targetId: string, move: boolean) {
    const target = library.lorebooks.find((b) => b.id === targetId);
    if (!target || !book) return;
    void run(async () => {
      await flushAll();
      const picked = entries.filter((e) => checked.has(e.uid));
      for (const entry of picked) {
        const { uid: _uid, ...copy } = structuredClone($state.snapshot(entry)) as WorldInfoEntry;
        await api.upsertLorebookEntry(target.id, copy as unknown as Record<string, unknown>);
      }
      invalidateBook(target.id);
      if (move) await bulk((list) => list.filter((e) => !checked.has(e.uid)));
      if (move && selectedUid !== null && checked.has(selectedUid)) selectedUid = null;
      checked.clear();
      await library.refreshLorebooks();
      ui.toast(t(move ? 'wi.moved' : 'wi.copied', { count: picked.length, name: target.name }), 'success');
    });
  }

  function toggleAll(on: boolean) {
    for (const entry of shown) {
      if (on) checked.add(entry.uid);
      else checked.delete(entry.uid);
    }
  }

  // -----------------------------------------------------------------------------------------
  // The book itself

  async function renameBook() {
    if (!book) return;
    const name = prompt(t('wi.renamePrompt'), book.name)?.trim();
    if (!name || name === book.name) return;
    await run(async () => {
      book = await api.renameLorebook(book!.id, name);
      await library.refreshLorebooks();
    });
  }

  async function duplicateBook() {
    if (!book) return;
    const name = prompt(t('wi.duplicatePrompt'), t('wi.copyOf', { name: book.name }))?.trim();
    if (!name) return;
    await run(async () => {
      await flushAll();
      const fresh = await api.getLorebook(book!.id);
      const created = await api.createLorebook(name, fresh.entries, fresh.data);
      await library.refreshLorebooks();
      ui.editingLorebookId = created.id;
    });
  }

  async function deleteBook() {
    if (!book || !confirm(t('wi.deleteConfirm', { name: book.name }))) return;
    await run(async () => {
      for (const saver of savers.values()) saver.cancel();
      savers.clear();
      await api.deleteLorebook(book!.id);
      invalidateBook(book!.id);
      await library.refreshLorebooks();
      ui.editingLorebookId = null;
    });
  }
</script>

<Modal open={!!ui.editingLorebookId} title={book?.name ?? t('panel.worldinfo')} onclose={close} full>
  {#snippet actions()}
    {#if book}
      <button class="icon-btn" title={t('wi.rename')} aria-label={t('wi.rename')} onclick={renameBook}
        ><Icon name="edit" /></button
      >
      <button
        class="icon-btn"
        title={t('wi.duplicateBook')}
        aria-label={t('wi.duplicateBook')}
        onclick={duplicateBook}><Icon name="copy" /></button
      >
      <a
        class="icon-btn"
        href={api.lorebookExportUrl(book.id)}
        download
        title={t('common.export')}
        aria-label={t('common.export')}><Icon name="download" /></a
      >
      <button class="icon-btn" title={t('wi.deleteBook')} aria-label={t('wi.deleteBook')} onclick={deleteBook}
        ><Icon name="trash" /></button
      >
    {/if}
  {/snippet}

  {#if book}
    <div class="workspace" class:detail={selected !== null}>
      <section class="list-pane" aria-label={t('wi.entries')}>
        <div class="toolbar">
          {#if library.lorebooks.length > 1}
            <select
              class="select"
              aria-label={t('wi.switchBook')}
              value={book.id}
              onchange={(e) => switchBook(e.currentTarget.value)}
            >
              {#each library.lorebooks as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
            </select>
          {/if}
          <div class="row">
            <input
              class="input"
              type="search"
              placeholder={t('wi.filter')}
              aria-label={t('wi.filter')}
              bind:value={query}
            />
            <select
              class="select sort"
              aria-label={t('wi.sort')}
              value={sort}
              onchange={(e) => setSort(e.currentTarget.value as EntrySort)}
            >
              {#each entrySorts as option (option.value)}<option value={option.value}
                  >{t(option.label)}</option
                >{/each}
            </select>
          </div>
          <div class="row">
            <label class="check all"
              ><input
                type="checkbox"
                checked={allShownChecked}
                disabled={!shown.length}
                onchange={(e) => toggleAll(e.currentTarget.checked)}
              />{t('wi.selectAll')}</label
            >
            <button class="btn" onclick={addEntry}><Icon name="plus" size={15} />{t('wi.newEntry')}</button>
          </div>
        </div>

        {#if checked.size}
          <div class="bulk" role="toolbar" aria-label={t('wi.bulkActions')}>
            <span class="faint">{t('wi.selected', { count: checked.size })}</span>
            <button class="btn ghost small" onclick={() => setEnabled(true)}>{t('wi.enable')}</button>
            <button class="btn ghost small" onclick={() => setEnabled(false)}>{t('wi.disable')}</button>
            {#if otherBooks.length}
              <select
                class="select small"
                aria-label={t('wi.moveTo')}
                value=""
                onchange={(e) => {
                  const target = e.currentTarget.value;
                  e.currentTarget.value = '';
                  if (target) transfer(target, true);
                }}
              >
                <option value="">{t('wi.moveTo')}</option>
                {#each otherBooks as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
              </select>
              <select
                class="select small"
                aria-label={t('wi.copyTo')}
                value=""
                onchange={(e) => {
                  const target = e.currentTarget.value;
                  e.currentTarget.value = '';
                  if (target) transfer(target, false);
                }}
              >
                <option value="">{t('wi.copyTo')}</option>
                {#each otherBooks as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
              </select>
            {/if}
            <button class="btn danger ghost small" onclick={deleteChecked}>{t('common.delete')}</button>
          </div>
        {/if}

        {#if shown.length}
          <ul class="entries">
            {#each shown as entry (entry.uid)}
              <li class:active={entry.uid === selectedUid} class:off={entry.disable}>
                <input
                  type="checkbox"
                  aria-label={t('wi.selectEntry', { name: entryTitle(entry) })}
                  checked={checked.has(entry.uid)}
                  onchange={(e) =>
                    e.currentTarget.checked ? checked.add(entry.uid) : checked.delete(entry.uid)}
                />
                <button class="item" onclick={() => (selectedUid = entry.uid)}>
                  <span
                    class="dot {strategyOf(entry)}"
                    title={t(
                      strategyOf(entry) === 'constant'
                        ? 'wi.strategyConstant'
                        : strategyOf(entry) === 'vectorized'
                          ? 'wi.strategyVector'
                          : 'wi.strategyKeyword',
                    )}
                  ></span>
                  <span class="title">{entryTitle(entry)}</span>
                  <span class="meta faint">{placementBadge(entry)} · {entry.order}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="faint empty">{entries.length ? t('wi.noMatches') : t('wi.noEntries')}</p>
        {/if}
      </section>

      <section class="editor-pane" aria-label={t('wi.entry')}>
        {#if selected}
          <button class="btn ghost back" onclick={() => (selectedUid = null)}
            ><Icon name="left" size={15} />{t('wi.backToList')}</button
          >
          {#key selected.uid}
            <EntryEditor
              entry={selected}
              onchange={(changes) => patch(selected.uid, changes)}
              ondelete={() => deleteEntry(selected)}
              onduplicate={() => duplicateEntry(selected)}
            />
          {/key}
        {:else}
          <p class="faint empty">{t('wi.pickEntry')}</p>
        {/if}
      </section>
    </div>
  {:else}
    <p class="faint empty">{t('common.loading')}</p>
  {/if}
</Modal>

<style>
  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) 1fr;
  }
  .list-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-inline-end: 1px solid var(--bt-line);
  }
  .toolbar {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border-bottom: 1px solid var(--bt-line);
  }
  .row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    justify-content: space-between;
  }
  .sort {
    width: auto;
    flex: none;
  }
  .all {
    font-size: var(--bt-size-sm);
  }
  .bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--bt-line);
    background: var(--bt-surface-2);
    font-size: var(--bt-size-sm);
  }
  .small {
    padding: 0.3rem 0.55rem;
    font-size: var(--bt-size-sm);
  }
  select.small {
    width: auto;
  }
  .entries {
    flex: 1;
    overflow-y: auto;
    list-style: none;
    padding: 0.35rem;
    display: grid;
    align-content: start;
    gap: 0.1rem;
  }
  .entries li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding-inline-start: 0.35rem;
    border-radius: var(--bt-radius-sm);
  }
  .entries li.active {
    background: var(--bt-surface-3);
  }
  .entries li.off .item {
    opacity: 0.5;
  }
  .entries input {
    accent-color: var(--bt-accent);
  }
  .item {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.4rem;
    border: 0;
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
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
  .dot.vectorized {
    background: var(--bt-action);
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    flex: none;
    font-size: var(--bt-size-xs);
  }
  .editor-pane {
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.25rem 1.5rem;
  }
  .back {
    display: none;
  }
  .empty {
    padding: 1.25rem;
    font-size: var(--bt-size-sm);
  }
  /* Phones and narrow windows: the list, or one entry. */
  @media (max-width: 900px) {
    .workspace {
      grid-template-columns: 1fr;
    }
    .list-pane {
      border-inline-end: 0;
    }
    .workspace.detail .list-pane,
    .workspace:not(.detail) .editor-pane {
      display: none;
    }
    .back {
      display: inline-flex;
      margin: 0 0 0.5rem -0.6rem;
    }
  }
</style>
