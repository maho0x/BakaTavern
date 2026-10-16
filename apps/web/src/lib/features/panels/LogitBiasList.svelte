<script lang="ts">
  import { uuidv4 } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';

  interface Entry {
    id?: string;
    text?: string;
    value?: number;
  }

  /** Logit bias entries: text or token ids (`[1, 2]`) and a bias from -100 to 100. */
  let { entries, onchange }: { entries: Entry[]; onchange: (entries: Entry[]) => void } = $props();

  const update = (index: number, patch: Partial<Entry>) =>
    onchange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
</script>

<div class="bias">
  {#each entries as entry, i (entry.id ?? i)}
    <div class="entry">
      <input
        class="input code"
        value={entry.text ?? ''}
        placeholder={t('bias.textPlaceholder')}
        aria-label={t('bias.text')}
        onchange={(e) => update(i, { text: e.currentTarget.value })}
      />
      <input
        class="input num"
        type="number"
        min="-100"
        max="100"
        value={entry.value ?? 0}
        aria-label={t('bias.value')}
        onchange={(e) => update(i, { value: Number(e.currentTarget.value) || 0 })}
      />
      <button
        class="icon-btn small"
        title={t('common.delete')}
        aria-label={t('common.delete')}
        onclick={() => onchange(entries.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button
      >
    </div>
  {:else}
    <p class="empty">{t('bias.empty')}</p>
  {/each}
  <button class="btn add" onclick={() => onchange([...entries, { id: uuidv4(), text: '', value: 0 }])}
    ><Icon name="plus" size={15} />{t('bias.add')}</button
  >
  <small class="hint">{t('bias.hint')}</small>
</div>

<style>
  .bias {
    display: grid;
    gap: 0.35rem;
  }
  .entry {
    display: grid;
    grid-template-columns: 1fr 4.5rem auto;
    gap: 0.35rem;
    align-items: center;
  }
  .num {
    padding: 0.25rem 0.35rem;
    font-size: var(--bt-size-sm);
  }
  .add {
    justify-self: start;
  }
  .empty,
  .hint {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
</style>
