<script lang="ts">
  import type { ChatMessage, PromptItemization } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Modal from '../../components/Modal.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import { copyText } from '../../util/clipboard.ts';

  /** The prompt a generation sent: its parts in tokens, the World Info it used and the text. */
  let log = $state<{ prompt: PromptItemization | null; previous: PromptItemization | null } | null>(null);
  let failed = $state('');

  $effect(() => {
    const target = ui.promptOf;
    log = null;
    failed = '';
    if (!target) return;
    let current = true;
    api
      .getPrompt(target.chatId, target.startedAt)
      .then((result) => {
        if (current) log = result as unknown as typeof log;
      })
      .catch((error) => {
        if (current) failed = errorText(error);
      });
    return () => {
      current = false;
    };
  });

  const prompt = $derived(log?.prompt ?? null);
  const number = (n: number) => n.toLocaleString();
  /** Parts on their own (not the ones counted inside the story string), largest first. */
  const parts = $derived(
    prompt ? prompt.items.filter((i) => !i.within).sort((a, b) => b.tokens - a.tokens) : [],
  );
  const inside = $derived(prompt ? prompt.items.filter((i) => i.within) : []);
  const largest = $derived(Math.max(1, ...parts.map((p) => p.tokens), ...inside.map((p) => p.tokens)));
  const known = new Set([
    'main',
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'nsfw',
    'jailbreak',
    'enhanceDefinitions',
    'dialogueExamples',
    'chatHistory',
    'bias',
    'controlPrompts',
    'storyString',
    'continuePrompt',
  ]);
  const label = (item: { id: string; name?: string }) =>
    known.has(item.id) ? t(`prompt.part.${item.id}` as MessageKey) : item.name || item.id;

  /** How the context is used: the prompt, then what is kept for the reply and padding. */
  const usage = $derived.by(() => {
    if (!prompt) return null;
    const size = Math.max(1, prompt.maxContext);
    const pct = (n: number) => `${Math.min(100, (n / size) * 100)}%`;
    return {
      prompt: pct(prompt.total),
      reserved: pct(prompt.maxResponse + prompt.padding),
    };
  });
  const change = $derived(log?.prompt && log.previous ? log.prompt.total - log.previous.total : null);

  const roleName = (m: ChatMessage) => (m.name ? `${m.role} (${m.name})` : m.role);
  const text = $derived.by(() => {
    if (!prompt) return '';
    if (prompt.prompt !== undefined) return prompt.prompt;
    return (prompt.messages ?? [])
      .map(
        (m) => `[${roleName(m)}]\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`,
      )
      .join('\n\n');
  });

  async function copy() {
    await copyText(text);
    ui.toast(t('chat.copied'));
  }
</script>

