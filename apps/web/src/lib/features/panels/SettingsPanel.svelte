<script lang="ts">
  import { api } from '../../api.ts';
  import { i18n, locales, t, type Locale } from '../../i18n/index.svelte.ts';
  import { chatDefaults, uiDefaults, type UiPrefs } from '../../state/prefs.ts';
  import { session } from '../../state/session.svelte.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived(settings.get('ui', uiDefaults));
  const chatPrefs = $derived(settings.get('chat', chatDefaults));

  const setUi = (patch: Partial<UiPrefs>) => settings.update('ui', patch);

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
    {#if chatPrefs.reasoningAutoParse}
      <div class="pair">
        <label class="field"
          ><span>{t('settings.reasoningPrefix')}</span><input
            class="input"
            value={chatPrefs.reasoningPrefix}
            onchange={(e) => settings.update('chat', { reasoningPrefix: e.currentTarget.value })}
          /></label
        >
        <label class="field"
          ><span>{t('settings.reasoningSuffix')}</span><input
            class="input"
            value={chatPrefs.reasoningSuffix}
            onchange={(e) => settings.update('chat', { reasoningSuffix: e.currentTarget.value })}
          /></label
        >
      </div>
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
  .code {
    font-family: var(--bt-font-mono);
    font-size: var(--bt-size-sm);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .version {
    font-size: var(--bt-size-xs);
  }
</style>
