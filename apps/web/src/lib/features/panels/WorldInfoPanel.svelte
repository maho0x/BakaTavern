<script lang="ts">
  import { ApiError } from '@bakatavern/api-client';
  import { convertForeignLorebook } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { worldInfoDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import KeywordInput from '../worldinfo/KeywordInput.svelte';

  const prefs = $derived(settings.get('worldinfo', worldInfoDefaults));
  const wi = $derived({ ...worldInfoDefaults.settings, ...prefs.settings });
  const character = $derived(chat.character);
  const characterBook = $derived(
    String(
      (character?.card as { data?: { extensions?: { world?: string } } } | undefined)?.data?.extensions
        ?.world ?? '',
    ),
  );
  const extraBooks = $derived(character ? (prefs.characterExtraBooks[character.id] ?? []) : []);
  const chatBook = $derived(String(chat.chat?.metadata.world_info ?? ''));
  const personaBook = $derived(chat.persona?.lorebook ?? '');
  const bookOptions = $derived(library.lorebooks.map((b) => ({ value: b.name, label: b.name })));
  let fileInput = $state<HTMLInputElement>();

  function setWi(patch: Partial<typeof wi>) {
    settings.update('worldinfo', { settings: { ...wi, ...patch } });
  }

  function toggleGlobal(name: string, on: boolean) {
    const list = prefs.globalBooks.filter((n) => n !== name);
    settings.update('worldinfo', { globalBooks: on ? [...list, name] : list });
  }

  function setExtraBooks(names: string[]) {
    if (!character) return;
    settings.update('worldinfo', {
      characterExtraBooks: { ...prefs.characterExtraBooks, [character.id]: names },
    });
  }

  async function setCharacterBook(name: string) {
    try {
      await chat.updateCard((card) => {
        const data = (card.data ??= {});
        data.extensions = { ...(data.extensions as Record<string, unknown> | undefined), world: name };
      });
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  /** Where a book is used besides being global. */
  function bindings(name: string): string[] {
    const out: string[] = [];
    if (name === characterBook || extraBooks.includes(name)) out.push(t('wi.boundCharacter'));
    if (name === chatBook) out.push(t('wi.boundChat'));
    if (name === personaBook) out.push(t('wi.boundPersona'));
    return out;
  }

  function freeName(base: string): string {
    const taken = new Set(library.lorebooks.map((b) => b.name));
    let name = base.trim() || 'Lorebook';
    for (let n = 2; taken.has(name); n++) name = `${base.trim()} (${n})`;
    return name;
  }

  async function createBook() {
    const name = prompt(t('wi.newName'))?.trim();
    if (!name) return;
    try {
      const created = await api.createLorebook(name);
      await library.refreshLorebooks();
      ui.editingLorebookId = created.id;
    } catch (error) {
      ui.toast(
        error instanceof ApiError && error.code === 'exists' ? t('wi.nameTaken') : errorText(error),
        'error',
      );
    }
  }

  async function importBooks(files: FileList | null) {
    for (const file of files ?? []) {
      try {
        let json: unknown = null;
        try {
          json = JSON.parse(await file.text());
        } catch {
          // not JSON: let the server explain
        }
        // NovelAI, Agnai and RisuAI books are converted here, like SillyTavern does.
        const converted = json ? convertForeignLorebook(json) : null;
        const book = converted
          ? await api.createLorebook(
              freeName(file.name.replace(/\.[^.]+$/, '')),
              converted as unknown as Record<string, unknown>[],
            )
          : await api.importLorebook(file);
        ui.toast(t('wi.imported', { name: book.name }), 'success');
      } catch (error) {
        ui.toast(t('wi.importFailed', { file: file.name, message: errorText(error) }), 'error');
      }
    }
    await library.refreshLorebooks();
    if (fileInput) fileInput.value = '';
  }
</script>

<div class="stack">
  <details>
    <summary>{t('wi.settings')}</summary>
    <div class="grid">
      <label class="field"
        ><span>{t('wi.scanDepth')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.depth}
          onchange={(e) => setWi({ depth: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.budget')}</span><input
          class="input"
          type="number"
          min="1"
          max="100"
          value={wi.budget}
          onchange={(e) => setWi({ budget: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.budgetCap')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.budgetCap}
          onchange={(e) => setWi({ budgetCap: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.minActivations')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.minActivations}
          onchange={(e) => setWi({ minActivations: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.minActivationsDepthMax')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.minActivationsDepthMax}
          onchange={(e) => setWi({ minActivationsDepthMax: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field"
        ><span>{t('wi.maxRecursion')}</span><input
          class="input"
          type="number"
          min="0"
          value={wi.maxRecursionSteps}
          onchange={(e) => setWi({ maxRecursionSteps: Number(e.currentTarget.value) })}
        /></label
      >
      <label class="field">
        <span>{t('wi.insertionStrategy')}</span>
        <select
          class="select"
          value={wi.characterStrategy}
          onchange={(e) => setWi({ characterStrategy: Number(e.currentTarget.value) })}
        >
          <option value={0}>{t('wi.strategyEvenly')}</option>
          <option value={1}>{t('wi.strategyCharacter')}</option>
          <option value={2}>{t('wi.strategyGlobal')}</option>
        </select>
      </label>
    </div>
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.recursive}
        onchange={(e) => setWi({ recursive: e.currentTarget.checked })}
      />{t('wi.recursive')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.includeNames}
        onchange={(e) => setWi({ includeNames: e.currentTarget.checked })}
      />{t('wi.includeNames')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.caseSensitive}
        onchange={(e) => setWi({ caseSensitive: e.currentTarget.checked })}
      />{t('wi.caseSensitive')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.matchWholeWords}
        onchange={(e) => setWi({ matchWholeWords: e.currentTarget.checked })}
      />{t('wi.wholeWords')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.useGroupScoring}
        onchange={(e) => setWi({ useGroupScoring: e.currentTarget.checked })}
      />{t('wi.groupScoringGlobal')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={wi.overflowAlert}
        onchange={(e) => setWi({ overflowAlert: e.currentTarget.checked })}
      />{t('wi.overflowAlert')}</label
    >
  </details>

  {#if character || chat.chat}
    <section class="bindings">
      <h3>{t('wi.inUse')}</h3>
      {#if character}
        <label class="field">
          <span>{t('wi.characterBook', { name: character.name })}</span>
          <select
            class="select"
            value={characterBook}
            onchange={(e) => setCharacterBook(e.currentTarget.value)}
          >
            <option value="">{t('common.none')}</option>
            {#each library.lorebooks as b (b.id)}<option value={b.name}>{b.name}</option>{/each}
          </select>
        </label>
        <div class="field">
          <span>{t('wi.extraBooks')}</span>
          <KeywordInput
            keys={extraBooks}
            label={t('wi.extraBooks')}
            options={bookOptions}
            onchange={setExtraBooks}
          />
        </div>
      {/if}
      {#if chat.chat}
        <label class="field">
          <span>{t('wi.chatBook')}</span>
          <select
            class="select"
            value={chatBook}
            onchange={(e) => chat.updateMetadata({ world_info: e.currentTarget.value || undefined })}
          >
            <option value="">{t('common.none')}</option>
            {#each library.lorebooks as b (b.id)}<option value={b.name}>{b.name}</option>{/each}
          </select>
        </label>
      {/if}
    </section>
  {/if}

  <div class="head">
    <h3>{t('wi.books')}</h3>
    <span>
      <button
        class="icon-btn"
        title={t('wi.import')}
        aria-label={t('wi.import')}
        onclick={() => fileInput?.click()}><Icon name="upload" /></button
      >
      <button class="icon-btn" title={t('wi.new')} aria-label={t('wi.new')} onclick={createBook}
        ><Icon name="plus" /></button
      >
    </span>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,.lorebook,application/json"
      multiple
      hidden
      onchange={(e) => importBooks(e.currentTarget.files)}
    />
  </div>
  <p class="faint hint">{t('wi.globalHint')}</p>
  {#if library.lorebooks.length}
    <ul class="books">
      {#each library.lorebooks as b (b.id)}
        <li>
          <input
            type="checkbox"
            checked={prefs.globalBooks.includes(b.name)}
            onchange={(e) => toggleGlobal(b.name, e.currentTarget.checked)}
            title={t('wi.global')}
            aria-label={t('wi.globalFor', { name: b.name })}
          />
          <button onclick={() => (ui.editingLorebookId = b.id)}>
            <span class="name">{b.name}</span>
            {#each bindings(b.name) as badge (badge)}<span class="badge">{badge}</span>{/each}
            <span class="faint count">{b.entryCount}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="faint hint">{t('wi.noBooks')}</p>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 0.9rem;
  }
  details summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
    margin-bottom: 0.5rem;
  }
  details .check {
    margin-top: 0.4rem;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .bindings {
    display: grid;
    gap: 0.6rem;
    padding-block: 0.75rem;
    border-block: 1px solid var(--bt-line);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .head span {
    display: flex;
  }
  h3 {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .hint {
    font-size: var(--bt-size-xs);
  }
  .books {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.1rem;
  }
  .books li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.1rem 0.3rem;
    border-radius: var(--bt-radius-sm);
  }
  .books li:hover {
    background: var(--bt-surface-2);
  }
  .books input {
    accent-color: var(--bt-accent);
  }
  .books button {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.3rem;
    border: 0;
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    flex: none;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--bt-surface-3);
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-muted);
  }
  .count {
    margin-inline-start: auto;
    font-size: var(--bt-size-xs);
  }
</style>
