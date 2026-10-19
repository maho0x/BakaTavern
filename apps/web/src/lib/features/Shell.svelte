<script lang="ts">
  import { onMount, untrack } from 'svelte';

  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n/index.svelte.ts';
  import { chat } from '../state/chat.svelte.ts';
  import { library } from '../state/library.svelte.ts';
  import { connectionDefaults } from '../state/prefs.ts';
  import { regex } from '../state/regex.svelte.ts';
  import { settings } from '../state/settings.svelte.ts';
  import { ui } from '../state/ui.svelte.ts';
  import { plugins } from '../plugins/host.svelte.ts';
  import { quickReplies } from '../quickreplies/store.svelte.ts';
  import ScriptDialog from '../stscript/ScriptDialog.svelte';
  import { bridge } from '../th/bridge.svelte.ts';
  import ScriptFrames from '../th/ScriptFrames.svelte';
  import { helperScripts } from '../th/scripts.svelte.ts';
  import '../stscript/setup.ts';
  import ChatPane from './chat/ChatPane.svelte';
  import LibraryRail from './library/LibraryRail.svelte';
  import SidePanel from './panels/SidePanel.svelte';
  import { panelTabs as dock } from './panels/tabs.ts';

  // Keep the active preset's embedded regex scripts loaded (they also apply to display).
  $effect(() => {
    void settings.get('connection', connectionDefaults).presetId;
    void library.presets.map((p) => p.rev);
    void regex.syncPreset();
  });

  onMount(() => void plugins.startAll());

  // Front-end pages and scripts see the chat as it changes.
  $effect(() => {
    if (!bridge.frames) return;
    // Read for its dependencies; what is sent is built when it goes.
    void bridge.state();
    untrack(() => bridge.scheduleState());
  });
  $effect(() => {
    void settings.get('connection', connectionDefaults).presetId;
    void library.presets.map((p) => p.rev);
    void helperScripts.syncPreset();
  });
  $effect(() => {
    if (chat.characterId) untrack(() => helperScripts.checkCharacter());
  });

  // Quick Reply sets follow the presets they are stored as.
  $effect(() => {
    void library.presets.map((p) => p.rev);
    // load() reads the loaded sets; only the preset list should rerun it.
    untrack(() => void quickReplies.load());
  });
</script>

<div class="shell" class:narrow={ui.narrow} class:panel-open={!!ui.panel}>
  {#if !ui.narrow}
    <div class="rail"><LibraryRail /></div>
  {/if}

  <main class="main"><ChatPane /></main>

  {#if ui.panel && !ui.narrow}
    <div class="side"><SidePanel /></div>
  {/if}

  {#if !ui.narrow}
    <nav class="dock" aria-label={t('panel.dock')}>
      {#each dock as item (item.id)}
        <button
          class="icon-btn"
          class:on={ui.panel === item.id}
          title={t(item.label)}
          aria-label={t(item.label)}
          aria-pressed={ui.panel === item.id}
          onclick={() => ui.togglePanel(item.id)}
        >
          <Icon name={item.icon} />
        </button>
      {/each}
    </nav>
  {/if}
</div>

{#if ui.narrow && ui.libraryOpen}
  <div class="sheet-backdrop" role="presentation" onclick={() => (ui.libraryOpen = false)}></div>
  <div class="sheet left"><LibraryRail /></div>
{/if}
{#if ui.narrow && ui.panel}
  <div class="sheet full"><SidePanel /></div>
{/if}

<!-- The editors and dialogs load when first opened. -->
<ScriptDialog />
<ScriptFrames />
<svelte:window onresize={() => bridge.host.setViewport(window.innerHeight)} />

{#if ui.searchOpen}
  {#await import('./library/SearchDialog.svelte') then { default: SearchDialog }}<SearchDialog
      open
      onclose={() => (ui.searchOpen = false)}
    />{/await}
{/if}
{#if ui.urlImportOpen}
  {#await import('./library/UrlImportDialog.svelte') then { default: UrlImportDialog }}<UrlImportDialog
      open
      onclose={() => (ui.urlImportOpen = false)}
    />{/await}
{/if}
{#if ui.editingCharacterId}
  {#await import('./character/CharacterEditor.svelte') then { default: CharacterEditor }}<CharacterEditor
    />{/await}
{/if}
{#if ui.editingGroupId}
  {#await import('./group/GroupEditor.svelte') then { default: GroupEditor }}<GroupEditor />{/await}
{/if}
{#if ui.editingLorebookId}
  {#await import('./worldinfo/LorebookEditor.svelte') then { default: LorebookEditor }}<LorebookEditor
    />{/await}
{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns: var(--bt-rail-width) minmax(0, 1fr) 3rem;
    height: 100dvh;
  }
  .shell.panel-open {
    grid-template-columns: var(--bt-rail-width) minmax(0, 1fr) var(--bt-panel-width) 3rem;
  }
  .shell.narrow {
    grid-template-columns: minmax(0, 1fr);
  }
  .rail,
  .side,
  .main {
    min-height: 0;
    min-width: 0;
  }
  .dock {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding-top: 0.6rem;
    border-inline-start: 1px solid var(--bt-line);
    background: var(--bt-surface);
  }
  .dock .on {
    background: var(--bt-surface-3);
    color: var(--bt-accent);
  }
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--bt-scrim);
  }
  .sheet {
    position: fixed;
    z-index: 31;
    inset-block: 0;
    background: var(--bt-surface);
    animation: slide-in 180ms var(--bt-ease);
  }
  .sheet.left {
    inset-inline-start: 0;
    width: min(22rem, 88vw);
  }
  .sheet.full {
    inset: 0;
  }
  @keyframes slide-in {
    from {
      transform: translateX(-12px);
      opacity: 0;
    }
  }
</style>
