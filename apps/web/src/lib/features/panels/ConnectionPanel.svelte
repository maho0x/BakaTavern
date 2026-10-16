<script lang="ts">
  import {
    adapterFor,
    getProvider,
    modelsRequest,
    parseModels,
    providerOrigins,
    providers,
    type ModelInfo,
  } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { activeConnection, rememberModels } from '../../generation/pipeline.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { connectionDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import KeyField from './KeyField.svelte';
  import ProfileBar from './ProfileBar.svelte';
  import TextConnection from './TextConnection.svelte';

  const prefs = $derived(settings.get('connection', connectionDefaults));
  const provider = $derived(getProvider(prefs.providerId) ?? providers[0]!);
  const endpoint = $derived(prefs.endpoints[provider.id] ?? Object.keys(provider.endpoints ?? {})[0] ?? '');
  const baseUrl = $derived(prefs.baseUrls[provider.id] ?? '');
  const effectiveBase = $derived(
    baseUrl || (endpoint ? provider.endpoints?.[endpoint] : undefined) || provider.baseUrl,
  );
  const model = $derived(prefs.models[provider.id] ?? provider.defaultModel ?? '');
  const secretId = $derived(prefs.secretIds[provider.id] ?? '');
  let models = $state<ModelInfo[]>([]);
  let loadingModels = $state(false);
  let testing = $state(false);

  function patch(field: 'models' | 'baseUrls' | 'endpoints' | 'secretIds', value: string) {
    settings.update('connection', { [field]: { ...prefs[field], [provider.id]: value } });
  }

  /** Source options, stored with SillyTavern's keys. */
  const sourceSettings = $derived(prefs.sourceSettings?.[provider.id] ?? {});
  function setSource(key: string, value: unknown) {
    settings.update('connection', {
      sourceSettings: { ...prefs.sourceSettings, [provider.id]: { ...sourceSettings, [key]: value } },
    });
  }
  const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '');
  const parseList = (text: string) =>
    text
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const customBody = $derived({ ...connectionDefaults.customBody, ...prefs.customBody });
  const yamlExamples = {
    include: 'top_k: 40\nmin_p: 0.05',
    exclude: '- frequency_penalty\n- presence_penalty',
    headers: 'X-Example: value',
  };
  function setCustomBody(key: 'include' | 'exclude' | 'headers', value: string) {
    settings.update('connection', { customBody: { ...customBody, [key]: value } });
  }

  async function loadModels() {
    const spec = modelsRequest(provider, effectiveBase);
    if (!spec) return;
    loadingModels = true;
    try {
      models = parseModels(provider, await api.proxyJson({ ...spec, secretId: secretId || undefined }));
      const connection = activeConnection();
      if (connection?.api === 'chat' && connection.provider.id === provider.id)
        rememberModels(connection, models);
      ui.toast(t('conn.modelsLoaded', { count: models.length }));
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      loadingModels = false;
    }
  }

  async function test() {
    testing = true;
    try {
      const spec = adapterFor(provider).buildRequest({
        provider,
        baseUrl: effectiveBase,
        model,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
        params: { max_tokens: 32 },
        names: { charName: '', userName: '', groupNames: [] },
      });
      const body = await api.proxyJson({ ...spec, secretId: secretId || undefined });
      const reply = adapterFor(provider).parseResponse(body);
      if (reply.error) throw new Error(reply.error);
      ui.toast(t('conn.testOk', { reply: (reply.text ?? '').slice(0, 80) }), 'success');
    } catch (error) {
      ui.toast(t('conn.testFailed', { message: errorText(error) }), 'error');
    } finally {
      testing = false;
    }
  }
</script>

