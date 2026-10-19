<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { backgrounds } from '../../state/backgrounds.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import type { BackgroundPrefs } from '../../state/prefs.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let fileInput = $state<HTMLInputElement>();
  let uploading = $state(false);
  const prefs = $derived(backgrounds.prefs);
  const active = $derived(backgrounds.active);
  const fits: {
    value: BackgroundPrefs['fit'];
    label: 'bg.fitClassic' | 'bg.fitCover' | 'bg.fitContain' | 'bg.fitStretch' | 'bg.fitCenter';
  }[] = [
    { value: 'classic', label: 'bg.fitClassic' },
    { value: 'cover', label: 'bg.fitCover' },
    { value: 'contain', label: 'bg.fitContain' },
    { value: 'stretch', label: 'bg.fitStretch' },
    { value: 'center', label: 'bg.fitCenter' },
  ];

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    uploading = true;
    try {
      await backgrounds.upload(files);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function lock(name: string | null) {
    try {
      await backgrounds.setChat(name);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<Modal {open} title={t('bg.title')} {onclose} wide>
  <div class="bar">
    <button class="btn" disabled={uploading} onclick={() => fileInput?.click()}
      ><Icon name="upload" size={15} />{t('bg.upload')}</button
    >
    <label class="fit"
      ><span>{t('bg.fit')}</span>
      <select
        class="select"
        value={prefs.fit}
        onchange={(e) => backgrounds.setFit(e.currentTarget.value as BackgroundPrefs['fit'])}
      >
        {#each fits as fit (fit.value)}<option value={fit.value}>{t(fit.label)}</option>{/each}
      </select></label
    >
    {#if active?.locked}
      <button class="btn ghost" onclick={() => lock(null)}>{t('bg.unlock')}</button>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*,video/mp4,video/webm"
      multiple
      hidden
      onchange={(e) => upload(e.currentTarget.files)}
    />
  </div>
  {#if !prefs.items.length}
    <p class="faint">{t('bg.empty')}</p>
  {/if}
  <ul class="grid" aria-label={t('bg.list')}>
    <li>
      <button
        class="tile none"
        class:current={!prefs.current}
        aria-pressed={!prefs.current}
        onclick={() => backgrounds.setCurrent(null)}>{t('bg.none')}</button
      >
    </li>
    {#each prefs.items as item (item.name)}
      {@const url = backgrounds.url(item.name)}
      <li>
        <button
          class="tile"
          class:current={prefs.current === item.name}
          class:shown={active?.name === item.name}
          aria-pressed={prefs.current === item.name}
          title={item.name}
          aria-label={item.name}
          style:background-image={url && !/\.(mp4|webm)$/i.test(item.name) ? `url("${url}")` : undefined}
          onclick={() => backgrounds.setCurrent(item.name)}
        >
          <span class="name">{item.name}</span>
        </button>
        <div class="actions">
          {#if chat.chat}
            <button
              class="icon-btn small"
              title={t('bg.lock')}
              aria-label="{t('bg.lock')}: {item.name}"
              onclick={() => lock(item.name)}><Icon name="chats" size={14} /></button
            >
          {/if}
          <button
            class="icon-btn small"
            title={t('common.delete')}
            aria-label="{t('common.delete')}: {item.name}"
            onclick={() => backgrounds.remove(item.name)}><Icon name="trash" size={14} /></button
          >
        </div>
      </li>
    {/each}
  </ul>
</Modal>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .fit {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--bt-size-sm);
  }
  .fit .select {
    width: auto;
  }
  .grid {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.6rem;
  }
  li {
    position: relative;
  }
  .tile {
    display: flex;
    align-items: flex-end;
    width: 100%;
    aspect-ratio: 16 / 10;
    padding: 0;
    border: 2px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface-2) center / cover no-repeat;
    color: var(--bt-ink);
    overflow: hidden;
  }
  .tile.none {
    align-items: center;
    justify-content: center;
    font-size: var(--bt-size-sm);
  }
  .tile.current {
    border-color: var(--bt-accent);
  }
  .tile.shown:not(.current) {
    border-style: dashed;
    border-color: var(--bt-accent);
  }
  .name {
    width: 100%;
    padding: 0.2rem 0.4rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-xs);
    text-align: left;
    background: color-mix(in oklch, var(--bt-surface) 80%, transparent);
  }
  .actions {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    display: flex;
    gap: 0.15rem;
    border-radius: var(--bt-radius-sm);
    background: color-mix(in oklch, var(--bt-surface) 85%, transparent);
  }
  .faint {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-sm);
    margin-bottom: 0.5rem;
  }
</style>
