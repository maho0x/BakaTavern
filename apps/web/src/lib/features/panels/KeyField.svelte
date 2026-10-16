<script lang="ts">
  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    /** Keys are listed per provider (or Text Completion backend). */
    providerId: string;
    /** Origins the key may be sent to. */
    origins: string[];
    secretId: string;
    onselect: (id: string) => void;
    /** The backend works without a key. */
    optional?: boolean;
  }

  let { providerId, origins, secretId, onselect, optional = false }: Props = $props();

  const secret = $derived(library.secrets.find((s) => s.id === secretId));
  const keys = $derived(library.secrets.filter((s) => s.provider === providerId));
  const originAllowed = $derived(!secret || origins.every((o) => secret.allowedOrigins.includes(o)));
  let keyInput = $state('');

  async function save() {
    const value = keyInput.trim();
    if (!value) return;
    try {
      if (!origins.length) throw new Error(t('conn.needBaseUrl'));
      const created = await api.createSecret({ provider: providerId, value, allowedOrigins: origins });
      library.secrets.push(created);
      onselect(created.id);
      keyInput = '';
      ui.toast(t('conn.keySaved'), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function remove() {
    if (!secret || !confirm(t('conn.removeKeyConfirm'))) return;
    await api.deleteSecret(secret.id);
    library.secrets = library.secrets.filter((s) => s.id !== secret.id);
    onselect('');
  }

  /** Keeps a key usable after the address changes by allowing the new origin. */
  async function allowOrigins() {
    if (!secret) return;
    const allowed = [...new Set([...secret.allowedOrigins, ...origins])];
    const updated = await api.updateSecret(secret.id, { allowedOrigins: allowed });
    library.secrets = library.secrets.map((s) => (s.id === updated.id ? updated : s));
  }
</script>

<div class="field">
  <span>{optional ? t('conn.apiKeyOptional') : t('conn.apiKey')}</span>
  {#if keys.length > 1}
    <select class="select" value={secretId} onchange={(e) => onselect(e.currentTarget.value)}>
      {#each keys as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
    </select>
  {/if}
  {#if secret}
    <div class="key">
      <code>{secret.masked}</code>
      <button class="btn ghost danger" onclick={remove}
        ><Icon name="trash" size={15} />{t('conn.removeKey')}</button
      >
    </div>
    {#if !originAllowed}
      <p class="warn">
        {t('conn.originNotAllowed')}
        <button class="btn" onclick={allowOrigins}>{t('conn.allowOrigin')}</button>
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
    <button class="btn" disabled={!keyInput.trim()} onclick={save}>{t('common.save')}</button>
  </div>
  <small>{t('conn.keyHint')}</small>
</div>

<style>
  .key,
  .key-input {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .key code {
    flex: 1;
    color: var(--bt-ink-muted);
  }
  .key-input .input {
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
