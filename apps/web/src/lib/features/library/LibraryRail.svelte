<script lang="ts">
  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { createCharacter, excerptText, importCharacterFiles } from './actions.ts';

  let query = $state('');
  let sort = $state<'name' | 'recent'>('recent');
  let fileInput = $state<HTMLInputElement>();
  let importing = $state(false);

  const tagNames = $derived(new Map(library.tags.map((tag) => [tag.id, tag.name.toLowerCase()])));
  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = library.characters.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.creator.toLowerCase().includes(q) ||
        c.tags.some((id) => tagNames.get(id)?.includes(q)),
    );
    return list.toSorted((a, b) => {
      if (a.fav !== b.fav) return a.fav ? -1 : 1;
      if (sort === 'recent') return (b.lastChatAt ?? b.createdAt) - (a.lastChatAt ?? a.createdAt);
      return a.name.localeCompare(b.name);
    });
  });

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
    <h1 class="brand">BakaTavern</h1>
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

  <div class="search">
    <Icon name="search" size={16} />
    <input
      class="input"
      type="search"
      placeholder={t('library.search')}
      bind:value={query}
      aria-label={t('library.search')}
    />
    <select class="select sort" bind:value={sort} aria-label={t('library.sort')}>
      <option value="recent">{t('library.sortRecent')}</option>
      <option value="name">{t('library.sortName')}</option>
    </select>
  </div>

  {#if library.characters.length === 0}
    <p class="empty">{t('library.empty')}</p>
  {:else}
    <ul class="list">
      {#each visible as character (character.id)}
        <li>
          <button
            class="row"
            class:active={chat.characterId === character.id}
            onclick={() => chat.openCharacter(character.id)}
            aria-current={chat.characterId === character.id ? 'true' : undefined}
          >
            <Avatar hash={character.avatar} name={character.name} width={36} />
            <span class="text">
              <span class="name">
                {character.name}
                {#if character.fav}<span class="fav"
                    ><Icon name="star" size={12} label={t('library.favorite')} /></span
                  >{/if}
              </span>
              <span class="excerpt"
                >{excerptText(character.excerpt, character.name) || character.creator}</span
              >
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  .rail {
    display: grid;
    grid-template-rows: auto auto 1fr;
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
  .actions {
    display: flex;
    gap: 0.15rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.25rem 0.75rem 0.5rem;
    color: var(--bt-ink-faint);
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
