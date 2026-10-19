<script lang="ts">
  import type { Chat } from '@bakatavern/api-client';
  import { onMount } from 'svelte';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import GroupAvatar from '../../components/GroupAvatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { i18n, t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { ui } from '../../state/ui.svelte.ts';
  import { createCharacter, importCharacterFiles } from '../library/actions.ts';

  let fileInput = $state<HTMLInputElement>();
  let importing = $state(false);
  const empty = $derived(library.characters.length === 0);

  /** Chats to pick up again (SillyTavern's welcome screen), and the favorites to start one with. */
  const recent = $derived(
    chat.recent
      .filter((c) => (c.groupId ? library.group(c.groupId) : library.character(c.characterId)))
      .slice(0, 6),
  );
  const favorites = $derived([
    ...library.characters.filter((c) => c.fav).map((item) => ({ kind: 'character' as const, item })),
    ...library.groups.filter((g) => g.fav).map((item) => ({ kind: 'group' as const, item })),
  ]);

  onMount(async () => {
    try {
      chat.recent = await api.recentChats(12);
    } catch {
      // the list from startup stays
    }
  });

  function ownerName(c: Chat) {
    return c.groupId
      ? (library.group(c.groupId)?.name ?? '')
      : (library.character(c.characterId)?.name ?? '');
  }

  function when(at: number | null) {
    if (!at) return '';
    return new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
  }

  function open(c: Chat) {
    if (c.groupId) void chat.openGroup(c.groupId, c.id);
    else if (c.characterId) void chat.openCharacter(c.characterId, c.id);
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

<div class="welcome">
  <p class="lead">{empty ? t('welcome.empty') : t('chat.noCharacter')}</p>
  <div class="actions">
    {#if empty}
      <button class="btn primary" disabled={importing} onclick={() => fileInput?.click()}>
        <Icon name="upload" size={16} />{t('library.import')}
      </button>
      <button class="btn" onclick={createCharacter}><Icon name="plus" size={16} />{t('library.new')}</button>
    {:else if ui.narrow}
      <button class="btn primary" onclick={() => (ui.libraryOpen = true)}>
        <Icon name="library" size={16} />{t('library.title')}
      </button>
    {/if}
    {#if ui.narrow}
      <button class="btn ghost" onclick={() => (ui.panel = 'connection')}>
        <Icon name="plug" size={16} />{t('panel.connection')}
      </button>
    {/if}
  </div>
  {#if recent.length}
    <section class="recent" aria-label={t('welcome.recent')}>
      <h2>{t('welcome.recent')}</h2>
      <ul>
        {#each recent as item (item.id)}
          <li>
            <button class="chat" onclick={() => open(item)}>
              {#if item.groupId}
                <GroupAvatar group={library.group(item.groupId)!} width={36} />
              {:else}
                <Avatar
                  hash={library.character(item.characterId)?.avatar}
                  name={ownerName(item)}
                  width={36}
                />
              {/if}
              <span class="text">
                <span class="who"
                  >{ownerName(item)} <small>{when(item.lastMessageAt ?? item.updatedAt)}</small></span
                >
                <span class="preview">{item.preview || item.title}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if favorites.length}
    <section class="favorites" aria-label={t('welcome.favorites')}>
      <h2>{t('welcome.favorites')}</h2>
      <div class="row">
        {#each favorites as entry (entry.item.id)}
          <button
            class="fav"
            title={entry.item.name}
            onclick={() =>
              entry.kind === 'group'
                ? void chat.openGroup(entry.item.id)
                : void chat.openCharacter(entry.item.id)}
          >
            {#if entry.kind === 'group'}
              <GroupAvatar group={entry.item} width={48} />
            {:else}
              <Avatar hash={entry.item.avatar} name={entry.item.name} width={48} />
            {/if}
            <span>{entry.item.name}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept=".png,.json,.charx,application/json,image/png"
    multiple
    hidden
    onchange={(e) => importFiles(e.currentTarget.files)}
  />
</div>

<style>
  .welcome {
    grid-row: 1 / -1;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1.25rem;
    padding: 2rem var(--bt-gutter);
    text-align: center;
  }
  .lead {
    max-width: 24ch;
    font-family: var(--bt-font-prose);
    font-size: var(--bt-size-lg);
    color: var(--bt-ink-muted);
    text-wrap: balance;
  }
  h2 {
    font-size: var(--bt-size-sm);
    font-weight: 650;
    color: var(--bt-ink-muted);
    text-align: left;
    margin-bottom: 0.4rem;
  }
  .recent,
  .favorites {
    width: min(32rem, 100%);
  }
  .recent ul {
    list-style: none;
    display: grid;
    gap: 0.3rem;
  }
  .chat {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface);
    color: var(--bt-ink);
    text-align: left;
  }
  .chat:hover,
  .fav:hover {
    border-color: var(--bt-accent);
  }
  .text {
    display: grid;
    min-width: 0;
  }
  .who {
    font-weight: 600;
    font-size: var(--bt-size-sm);
  }
  .who small {
    font-weight: 400;
    color: var(--bt-ink-faint);
  }
  .preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .favorites .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .fav {
    display: grid;
    justify-items: center;
    gap: 0.25rem;
    width: 5.5rem;
    padding: 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--bt-radius-sm);
    background: none;
    color: var(--bt-ink);
    font-size: var(--bt-size-xs);
  }
  .fav span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }
</style>
