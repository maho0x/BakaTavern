<script lang="ts">
  import { messageDocument, messageFrameName, iframeEvents } from '@bakatavern/th-bridge';
  import { untrack } from 'svelte';

  import { events } from '../events.ts';
  import { t } from '../i18n/index.svelte.ts';
  import { bridge, runtimeUrl, trusted } from './bridge.svelte.ts';
  import { helperScripts } from './scripts.svelte.ts';

  interface Props {
    /** The page's code (a message's code block). */
    code: string;
    messageIndex: number;
    /** Which of the message's pages this is. */
    part: number;
  }
  let { code, messageIndex, part }: Props = $props();

  let frame = $state<HTMLIFrameElement>();
  // Deriveds pass on changes of value only: a re-rendered message keeps its page running.
  const name = $derived(messageFrameName(messageIndex, part));
  const page = $derived(code);
  const sandboxed = $derived(!trusted());

  $effect(() => {
    const element = frame;
    if (!element) return;
    const frameName = name;
    const { config, cdn } = untrack(() => ({
      config: bridge.open({ name: frameName, kind: 'message', messageId: messageIndex }),
      cdn: helperScripts.prefs.cdn,
    }));
    bridge.host.attach(config.token, element);
    void events.emit(iframeEvents.MESSAGE_IFRAME_RENDER_STARTED, frameName);
    element.srcdoc = messageDocument(page, {
      runtimeUrl: new URL(runtimeUrl, location.href).href,
      config,
      cdn,
    });
    return () => bridge.close(config.token);
  });
</script>

<iframe
  bind:this={frame}
  id={name}
  {name}
  class="frontend"
  title={t('th.frameTitle')}
  sandbox={sandboxed
    ? 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads'
    : undefined}
  onload={() => void events.emit(iframeEvents.MESSAGE_IFRAME_RENDER_ENDED, name)}
></iframe>

<style>
  .frontend {
    display: block;
    width: 100%;
    min-height: 2rem;
    border: 0;
    margin: 0.25rem 0;
    background: transparent;
  }
</style>