<Modal open={!!ui.promptOf} title={t('prompt.title')} wide onclose={() => (ui.promptOf = null)}>
  {#if failed}
    <p class="note">{failed}</p>
  {:else if !log}
    <p class="note">{t('prompt.loading')}</p>
  {:else if !prompt}
    <p class="note">{t('prompt.none')}</p>
  {:else}
    <dl class="meta">
      <div>
        <dt>{t('prompt.api')}</dt>
        <dd>{prompt.api === 'text' ? t('conn.apiText') : t('conn.apiChat')} ({prompt.source})</dd>
      </div>
      {#if prompt.model}<div>
          <dt>{t('prompt.model')}</dt>
          <dd>{prompt.model}</dd>
        </div>{/if}
      <div>
        <dt>{t('prompt.tokenizer')}</dt>
        <dd>{prompt.tokenizer}</dd>
      </div>
    </dl>

    <section class="usage" aria-label={t('prompt.context')}>
      <p class="total">
        <strong>{number(prompt.total)}</strong>
        {t('prompt.ofContext', { context: number(prompt.maxContext) })}
        {#if change !== null && change !== 0}<span class="change"
            >{t('prompt.change', { change: `${change > 0 ? '+' : ''}${number(change)}` })}</span
          >{/if}
      </p>
      {#if usage}
        <div class="meter" aria-hidden="true">
          <span class="used" style:width={usage.prompt}></span>
          <span class="reserved" style:width={usage.reserved}></span>
        </div>
      {/if}
      <p class="legend">
        <span><i class="key used"></i>{t('prompt.legendPrompt')}</span>
        <span
          ><i class="key reserved"></i>{prompt.padding
            ? t('prompt.legendReservedPadding', {
                response: number(prompt.maxResponse),
                padding: number(prompt.padding),
              })
            : t('prompt.legendReserved', { response: number(prompt.maxResponse) })}</span
        >
      </p>
    </section>

    <section>
      <h3>{t('prompt.parts')}</h3>
      <table class="parts">
        <tbody>
          {#each parts as item (item.id)}
            <tr>
              <th scope="row">{label(item)}</th>
              <td class="bar"><span style:width={`${(item.tokens / largest) * 100}%`}></span></td>
              <td class="num">{number(item.tokens)}</td>
            </tr>
            {#if item.id === 'storyString'}
              {#each inside as sub (sub.id)}
                <tr class="sub">
                  <th scope="row">{label(sub)}</th>
                  <td class="bar"><span style:width={`${(sub.tokens / largest) * 100}%`}></span></td>
                  <td class="num">{number(sub.tokens)}</td>
                </tr>
              {/each}
            {/if}
          {/each}
        </tbody>
      </table>
    </section>

    {#if prompt.worldInfo.length}
      <details>
        <summary>{t('prompt.worldInfo', { count: prompt.worldInfo.length })}</summary>
        <table class="entries">
          <tbody>
            {#each prompt.worldInfo as entry (`${entry.book}/${entry.uid}`)}
              <tr>
                <th scope="row">{entry.comment || `#${entry.uid}`}</th>
                <td class="book">{entry.book}</td>
                <td class="num">{number(entry.tokens)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </details>
    {/if}

    <details>
      <summary>{t('prompt.show')}</summary>
      <pre class="raw">{text}</pre>
    </details>
  {/if}
  {#snippet footer()}
    {#if prompt}<button class="btn ghost" onclick={copy}>{t('prompt.copy')}</button>{/if}
    <button class="btn primary" onclick={() => (ui.promptOf = null)}>{t('common.close')}</button>
  {/snippet}
</Modal>

<style>
  .note {
    color: var(--bt-ink-muted);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.5rem;
    margin: 0 0 1rem;
    font-size: var(--bt-size-sm);
  }
  .meta dt {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-xs);
  }
  .meta dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  section {
    margin-bottom: 1.1rem;
  }
  h3 {
    font-size: var(--bt-size-sm);
    font-weight: 650;
    color: var(--bt-ink-muted);
    margin-bottom: 0.4rem;
  }
  .total {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
    margin-bottom: 0.4rem;
  }
  .total strong {
    font-size: var(--bt-size-lg);
    color: var(--bt-ink);
    font-variant-numeric: tabular-nums;
  }
  .change {
    margin-inline-start: 0.5rem;
    color: var(--bt-ink-faint);
  }
  /* The context: what the prompt uses, then what is kept free for the reply. */
  .meter {
    display: flex;
    gap: 2px;
    height: 10px;
    border-radius: 4px;
    background: var(--bt-surface-3);
    overflow: hidden;
  }
  .meter span {
    min-width: 2px;
  }
  .used {
    background: var(--bt-accent);
  }
  .reserved {
    background: color-mix(in oklch, var(--bt-accent) 35%, var(--bt-surface-3));
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
    margin-top: 0.4rem;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-muted);
  }
  .key {
    display: inline-block;
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 2px;
    margin-inline-end: 0.35rem;
    vertical-align: -0.05rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--bt-size-sm);
  }
  th {
    text-align: start;
    font-weight: 400;
    padding: 0.2rem 0.75rem 0.2rem 0;
    white-space: nowrap;
  }
  .sub th {
    padding-inline-start: 1rem;
    color: var(--bt-ink-muted);
  }
  .bar {
    width: 100%;
  }
  .bar span {
    display: block;
    height: 8px;
    min-width: 2px;
    border-radius: 0 4px 4px 0;
    background: var(--bt-accent);
  }
  .sub .bar span {
    background: color-mix(in oklch, var(--bt-accent) 45%, var(--bt-surface-3));
  }
  .num {
    text-align: end;
    padding-inline-start: 0.75rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .book {
    color: var(--bt-ink-muted);
    padding-inline-start: 0.75rem;
  }
  .entries th {
    white-space: normal;
  }
  details {
    margin-bottom: 0.75rem;
  }
  summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .raw {
    margin-top: 0.5rem;
    max-height: 50vh;
    overflow: auto;
    padding: 0.75rem;
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface-2);
    font-family: var(--bt-font-mono);
    font-size: var(--bt-size-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    th {
      white-space: normal;
    }
    .bar {
      width: 30%;
    }
  }
</style>
