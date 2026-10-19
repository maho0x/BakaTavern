<script lang="ts">
  import type { CharacterSummary, Group } from '@bakatavern/api-client';

  import Avatar from '../../components/Avatar.svelte';
  import GroupAvatar from '../../components/GroupAvatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import {
    addTag,
    createCharacter,
    deleteCharacters,
    deleteGroups,
    excerptText,
    importCharacterFiles,
    removeTag,
    setFavorite,
    type LibraryEntry,
  } from './actions.ts';
  import TagManager from './TagManager.svelte';

  let query = $state('');
  let sort = $state<'name' | 'recent'>('recent');
  let fileInput = $state<HTMLInputElement>();
  let importing = $state(false);
  /** The tag folder open (SillyTavern's folder tags), if any. */
  let folder = $state<string | null>(null);
  /** Choosing several entries to change together. */
  let selecting = $state(false);
  let selected = $state<string[]>([]);
  let tagsOpen = $state(false);
  let bulkTag = $state('');

  type Entry = { kind: 'character'; item: CharacterSummary } | { kind: 'group'; item: Group };

  const tagNames = $derived(new Map(library.tags.map((tag) => [tag.id, tag.name.toLowerCase()])));
  const memberNames = (group: Group) =>
    group.members.map((m) => library.character(m.characterId)?.name ?? '').filter(Boolean);
  /** Tags shown as folders; a closed folder's members show only inside it. */
  const folders = $derived(
    library.tags
      .filter((tag) => tag.folder === 'open' || tag.folder === 'closed')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );
  const closedFolders = $derived(new Set(folders.filter((f) => f.folder === 'closed').map((f) => f.id)));
  const openFolder = $derived(folders.find((f) => f.id === folder) ?? null);
  const folderSize = (id: string) =>
    library.characters.filter((c) => c.tags.includes(id)).length +
    library.groups.filter((g) => g.tags.includes(id)).length;

  // Groups are listed with the characters, as in SillyTavern.
  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    // Inside a folder: its members; outside: all but the members of closed folders (unless searching).
    const inPlace = (tags: string[]) =>
      openFolder ? tags.includes(openFolder.id) : q || !tags.some((id) => closedFolders.has(id));
    const tagged = (tags: string[]) => tags.some((id) => tagNames.get(id)?.includes(q));
    const entries: Entry[] = [
      ...library.characters
        .filter(
          (c) =>
            inPlace(c.tags) &&
            (!q || c.name.toLowerCase().includes(q) || c.creator.toLowerCase().includes(q) || tagged(c.tags)),
        )
        .map((item) => ({ kind: 'character' as const, item })),
      ...library.groups
        .filter(
          (g) =>
            inPlace(g.tags) &&
            (!q ||
              g.name.toLowerCase().includes(q) ||
              memberNames(g).some((n) => n.toLowerCase().includes(q)) ||
              tagged(g.tags)),
        )
        .map((item) => ({ kind: 'group' as const, item })),
    ];
    return entries.toSorted(({ item: a }, { item: b }) => {
      if (a.fav !== b.fav) return a.fav ? -1 : 1;
      if (sort === 'recent') return (b.lastChatAt ?? b.createdAt) - (a.lastChatAt ?? a.createdAt);
      return a.name.localeCompare(b.name);
    });
  });

  const selectedEntries = (): LibraryEntry[] =>
    visible.filter((e) => selected.includes(e.item.id)).map((e) => ({ kind: e.kind, id: e.item.id }));

  function toggle(id: string) {
    selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
  }

  function stopSelecting() {
    selecting = false;
    selected = [];
    bulkTag = '';
  }

  async function bulk(action: (entries: LibraryEntry[]) => Promise<void>) {
    const entries = selectedEntries();
    if (!entries.length) return;
    try {
      await action(entries);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function bulkDelete() {
    const entries = selectedEntries();
    if (!entries.length || !confirm(t('library.deleteSelected', { count: entries.length }))) return;
    await bulk(async () => {
      await deleteCharacters(entries.filter((e) => e.kind === 'character').map((e) => e.id));
      await deleteGroups(entries.filter((e) => e.kind === 'group').map((e) => e.id));
      stopSelecting();
    });
  }

  async function importFiles(files: FileList | null) {
    importing = true;
    try {
      await importCharacterFiles(files);
    } finally {
      importing = false;
      if (fileInput) fileInput.value = '';
    }
  }
</script>

<nav class="rail" aria-label={t('library.title')}>
  <header>
    <h1 class="brand">
      <button
        class="home"
        title={t('welcome.home')}
        onclick={() => {
          if (chat.busy) return;
          chat.close();
          if (ui.narrow) ui.libraryOpen = false;
        }}>BakaTavern</button
      >
    </h1>
    <div class="actions">
      <button
        class="icon-btn"
        title={t('library.import')}
        aria-label={t('library.import')}
        disabled={importing}
        onclick={() => fileInput?.click()}
      >
        <Icon name="upload" />
      </button>
      <button
        class="icon-btn"
        title={t('library.urlTitle')}
        aria-label={t('library.urlTitle')}
        onclick={() => (ui.urlImportOpen = true)}
      >
        <Icon name="link" />
      </button>
      <button
        class="icon-btn"
        title={t('library.newGroup')}
        aria-label={t('library.newGroup')}
        disabled={library.characters.length === 0}
        onclick={() => (ui.editingGroupId = 'new')}
      >
        <Icon name="users" />
      </button>
      <button
        class="icon-btn"
        title={t('library.new')}
        aria-label={t('library.new')}
        onclick={createCharacter}
      >
        <Icon name="plus" />
      </button>
    </div>
    <input
      bind:this={fileInput}
      type="file"
      accept=".png,.json,.charx,application/json,image/png"
      multiple
      hidden
      onchange={(e) => importFiles(e.currentTarget.files)}
    />
  </header>

  <div class="tools">
    <div class="search">
      <Icon name="search" size={16} />
      <input
        class="input"
        type="search"
        placeholder={t('library.search')}
        bind:value={query}
        aria-label={t('library.search')}
      />
    </div>
    <div class="filters">
      <select class="select sort" bind:value={sort} aria-label={t('library.sort')}>
        <option value="recent">{t('library.sortRecent')}</option>
        <option value="name">{t('library.sortName')}</option>
      </select>
      <span class="spacer"></span>
      <button
        class="icon-btn small"
        title={t('search.title')}
        aria-label={t('search.title')}
        onclick={() => (ui.searchOpen = true)}><Icon name="chats" size={16} /></button
      >
      <button
        class="icon-btn small"
        title={t('tags.title')}
        aria-label={t('tags.title')}
        onclick={() => (tagsOpen = true)}><Icon name="tag" size={16} /></button
      >
      <button
        class="icon-btn small"
        title={t('library.select')}
        aria-label={t('library.select')}
        aria-pressed={selecting}
        onclick={() => (selecting ? stopSelecting() : (selecting = true))}
        ><Icon name="check" size={16} /></button
      >
    </div>

    {#if selecting}
      <div class="bulk" role="toolbar" aria-label={t('library.selection')}>
        <span class="count">{t('library.selectedCount', { count: selected.length })}</span>
        <button
          class="btn small"
          disabled={!selected.length}
          onclick={() => bulk((e) => setFavorite(e, true))}
          ><Icon name="star" size={14} />{t('library.favoriteSelected')}</button
        >
        <button
          class="btn small"
          disabled={!selected.length}
          onclick={() => bulk((e) => setFavorite(e, false))}>{t('library.unfavoriteSelected')}</button
        >
        <form
          class="tag-form"
          onsubmit={(e) => {
            e.preventDefault();
            const name = bulkTag;
            void bulk((entries) => addTag(entries, name)).then(() => (bulkTag = ''));
          }}
        >
          <input
            class="input small"
            list="library-tags"
            placeholder={t('library.tagName')}
            aria-label={t('library.tagName')}
            bind:value={bulkTag}
          />
          <button class="btn small" type="submit" disabled={!selected.length || !bulkTag.trim()}
            >{t('library.addTag')}</button
          >
          <button
            class="btn small"
            type="button"
            disabled={!selected.length || !library.tags.some((tag) => tag.name === bulkTag.trim())}
            onclick={() => {
              const tag = library.tags.find((x) => x.name === bulkTag.trim());
              if (tag) void bulk((entries) => removeTag(entries, tag.id));
            }}>{t('library.removeTag')}</button
          >
          <datalist id="library-tags">
            {#each library.tags as tag (tag.id)}<option value={tag.name}></option>{/each}
          </datalist>
        </form>
        <button class="btn small danger" disabled={!selected.length} onclick={bulkDelete}
          ><Icon name="trash" size={14} />{t('common.delete')}</button
        >
      </div>
    {/if}
  </div>

  {#if library.characters.length === 0}
    <p class="empty">{t('library.empty')}</p>
  {:else}
    <ul class="list">
      {#if openFolder}
        <li>
          <button class="row folder" onclick={() => (folder = null)}>
            <span class="folder-icon"><Icon name="left" size={18} /></span>
            <span class="text"><span class="name">{openFolder.name}</span></span>
          </button>
        </li>
      {:else if !query.trim()}
        {#each folders as tag (tag.id)}
          <li>
            <button class="row folder" onclick={() => (folder = tag.id)} style:--tag-color={tag.color}>
              <span class="folder-icon"><Icon name="folder" size={18} /></span>
              <span class="text">
                <span class="name">{tag.name}</span>
                <span class="excerpt">{t('library.folderCount', { count: folderSize(tag.id) })}</span>
              </span>
            </button>
          </li>
        {/each}
      {/if}
      {#each visible as entry (entry.item.id)}
        {@const active =
          entry.kind === 'group' ? chat.groupId === entry.item.id : chat.characterId === entry.item.id}
        <li>
          <button
            class="row"
            class:active
            class:chosen={selecting && selected.includes(entry.item.id)}
            onclick={() =>
              selecting
                ? toggle(entry.item.id)
                : entry.kind === 'group'
                  ? chat.openGroup(entry.item.id)
                  : chat.openCharacter(entry.item.id)}
            aria-current={active ? 'true' : undefined}
            aria-pressed={selecting ? selected.includes(entry.item.id) : undefined}
          >
            {#if entry.kind === 'group'}
              <GroupAvatar group={entry.item} width={36} />
            {:else}
              <Avatar hash={entry.item.avatar} name={entry.item.name} width={36} />
            {/if}
            <span class="text">
              <span class="name">
                {#if entry.kind === 'group'}<span class="faint"><Icon name="users" size={13} /></span>{/if}
                {entry.item.name}
                {#if entry.item.fav}<span class="fav"
                    ><Icon name="star" size={12} label={t('library.favorite')} /></span
                  >{/if}
              </span>
              <span class="excerpt"
                >{entry.kind === 'group'
                  ? memberNames(entry.item).join(', ')
                  : excerptText(entry.item.excerpt, entry.item.name) || entry.item.creator}</span
              >
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

{#if tagsOpen}<TagManager open onclose={() => (tagsOpen = false)} />{/if}

<style>
  .rail {
    display: grid;
    grid-template-rows: auto auto 1fr;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--bt-surface);
    border-inline-end: 1px solid var(--bt-line);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 0.6rem 0.4rem 1rem;
  }
  .brand {
    font-family: var(--bt-font-prose);
    font-size: 1.2rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--bt-dialogue);
  }
  .home {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }
  .actions {
    display: flex;
    gap: 0.15rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.25rem 0.75rem 0.3rem;
    color: var(--bt-ink-faint);
  }
  .filters {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    margin: 0 0.6rem 0.4rem 0.75rem;
  }
  .spacer {
    flex: 1;
  }
  .search .input {
    flex: 1;
    min-width: 0;
    padding-block: 0.35rem;
  }
  .sort {
    width: auto;
    padding: 0.35rem 0.4rem;
    font-size: var(--bt-size-xs);
  }
  .list {
    list-style: none;
    padding: 0 0.4rem 1rem;
    overflow-y: auto;
    min-height: 0;
  }
  .list li {
    content-visibility: auto;
    contain-intrinsic-size: auto 66px;
  }
  .row {
    display: flex;
    gap: 0.7rem;
    align-items: center;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
  }
  .row:hover {
    background: var(--bt-surface-2);
  }
  .row.chosen {
    background: color-mix(in oklch, var(--bt-accent) 22%, var(--bt-surface));
  }
  .folder-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: var(--bt-radius-sm);
    color: var(--tag-color, var(--bt-ink-muted));
    background: var(--bt-surface-2);
  }
  .bulk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.6rem 0.5rem 1rem;
  }
  .bulk .count {
    flex-basis: 100%;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .bulk .btn {
    padding: 0.25rem 0.55rem;
    font-size: var(--bt-size-xs);
  }
  .tag-form {
    display: flex;
    gap: 0.3rem;
    flex-basis: 100%;
  }
  .tag-form .input {
    flex: 1;
    min-width: 0;
    padding: 0.3rem 0.5rem;
    font-size: var(--bt-size-sm);
  }
  .row.active {
    background: var(--bt-surface-3);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-weight: 600;
    font-size: var(--bt-size-md);
  }
  .fav {
    color: var(--bt-dialogue);
  }
  .excerpt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .empty {
    padding: 1rem 1.25rem;
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-sm);
  }
</style>