<div class="stack">
  <ProfileBar />
  <div class="api" role="radiogroup" aria-label={t('conn.api')}>
    <button
      role="radio"
      aria-checked={prefs.api !== 'text'}
      onclick={() => settings.update('connection', { api: 'chat' })}>{t('conn.apiChat')}</button
    >
    <button
      role="radio"
      aria-checked={prefs.api === 'text'}
      onclick={() => settings.update('connection', { api: 'text' })}>{t('conn.apiText')}</button
    >
  </div>

  {#if prefs.api === 'text'}
    <TextConnection />
  {:else}
    <label class="field">
      <span>{t('conn.provider')}</span>
      <select
        class="select"
        value={provider.id}
        onchange={(e) => settings.update('connection', { providerId: e.currentTarget.value })}
      >
        {#each providers as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    </label>

    {#if provider.endpoints}
      <label class="field">
        <span>{t('conn.endpoint')}</span>
        <select class="select" value={endpoint} onchange={(e) => patch('endpoints', e.currentTarget.value)}>
          {#each Object.entries(provider.endpoints) as [id, url] (id)}<option value={id}
              >{id} · {new URL(url).host}</option
            >{/each}
        </select>
      </label>
    {/if}

    <label class="field">
      <span>{provider.id === 'custom' ? t('conn.baseUrl') : t('conn.proxyUrl')}</span>
      <input
        class="input"
        type="url"
        placeholder={provider.baseUrl || 'http://127.0.0.1:5001/v1'}
        value={baseUrl}
        onchange={(e) => patch('baseUrls', e.currentTarget.value.trim())}
      />
      <small>{provider.id === 'custom' ? t('conn.baseUrlHint') : t('conn.proxyUrlHint')}</small>
    </label>

    <KeyField
      providerId={provider.id}
      origins={providerOrigins(provider, effectiveBase)}
      {secretId}
      optional={!provider.keyRequired}
      onselect={(id) => patch('secretIds', id)}
    />

    <label class="field">
      <span>{t('conn.model')}</span>
      <div class="model">
        <input
          class="input"
          list="bt-models"
          value={model}
          onchange={(e) => patch('models', e.currentTarget.value.trim())}
        />
        <button class="btn" disabled={loadingModels || !provider.modelsPath} onclick={loadModels}
          ><Icon name="refresh" size={15} />{t('conn.loadModels')}</button
        >
      </div>
      <datalist id="bt-models">
        {#each models as m (m.id)}<option value={m.id}
            >{m.name}{m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k` : ''}</option
          >{/each}
      </datalist>
    </label>

    {#if provider.id === 'custom'}
      <details class="advanced">
        <summary>{t('conn.customAdvanced')}</summary>
        <p class="hint">{t('conn.customAdvancedHint')}</p>
        <label class="field"
          ><span>{t('conn.includeBody')}</span><textarea
            class="textarea code"
            rows="3"
            spellcheck="false"
            placeholder={yamlExamples.include}
            value={customBody.include}
            onchange={(e) => setCustomBody('include', e.currentTarget.value)}></textarea></label
        >
        <label class="field"
          ><span>{t('conn.excludeBody')}</span><textarea
            class="textarea code"
            rows="2"
            spellcheck="false"
            placeholder={yamlExamples.exclude}
            value={customBody.exclude}
            onchange={(e) => setCustomBody('exclude', e.currentTarget.value)}></textarea></label
        >
        <label class="field"
          ><span>{t('conn.includeHeaders')}</span><textarea
            class="textarea code"
            rows="2"
            spellcheck="false"
            placeholder={yamlExamples.headers}
            value={customBody.headers}
            onchange={(e) => setCustomBody('headers', e.currentTarget.value)}></textarea></label
        >
      </details>
    {/if}

    {#if provider.id === 'openrouter'}
      <details class="advanced">
        <summary>{t('conn.openrouterRouting')}</summary>
        <label class="field">
          <span>{t('conn.middleOut')}</span>
          <select
            class="select"
            value={String(sourceSettings.openrouter_middleout ?? 'on')}
            onchange={(e) => setSource('openrouter_middleout', e.currentTarget.value)}
          >
            <option value="auto">{t('conn.middleOutAuto')}</option>
            <option value="on">{t('conn.middleOutOn')}</option>
            <option value="off">{t('conn.middleOutOff')}</option>
          </select>
        </label>
        <label class="field"
          ><span>{t('conn.providerOrder')}</span><input
            class="input"
            placeholder="DeepInfra, Together"
            value={list(sourceSettings.openrouter_providers)}
            onchange={(e) => setSource('openrouter_providers', parseList(e.currentTarget.value))}
          /></label
        >
        <label class="check"
          ><input
            type="checkbox"
            checked={sourceSettings.openrouter_allow_fallbacks !== false}
            onchange={(e) => setSource('openrouter_allow_fallbacks', e.currentTarget.checked)}
          />{t('conn.allowFallbacks')}</label
        >
        <label class="field"
          ><span>{t('conn.quantizations')}</span><input
            class="input"
            placeholder="fp8, bf16"
            value={list(sourceSettings.openrouter_quantizations)}
            onchange={(e) => setSource('openrouter_quantizations', parseList(e.currentTarget.value))}
          /></label
        >
        <label class="check"
          ><input
            type="checkbox"
            checked={!!sourceSettings.openrouter_use_fallback}
            onchange={(e) => setSource('openrouter_use_fallback', e.currentTarget.checked)}
          />{t('conn.fallbackModels')}</label
        >
      </details>
    {/if}

    <button class="btn primary" disabled={testing || !model} onclick={test}
      >{testing ? t('conn.testing') : t('conn.test')}</button
    >
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }
  .api {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.2rem;
    padding: 0.2rem;
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface-2);
  }
  .api button {
    padding: 0.45rem 0.5rem;
    border: 0;
    border-radius: calc(var(--bt-radius-sm) - 2px);
    background: transparent;
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-sm);
  }
  .api button[aria-checked='true'] {
    background: var(--bt-surface);
    color: var(--bt-ink);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
  }
  .model {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .model .input {
    flex: 1;
    min-width: 0;
  }
  .advanced {
    display: grid;
    gap: 0.6rem;
  }
  .advanced summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .advanced > :not(summary) {
    margin-top: 0.4rem;
  }
  .hint {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
</style>
