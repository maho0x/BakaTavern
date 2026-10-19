<script lang="ts">
  import Modal from '../components/Modal.svelte';
  import { t } from '../i18n/index.svelte.ts';
  import { sanitizeHtml } from '../render/markdown.ts';
  import { scriptDialogs } from './dialogs.svelte.ts';

  const dialog = $derived(scriptDialogs.current);
  let text = $state('');
  let toggled = $state<string[]>([]);

  $effect(() => {
    // A new dialog starts from its own default.
    text = dialog?.kind === 'input' ? dialog.initial : '';
    toggled = [];
  });

  const title = $derived(dialog?.kind === 'popup' && dialog.header ? dialog.header : t('script.dialogTitle'));

  function cancel() {
    scriptDialogs.close(dialog?.kind === 'buttons' ? (dialog.multiple ? [] : '') : null);
  }
</script>

{#if dialog}
  <Modal open {title} onclose={cancel} wide={dialog.wide}>
    {#if dialog.body}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized with DOMPurify -->
      <div class="body">{@html sanitizeHtml(dialog.body)}</div>
    {/if}
    {#if dialog.kind === 'input'}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="textarea"
        rows={dialog.rows}
        placeholder={dialog.placeholder ?? ''}
        aria-label={t('script.inputLabel')}
        autofocus
        bind:value={text}
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) scriptDialogs.close(text);
        }}></textarea>
    {:else if dialog.kind === 'buttons'}
      <div class="buttons">
        {#each dialog.buttons as button (button.text)}
          {#if dialog.multiple}
            <button
              class="btn"
              class:on={toggled.includes(button.text)}
              title={button.tooltip}
              aria-pressed={toggled.includes(button.text)}
              onclick={() =>
                (toggled = toggled.includes(button.text)
                  ? toggled.filter((x) => x !== button.text)
                  : [...toggled, button.text])}>{button.text}</button
            >
          {:else}
            <button class="btn" title={button.tooltip} onclick={() => scriptDialogs.close(button.text)}
              >{button.text}</button
            >
          {/if}
        {/each}
      </div>
    {/if}
    {#snippet footer()}
      {#if dialog.kind === 'popup'}
        {#if dialog.cancelButton}
          <button class="btn ghost" onclick={() => scriptDialogs.close(0)}>{dialog.cancelButton}</button>
        {/if}
        <button class="btn primary" onclick={() => scriptDialogs.close(1)}>{dialog.okButton}</button>
      {:else if dialog.kind === 'input'}
        <button class="btn ghost" onclick={cancel}>{t('common.cancel')}</button>
        <button class="btn primary" onclick={() => scriptDialogs.close(text)}>{dialog.okButton}</button>
      {:else if dialog.multiple}
        <button class="btn ghost" onclick={cancel}>{t('common.cancel')}</button>
        <button
          class="btn primary"
          onclick={() =>
            scriptDialogs.close(dialog.buttons.map((b) => b.text).filter((x) => toggled.includes(x)))}
          >{t('script.ok')}</button
        >
      {:else}
        <button class="btn ghost" onclick={cancel}>{t('common.cancel')}</button>
      {/if}
    {/snippet}
  </Modal>
{/if}

<style>
  .body {
    overflow-wrap: anywhere;
    line-height: 1.55;
  }
  .buttons {
    display: grid;
    gap: 0.4rem;
    max-height: 60vh;
    overflow-y: auto;
  }
  .buttons .btn {
    justify-content: flex-start;
    white-space: normal;
    text-align: start;
  }
  .btn.on {
    border-color: var(--bt-accent);
    background: color-mix(in oklch, var(--bt-accent) 18%, var(--bt-surface-2));
  }
</style>
