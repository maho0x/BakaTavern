<script lang="ts">
  import { onMount } from 'svelte';

  import Icon from '../components/Icon.svelte';
  import { t, type MessageKey } from '../i18n/index.svelte.ts';
  import { chat } from '../state/chat.svelte.ts';
  import { DebouncedSave } from '../state/pending-saves.ts';
  import { errorText, ui } from '../state/ui.svelte.ts';
  import {
    newQuickReply,
    newQuickReplySet,
    normalizeSet,
    quickReplies,
    type AutoEvent,
    type QuickReply,
    type QuickReplySet,
    type SetLink,
  } from './store.svelte.ts';

  const prefs = $derived(quickReplies.prefs);
  const names = $derived(quickReplies.infos.map((p) => p.name));

  let selected = $state<string | null>(null);
  let draft = $state<QuickReplySet | null>(null);
  let open = $state<number | null>(null);
  let importInput = $state<HTMLInputElement>();

  onMount(() => void quickReplies.load());

  // The set being edited: a copy saved shortly after each change.
  $effect(() => {
    const name = selected ?? names[0] ?? null;
    const set = name ? quickReplies.set(name) : undefined;
    if (!set || (draft && draft.name === name)) return;
    selected = name;
    draft = JSON.parse(JSON.stringify(set)) as QuickReplySet;
  });

  const saver = new DebouncedSave(async () => {
    if (!draft) return;
    try {
      await quickReplies.save(JSON.parse(JSON.stringify(draft)) as QuickReplySet);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  });
  const changed = () => saver.schedule();

  function pick(name: string) {
    void saver.flush();
    draft = null;
    selected = name;
  }

  async function createSet() {
    const name = prompt(t('qr.newSetName'))?.trim();
    if (!name) return;
    if (quickReplies.set(name)) {
      ui.toast(t('qr.setExists', { name }), 'error');
      return;
    }
    await quickReplies.save(newQuickReplySet(name));
    pick(name);
  }

  async function renameSet() {
    if (!draft) return;
    const name = prompt(t('qr.renameSet'), draft.name)?.trim();
    if (!name || name === draft.name) return;
    await saver.flush();
    await quickReplies.rename(draft.name, name);
    pick(name);
  }

  async function deleteSet() {
    if (!draft || !confirm(t('qr.deleteSetConfirm', { name: draft.name }))) return;
    const name = draft.name;
    saver.cancel();
    await quickReplies.remove(name);
    draft = null;
    selected = null;
  }

  async function importSets(files: FileList | null) {
    for (const file of files ?? []) {
      try {
        const data = JSON.parse(await file.text()) as Record<string, unknown>;
        const name = String(data.name || file.name.replace(/\.json$/i, ''));
        await quickReplies.save(normalizeSet(data, name));
        pick(name);
      } catch (error) {
        ui.toast(t('qr.importFailed', { file: file.name, message: errorText(error) }), 'error');
      }
    }
    if (importInput) importInput.value = '';
  }

  function exportSet() {
    if (!draft) return;
    const blob = new Blob([JSON.stringify(draft, null, 4)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function addReply() {
    if (!draft) return;
    const id = Math.max(draft.idIndex, ...draft.qrList.map((q) => q.id), 0) + 1;
    draft.idIndex = id + 1;
    draft.qrList.push(newQuickReply(id, { label: t('qr.newReplyLabel') }));
    open = id;
    changed();
  }

  function removeReply(qr: QuickReply) {
    if (!draft) return;
    draft.qrList = draft.qrList.filter((q) => q.id !== qr.id);
    changed();
  }

  function move(index: number, delta: number) {
    if (!draft) return;
    const next = index + delta;
    if (next < 0 || next >= draft.qrList.length) return;
    [draft.qrList[index], draft.qrList[next]] = [draft.qrList[next]!, draft.qrList[index]!];
    changed();
  }

  async function run(qr: QuickReply) {
    if (!draft) return;
    await saver.flush();
    await quickReplies.click(draft, qr);
  }

  const autoFlags: { key: AutoEvent; label: MessageKey }[] = [
    { key: 'executeOnStartup', label: 'qr.onStartup' },
    { key: 'executeOnUser', label: 'qr.onUser' },
    { key: 'executeOnAi', label: 'qr.onAi' },
    { key: 'executeOnChatChange', label: 'qr.onChatChange' },
    { key: 'executeOnNewChat', label: 'qr.onNewChat' },
    { key: 'executeOnGroupMemberDraft', label: 'qr.onGroupMember' },
    { key: 'executeBeforeGeneration', label: 'qr.beforeGeneration' },
  ];

  // Where sets show
  const scopes = $derived([
    { id: 'global', label: t('qr.global'), links: quickReplies.globalLinks, enabled: true },
    { id: 'chat', label: t('qr.chat'), links: quickReplies.chatLinks, enabled: Boolean(chat.chat) },
    {
      id: 'character',
      label: t('qr.character', { name: chat.character?.name ?? '' }),
      links: quickReplies.characterLinks,
      enabled: Boolean(chat.characterId),
    },
  ]);

  async function setLinks(scope: string, links: SetLink[]) {
    try {
      if (scope === 'global') quickReplies.setGlobalLinks(links);
      else if (scope === 'chat') await quickReplies.setChatLinks(links);
      else quickReplies.setCharacterLinks(links);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<div class="stack">
  <section class="card">
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.isEnabled}
        onchange={(e) => quickReplies.updatePrefs({ isEnabled: e.currentTarget.checked })}
      />{t('qr.enabled')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.isCombined}
        onchange={(e) => quickReplies.updatePrefs({ isCombined: e.currentTarget.checked })}
      />{t('qr.combined')}</label
    >
  </section>

  {#each scopes as scope (scope.id)}
    <section class="card" aria-label={scope.label}>
      <h3>{scope.label}</h3>
      {#if scope.enabled}
        <ul class="links">
          {#each scope.links as link, i (link.set)}
            <li>
              <span class="name" class:faint={!quickReplies.set(link.set)}>{link.set}</span>
              <button
                class="icon-btn small"
                title={link.isVisible ? t('qr.hideButtons') : t('qr.showButtons')}
                aria-label="{link.isVisible ? t('qr.hideButtons') : t('qr.showButtons')}: {link.set}"
                aria-pressed={!link.isVisible}
                onclick={() =>
                  setLinks(
                    scope.id,
                    scope.links.map((l, j) => (j === i ? { ...l, isVisible: !l.isVisible } : l)),
                  )}><Icon name={link.isVisible ? 'eye' : 'eyeOff'} size={15} /></button
              >
              <button
                class="icon-btn small"
                title={t('qr.unlink')}
                aria-label="{t('qr.unlink')}: {link.set}"
                onclick={() =>
                  setLinks(
                    scope.id,
                    scope.links.filter((_, j) => j !== i),
                  )}><Icon name="close" size={15} /></button
              >
            </li>
          {/each}
        </ul>
        <select
          class="select"
          aria-label="{t('qr.addSet')}: {scope.label}"
          value=""
          onchange={(e) => {
            const name = e.currentTarget.value;
            e.currentTarget.value = '';
            if (name) void setLinks(scope.id, [...scope.links, { set: name, isVisible: true }]);
          }}
        >
          <option value="">{t('qr.addSet')}</option>
          {#each names.filter((n) => !scope.links.some((l) => l.set === n)) as name (name)}
            <option value={name}>{name}</option>
          {/each}
        </select>
      {:else}
        <p class="faint">{t('qr.noChat')}</p>
      {/if}
    </section>
  {/each}

  <section class="card" aria-label={t('qr.sets')}>
    <div class="head">
      <h3>{t('qr.sets')}</h3>
      <span class="actions">
        <button class="icon-btn small" title={t('qr.newSet')} aria-label={t('qr.newSet')} onclick={createSet}
          ><Icon name="plus" size={15} /></button
        >
        <button
          class="icon-btn small"
          title={t('qr.importSet')}
          aria-label={t('qr.importSet')}
          onclick={() => importInput?.click()}><Icon name="upload" size={15} /></button
        >
      </span>
      <input
        bind:this={importInput}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onchange={(e) => importSets(e.currentTarget.files)}
      />
    </div>
    {#if names.length === 0}
      <p class="faint">{t('qr.noSets')}</p>
    {:else}
      <div class="set-row">
        <select
          class="select"
          aria-label={t('qr.editSet')}
          value={selected ?? ''}
          onchange={(e) => pick(e.currentTarget.value)}
        >
          {#each names as name (name)}<option value={name}>{name}</option>{/each}
        </select>
        <button
          class="icon-btn small"
          title={t('qr.renameSet')}
          aria-label={t('qr.renameSet')}
          onclick={renameSet}><Icon name="edit" size={15} /></button
        >
        <button
          class="icon-btn small"
          title={t('common.export')}
          aria-label={t('common.export')}
          onclick={exportSet}><Icon name="download" size={15} /></button
        >
        <button
          class="icon-btn small danger"
          title={t('qr.deleteSet')}
          aria-label={t('qr.deleteSet')}
          onclick={deleteSet}><Icon name="trash" size={15} /></button
        >
      </div>
    {/if}

    {#if draft}
      <div class="options">
        <label class="check"
          ><input type="checkbox" bind:checked={draft.disableSend} onchange={changed} />{t(
            'qr.disableSend',
          )}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={draft.injectInput} onchange={changed} />{t(
            'qr.injectInput',
          )}</label
        >
        <label class="check"
          ><input
            type="checkbox"
            bind:checked={draft.placeBeforeInput}
            onchange={changed}
            disabled={!draft.injectInput}
          />{t('qr.placeBefore')}</label
        >
      </div>

      <ol class="replies">
        {#each draft.qrList as qr, i (qr.id)}
          <li class="reply" class:open={open === qr.id}>
            <div class="reply-head">
              <input
                class="input label"
                aria-label={t('qr.label')}
                placeholder={t('qr.label')}
                bind:value={qr.label}
                oninput={changed}
              />
              <button
                class="icon-btn small"
                title={t('qr.run')}
                aria-label="{t('qr.run')}: {qr.label}"
                onclick={() => run(qr)}><Icon name="play" size={15} /></button
              >
              <button
                class="icon-btn small"
                title={t('qr.details')}
                aria-label="{t('qr.details')}: {qr.label}"
                aria-expanded={open === qr.id}
                onclick={() => (open = open === qr.id ? null : qr.id)}
                ><Icon name={open === qr.id ? 'up' : 'down'} size={15} /></button
              >
            </div>
            <textarea
              class="textarea code compact"
              rows={open === qr.id ? 8 : 2}
              aria-label={t('qr.message')}
              placeholder={t('qr.messageHint')}
              bind:value={qr.message}
              oninput={changed}></textarea>
            {#if open === qr.id}
              <div class="details">
                <label class="field"
                  ><span>{t('qr.title')}</span><input
                    class="input"
                    bind:value={qr.title}
                    oninput={changed}
                  /></label
                >
                <label class="check"
                  ><input type="checkbox" bind:checked={qr.isHidden} onchange={changed} />{t(
                    'qr.hidden',
                  )}</label
                >
                <fieldset>
                  <legend>{t('qr.autoRun')}</legend>
                  {#each autoFlags as f (f.key)}
                    <label class="check"
                      ><input type="checkbox" bind:checked={qr[f.key]} onchange={changed} />{t(
                        f.label,
                      )}</label
                    >
                  {/each}
                  <label class="check"
                    ><input type="checkbox" bind:checked={qr.preventAutoExecute} onchange={changed} />{t(
                      'qr.preventAuto',
                    )}</label
                  >
                  <label class="field"
                    ><span>{t('qr.automationId')}</span><input
                      class="input"
                      bind:value={qr.automationId}
                      oninput={changed}
                    /></label
                  >
                </fieldset>
                <fieldset>
                  <legend>{t('qr.contextMenu')}</legend>
                  {#each qr.contextList as link, j (link.set)}
                    <div class="ctx">
                      <span class="name">{link.set}</span>
                      <label class="check"
                        ><input type="checkbox" bind:checked={link.isChained} onchange={changed} />{t(
                          'qr.chained',
                        )}</label
                      >
                      <button
                        class="icon-btn small"
                        aria-label="{t('qr.unlink')}: {link.set}"
                        onclick={() => {
                          qr.contextList = qr.contextList.filter((_, k) => k !== j);
                          changed();
                        }}><Icon name="close" size={14} /></button
                      >
                    </div>
                  {/each}
                  <select
                    class="select"
                    aria-label={t('qr.addContext')}
                    value=""
                    onchange={(e) => {
                      const name = e.currentTarget.value;
                      e.currentTarget.value = '';
                      if (!name) return;
                      qr.contextList = [...qr.contextList, { set: name, isChained: false }];
                      changed();
                    }}
                  >
                    <option value="">{t('qr.addContext')}</option>
                    {#each names.filter((n) => !qr.contextList.some((c) => c.set === n)) as name (name)}
                      <option value={name}>{name}</option>
                    {/each}
                  </select>
                </fieldset>
                <div class="row-actions">
                  <button class="btn ghost small" disabled={i === 0} onclick={() => move(i, -1)}
                    ><Icon name="up" size={14} />{t('common.moveUp')}</button
                  >
                  <button
                    class="btn ghost small"
                    disabled={i === draft.qrList.length - 1}
                    onclick={() => move(i, 1)}><Icon name="down" size={14} />{t('common.moveDown')}</button
                  >
                  <button class="btn ghost small danger" onclick={() => removeReply(qr)}
                    ><Icon name="trash" size={14} />{t('qr.deleteReply')}</button
                  >
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      <button class="btn" onclick={addReply}><Icon name="plus" size={15} />{t('qr.addReply')}</button>
    {/if}
  </section>
</div>

<style>
  .stack {
    display: grid;
    gap: 0.75rem;
    padding: 0.75rem;
  }
  .card {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
  }
  h3 {
    font-size: var(--bt-size-sm);
    font-weight: 650;
  }
  .head,
  .set-row,
  .reply-head,
  .ctx {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .head h3 {
    flex: 1;
  }
  .set-row .select {
    flex: 1;
  }
  .links {
    list-style: none;
    display: grid;
    gap: 0.15rem;
  }
  .links li {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-sm);
  }
  .options {
    display: grid;
    gap: 0.25rem;
  }
  .replies {
    list-style: none;
    display: grid;
    gap: 0.5rem;
  }
  .reply {
    display: grid;
    gap: 0.35rem;
    padding: 0.5rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: var(--bt-bg);
  }
  .reply.open {
    border-color: var(--bt-accent);
  }
  .label {
    flex: 1;
    min-width: 0;
    padding-block: 0.3rem;
    font-weight: 600;
  }
  .details {
    display: grid;
    gap: 0.5rem;
  }
  fieldset {
    display: grid;
    gap: 0.3rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
  }
  legend {
    padding: 0 0.25rem;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-muted);
  }
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .small {
    min-height: 1.75rem;
    font-size: var(--bt-size-xs);
  }
  .danger {
    color: var(--bt-danger);
  }
</style>
