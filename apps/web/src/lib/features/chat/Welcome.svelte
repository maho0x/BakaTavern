<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { ui } from '../../state/ui.svelte.ts';
  import { createCharacter, importCharacterFiles } from '../library/actions.ts';

  let fileInput = $state<HTMLInputElement>();
  let importing = $state(false);
  const empty = $derived(library.characters.length === 0);

  async function importFiles(files: FileList | null) {
    importing = true;
    try {
      await importCharacterFiles(files);
    } finally {
      importing = false;
      if (fileInput) fileInput.value = '';
    }
  }
</script>

<div class="welcome">
  <p class="lead">{empty ? t('welcome.empty') : t('chat.noCharacter')}</p>
  <div class="actions">
    {#if empty}
      <button class="btn primary" disabled={importing} onclick={() => fileInput?.click()}>
        <Icon name="upload" size={16} />{t('library.import')}
      </button>
      <button class="btn" onclick={createCharacter}><Icon name="plus" size={16} />{t('library.new')}</button>
    {:else if ui.narrow}
      <button class="btn primary" onclick={() => (ui.libraryOpen = true)}>
        <Icon name="library" size={16} />{t('library.title')}
      </button>
    {/if}
    {#if ui.narrow}
      <button class="btn ghost" onclick={() => (ui.panel = 'connection')}>
        <Icon name="plug" size={16} />{t('panel.connection')}
      </button>
    {/if}
  </div>
  <input
    bind:this={fileInput}
    type="file"
    accept=".png,.json,.charx,application/json,image/png"
    multiple
    hidden
    onchange={(e) => importFiles(e.currentTarget.files)}
  />
</div>

<style>
  .welcome {
    grid-row: 1 / -1;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1.25rem;
    padding: 2rem var(--bt-gutter);
    text-align: center;
  }
  .lead {
    max-width: 24ch;
    font-family: var(--bt-font-prose);
    font-size: var(--bt-size-lg);
    color: var(--bt-ink-muted);
    text-wrap: balance;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }
</style>
