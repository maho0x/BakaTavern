<script lang="ts">
  import { t } from '../i18n/index.svelte.ts';
  import { ui } from '../state/ui.svelte.ts';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each ui.toasts as toast (toast.id)}
    <!-- A tap anywhere dismisses it, as in SillyTavern, so it never stands in the way for long. -->
    <button
      type="button"
      class="toast {toast.kind}"
      title={t('common.dismiss')}
      onclick={() => ui.dismiss(toast.id)}
    >
      <span>{toast.text}</span>
      <Icon name="close" size={14} />
    </button>
  {/each}
</div>

<style>
  /*
   * Below the top bars: at the bottom they would cover the composer, at the very top the bars'
   * buttons (the chat's and, on phones, the open panel's).
   */
  .toasts {
    position: fixed;
    inset-block-start: calc(4rem + env(safe-area-inset-top));
    inset-inline: 0;
    margin-inline: auto;
    z-index: 100;
    display: grid;
    gap: 0.5rem;
    width: min(26rem, calc(100vw - 2rem));
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: start;
    gap: 0.5rem;
    width: 100%;
    padding: 0.65rem 0.75rem 0.65rem 0.85rem;
    border-radius: var(--bt-radius);
    border: 1px solid var(--bt-line);
    border-inline-start: 3px solid var(--bt-accent);
    background: var(--bt-surface-2);
    color: var(--bt-ink);
    font-size: var(--bt-size-sm);
    text-align: start;
    cursor: pointer;
    box-shadow: 0 8px 30px rgb(0 0 0 / 25%);
  }
  .toast span {
    flex: 1;
  }
  .toast :global(svg) {
    flex: none;
    margin-top: 0.15rem;
    color: var(--bt-ink-faint);
  }
  .toast.error {
    border-inline-start-color: var(--bt-danger);
  }
</style>
