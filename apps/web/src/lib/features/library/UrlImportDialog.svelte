<script lang="ts">
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { importFromUrls } from './actions.ts';

  let { open, onclose }: { open: boolean; onclose: () => void } = $props();
  let text = $state('');
  let busy = $state(false);

  const lines = $derived(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  async function run() {
    if (!lines.length) return;
    busy = true;
    try {
      // What failed stays in the box, to try again.
      const failed = await importFromUrls(lines);
      text = failed.join('\n');
      if (!failed.length) onclose();
    } finally {
      busy = false;
    }
  }
</script>

<Modal {open} title={t('library.urlTitle')} {onclose}>
  <label class="field">
    <span>{t('library.urlLabel')}</span>
    <textarea
      class="textarea code"
      rows="5"
      spellcheck="false"
      placeholder="https://chub.ai/characters/creator/name"
      bind:value={text}></textarea>
  </label>
  <p class="hint">{t('library.urlHint')}</p>
  {#snippet footer()}
    <button class="btn ghost" onclick={onclose}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={busy || !lines.length} onclick={run}
      >{busy ? t('library.urlImporting') : t('library.urlImport')}</button
    >
  {/snippet}
</Modal>

<style>
  .hint {
    margin-top: 0.6rem;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
</style>
