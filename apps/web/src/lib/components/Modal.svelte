<script lang="ts">
  import type { Snippet } from 'svelte';

  import Icon from './Icon.svelte';

  interface Props {
    open: boolean;
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
    wide?: boolean;
    /** Nearly full-screen; the body is a bare flex column for multi-pane layouts. */
    full?: boolean;
    /** Extra header content (actions next to the title). */
    actions?: Snippet;
  }
  let { open, title, onclose, children, footer, wide = false, full = false, actions }: Props = $props();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} class="sheet" class:wide class:full {onclose} aria-labelledby="modal-title">
  {#if open}
    <header>
      <h2 id="modal-title">{title}</h2>
      <span class="actions">
        {#if actions}{@render actions()}{/if}
        <button class="icon-btn" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
      </span>
    </header>
    <div class="body" class:bare={full}>{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  /* Phones get the full screen from the global sheet styles; only widen on larger screens. */
  @media (min-width: 641px) {
    dialog.wide {
      width: min(60rem, calc(100vw - 2rem));
    }
    dialog.full {
      width: min(84rem, calc(100vw - 2rem));
      height: calc(100dvh - 2rem);
      max-height: calc(100dvh - 2rem);
    }
  }
  dialog.full[open] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.75rem 0.75rem 1.25rem;
    border-bottom: 1px solid var(--bt-line);
    background: var(--bt-surface);
  }
  h2 {
    font-size: var(--bt-size-lg);
    font-weight: 600;
  }
  .body {
    padding: 1.25rem;
    display: grid;
    gap: 1rem;
  }
  .body.bare {
    flex: 1;
    min-height: 0;
    padding: 0;
    display: flex;
  }
  footer {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--bt-line);
    background: var(--bt-surface);
  }
</style>
