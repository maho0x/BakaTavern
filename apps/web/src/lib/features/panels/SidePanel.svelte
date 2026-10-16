<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { ui } from '../../state/ui.svelte.ts';
  import { connectionDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import type { Component } from 'svelte';

  import { panelTabs as tabs } from './tabs.ts';

  const textApi = $derived(settings.get('connection', connectionDefaults).api === 'text');

  /** Panels load when first shown, so they stay out of the first page load. */
  const panels: Record<string, () => Promise<{ default: Component }>> = {
    connection: () => import('./ConnectionPanel.svelte'),
    preset: () => import('./PresetPanel.svelte'),
    textPreset: () => import('./TextPresetPanel.svelte'),
    formatting: () => import('./FormattingPanel.svelte'),
    persona: () => import('./PersonaPanel.svelte'),
    worldinfo: () => import('./WorldInfoPanel.svelte'),
    regex: () => import('./RegexPanel.svelte'),
    settings: () => import('./SettingsPanel.svelte'),
  };
  const shown = $derived(ui.panel === 'preset' && textApi ? 'textPreset' : ui.panel);
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
    {#if shown && panels[shown]}
      {#key shown}
        {#await panels[shown]() then { default: Panel }}<Panel />{/await}
      {/key}
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
