<script lang="ts">
  import { buttonEvent } from '@bakatavern/th-bridge';

  import { events } from '../events.ts';
  import { t } from '../i18n/index.svelte.ts';
  import { helperScripts } from './scripts.svelte.ts';

  /** Buttons scripts show (TavernHelper's script buttons); a click is an event the script hears. */
  const buttons = $derived(
    helperScripts.running.flatMap(({ script }) =>
      script.button.enabled
        ? script.button.buttons
            .filter((b) => b.visible && b.name)
            .map((b) => ({ id: script.id, name: b.name, key: `${script.id}:${b.name}` }))
        : [],
    ),
  );
</script>

{#if buttons.length}
  <div class="bar" role="toolbar" aria-label={t('th.scriptButtons')}>
    {#each buttons as button (button.key)}
      <button class="chip" onclick={() => void events.emit(buttonEvent(button.id, button.name))}
        >{button.name}</button
      >
    {/each}
  </div>
{/if}

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    max-width: var(--bt-chat-width);
    margin: 0 auto;
    padding: 0.35rem var(--bt-gutter) 0;
  }
  .chip {
    padding: 0.25rem 0.65rem;
    border: 1px solid var(--bt-line);
    border-radius: 999px;
    background: var(--bt-surface-2);
    color: var(--bt-ink);
    font-size: var(--bt-size-sm);
    white-space: nowrap;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip:hover {
    background: var(--bt-surface-3);
  }
</style>
