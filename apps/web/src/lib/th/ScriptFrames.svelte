<script lang="ts">
  import { scriptDocument, scriptFrameName } from '@bakatavern/th-bridge';
  import { stringHash } from '@bakatavern/core';
  import { untrack } from 'svelte';

  import { bridge, runtimeUrl } from './bridge.svelte.ts';
  import { helperScripts, type Script } from './scripts.svelte.ts';

  /** Scripts run in hidden frames; a frame starts over when its script's code changes. */
  const running = $derived(
    helperScripts.running.map(({ script }) => ({
      script,
      key: `${script.id}:${stringHash(script.content)}`,
    })),
  );

  function start(element: HTMLIFrameElement, script: Script) {
    const { config, cdn } = untrack(() => ({
      config: bridge.open({
        name: scriptFrameName(script.name, script.id),
        kind: 'script',
        scriptId: script.id,
      }),
      cdn: helperScripts.prefs.cdn,
    }));
    bridge.host.attach(config.token, element);
    element.srcdoc = scriptDocument(script.content, {
      runtimeUrl: new URL(runtimeUrl, location.href).href,
      config,
      cdn,
    });
    return { destroy: () => bridge.close(config.token) };
  }
</script>

<div class="scripts" aria-hidden="true">
  {#each running as { script, key } (key)}
    <iframe
      use:start={script}
      title={script.name}
      name={scriptFrameName(script.name, script.id)}
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      tabindex="-1"
    ></iframe>
  {/each}
</div>

<style>
  .scripts {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
  }
  iframe {
    border: 0;
    width: 0;
    height: 0;
  }
</style>
