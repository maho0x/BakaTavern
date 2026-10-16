<script lang="ts">
  import type { StImportReport } from '@bakatavern/api-client';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { i18n, locales, t, type Locale, type MessageKey } from '../../i18n/index.svelte.ts';
  import { toStSettings } from '../../migration/st-settings.ts';
  import { library } from '../../state/library.svelte.ts';
  import {
    chatDefaults,
    connectionDefaults,
    formattingDefaults,
    logitBiasDefaults,
    noteDefaults,
    personaDefaults,
    regexDefaults,
    uiDefaults,
    worldInfoDefaults,
    type UiPrefs,
  } from '../../state/prefs.ts';
  import { profileDefaults } from '../../state/profiles.ts';
  import { applyPendingImport, session } from '../../state/session.svelte.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived(settings.get('ui', uiDefaults));
  const chatPrefs = $derived(settings.get('chat', chatDefaults));

  const setUi = (patch: Partial<UiPrefs>) => settings.update('ui', patch);

  let importInput = $state<HTMLInputElement>();
  let importSecrets = $state(false);
  let importing = $state(false);
  let report = $state<StImportReport | null>(null);

  async function runImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    importing = true;
    report = null;
    try {
      report = await api.importSillyTavern(file, { secrets: importSecrets });
      await session.refresh();
      await applyPendingImport();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      importing = false;
      if (importInput) importInput.value = '';
    }
  }

  const skippedName = (kind: string) => t(`import.kind.${kind}` as MessageKey);

  let exporting = $state(false);
  async function runExport() {
    exporting = true;
    try {
      const names = await api.stExportNames();
      const formatting = { ...formattingDefaults, ...settings.get('formatting', formattingDefaults) };
      const connection = settings.get('connection', connectionDefaults);
      const template = async (kind: string, id: string | null | undefined, fallback?: string) => {
        const list = library.presets.filter((p) => p.kind === kind);
        const info = list.find((p) => p.id === id) ?? list.find((p) => p.name === fallback) ?? list[0];
        return info ? { name: info.name, data: (await api.getPreset(info.id)).data } : undefined;
      };
      const [instruct, context, sysprompt, textgen] = await Promise.all([
        template('instruct', formatting.instructId, 'Alpaca'),
        template('context', formatting.contextId, 'Default'),
        template('sysprompt', formatting.syspromptId, 'Neutral - Chat'),
        template('textgen', connection.text?.presetId, 'Default'),
      ]);
      const stSettings = toStSettings({
        formatting,
        logitbias: settings.get('logitbias', logitBiasDefaults),
        profiles: settings.get('profiles', profileDefaults),
        templates: { instruct, context, sysprompt, textgen },
        names,
        connection: settings.get('connection', connectionDefaults),
        chat: settings.get('chat', chatDefaults),
        worldinfo: settings.get('worldinfo', worldInfoDefaults),
        note: settings.get('note', noteDefaults),
        persona: settings.get('persona', personaDefaults),
        regex: settings.get('regex', regexDefaults),
        variables: settings.get('variables', {}) as Record<string, unknown>,
        presetNames: Object.fromEntries(
          library.presets.filter((p) => p.kind === 'openai').map((p) => [p.id, p.name]),
        ),
      });
      const blob = await api.exportSillyTavern(stSettings);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob),
        download: 'sillytavern-data.zip',
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      exporting = false;
    }
  }

  async function changePassword() {
    const current = session.user?.hasPassword
      ? (prompt(t('settings.currentPassword')) ?? undefined)
      : undefined;
    const next = prompt(t('settings.newPassword'));
    if (!next) return;
    try {
      await api.changePassword(current, next);
      ui.toast(t('settings.passwordChanged'), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<div class="stack">
  <section>
    <h3>{t('settings.appearance')}</h3>
    <label class="field">
      <span>{t('settings.language')}</span>
      <select class="select" value={i18n.locale} onchange={(e) => i18n.set(e.currentTarget.value as Locale)}>
        {#each locales as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
    </label>
    <label class="field">
      <span>{t('settings.theme')}</span>
      <select
        class="select"
        value={prefs.theme}
        onchange={(e) => setUi({ theme: e.currentTarget.value as UiPrefs['theme'] })}
      >
        <option value="auto">{t('settings.themeAuto')}</option>
        <option value="night">{t('settings.themeNight')}</option>
        <option value="day">{t('settings.themeDay')}</option>
      </select>
    </label>
    <label class="field">
      <span>{t('settings.textSize', { value: Math.round(prefs.textScale * 100) })}</span>
      <input
        type="range"
        min="0.8"
        max="1.4"
        step="0.05"
        value={prefs.textScale}
        oninput={(e) => setUi({ textScale: Number(e.currentTarget.value) })}
      />
    </label>
    <label class="field">
      <span>{t('settings.chatWidth', { value: prefs.chatWidth })}</span>
      <input
        type="range"
        min="32"
        max="80"
        step="1"
        value={prefs.chatWidth}
        oninput={(e) => setUi({ chatWidth: Number(e.currentTarget.value) })}
      />
    </label>
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.showTimestamps}
        onchange={(e) => setUi({ showTimestamps: e.currentTarget.checked })}
      />{t('settings.timestamps')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.showTokenCounts}
        onchange={(e) => setUi({ showTokenCounts: e.currentTarget.checked })}
      />{t('settings.tokenCounts')}</label
    >
  </section>

  <section>
    <h3>{t('settings.messages')}</h3>
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.renderHtml}
        onchange={(e) => setUi({ renderHtml: e.currentTarget.checked })}
      />{t('settings.renderHtml')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.externalMedia}
        onchange={(e) => setUi({ externalMedia: e.currentTarget.checked })}
      />{t('settings.externalMedia')}</label
    >
    <label class="field">
      <span>{t('settings.mediaDisplay')}</span>
      <select
        class="select"
        value={prefs.mediaDisplay ?? 'list'}
        onchange={(e) => setUi({ mediaDisplay: e.currentTarget.value as 'list' | 'gallery' })}
      >
        <option value="list">{t('settings.mediaList')}</option>
        <option value="gallery">{t('settings.mediaGallery')}</option>
      </select>
    </label>
    <label class="check"
      ><input
        type="checkbox"
        checked={chatPrefs.sendOnEnter}
        onchange={(e) => settings.update('chat', { sendOnEnter: e.currentTarget.checked })}
      />{t('settings.sendOnEnter')}</label
    >
    <label class="field">
      <span>{t('settings.promptBias')}</span>
      <input
        class="input"
        value={chatPrefs.promptBias}
        onchange={(e) => settings.update('chat', { promptBias: e.currentTarget.value })}
      />
      <small>{t('settings.promptBiasHint')}</small>
    </label>
    <label class="field">
      <span>{t('settings.stopStrings')}</span>
      <textarea
        class="textarea"
        rows="3"
        value={chatPrefs.stoppingStrings.join('\n')}
        onchange={(e) =>
          settings.update('chat', {
            stoppingStrings: e.currentTarget.value.split('\n').filter((s) => s.length),
          })}></textarea>
      <small>{t('settings.stopStringsHint')}</small>
    </label>
    <label class="check"
      ><input
        type="checkbox"
        checked={chatPrefs.reasoningAutoParse}
        onchange={(e) => settings.update('chat', { reasoningAutoParse: e.currentTarget.checked })}
      />{t('settings.reasoningParse')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={chatPrefs.reasoningAddToPrompts}
        onchange={(e) => settings.update('chat', { reasoningAddToPrompts: e.currentTarget.checked })}
      />{t('settings.reasoningAddToPrompts')}</label
    >
    {#if chatPrefs.reasoningAddToPrompts}
      <label class="field"
        ><span>{t('settings.reasoningMaxAdditions')}</span><input
          class="input"
          type="number"
          min="0"
          value={chatPrefs.reasoningMaxAdditions}
          onchange={(e) => settings.update('chat', { reasoningMaxAdditions: Number(e.currentTarget.value) })}
        /></label
      >
    {/if}
    {#if chatPrefs.reasoningAutoParse || chatPrefs.reasoningAddToPrompts}
      <!-- Textareas: templates may contain line breaks (e.g. "<think>" + newline). -->
      <div class="pair">
        <label class="field"
          ><span>{t('settings.reasoningPrefix')}</span><textarea
            class="textarea code"
            rows="2"
            spellcheck="false"
            value={chatPrefs.reasoningPrefix}
            onchange={(e) => settings.update('chat', { reasoningPrefix: e.currentTarget.value })}
          ></textarea></label
        >
        <label class="field"
          ><span>{t('settings.reasoningSuffix')}</span><textarea
            class="textarea code"
            rows="2"
            spellcheck="false"
            value={chatPrefs.reasoningSuffix}
            onchange={(e) => settings.update('chat', { reasoningSuffix: e.currentTarget.value })}
          ></textarea></label
        >
      </div>
      {#if chatPrefs.reasoningAddToPrompts}
        <label class="field"
          ><span>{t('settings.reasoningSeparator')}</span><textarea
            class="textarea code"
            rows="2"
            spellcheck="false"
            value={chatPrefs.reasoningSeparator}
            onchange={(e) => settings.update('chat', { reasoningSeparator: e.currentTarget.value })}
          ></textarea></label
        >
      {/if}
    {/if}
  </section>

  <section>
    <h3>{t('settings.customCss')}</h3>
    <textarea
      class="textarea code"
      rows="6"
      spellcheck="false"
      value={prefs.customCss}
      onchange={(e) => setUi({ customCss: e.currentTarget.value })}></textarea>
    <small class="faint">{t('settings.customCssHint')}</small>
  </section>

  <section>
    <h3>{t('import.title')}</h3>
    <p class="faint hint">{t('import.intro')}</p>
    <label class="check"><input type="checkbox" bind:checked={importSecrets} />{t('import.secrets')}</label>
    <div class="actions">
      <button class="btn" disabled={importing} onclick={() => importInput?.click()}
        ><Icon name="upload" size={15} />{importing ? t('import.running') : t('import.choose')}</button
      >
    </div>
    <p class="faint hint">{t('export.intro')}</p>
    <div class="actions">
      <button class="btn" disabled={exporting} onclick={runExport}
        ><Icon name="download" size={15} />{exporting ? t('export.running') : t('export.button')}</button
      >
    </div>
    <input
      bind:this={importInput}
      type="file"
      accept=".zip,application/zip"
      hidden
      onchange={(e) => runImport(e.currentTarget.files)}
    />
    {#if report}
      <div class="report" role="status">
        <p>
          {t('import.summary', {
            characters: report.characters,
            chats: report.chats,
            lorebooks: report.lorebooks,
            presets: report.presets,
            personas: report.personas,
            attachments: report.attachments,
            secrets: report.secrets,
          })}
        </p>
        {#if report.unchanged}<p class="faint">{t('import.unchanged', { count: report.unchanged })}</p>{/if}
        {#if Object.keys(report.skipped).length}
          <p class="faint">
            {t('import.skipped', {
              list: Object.entries(report.skipped)
                .map(([kind, n]) => `${skippedName(kind)} ${n}`)
                .join(', '),
            })}
          </p>
        {/if}
        {#if report.failures.length}
          <p>{t('import.failures')}</p>
          <ul>
            {#each report.failures.slice(0, 20) as failure (failure.file)}<li>
                <code>{failure.file}</code>: {failure.message}
              </li>{/each}
          </ul>
        {/if}
      </div>
    {/if}
  </section>

  <section>
    <h3>{t('settings.account')}</h3>
    <div class="actions">
      <button class="btn" onclick={changePassword}
        >{session.user?.hasPassword ? t('settings.changePassword') : t('settings.setPassword')}</button
      >
      {#if session.authRequired}<button class="btn" onclick={() => session.logout()}
          >{t('settings.logout')}</button
        >{/if}
    </div>
    <p class="faint version">BakaTavern {session.version}</p>
  </section>
</div>

<style>
  .stack {
    display: grid;
    gap: 1.4rem;
  }
  section {
    display: grid;
    gap: 0.65rem;
  }
  h3 {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .version {
    font-size: var(--bt-size-xs);
  }
  .hint {
    font-size: var(--bt-size-xs);
  }
  .report {
    display: grid;
    gap: 0.35rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    font-size: var(--bt-size-sm);
  }
  .report ul {
    padding-inline-start: 1.1rem;
    font-size: var(--bt-size-xs);
  }
</style>
