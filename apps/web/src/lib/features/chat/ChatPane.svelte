<script lang="ts">
  import { tick } from 'svelte';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import AuthorsNote from './AuthorsNote.svelte';
  import Welcome from './Welcome.svelte';
  import Composer from './Composer.svelte';
  import MessageItem from './MessageItem.svelte';

  let scroller = $state<HTMLElement>();
  let stickToBottom = true;
  let noteOpen = $state(false);
  let chatMenuOpen = $state(false);
  let importInput = $state<HTMLInputElement>();

  const generation = $derived(chat.generation);
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

  async function remove() {
    if (chat.chat && confirm(t('chat.deleteConfirm'))) await guarded(() => chat.deleteChat(chat.chat!.id));
  }

  async function importChat(files: FileList | null) {
    const file = files?.[0];
    if (!file || !chat.characterId) return;
    await guarded(async () => {
      const imported = await api.importChat(file, chat.characterId!);
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

<section class="pane" aria-label={t('chat.region')}>
  {#if !chat.character}
    <Welcome />
  {:else}
    <header class="bar">
      {#if ui.narrow}
        <button class="icon-btn" aria-label={t('library.title')} onclick={() => (ui.libraryOpen = true)}
          ><Icon name="menu" /></button
        >
      {/if}
      <button class="who" onclick={() => (ui.editingCharacterId = chat.characterId)} title={t('char.edit')}>
        <Avatar hash={chat.character.avatar} name={chat.character.name} width={28} round />
        <span class="who-name">{chat.character.name}</span>
      </button>
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
  {/if}
</section>

<style>
  .pane {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-width: 0;
    min-height: 0;
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
