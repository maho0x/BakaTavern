<script lang="ts">
  import { tick } from 'svelte';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import GroupAvatar from '../../components/GroupAvatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { backgrounds } from '../../state/backgrounds.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import BackgroundPicker from './BackgroundPicker.svelte';
  import GroupMembers from '../group/GroupMembers.svelte';
  import AuthorsNote from './AuthorsNote.svelte';
  import Welcome from './Welcome.svelte';
  import Composer from './Composer.svelte';
  import MessageItem from './MessageItem.svelte';

  let scroller = $state<HTMLElement>();
  let stickToBottom = true;
  let noteOpen = $state(false);
  let chatMenuOpen = $state(false);
  let backgroundOpen = $state(false);
  const background = $derived(backgrounds.active);
  const fit = $derived(backgrounds.prefs.fit);
  const isVideo = $derived(!!background && /\.(mp4|webm)$/i.test(background.name));
  let membersOpen = $state(false);
  let importInput = $state<HTMLInputElement>();

  // Once the reply is stored it shows as a regular message; the streamed copy goes away.
  const generation = $derived(chat.generation?.stored ? null : chat.generation);
  const streamTarget = $derived.by(() => {
    const target = generation?.target;
    if (!target || target.kind === 'new' || target.kind === 'impersonate') return null;
    return target.messageId;
  });

  function onScroll() {
    if (!scroller) return;
    stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }

  $effect(() => {
    // Follow new messages and streamed text while the reader is at the bottom.
    void chat.messages.length;
    void generation?.text;
    void generation?.reasoning;
    void chat.chat?.id;
    if (!stickToBottom) return;
    void tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }));
  });

  $effect(() => {
    void chat.chat?.id;
    stickToBottom = true;
  });

  // A search result: its message comes into view and is marked for a moment.
  $effect(() => {
    const target = ui.jumpTo;
    if (!target || chat.chat?.id !== target.chatId || chat.messages.length <= target.seq) return;
    stickToBottom = false;
    void tick().then(() => {
      const element = scroller?.querySelector<HTMLElement>(`article.message[data-index="${target.seq}"]`);
      element?.scrollIntoView({ block: 'center' });
      element?.classList.add('found');
      setTimeout(() => element?.classList.remove('found'), 2500);
      ui.jumpTo = null;
    });
  });

  async function guarded(action: () => Promise<unknown>) {
    chatMenuOpen = false;
    try {
      await action();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function rename() {
    const title = prompt(t('chat.renamePrompt'), chat.chat?.title)?.trim();
    if (title) await guarded(() => chat.renameChat(title));
  }

  /** The chat this one was branched from (SillyTavern `chat_metadata.main_chat`). */
  const mainChat = $derived.by(() => {
    const name = (chat.chat?.metadata as { main_chat?: unknown } | undefined)?.main_chat;
    return typeof name === 'string' && chat.chats.some((c) => c.title === name) ? name : null;
  });

  async function checkpoint() {
    const last = chat.messages.length - 1;
    if (last < 0) return;
    const suggested = chat.checkpointTitle();
    const name = prompt(t('chat.checkpointPrompt'), suggested);
    if (name !== null) await guarded(() => chat.checkpoint(last, name.trim() || suggested));
  }

  async function remove() {
    if (chat.chat && confirm(t('chat.deleteConfirm'))) await guarded(() => chat.deleteChat(chat.chat!.id));
  }

  async function importChat(files: FileList | null) {
    const file = files?.[0];
    const owner = chat.groupId
      ? { groupId: chat.groupId }
      : chat.characterId
        ? { characterId: chat.characterId }
        : null;
    if (!file || !owner) return;
    await guarded(async () => {
      const imported = await api.importChat(file, owner);
      chat.chats.unshift(imported);
      await chat.openChat(imported.id);
    });
    if (importInput) importInput.value = '';
  }
</script>

{#snippet chatSelect(className: string)}
  <select
    class={className}
    aria-label={t('chat.chats')}
    value={chat.chat?.id}
    onchange={(e) => guarded(() => chat.openChat(e.currentTarget.value))}
  >
    {#each chat.chats as item (item.id)}
      <option value={item.id}>{item.title}</option>
    {/each}
  </select>
{/snippet}

<section
  class="pane"
  class:with-bg={!!background}
  aria-label={t('chat.region')}
  style:--bt-chat-bg={background && !isVideo ? `url("${background.url}")` : undefined}
  data-fit={fit}
>
  {#if background && isVideo}
    <video class="bg-video" src={background.url} autoplay muted loop playsinline></video>
  {/if}
  {#if !chat.character && !chat.group}
    <Welcome />
  {:else}
    <header class="bar">
      {#if ui.narrow}
        <button class="icon-btn" aria-label={t('library.title')} onclick={() => (ui.libraryOpen = true)}
          ><Icon name="menu" /></button
        >
      {/if}
      {#if chat.group}
        <button class="who" onclick={() => (ui.editingGroupId = chat.groupId)} title={t('group.edit')}>
          <GroupAvatar group={chat.group} width={28} round />
          <span class="who-name">{chat.group.name}</span>
        </button>
      {:else if chat.character}
        <button class="who" onclick={() => (ui.editingCharacterId = chat.characterId)} title={t('char.edit')}>
          <Avatar hash={chat.character.avatar} name={chat.character.name} width={28} round />
          <span class="who-name">{chat.character.name}</span>
        </button>
      {/if}
      {#if ui.narrow}
        <!-- On phones the chat list is an icon; tapping it opens the native picker on top. -->
        <label class="icon-btn picker" title={t('chat.chats')}>
          <Icon name="chats" />
          {@render chatSelect('overlay')}
        </label>
      {:else}
        {@render chatSelect('select chats')}
      {/if}
      <div class="bar-actions">
        {#if chat.group}
          <div class="menu-wrap">
            <button
              class="icon-btn"
              class:on={chat.autoMode}
              title={t('group.members')}
              aria-label={t('group.members')}
              aria-expanded={membersOpen}
              onclick={() => {
                membersOpen = !membersOpen;
                chatMenuOpen = false;
              }}><Icon name="users" /></button
            >
            {#if membersOpen}<GroupMembers onclose={() => (membersOpen = false)} />{/if}
          </div>
        {/if}
        <button
          class="icon-btn"
          title={t('chat.newChat')}
          aria-label={t('chat.newChat')}
          onclick={() => guarded(() => chat.newChat())}><Icon name="plus" /></button
        >
        <button
          class="icon-btn"
          title={t('chat.authorsNote')}
          aria-label={t('chat.authorsNote')}
          onclick={() => (noteOpen = true)}><Icon name="note" /></button
        >
        <div class="menu-wrap">
          <button
            class="icon-btn"
            aria-label={t('chat.menu')}
            aria-expanded={chatMenuOpen}
            onclick={() => (chatMenuOpen = !chatMenuOpen)}><Icon name="more" /></button
          >
          {#if chatMenuOpen}
            <div class="menu" role="menu">
              {#if mainChat}
                <button role="menuitem" onclick={() => guarded(() => chat.openChatByTitle(mainChat!))}
                  ><Icon name="back" size={15} />{t('chat.backToMain')}</button
                >
              {/if}
              <button role="menuitem" onclick={checkpoint} disabled={!chat.messages.length}
                ><Icon name="flag" size={15} />{t('chat.checkpoint')}</button
              >
              <button role="menuitem" onclick={rename}
                ><Icon name="edit" size={15} />{t('chat.rename')}</button
              >
              <a
                role="menuitem"
                href={chat.chat ? api.chatExportUrl(chat.chat.id) : undefined}
                download
                onclick={() => (chatMenuOpen = false)}
              >
                <Icon name="download" size={15} />{t('chat.exportJsonl')}
              </a>
              <a
                role="menuitem"
                href={chat.chat ? api.chatExportUrl(chat.chat.id, 'txt') : undefined}
                download
                onclick={() => (chatMenuOpen = false)}
              >
                <Icon name="download" size={15} />{t('chat.exportTxt')}
              </a>
              <button role="menuitem" onclick={() => importInput?.click()}
                ><Icon name="upload" size={15} />{t('chat.import')}</button
              >
              <button
                role="menuitem"
                onclick={() => {
                  chatMenuOpen = false;
                  backgroundOpen = true;
                }}><Icon name="image" size={15} />{t('bg.title')}</button
              >
              <button role="menuitem" class="danger" onclick={remove}
                ><Icon name="trash" size={15} />{t('chat.delete')}</button
              >
            </div>
          {/if}
        </div>
        {#if ui.narrow}
          <button
            class="icon-btn"
            aria-label={t('panel.connection')}
            onclick={() => ui.togglePanel('connection')}><Icon name="sliders" /></button
          >
        {/if}
      </div>
      <input
        bind:this={importInput}
        type="file"
        accept=".jsonl"
        hidden
        onchange={(e) => importChat(e.currentTarget.files)}
      />
    </header>

    <div class="scroller" bind:this={scroller} onscroll={onScroll}>
      <div class="column">
        {#each chat.messages as message, index (message.id)}
          <MessageItem
            {message}
            {index}
            isLast={index === chat.messages.length - 1}
            streaming={streamTarget === message.id && generation
              ? { text: generation.text, reasoning: generation.reasoning }
              : null}
          />
        {/each}
        {#if generation?.target.kind === 'new'}
          <MessageItem
            message={null}
            index={chat.messages.length}
            streaming={{ text: generation.text, reasoning: generation.reasoning }}
          />
        {/if}
      </div>
    </div>

    <Composer />
    <AuthorsNote open={noteOpen} onclose={() => (noteOpen = false)} />
    {#if backgroundOpen}<BackgroundPicker open onclose={() => (backgroundOpen = false)} />{/if}
    {#if ui.promptOf}
      {#await import('./PromptViewer.svelte') then { default: PromptViewer }}<PromptViewer />{/await}
    {/if}
  {/if}
</section>

<style>
  .pane {
    position: relative;
    isolation: isolate;
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  /* A background picture behind the chat, washed with the page color so text stays readable. */
  .pane.with-bg {
    background:
      linear-gradient(
        color-mix(in oklch, var(--bt-bg) var(--bt-chat-bg-wash, 55%), transparent),
        color-mix(in oklch, var(--bt-bg) var(--bt-chat-bg-wash, 55%), transparent)
      ),
      var(--bt-chat-bg, none) center / cover no-repeat;
  }
  .pane.with-bg[data-fit='contain'] {
    background-size: auto, contain;
  }
  .pane.with-bg[data-fit='stretch'] {
    background-size:
      auto,
      100% 100%;
  }
  .pane.with-bg[data-fit='center'] {
    background-size: auto, auto;
  }
  .bg-video {
    position: absolute;
    inset: 0;
    z-index: -1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.45;
  }
  .picker {
    position: relative;
    flex: none;
  }
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    padding-top: calc(0.5rem + env(safe-area-inset-top));
    border-bottom: 1px solid var(--bt-line);
    min-width: 0;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
    padding: 0.2rem 0.45rem 0.2rem 0.2rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
  }
  .who:hover {
    background: var(--bt-surface-2);
  }
  .who-name {
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chats {
    width: auto;
    min-width: 0;
    max-width: 22rem;
    flex: 0 1 auto;
    padding: 0.3rem 0.5rem;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-muted);
    background: transparent;
  }
  .bar-actions {
    display: flex;
    align-items: center;
    margin-inline-start: auto;
  }
  .menu-wrap {
    position: relative;
  }
  .menu {
    position: absolute;
    inset-inline-end: 0;
    top: 2.5rem;
    z-index: 10;
    display: grid;
    min-width: 13rem;
    padding: 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface-2);
    box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
  }
  .menu button,
  .menu a {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.5rem 0.6rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    color: var(--bt-ink);
    font-size: var(--bt-size-sm);
    text-align: start;
    text-decoration: none;
  }
  .menu button:hover,
  .menu a:hover {
    background: var(--bt-surface-3);
  }
  .menu .danger {
    color: var(--bt-danger);
  }
  .on {
    color: var(--bt-accent);
  }
  .scroller {
    overflow-y: auto;
    min-height: 0;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .column {
    max-width: var(--bt-chat-width);
    margin: 0 auto;
    padding: 0.5rem var(--bt-gutter) 1.5rem;
  }
</style>
