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
  }
  let { open, title, onclose, children, footer, wide = false }: Props = $props();
  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });
</script>

<dialog bind:this={dialog} class="sheet" class:wide {onclose} aria-labelledby="modal-title">
  {#if open}
    <header>
      <h2 id="modal-title">{title}</h2>
      <button class="icon-btn" aria-label="Close" onclick={onclose}><Icon name="close" /></button>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  {/if}
</dialog>

<style>
  dialog.wide {
    width: min(60rem, calc(100vw - 2rem));
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
