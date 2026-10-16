<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { chatDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  let textarea = $state<HTMLTextAreaElement>();
  let fileInput = $state<HTMLInputElement>();
  let menuOpen = $state(false);
  let dragging = $state(false);

  /** Images pasted into the box are attached; text pastes as usual. */
  function onPaste(event: ClipboardEvent) {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    chat.attach(files);
  }

  function onDrop(event: DragEvent) {
    dragging = false;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    chat.attach(files);
  }

  const sizeText = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const prefs = $derived(settings.get('chat', chatDefaults));
  const busy = $derived(!!chat.generation);

  $effect(() => {
    // Grow with the content (up to the max-height in CSS).
    void chat.draft;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  });

  async function run(action: () => Promise<unknown>) {
    menuOpen = false;
    try {
      await action();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  function send() {
    if (busy) return;
    void run(() => chat.send(chat.draft));
  }

  function onKeydown(event: KeyboardEvent) {
    // Never send while an IME composition (e.g. Chinese pinyin) is active.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey && prefs.sendOnEnter && !ui.narrow) {
      event.preventDefault();
      send();
    }
  }
</script>

<form
  class="composer"
  onsubmit={(e) => (e.preventDefault(), send())}
  ondragover={(e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dragging = true;
    }
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  {#if chat.attachments.length}
    <ul class="pending" aria-label={t('chat.attachments')}>
      {#each chat.attachments as item (item.id)}
        <li>
          {#if item.preview}<img src={item.preview} alt="" />{:else}<span class="kind"
              ><Icon name={item.kind === 'file' ? 'file' : 'image'} size={16} /></span
            >{/if}
          <span class="name">{item.file.name}</span>
          <span class="size">{sizeText(item.file.size)}</span>
          <button
            type="button"
            class="icon-btn small"
            aria-label={t('chat.detach', { name: item.file.name })}
            onclick={() => chat.detach(item.id)}><Icon name="close" size={14} /></button
          >
        </li>
      {/each}
    </ul>
  {/if}
  <div class="box" class:dragging>
    <div class="more">
      <button
        type="button"
        class="icon-btn"
        aria-label={t('chat.actions')}
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
        disabled={busy}
      >
        <Icon name="plus" />
      </button>
      {#if menuOpen}
        <div class="menu" role="menu">
          <button type="button" role="menuitem" onclick={() => run(() => chat.generate('continue'))}
            ><Icon name="forward" size={15} />{t('chat.continue')}</button
          >
          <button type="button" role="menuitem" onclick={() => run(() => chat.regenerate())}
            ><Icon name="refresh" size={15} />{t('chat.regenerate')}</button
          >
          <button type="button" role="menuitem" onclick={() => run(() => chat.generate('impersonate'))}
            ><Icon name="feather" size={15} />{t('chat.impersonate')}</button
          >
        </div>
      {/if}
    </div>
    <button
      type="button"
      class="icon-btn"
      title={t('chat.attach')}
      aria-label={t('chat.attach')}
      disabled={busy}
      onclick={() => fileInput?.click()}><Icon name="clip" /></button
    >
    <input
      bind:this={fileInput}
      type="file"
      multiple
      hidden
      accept="image/*,video/*,audio/*,text/*,.md,.json,.jsonl,.csv,.tsv,.xml,.yaml,.yml,.html,.htm,.srt,.vtt,.log"
      onchange={(e) => {
        chat.attach(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
      }}
    />
    <textarea
      bind:this={textarea}
      bind:value={chat.draft}
      rows="1"
      placeholder={t('chat.placeholder', { name: chat.userName })}
      aria-label={t('chat.placeholder', { name: chat.userName })}
      onkeydown={onKeydown}
      onpaste={onPaste}></textarea>
    {#if busy}
      <button
        type="button"
        class="send stop"
        aria-label={t('chat.stop')}
        title={t('chat.stop')}
        onclick={() => chat.stop()}
      >
        <Icon name="stop" />
      </button>
    {:else}
      <button type="submit" class="send" aria-label={t('chat.send')} title={t('chat.send')}
        ><Icon name="send" /></button
      >
    {/if}
  </div>
</form>

<style>
  .composer {
    padding: 0.5rem var(--bt-gutter) calc(0.75rem + env(safe-area-inset-bottom));
  }
  .box {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
    max-width: var(--bt-chat-width);
    margin: 0 auto;
    padding: 0.35rem;
    border: 1px solid var(--bt-line);
    border-radius: 14px;
    background: var(--bt-surface);
  }
  .box:focus-within,
  .box.dragging {
    border-color: color-mix(in oklch, var(--bt-accent) 60%, var(--bt-line));
  }
  .box.dragging {
    background: color-mix(in oklch, var(--bt-accent) 6%, var(--bt-surface));
  }
  .pending {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    max-width: var(--bt-chat-width);
    margin: 0 auto 0.4rem;
    padding: 0;
    list-style: none;
  }
  .pending li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 16rem;
    padding: 0.25rem 0.25rem 0.25rem 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface);
    font-size: var(--bt-size-sm);
  }
  .pending img,
  .pending .kind {
    width: 2rem;
    height: 2rem;
    flex: none;
    border-radius: var(--bt-radius-sm);
    object-fit: cover;
  }
  .pending .kind {
    display: grid;
    place-items: center;
    background: var(--bt-surface-2);
    color: var(--bt-ink-muted);
  }
  .pending .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pending .size {
    flex: none;
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-xs);
  }
  textarea {
    flex: 1;
    max-height: 40dvh;
    padding: 0.5rem 0.25rem;
    border: 0;
    background: transparent;
    resize: none;
    font-family: var(--bt-font-prose);
    font-size: var(--bt-size-prose);
    line-height: 1.5;
    outline: none;
  }
  .send {
    display: grid;
    place-items: center;
    width: 2.4rem;
    height: 2.4rem;
    flex: none;
    border: 0;
    border-radius: 10px;
    background: var(--bt-accent);
    color: var(--bt-accent-ink);
  }
  .send.stop {
    background: var(--bt-danger);
    color: white;
  }
  .more {
    position: relative;
  }
  .menu {
    position: absolute;
    bottom: 2.75rem;
    inset-inline-start: 0;
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
    padding: 0.55rem 0.6rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    font-size: var(--bt-size-sm);
    text-align: start;
  }
  .menu button:hover {
    background: var(--bt-surface-3);
  }
</style>
