<script lang="ts">
  import Toasts from './lib/components/Toasts.svelte';
  import Login from './lib/features/Login.svelte';
  import Shell from './lib/features/Shell.svelte';
  import { i18n, t } from './lib/i18n/index.svelte.ts';
  import { uiDefaults } from './lib/state/prefs.ts';
  import { session } from './lib/state/session.svelte.ts';
  import { settings } from './lib/state/settings.svelte.ts';

  const prefs = $derived(settings.get('ui', uiDefaults));

  $effect(() => {
    const root = document.documentElement;
    if (prefs.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = prefs.theme;
    root.style.setProperty('--bt-text-scale', String(prefs.textScale));
    root.style.setProperty('--bt-chat-width', `${prefs.chatWidth}rem`);
  });

  $effect(() => {
    let style = document.getElementById('bt-user-css');
    if (!style) {
      style = Object.assign(document.createElement('style'), { id: 'bt-user-css' });
      document.head.append(style);
    }
    style.textContent = prefs.customCss ? `@layer user {\n${prefs.customCss}\n}` : '';
  });

  void i18n.init().then(() => session.boot());
</script>

{#if session.status === 'loading'}
  <div class="splash" aria-busy="true"><span>BakaTavern</span></div>
{:else if session.status === 'login'}
  <Login />
{:else if session.status === 'offline'}
  <div class="splash">
    <p>{t('app.offline')}</p>
    <button class="btn" onclick={() => session.boot()}>{t('app.retry')}</button>
  </div>
{:else}
  <Shell />
{/if}
<Toasts />

<style>
  .splash {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1rem;
    height: 100dvh;
    font-family: var(--bt-font-prose);
    color: var(--bt-dialogue);
    font-size: var(--bt-size-lg);
  }
</style>
