<script lang="ts">
  import type { Message } from '@bakatavern/api-client';
  import { messageAttachments, RegexPlacement } from '@bakatavern/core';
  import { splitFrontend } from '@bakatavern/th-bridge';

  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { activeConnection } from '../../generation/pipeline.ts';
  import { tokenizerFor } from '../../generation/tokenizers.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { pluginExtensions } from '../../plugins/extensions.svelte.ts';
  import { renderMessage } from '../../render/markdown.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { uiDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import FrontendFrame from '../../th/FrontendFrame.svelte';
  import { helperScripts } from '../../th/scripts.svelte.ts';
  import { copyText } from '../../util/clipboard.ts';

  interface Props {
    message: Message | null;
    index: number;
    /** Text being streamed into this message (new reply, swipe or continuation). */
    streaming?: { text: string; reasoning: string } | null;
    isLast?: boolean;
  }
  let { message, index, streaming = null, isLast = false }: Props = $props();

  const prefs = $derived(settings.get('ui', uiDefaults));
  const role = $derived(message?.role ?? 'assistant');
  // A new reply being written in a group belongs to the member replying.
  const speaker = $derived(message ? undefined : chat.generation?.speaker);
  const name = $derived(message?.name ?? speaker?.name ?? chat.character?.name ?? '');
  const swipe = $derived(message ? message.swipes[message.swipeId] : undefined);
  const baseText = $derived(swipe?.content ?? '');
  const extra = $derived((swipe?.info.extra as Record<string, unknown> | undefined) ?? message?.extra ?? {});
  const text = $derived.by(() => {
    if (!streaming) return baseText;
    if (chat.generation?.target.kind === 'continue') return baseText + streaming.text;
    return streaming.text;
  });
  const reasoning = $derived(streaming ? streaming.reasoning : String(extra.reasoning ?? ''));

  // Token counts by the tokenizer of the connection in use, counted in the tokenizer worker.
  let tokenCount = $state<number | null>(null);
  $effect(() => {
    tokenCount = null;
    const connection = prefs.showTokenCounts && message && !streaming ? activeConnection() : null;
    if (!connection) return;
    let current = true;
    Promise.resolve(tokenizerFor(connection).count(baseText))
      .then((count) => {
        if (current) tokenCount = count;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
  const reasoningSeconds = $derived(Math.max(1, Math.round(Number(extra.reasoning_duration ?? 0) / 1000)));
  // Display-only regex scripts, as SillyTavern formats messages: by placement and depth.
  const placement = $derived(
    role === 'user'
      ? RegexPlacement.USER_INPUT
      : (message?.extra as { type?: string } | undefined)?.type === 'narrator'
        ? RegexPlacement.SLASH_COMMAND
        : RegexPlacement.AI_OUTPUT,
  );
  const depth = $derived(message ? chat.regexDepths.get(message.id) : 0);
  const shownText = $derived(
    chat.applyRegex(text, placement, { characterOverride: name, isMarkdown: true, depth }),
  );
  const shownReasoning = $derived(
    chat.applyRegex(reasoning, RegexPlacement.REASONING, { isMarkdown: true, depth }),
  );
  /** A record of tool calls (SillyTavern `extra.isSmallSys`): our own HTML, shown small. */
  const smallSys = $derived(Boolean((message?.extra as { isSmallSys?: unknown } | undefined)?.isSmallSys));
  /**
   * Front-end code blocks become pages once the message is written (TavernHelper's rendering),
   * after scripts have handled its arrival.
   */
  const parts = $derived.by(() => {
    const pages = message && !streaming && helperScripts.prefs.enabled;
    const waiting = !!message && chat.receiving === message.id;
    const split = pages ? splitFrontend(shownText) : [{ kind: 'text' as const, text: shownText }];
    let page = 0;
    type Part = { kind: 'frontend'; code: string; page: number } | { kind: 'text'; html: string };
    return split.flatMap((part): Part[] => {
      if (part.kind === 'frontend') {
        return waiting ? [] : [{ kind: 'frontend' as const, code: part.code, page: page++ }];
      }
      const html = renderMessage(part.text, {
        html: prefs.renderHtml || smallSys,
        externalMedia: prefs.externalMedia,
      });
      return [{ kind: 'text' as const, html }];
    });
  });
  const reasoningHtml = $derived(renderMessage(shownReasoning, { html: false, externalMedia: false }));
  const avatarHash = $derived.by(() => {
    if (role === 'assistant') {
      if (message?.characterId) return library.character(message.characterId)?.avatar ?? null;
      if (speaker) return speaker.avatar;
      // Older group messages without a recorded author: by name.
      if (chat.group) return chat.members.find((m) => m.name === name)?.avatar ?? null;
      return chat.character?.avatar ?? null;
    }
    if (role === 'user')
      return (library.personas.find((p) => p.name === name) ?? chat.persona)?.avatar ?? null;
    return null;
  });
  const showSwipes = $derived(!!message && isLast && role === 'assistant' && !chat.busy);
  const time = $derived(message ? new Date(message.createdAt).toLocaleString() : '');

  let editing = $state(false);
  let draft = $state('');
  let menuOpen = $state(false);
  /** The menu opens upwards when there is no room for it below. */
  let menuUp = $state(false);
  function toggleMenu(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menuUp = rect.bottom + 340 > window.innerHeight && rect.top > 340;
    menuOpen = !menuOpen;
  }

  function startEdit() {
    draft = baseText;
    editing = true;
    menuOpen = false;
  }

  async function saveEdit() {
    if (!message) return;
    try {
      await chat.editMessage(message.id, draft);
      editing = false;
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function act(action: () => Promise<unknown>) {
    menuOpen = false;
    try {
      await action();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function copy() {
    await copyText(baseText);
    ui.toast(t('chat.copied'));
  }

  /** When the shown reply's generation started: the key of its prompt in the prompt viewer. */
  const startedAt = $derived.by(() => {
    const value =
      swipe?.info.gen_started ?? (message?.data as { gen_started?: unknown } | undefined)?.gen_started;
    return typeof value === 'string' && value ? value : null;
  });

  /** Images, video, audio and files attached to the message (SillyTavern's formats, old ones too). */
  const attachments = $derived(messageAttachments(message?.extra, prefs.mediaDisplay ?? 'list'));
  const shownMedia = $derived(
    attachments.display === 'gallery' && attachments.media.length
      ? [attachments.media[attachments.index]!]
      : attachments.media,
  );
  const sizeText = (bytes: number | undefined) =>
    !bytes
      ? ''
      : bytes < 1024 * 1024
        ? `${Math.max(1, Math.round(bytes / 1024))} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  /** The checkpoint this message links to (SillyTavern `extra.bookmark_link`). */
  const bookmark = $derived.by(() => {
    const link = (message?.extra as { bookmark_link?: unknown } | undefined)?.bookmark_link;
    return typeof link === 'string' && link ? link : null;
  });
  async function createCheckpoint() {
    const suggested = chat.checkpointTitle();
    const name = prompt(
      bookmark ? t('chat.checkpointReplacePrompt', { name: bookmark }) : t('chat.checkpointPrompt'),
      suggested,
    );
    if (name === null) return;
    await chat.checkpoint(index, name.trim() || suggested);
  }

  function onEditKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void saveEdit();
    if (event.key === 'Escape') editing = false;
  }
</script>

<article
  class="message {role}"
  class:hidden={message?.hidden}
  class:small-sys={smallSys}
  class:menu-open={menuOpen}
  data-index={index}
>
  <div class="gutter">
    {#if role !== 'system'}<Avatar hash={avatarHash} {name} width={40} />{/if}
  </div>
  <div class="body">
    <header>
      <span class="name">{name}</span>
      {#if prefs.showTimestamps && time}<time class="faint">{time}</time>{/if}
      {#if tokenCount !== null}<span class="faint tokens">{t('chat.tokenCount', { count: tokenCount })}</span
        >{/if}
      {#if bookmark}
        <button
          class="icon-btn small flag"
          title={t('chat.openCheckpoint', { name: bookmark })}
          aria-label={t('chat.openCheckpoint', { name: bookmark })}
          onclick={() => act(() => chat.openChatByTitle(bookmark))}><Icon name="flag" size={14} /></button
        >
      {/if}
      {#if message?.hidden}<span class="faint" title={t('chat.hiddenHint')}
          ><Icon name="eyeOff" size={14} /></span
        >{/if}
      {#if message && !streaming}
        <span class="tools">
          <button
            class="icon-btn small"
            title={t('chat.edit')}
            aria-label={t('chat.edit')}
            onclick={startEdit}><Icon name="edit" size={15} /></button
          >
          <button
            class="icon-btn small"
            title={t('chat.more')}
            aria-label={t('chat.more')}
            aria-expanded={menuOpen}
            onclick={toggleMenu}
          >
            <Icon name="more" size={15} />
          </button>
          {#if menuOpen}
            <div class="menu" class:up={menuUp} role="menu">
              <button role="menuitem" onclick={() => act(copy)}
                ><Icon name="copy" size={15} />{t('chat.copy')}</button
              >
              {#if startedAt && chat.chat}
                <button
                  role="menuitem"
                  onclick={() => {
                    menuOpen = false;
                    ui.promptOf = { chatId: chat.chat!.id, startedAt: startedAt! };
                  }}><Icon name="text" size={15} />{t('chat.viewPrompt')}</button
                >
              {/if}
              <button role="menuitem" onclick={() => act(() => chat.branch(index))}
                ><Icon name="branch" size={15} />{t('chat.branch')}</button
              >
              <button role="menuitem" onclick={() => act(createCheckpoint)}
                ><Icon name="flag" size={15} />{t('chat.checkpoint')}</button
              >
              <button role="menuitem" onclick={() => act(() => chat.toggleHidden(message!.id))}>
                <Icon name={message.hidden ? 'eye' : 'eyeOff'} size={15} />{message.hidden
                  ? t('chat.unhide')
                  : t('chat.hide')}
              </button>
              {#each pluginExtensions.messageActions as action (action.key)}
                <button role="menuitem" onclick={() => act(async () => action.onClick(index))}
                  ><Icon name="puzzle" size={15} />{action.label}</button
                >
              {/each}
              <button
                role="menuitem"
                class="danger"
                onclick={() => act(() => chat.deleteMessage(message!.id))}
              >
                <Icon name="trash" size={15} />{t('chat.deleteMessage')}
              </button>
            </div>
          {/if}
        </span>
      {/if}
    </header>

    {#if reasoning}
      <details class="reasoning" open={!!streaming && !text}>
        <summary
          >{streaming && !text
            ? t('chat.thinking')
            : t('chat.thoughtFor', { seconds: reasoningSeconds })}</summary
        >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMessage sanitizes with DOMPurify -->
        <div class="prose small">{@html reasoningHtml}</div>
      </details>
    {/if}

    {#if editing}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="textarea prose"
        bind:value={draft}
        rows={Math.min(16, Math.max(3, draft.split('\n').length + 1))}
        autofocus
        onkeydown={onEditKey}></textarea>
      <div class="edit-actions">
        <button class="btn ghost" onclick={() => (editing = false)}>{t('common.cancel')}</button>
        <button class="btn primary" onclick={saveEdit}
          ><Icon name="check" size={15} />{t('common.save')}</button
        >
      </div>
    {:else}
      <div class="prose" class:streaming={!!streaming}>
        {#each parts as part, i (i)}
          {#if part.kind === 'frontend'}
            <FrontendFrame code={part.code} messageIndex={index} part={part.page} />
          {:else}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMessage sanitizes with DOMPurify -->
            {@html part.html}
          {/if}
        {/each}{#if streaming}<span class="caret" aria-hidden="true"></span>{/if}
      </div>
    {/if}

    {#if message && (attachments.media.length || attachments.files.length)}
      <div class="attachments">
        {#each shownMedia as item (item.url)}
          {#if item.type === 'video'}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={item.url} controls preload="metadata" title={item.title}></video>
          {:else if item.type === 'audio'}
            <audio src={item.url} controls preload="metadata" title={item.title}></audio>
          {:else}
            <a class="image" href={item.url} target="_blank" rel="noopener"
              ><img src={item.url} alt={item.title ?? ''} loading="lazy" /></a
            >
          {/if}
        {/each}
        {#if attachments.display === 'gallery' && attachments.media.length > 1}
          <div class="gallery-nav">
            <button
              class="icon-btn small"
              aria-label={t('chat.mediaPrev')}
              disabled={attachments.index === 0}
              onclick={() => act(() => chat.setMediaIndex(message!.id, attachments.index - 1))}
              ><Icon name="left" size={16} /></button
            >
            <span class="faint">{attachments.index + 1}/{attachments.media.length}</span>
            <button
              class="icon-btn small"
              aria-label={t('chat.mediaNext')}
              disabled={attachments.index >= attachments.media.length - 1}
              onclick={() => act(() => chat.setMediaIndex(message!.id, attachments.index + 1))}
              ><Icon name="right" size={16} /></button
            >
          </div>
        {/if}
        {#each attachments.files as file (file.url)}
          <a class="file" href={file.url} download={file.name ?? true}>
            <Icon name="file" size={16} /><span class="name">{file.name ?? file.url}</span>
            <span class="faint">{sizeText(file.size)}</span>
          </a>
        {/each}
      </div>
    {/if}

    {#if showSwipes && message}
      <div class="swipes">
        <button
          class="icon-btn small"
          aria-label={t('chat.swipePrev')}
          disabled={message.swipeId === 0}
          onclick={() => chat.swipe(message!.id, -1)}
        >
          <Icon name="left" size={16} />
        </button>
        <span class="faint">{message.swipeId + 1}/{message.swipes.length}</span>
        <button
          class="icon-btn small"
          aria-label={t('chat.swipeNext')}
          onclick={() => chat.swipe(message!.id, 1)}
        >
          <Icon name="right" size={16} />
        </button>
      </div>
    {/if}
  </div>
</article>

<style>
  :global(article.message.found) {
    outline: 2px solid var(--bt-accent);
    outline-offset: 2px;
    border-radius: var(--bt-radius-sm);
  }
  .message {
    display: grid;
    grid-template-columns: 48px 1fr;
    gap: 0 0.85rem;
    padding: 0.9rem 0 0.6rem;
    content-visibility: auto;
    contain-intrinsic-size: auto 160px;
  }
  .message.small-sys .prose {
    font-family: var(--bt-font-ui);
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .message.small-sys .gutter {
    visibility: hidden;
  }
  /* Skipped rendering clips to the message: not while its menu is open. */
  .message.menu-open {
    content-visibility: visible;
    position: relative;
    z-index: 6;
  }
  .message.user .body {
    background: var(--bt-user-tint);
    border-radius: var(--bt-radius);
    padding: 0.45rem 0.85rem 0.55rem;
    margin-inline-start: -0.85rem;
  }
  .message.system {
    grid-template-columns: 0 1fr;
  }
  .message.system .prose {
    color: var(--bt-ink-muted);
    font-style: italic;
  }
  .message.hidden {
    opacity: 0.55;
  }
  .gutter {
    padding-top: 0.15rem;
  }
  .body {
    min-width: 0;
  }
  header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.75rem;
  }
  .name {
    font-weight: 650;
    font-size: var(--bt-size-sm);
    letter-spacing: 0.01em;
  }
  .assistant .name {
    color: var(--bt-dialogue);
  }
  time,
  .tokens {
    font-size: var(--bt-size-xs);
  }
  .flag {
    color: var(--bt-accent);
  }
  .attachments {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .attachments .image img {
    min-width: 3rem;
    min-height: 3rem;
    object-fit: contain;
  }
  .attachments .image img,
  .attachments video {
    display: block;
    max-width: min(100%, 22rem);
    max-height: 18rem;
    border-radius: var(--bt-radius);
    border: 1px solid var(--bt-line);
    background: var(--bt-surface-2);
  }
  .attachments audio {
    max-width: 100%;
  }
  .gallery-nav {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    align-self: center;
    font-size: var(--bt-size-xs);
  }
  .attachments .file {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 100%;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface);
    color: var(--bt-ink);
    font-size: var(--bt-size-sm);
    text-decoration: none;
  }
  .attachments .file .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tokens {
    font-variant-numeric: tabular-nums;
  }
  .tools {
    position: relative;
    margin-inline-start: auto;
    display: flex;
    gap: 0.1rem;
    opacity: 0;
    transition: opacity 120ms;
  }
  .message:hover .tools,
  .message:focus-within .tools,
  .message.menu-open .tools {
    opacity: 1;
  }
  @media (hover: none) {
    .tools {
      opacity: 1;
    }
  }
  .menu {
    position: absolute;
    inset-inline-end: 0;
    top: 2rem;
    z-index: 5;
    display: grid;
    min-width: 12rem;
    padding: 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface-2);
    box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
  }
  .menu.up {
    top: auto;
    bottom: 2rem;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.5rem 0.6rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    font-size: var(--bt-size-sm);
    text-align: start;
  }
  .menu button:hover {
    background: var(--bt-surface-3);
  }
  .menu .danger {
    color: var(--bt-danger);
  }
  .prose {
    font-family: var(--bt-font-prose);
    font-size: var(--bt-size-prose);
    line-height: var(--bt-leading-prose);
    color: var(--bt-ink);
    overflow-wrap: anywhere;
  }
  .prose.small {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .prose :global(p + p) {
    margin-top: 0.75em;
  }
  .prose :global(em) {
    color: var(--bt-action);
  }
  .prose :global(u) {
    text-decoration-color: var(--bt-underline, currentColor);
  }
  .prose :global(q) {
    color: var(--bt-dialogue);
    quotes: none;
  }
  .prose :global(q::before),
  .prose :global(q::after) {
    content: none;
  }
  .prose :global(strong) {
    font-weight: 650;
  }
  .prose :global(pre) {
    margin: 0.75em 0;
    padding: 0.75em 0.9em;
    overflow-x: auto;
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface-2);
    font-size: 0.85em;
    line-height: 1.5;
  }
  .prose :global(code) {
    font-size: 0.9em;
  }
  .prose :global(blockquote) {
    margin: 0.6em 0;
    padding-inline-start: 0.9em;
    border-inline-start: 3px solid var(--bt-line);
    color: var(--bt-ink-muted);
  }
  .prose :global(ul),
  .prose :global(ol) {
    padding-inline-start: 1.4em;
  }
  .prose :global(img) {
    max-height: 60vh;
    border-radius: var(--bt-radius-sm);
  }
  .prose :global(table) {
    border-collapse: collapse;
    margin: 0.75em 0;
    font-size: 0.92em;
  }
  .prose :global(th),
  .prose :global(td) {
    border: 1px solid var(--bt-line);
    padding: 0.3em 0.6em;
  }
  .caret {
    display: inline-block;
    width: 0.5em;
    height: 1.1em;
    margin-inline-start: 0.15em;
    vertical-align: text-bottom;
    background: var(--bt-accent);
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
  .reasoning {
    margin: 0.2rem 0 0.5rem;
    padding: 0.35rem 0.7rem;
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface);
    border: 1px solid var(--bt-line);
  }
  .reasoning summary {
    cursor: pointer;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-muted);
  }
  .reasoning[open] summary {
    margin-bottom: 0.35rem;
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
    margin-top: 0.4rem;
  }
  .swipes {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    font-size: var(--bt-size-xs);
  }
</style>
