<script lang="ts">
  import type { Message } from '@bakatavern/api-client';

  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { renderMessage } from '../../render/markdown.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { uiDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
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
  const name = $derived(message?.name ?? chat.character?.name ?? '');
  const swipe = $derived(message ? message.swipes[message.swipeId] : undefined);
  const baseText = $derived(swipe?.content ?? '');
  const extra = $derived((swipe?.info.extra as Record<string, unknown> | undefined) ?? message?.extra ?? {});
  const text = $derived.by(() => {
    if (!streaming) return baseText;
    if (chat.generation?.target.kind === 'continue') return baseText + streaming.text;
    return streaming.text;
  });
  const reasoning = $derived(streaming ? streaming.reasoning : String(extra.reasoning ?? ''));
  const reasoningSeconds = $derived(Math.max(1, Math.round(Number(extra.reasoning_duration ?? 0) / 1000)));
  const html = $derived(renderMessage(text, { html: prefs.renderHtml, externalMedia: prefs.externalMedia }));
  const avatarHash = $derived.by(() => {
    if (role === 'assistant') return chat.character?.avatar ?? null;
    if (role === 'user')
      return (library.personas.find((p) => p.name === name) ?? chat.persona)?.avatar ?? null;
    return null;
  });
  const showSwipes = $derived(!!message && isLast && role === 'assistant' && !chat.generation);
  const time = $derived(message ? new Date(message.createdAt).toLocaleString() : '');

  let editing = $state(false);
  let draft = $state('');
  let menuOpen = $state(false);

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

  function onEditKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void saveEdit();
    if (event.key === 'Escape') editing = false;
  }
</script>

<article class="message {role}" class:hidden={message?.hidden} data-index={index}>
  <div class="gutter">
    {#if role !== 'system'}<Avatar hash={avatarHash} {name} width={40} />{/if}
  </div>
  <div class="body">
    <header>
      <span class="name">{name}</span>
      {#if prefs.showTimestamps && time}<time class="faint">{time}</time>{/if}
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
            onclick={() => (menuOpen = !menuOpen)}
          >
            <Icon name="more" size={15} />
          </button>
          {#if menuOpen}
            <div class="menu" role="menu">
              <button role="menuitem" onclick={() => act(copy)}
                ><Icon name="copy" size={15} />{t('chat.copy')}</button
              >
              <button role="menuitem" onclick={() => act(() => chat.branch(index))}
                ><Icon name="branch" size={15} />{t('chat.branch')}</button
              >
              <button role="menuitem" onclick={() => act(() => chat.toggleHidden(message!.id))}>
                <Icon name={message.hidden ? 'eye' : 'eyeOff'} size={15} />{message.hidden
                  ? t('chat.unhide')
                  : t('chat.hide')}
              </button>
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
        <div class="prose small">{@html renderMessage(reasoning, { html: false, externalMedia: false })}</div>
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
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderMessage sanitizes with DOMPurify -->
        {@html html}{#if streaming}<span class="caret" aria-hidden="true"></span>{/if}
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
  .message {
    display: grid;
    grid-template-columns: 48px 1fr;
    gap: 0 0.85rem;
    padding: 0.9rem 0 0.6rem;
    content-visibility: auto;
    contain-intrinsic-size: auto 160px;
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
  time {
    font-size: var(--bt-size-xs);
  }
  .tools {
    margin-inline-start: auto;
    display: flex;
    gap: 0.1rem;
    opacity: 0;
    transition: opacity 120ms;
  }
  .message:hover .tools,
  .message:focus-within .tools {
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
