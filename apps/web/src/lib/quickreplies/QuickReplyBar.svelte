<script lang="ts">
  import { t } from '../i18n/index.svelte.ts';
  import { chat } from '../state/chat.svelte.ts';
  import { quickReplies, type QuickReply, type QuickReplySet } from './store.svelte.ts';

  const sets = $derived(quickReplies.visibleSets);
  const combined = $derived(quickReplies.prefs.isCombined);
  const rows = $derived(
    combined
      ? [
          {
            name: 'all',
            color: '',
            buttons: sets.flatMap((set) => set.qrList.filter((q) => !q.isHidden).map((qr) => ({ set, qr }))),
          },
        ]
      : sets.map((set) => ({
          name: set.name,
          color: set.color && set.color !== 'transparent' ? set.color : '',
          buttons: set.qrList.filter((q) => !q.isHidden).map((qr) => ({ set, qr })),
        })),
  );

  /** The context menu of a reply (its linked sets' replies). */
  let menu = $state<{ set: QuickReplySet; qr: QuickReply; x: number; y: number } | null>(null);
  const menuItems = $derived(
    menu
      ? menu.qr.contextList.flatMap((link) => {
          const linked = quickReplies.set(link.set);
          return linked ? linked.qrList.map((qr) => ({ set: linked, qr, chained: link.isChained })) : [];
        })
      : [],
  );

  function openMenu(event: MouseEvent, set: QuickReplySet, qr: QuickReply) {
    if (!qr.contextList.length) return;
    event.preventDefault();
    menu = { set, qr, x: event.clientX, y: event.clientY };
  }

  async function runItem(item: { set: QuickReplySet; qr: QuickReply; chained: boolean }) {
    const parent = menu;
    menu = null;
    // A chained item runs after its parent.
    if (item.chained && parent) await quickReplies.click(parent.set, parent.qr);
    await quickReplies.click(item.set, item.qr);
  }

  const label = (qr: QuickReply) => qr.label || qr.title || '…';
</script>

{#if rows.some((r) => r.buttons.length)}
  <div class="bar" role="toolbar" aria-label={t('qr.bar')}>
    {#each rows as row (row.name)}
      {#if row.buttons.length}
        <div class="row" style:--qr-color={row.color || null}>
          {#each row.buttons as { set, qr } (`${set.name}:${qr.id}`)}
            <button
              class="qr"
              class:linked={qr.contextList.length > 0}
              title={qr.title || qr.message}
              disabled={chat.busy && !qr.message.startsWith('/')}
              onclick={() => quickReplies.click(set, qr)}
              oncontextmenu={(e) => openMenu(e, set, qr)}>{label(qr)}</button
            >
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

{#if menu}
  <div class="backdrop" role="presentation" onclick={() => (menu = null)}></div>
  <div
    class="menu"
    role="menu"
    style:left="{Math.min(menu.x, window.innerWidth - 220)}px"
    style:top="{menu.y}px"
  >
    {#each menuItems as item (`${item.set.name}:${item.qr.id}`)}
      <button role="menuitem" title={item.qr.title} onclick={() => runItem(item)}>{label(item.qr)}</button>
    {/each}
  </div>
{/if}

<style>
  .bar {
    display: grid;
    gap: 0.3rem;
    max-width: var(--bt-chat-width);
    margin: 0 auto;
    padding: 0.35rem var(--bt-gutter) 0;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .qr {
    padding: 0.25rem 0.65rem;
    border: 1px solid var(--qr-color, var(--bt-line));
    border-radius: 999px;
    background: color-mix(in oklch, var(--qr-color, var(--bt-surface-2)) 18%, var(--bt-surface));
    color: var(--bt-ink);
    font-size: var(--bt-size-sm);
    white-space: nowrap;
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qr:hover {
    background: var(--bt-surface-3);
  }
  .qr.linked::after {
    content: ' ▾';
    color: var(--bt-ink-faint);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: fixed;
    z-index: 41;
    display: grid;
    min-width: 12rem;
    max-height: 50vh;
    overflow-y: auto;
    padding: 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface-2);
    box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
    transform: translateY(-100%);
  }
  .menu button {
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    color: var(--bt-ink);
    text-align: start;
    font-size: var(--bt-size-sm);
  }
  .menu button:hover {
    background: var(--bt-surface-3);
  }
</style>
