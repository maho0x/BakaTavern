<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { t, type MessageKey } from '../i18n/index.svelte.ts';
  import { errorText, ui } from '../state/ui.svelte.ts';
  import { pluginExtensions, type PluginSettingsSection } from './extensions.svelte.ts';
  import { plugins } from './host.svelte.ts';

  let fileInput = $state<HTMLInputElement>();
  let url = $state('');
  let installing = $state(false);

  async function install(load: () => Promise<{ code: string; source: string }>) {
    installing = true;
    try {
      const { code, source } = await load();
      if (await plugins.install(code, source)) ui.toast(t('plugins.installed'), 'success');
    } catch (error) {
      ui.toast(t('plugins.installFailed', { message: errorText(error) }), 'error');
    } finally {
      installing = false;
    }
  }

  function fromFile(files: FileList | null) {
    const file = files?.[0];
    if (fileInput) fileInput.value = '';
    if (!file) return;
    void install(async () => ({ code: await file.text(), source: file.name }));
  }

  function fromUrl() {
    const address = url.trim();
    if (!address) return;
    void install(async () => {
      const response = await fetch(address);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      url = '';
      return { code: await response.text(), source: address };
    });
  }

  function uninstall(id: string, name: string) {
    if (confirm(t('plugins.uninstallConfirm', { name }))) plugins.uninstall(id);
  }

  /** Mounts a plugin's settings section into its element. */
  function section(element: HTMLElement, entry: PluginSettingsSection) {
    let cleanup: void | (() => void);
    try {
      cleanup = entry.mount(element);
    } catch (error) {
      element.textContent = errorText(error);
    }
    return { destroy: () => (typeof cleanup === 'function' ? cleanup() : undefined) };
  }
</script>

<div class="stack">
  <section class="card" aria-label={t('plugins.install')}>
    <h3>{t('plugins.install')}</h3>
    <p class="faint">{t('plugins.installHint')}</p>
    <div class="row">
      <input
        class="input"
        type="url"
        placeholder="https://…/plugin.js"
        aria-label={t('plugins.url')}
        bind:value={url}
        onkeydown={(e) => e.key === 'Enter' && fromUrl()}
      />
      <button class="btn" disabled={installing || !url.trim()} onclick={fromUrl}
        >{t('plugins.installUrl')}</button
      >
    </div>
    <button class="btn" disabled={installing} onclick={() => fileInput?.click()}
      ><Icon name="upload" size={15} />{t('plugins.installFile')}</button
    >
    <input
      bind:this={fileInput}
      type="file"
      accept=".js,.mjs,text/javascript"
      hidden
      onchange={(e) => fromFile(e.currentTarget.files)}
    />
  </section>

  {#if plugins.installed.length === 0}
    <p class="faint">{t('plugins.none')}</p>
  {/if}
  {#each plugins.installed as plugin (plugin.id)}
    <section class="card" aria-label={plugin.name}>
      <div class="row">
        <label class="check grow"
          ><input
            type="checkbox"
            checked={plugin.enabled}
            aria-label="{t('plugins.enabled')}: {plugin.name}"
            onchange={(e) => void plugins.setEnabled(plugin.id, e.currentTarget.checked)}
          /><strong>{plugin.name}</strong>
          <span class="faint">{plugin.version}</span></label
        >
        <button
          class="icon-btn small"
          title={t('plugins.uninstall')}
          aria-label="{t('plugins.uninstall')}: {plugin.name}"
          onclick={() => uninstall(plugin.id, plugin.name)}><Icon name="trash" size={15} /></button
        >
      </div>
      {#if plugin.description}<p>{plugin.description}</p>{/if}
      {#if plugin.permissions.length}
        <ul class="perms">
          {#each plugin.permissions as permission (permission)}
            <li>{t(`plugins.perm.${permission}` as MessageKey)}</li>
          {/each}
        </ul>
      {/if}
      {#if plugins.errors[plugin.id]}
        <p class="error" role="alert">{plugins.errors[plugin.id]}</p>
      {/if}
      {#each pluginExtensions.settings.filter((s) => s.plugin === plugin.id) as entry (entry.key)}
        <div class="plugin-settings" use:section={entry}></div>
      {/each}
    </section>
  {/each}
</div>

<style>
  .stack {
    display: grid;
    gap: 0.75rem;
    padding: 0.75rem;
  }
  .card {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    font-size: var(--bt-size-sm);
  }
  h3 {
    font-size: var(--bt-size-sm);
    font-weight: 650;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .perms {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .perms li {
    padding: 0.1rem 0.5rem;
    border: 1px solid var(--bt-line);
    border-radius: 999px;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-soft, var(--bt-ink));
  }
  .faint {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-xs);
  }
  .error {
    color: var(--bt-danger, #d33);
  }
</style>
