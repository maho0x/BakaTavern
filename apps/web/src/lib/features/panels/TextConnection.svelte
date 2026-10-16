<script lang="ts">
  import {
    getTextgenType,
    parseTextgenModels,
    textgenAdapter,
    textgenGenerateData,
    textgenModelsRequest,
    textgenOrigins,
    textgenRequest,
    textgenTypes,
  } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import {
    activeTextSettings,
    macros,
    textPrefs,
    type ActiveTextConnection,
  } from '../../generation/pipeline.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { connectionDefaults, type TextConnectionPrefs } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import KeyField from './KeyField.svelte';

  const prefs = $derived(textPrefs(settings.get('connection', connectionDefaults)));
  const type = $derived(getTextgenType(prefs.type) ?? textgenTypes[0]!);
  const serverUrl = $derived(type.server ?? prefs.serverUrls[type.id] ?? '');
  const model = $derived(prefs.models[type.id] ?? type.defaultModel ?? '');
  const secretId = $derived(prefs.secretIds[type.id] ?? '');
  const options = $derived(prefs.settings);

  let models = $state<string[]>([]);
  let loadingModels = $state(false);
  let testing = $state(false);

  function update(patch: Partial<TextConnectionPrefs>) {
    settings.update('connection', { text: { ...prefs, ...patch } });
  }
  function patch(field: 'serverUrls' | 'models' | 'secretIds', value: string) {
    update({ [field]: { ...prefs[field], [type.id]: value } });
  }
  function setOption(key: string, value: unknown) {
    update({ settings: { ...options, [key]: value } });
  }
  const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '');
  const parseList = (text: string) =>
    text
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  function connection(): ActiveTextConnection {
    return { api: 'text', type, model, serverUrl, secretId: secretId || undefined, prefs };
  }

  async function loadModels() {
    const spec = textgenModelsRequest(type.id, serverUrl);
    if (!spec) return;
    loadingModels = true;
    try {
      models = parseTextgenModels(type.id, await api.proxyJson({ ...spec, secretId: secretId || undefined }));
      ui.toast(t('conn.modelsLoaded', { count: models.length }));
      if (!model && models[0] && type.modelSetting) patch('models', models[0]);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      loadingModels = false;
    }
  }

  async function test() {
    testing = true;
    try {
      const data = textgenGenerateData({
        settings: await activeTextSettings(connection()),
        prompt: 'Hello',
        maxTokens: 16,
        maxContext: prefs.maxContext,
        type: 'quiet',
        stoppingStrings: [],
        substitute: (text) => macros.evaluate(text, { user: 'User', char: 'Assistant' }),
        stream: false,
      });
      const body = await api.proxyJson({ ...textgenRequest(data), secretId: secretId || undefined });
      const reply = textgenAdapter(type.id).parseResponse(body);
      if (reply.error) throw new Error(reply.error);
      ui.toast(t('conn.testOk', { reply: (reply.text ?? '').slice(0, 80) }), 'success');
    } catch (error) {
      ui.toast(t('conn.testFailed', { message: errorText(error) }), 'error');
    } finally {
      testing = false;
    }
  }
</script>

<label class="field">
  <span>{t('conn.backend')}</span>
  <select class="select" value={type.id} onchange={(e) => update({ type: e.currentTarget.value })}>
    {#each textgenTypes as tg (tg.id)}<option value={tg.id}>{tg.name}</option>{/each}
  </select>
</label>

{#if !type.server}
  <label class="field">
    <span>{t('conn.serverUrl')}</span>
    <input
      class="input"
      type="url"
      placeholder={type.exampleUrl ?? 'http://127.0.0.1:5000'}
      value={serverUrl}
      onchange={(e) => patch('serverUrls', e.currentTarget.value.trim())}
    />
    <small>{t('conn.serverUrlHint')}</small>
  </label>
{/if}

<KeyField
  providerId={type.id}
  origins={textgenOrigins(type, serverUrl)}
  {secretId}
  optional={!type.keyRequired}
  onselect={(id) => patch('secretIds', id)}
/>

<div class="field">
  <span>{type.modelSetting ? t('conn.model') : t('conn.modelInfo')}</span>
  <div class="model">
    {#if type.modelSetting}
      <input
        class="input"
        list="bt-text-models"
        aria-label={t('conn.model')}
        value={model}
        placeholder={type.modelRequired ? '' : t('conn.modelOptional')}
        onchange={(e) => patch('models', e.currentTarget.value.trim())}
      />
    {:else}
      <span class="loaded">{models[0] ?? '—'}</span>
    {/if}
    <button class="btn" disabled={loadingModels || !serverUrl} onclick={loadModels}
      ><Icon name="refresh" size={15} />{t('conn.loadModels')}</button
    >
  </div>
  <datalist id="bt-text-models">
    {#each models as id (id)}<option value={id}></option>{/each}
  </datalist>
</div>

<label class="check"
  ><input
    type="checkbox"
    checked={prefs.streaming}
    onchange={(e) => update({ streaming: e.currentTarget.checked })}
  />{t('preset.stream')}</label
>

{#if type.id === 'openrouter'}
  <details class="advanced">
    <summary>{t('conn.openrouterRouting')}</summary>
    <label class="field"
      ><span>{t('conn.providerOrder')}</span><input
        class="input"
        placeholder="DeepInfra, Together"
        value={list(options.openrouter_providers)}
        onchange={(e) => setOption('openrouter_providers', parseList(e.currentTarget.value))}
      /></label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={options.openrouter_allow_fallbacks !== false}
        onchange={(e) => setOption('openrouter_allow_fallbacks', e.currentTarget.checked)}
      />{t('conn.allowFallbacks')}</label
    >
    <label class="field"
      ><span>{t('conn.quantizations')}</span><input
        class="input"
        placeholder="fp8, bf16"
        value={list(options.openrouter_quantizations)}
        onchange={(e) => setOption('openrouter_quantizations', parseList(e.currentTarget.value))}
      /></label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={options.include_reasoning !== false}
        onchange={(e) => setOption('include_reasoning', e.currentTarget.checked)}
      />{t('preset.showThoughts')}</label
    >
  </details>
{/if}

<button class="btn primary" disabled={testing || !serverUrl || (type.modelRequired && !model)} onclick={test}
  >{testing ? t('conn.testing') : t('conn.test')}</button
>

<style>
  .model {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .model .input,
  .model .loaded {
    flex: 1;
    min-width: 0;
  }
  .loaded {
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
</style>
