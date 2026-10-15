<script lang="ts">
  import { t } from '../i18n/index.svelte.ts';
  import { session } from '../state/session.svelte.ts';
  import { errorText } from '../state/ui.svelte.ts';

  let password = $state('');
  let handle = $state('');
  let error = $state('');
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      await session.login(password, handle.trim() || undefined);
    } catch (e) {
      error = errorText(e);
    } finally {
      busy = false;
    }
  }
</script>

<main class="login">
  <form onsubmit={submit}>
    <h1>BakaTavern</h1>
    <p class="muted">{t('login.intro')}</p>
    <label class="field">
      <span>{t('login.user')}</span>
      <input class="input" bind:value={handle} autocomplete="username" placeholder="default-user" />
    </label>
    <label class="field">
      <span>{t('login.password')}</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="input"
        type="password"
        bind:value={password}
        autocomplete="current-password"
        autofocus
        required
      />
    </label>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="btn primary" disabled={busy}>{t('login.submit')}</button>
  </form>
</main>

<style>
  .login {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: 1.5rem;
  }
  form {
    display: grid;
    gap: 1rem;
    width: min(22rem, 100%);
  }
  h1 {
    font-family: var(--bt-font-prose);
    font-size: var(--bt-size-xl);
    color: var(--bt-dialogue);
  }
  .error {
    color: var(--bt-danger);
    font-size: var(--bt-size-sm);
  }
</style>
