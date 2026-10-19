<script lang="ts">
  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { uiDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { THEME_KIND, themeFromSt } from '../../state/themes.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived({ ...uiDefaults, ...settings.get('ui', uiDefaults) });
  const themes = $derived(
    library.presets.filter((p) => p.kind === THEME_KIND).sort((a, b) => a.name.localeCompare(b.name)),
  );
  let fileInput = $state<HTMLInputElement>();

  /** Uses a theme (its colors and display options), or none: the built-in colors. */
  async function apply(name: string) {
    try {
      if (!name) {
        settings.update('ui', { themeName: null, themeColors: {} });
        return;
      }
      const info = themes.find((p) => p.name === name);
      if (!info) return;
      const style = themeFromSt((await api.getPreset(info.id)).data);
      settings.update('ui', { ...style.ui, themeName: name, themeColors: style.colors });
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function importThemes(files: FileList | null) {
    let last = '';
    for (const file of files ?? []) {
      try {
        const data = JSON.parse(await file.text()) as Record<string, unknown>;
        if (!data || typeof data !== 'object' || !('main_text_color' in data || 'blur_tint_color' in data)) {
          throw new Error(t('theme.notTheme'));
        }
        const name = String(data.name || file.name.replace(/\.json$/i, ''));
        await api.upsertPreset(THEME_KIND, name, data);
        last = name;
      } catch (error) {
        ui.toast(t('theme.importFailed', { file: file.name, message: errorText(error) }), 'error');
      }
    }
    if (fileInput) fileInput.value = '';
    if (!last) return;
    await library.refreshPresets();
    await apply(last);
    ui.toast(t('theme.applied', { name: last }), 'success');
  }
</script>

<label class="field">
  <span>{t('theme.colors')}</span>
  <span class="row">
    <select class="select" value={prefs.themeName ?? ''} onchange={(e) => apply(e.currentTarget.value)}>
      <option value="">{t('theme.builtIn')}</option>
      {#each themes as theme (theme.id)}<option value={theme.name}>{theme.name}</option>{/each}
    </select>
    <button
      class="icon-btn"
      type="button"
      title={t('theme.import')}
      aria-label={t('theme.import')}
      onclick={() => fileInput?.click()}><Icon name="upload" size={16} /></button
    >
  </span>
</label>
<input
  bind:this={fileInput}
  type="file"
  accept=".json,application/json"
  multiple
  hidden
  onchange={(e) => importThemes(e.currentTarget.files)}
/>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .row .select {
    flex: 1;
  }
</style>
