<script lang="ts">
  import Icon, { type IconName } from '../../components/Icon.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { ui, type PanelId } from '../../state/ui.svelte.ts';
  import ConnectionPanel from './ConnectionPanel.svelte';
  import PersonaPanel from './PersonaPanel.svelte';
  import PresetPanel from './PresetPanel.svelte';
  import SettingsPanel from './SettingsPanel.svelte';
  import WorldInfoPanel from './WorldInfoPanel.svelte';

  const tabs: { id: PanelId; icon: IconName; label: MessageKey }[] = [
    { id: 'connection', icon: 'plug', label: 'panel.connection' },
    { id: 'preset', icon: 'sliders', label: 'panel.preset' },
    { id: 'persona', icon: 'user', label: 'panel.persona' },
    { id: 'worldinfo', icon: 'book', label: 'panel.worldinfo' },
    { id: 'settings', icon: 'gear', label: 'panel.settings' },
  ];
</script>

<aside class="panel" aria-label={ui.panel ? t(`panel.${ui.panel}` as MessageKey) : undefined}>
  <header>
    <div class="tabs" role="tablist">
      {#each tabs as tab (tab.id)}
        <button
          class="tab"
          role="tab"
          aria-selected={ui.panel === tab.id}
          title={t(tab.label)}
          onclick={() => (ui.panel = tab.id)}
        >
          <Icon name={tab.icon} />
          <span class="tab-label">{t(tab.label)}</span>
        </button>
      {/each}
    </div>
    <button class="icon-btn" aria-label={t('common.close')} onclick={() => (ui.panel = null)}
      ><Icon name="close" /></button
    >
  </header>
  <div class="content" role="tabpanel">
    {#if ui.panel === 'connection'}<ConnectionPanel />
    {:else if ui.panel === 'preset'}<PresetPanel />
    {:else if ui.panel === 'persona'}<PersonaPanel />
    {:else if ui.panel === 'worldinfo'}<WorldInfoPanel />
    {:else if ui.panel === 'settings'}<SettingsPanel />
    {/if}
  </div>
</aside>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100%;
    min-height: 0;
    background: var(--bt-surface);
    border-inline-start: 1px solid var(--bt-line);
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.4rem 0.4rem 0.4rem 0.5rem;
    padding-top: calc(0.4rem + env(safe-area-inset-top));
    border-bottom: 1px solid var(--bt-line);
  }
  .tabs {
    flex: 1;
    display: flex;
    gap: 0.15rem;
    overflow-x: auto;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.45rem 0.55rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-xs);
    white-space: nowrap;
  }
  .tab[aria-selected='true'] {
    background: var(--bt-surface-3);
    color: var(--bt-ink);
  }
  .tab-label {
    display: none;
  }
  .tab[aria-selected='true'] .tab-label {
    display: inline;
  }
  .content {
    overflow-y: auto;
    min-height: 0;
    padding: 1rem;
  }
</style>
