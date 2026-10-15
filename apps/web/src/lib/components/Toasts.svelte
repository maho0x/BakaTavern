<script lang="ts">
  import { ui } from '../state/ui.svelte.ts';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each ui.toasts as toast (toast.id)}
    <div class="toast {toast.kind}">
      <span>{toast.text}</span>
      <button class="icon-btn small" aria-label="Dismiss" onclick={() => ui.dismiss(toast.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    inset-block-end: calc(1rem + env(safe-area-inset-bottom));
    inset-inline-end: 1rem;
    z-index: 100;
    display: grid;
    gap: 0.5rem;
    width: min(26rem, calc(100vw - 2rem));
  }
  .toast {
    display: flex;
    align-items: start;
    gap: 0.5rem;
    padding: 0.65rem 0.5rem 0.65rem 0.85rem;
    border-radius: var(--bt-radius);
    border: 1px solid var(--bt-line);
    border-inline-start: 3px solid var(--bt-accent);
    background: var(--bt-surface-2);
    font-size: var(--bt-size-sm);
    box-shadow: 0 8px 30px rgb(0 0 0 / 25%);
  }
  .toast span {
    flex: 1;
    padding-top: 0.15rem;
  }
  .toast.error {
    border-inline-start-color: var(--bt-danger);
  }
</style>
