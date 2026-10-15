<script lang="ts">
  import Icon, { type IconName } from '../components/Icon.svelte';
  import { t, type MessageKey } from '../i18n/index.svelte.ts';
  import { ui, type PanelId } from '../state/ui.svelte.ts';
  import CharacterEditor from './character/CharacterEditor.svelte';
  import ChatPane from './chat/ChatPane.svelte';
  import LibraryRail from './library/LibraryRail.svelte';
  import SidePanel from './panels/SidePanel.svelte';

  const dock: { id: PanelId; icon: IconName; label: MessageKey }[] = [
    { id: 'connection', icon: 'plug', label: 'panel.connection' },
    { id: 'preset', icon: 'sliders', label: 'panel.preset' },
    { id: 'persona', icon: 'user', label: 'panel.persona' },
    { id: 'worldinfo', icon: 'book', label: 'panel.worldinfo' },
    { id: 'settings', icon: 'gear', label: 'panel.settings' },
  ];
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

<CharacterEditor />

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
