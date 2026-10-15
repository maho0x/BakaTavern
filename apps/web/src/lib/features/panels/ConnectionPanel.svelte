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
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { connectionDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  const prefs = $derived(settings.get('connection', connectionDefaults));
  const provider = $derived(getProvider(prefs.providerId) ?? providers[0]!);
  const endpoint = $derived(prefs.endpoints[provider.id] ?? Object.keys(provider.endpoints ?? {})[0] ?? '');
  const baseUrl = $derived(prefs.baseUrls[provider.id] ?? '');
  const effectiveBase = $derived(
    baseUrl || (endpoint ? provider.endpoints?.[endpoint] : undefined) || provider.baseUrl,
  );
  const model = $derived(prefs.models[provider.id] ?? provider.defaultModel ?? '');
  const secretId = $derived(prefs.secretIds[provider.id] ?? '');
  const secret = $derived(library.secrets.find((s) => s.id === secretId));
  const keysForProvider = $derived(library.secrets.filter((s) => s.provider === provider.id));

  let keyInput = $state('');
  let models = $state<ModelInfo[]>([]);
  let loadingModels = $state(false);
  let testing = $state(false);

  function patch(field: 'models' | 'baseUrls' | 'endpoints' | 'secretIds', value: string) {
    settings.update('connection', { [field]: { ...prefs[field], [provider.id]: value } });
  }

  async function saveKey() {
    const value = keyInput.trim();
    if (!value) return;
    try {
      const origins = providerOrigins(provider, effectiveBase);
      if (!origins.length) throw new Error(t('conn.needBaseUrl'));
      const created = await api.createSecret({ provider: provider.id, value, allowedOrigins: origins });
      library.secrets.push(created);
      patch('secretIds', created.id);
      keyInput = '';
      ui.toast(t('conn.keySaved'), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function removeKey() {
    if (!secret || !confirm(t('conn.removeKeyConfirm'))) return;
    await api.deleteSecret(secret.id);
    library.secrets = library.secrets.filter((s) => s.id !== secret.id);
    patch('secretIds', '');
  }

  /** Keeps a key usable after the base URL changes by allowing the new origin. */
  async function allowCurrentOrigin() {
    if (!secret) return;
    const origins = [...new Set([...secret.allowedOrigins, ...providerOrigins(provider, effectiveBase)])];
    const updated = await api.updateSecret(secret.id, { allowedOrigins: origins });
    library.secrets = library.secrets.map((s) => (s.id === updated.id ? updated : s));
  }

  const originAllowed = $derived(
    !secret || providerOrigins(provider, effectiveBase).every((o) => secret.allowedOrigins.includes(o)),
  );

  async function loadModels() {
    const spec = modelsRequest(provider, effectiveBase);
    if (!spec) return;
    loadingModels = true;
    try {
      models = parseModels(provider, await api.proxyJson({ ...spec, secretId: secretId || undefined }));
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

  <div class="field">
    <span>{t('conn.apiKey')}</span>
    {#if keysForProvider.length > 1}
      <select class="select" value={secretId} onchange={(e) => patch('secretIds', e.currentTarget.value)}>
        {#each keysForProvider as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
      </select>
    {/if}
    {#if secret}
      <div class="key">
        <code>{secret.masked}</code>
        <button class="btn ghost danger" onclick={removeKey}
          ><Icon name="trash" size={15} />{t('conn.removeKey')}</button
        >
      </div>
      {#if !originAllowed}
        <p class="warn">
          {t('conn.originNotAllowed')}
          <button class="btn" onclick={allowCurrentOrigin}>{t('conn.allowOrigin')}</button>
        </p>
      {/if}
    {/if}
    <div class="key-input">
      <input
        class="input"
        type="password"
        autocomplete="off"
        placeholder={secret ? t('conn.replaceKey') : t('conn.pasteKey')}
        bind:value={keyInput}
      />
      <button class="btn" disabled={!keyInput.trim()} onclick={saveKey}>{t('common.save')}</button>
    </div>
    <small>{t('conn.keyHint')}</small>
  </div>

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

  <button class="btn primary" disabled={testing || !model} onclick={test}
    >{testing ? t('conn.testing') : t('conn.test')}</button
  >
</div>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }
  .key,
  .key-input,
  .model {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .key code {
    flex: 1;
    color: var(--bt-ink-muted);
  }
  .key-input .input,
  .model .input {
    flex: 1;
    min-width: 0;
  }
  .warn {
    font-size: var(--bt-size-xs);
    color: var(--bt-danger);
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
</style>
