<script lang="ts">
  import type { SearchHit } from '@bakatavern/api-client';

  import { api } from '../../api.ts';
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let query = $state('');
  let scope = $state<'all' | 'current'>('all');
  let hits = $state<SearchHit[]>([]);
  let searched = $state('');
  let busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owner = $derived(
    chat.groupId ? { groupId: chat.groupId } : chat.characterId ? { characterId: chat.characterId } : null,
  );

  // Searches shortly after typing stops; an answer to an older query is dropped.
  $effect(() => {
    const q = query.trim();
    const where = scope === 'current' && owner ? owner : {};
    clearTimeout(timer);
    if (!q) {
      hits = [];
      searched = '';
      return;
    }
    timer = setTimeout(async () => {
      busy = true;
      try {
        const found = await api.search(q, { ...where, limit: 100 });
        if (query.trim() === q) {
          hits = found;
          searched = q;
        }
      } catch (error) {
        ui.toast(errorText(error), 'error');
      } finally {
        busy = false;
      }
    }, 250);
  });

  function ownerName(hit: SearchHit) {
    if (hit.groupId) return library.group(hit.groupId)?.name ?? '';
    return library.character(hit.characterId)?.name ?? '';
  }

  async function show(hit: SearchHit) {
    onclose();
    ui.jumpTo = { chatId: hit.chatId, seq: hit.seq };
    if (chat.chat?.id === hit.chatId) return;
    if (hit.groupId) await chat.openGroup(hit.groupId, hit.chatId);
    else if (hit.characterId) await chat.openCharacter(hit.characterId, hit.chatId);
  }

  /** The snippet with the query marked (as text: nothing in it is HTML). */
  function parts(snippet: string): { text: string; match: boolean }[] {
    const q = searched.toLowerCase();
    if (!q) return [{ text: snippet, match: false }];
    const out: { text: string; match: boolean }[] = [];
    const lower = snippet.toLowerCase();
    let from = 0;
    for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
      if (at > from) out.push({ text: snippet.slice(from, at), match: false });
      out.push({ text: snippet.slice(at, at + q.length), match: true });
      from = at + q.length;
    }
    if (from < snippet.length) out.push({ text: snippet.slice(from), match: false });
    return out;
  }
</script>

<Modal {open} title={t('search.title')} {onclose} wide>
  <div class="search">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="input"
      type="search"
      placeholder={t('search.placeholder')}
      aria-label={t('search.query')}
      bind:value={query}
      autofocus
    />
    <select class="select" aria-label={t('search.scope')} bind:value={scope} disabled={!owner}>
      <option value="all">{t('search.all')}</option>
      <option value="current">{t('search.current')}</option>
    </select>
  </div>
  {#if searched && !hits.length && !busy}
    <p class="faint">{t('search.none', { query: searched })}</p>
  {/if}
  <ul class="hits" aria-label={t('search.results')}>
    {#each hits as hit (hit.messageId)}
      <li>
        <button class="hit" onclick={() => void show(hit)}>
          <span class="where">{ownerName(hit)} · {hit.chatTitle} · #{hit.seq}</span>
          <span class="text"
            ><strong>{hit.name}:</strong>
            {#each parts(hit.snippet) as part, i (i)}{#if part.match}<mark>{part.text}</mark
                >{:else}{part.text}{/if}{/each}</span
          >
        </button>
      </li>
    {/each}
  </ul>
</Modal>

<style>
  .search {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  .search .select {
    width: auto;
  }
  .hits {
    list-style: none;
    display: grid;
    gap: 0.35rem;
  }
  .hit {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: var(--bt-surface);
    color: var(--bt-ink);
    text-align: left;
    cursor: pointer;
  }
  .hit:hover {
    border-color: var(--bt-accent);
  }
  .where {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .text {
    font-size: var(--bt-size-sm);
    line-height: 1.5;
  }
  mark {
    background: color-mix(in oklch, var(--bt-accent) 35%, transparent);
    color: inherit;
    border-radius: 2px;
  }
  .faint {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-sm);
  }
</style>
