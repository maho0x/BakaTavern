<script lang="ts">
  import { randomId } from '@bakatavern/api-client';
  import { migrateRegexScript, newRegexScript, RegexPlacement, type RegexScript } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import RegexEditor from './RegexEditor.svelte';

  interface MoveTarget {
    label: string;
    move: (script: RegexScript) => Promise<void> | void;
  }

  interface Props {
    title: string;
    scripts: RegexScript[];
    onchange: (scripts: RegexScript[]) => Promise<void> | void;
    /** Shown for embedded scripts, which run only once allowed. */
    allowed?: boolean;
    onallow?: (allowed: boolean) => void;
    moveTargets?: MoveTarget[];
    /** File name stem for "export all". */
    exportName: string;
  }
  let { title, scripts, onchange, allowed, onallow, moveTargets = [], exportName }: Props = $props();

  let editing = $state<RegexScript | null>(null);
  let menuFor = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>();

  async function update(next: RegexScript[]) {
    try {
      await onchange(next);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  function create() {
    // SillyTavern's defaults for a new script.
    editing = newRegexScript(randomId(), {
      placement: [RegexPlacement.USER_INPUT],
      markdownOnly: true,
      runOnEdit: true,
    });
  }

  async function save(script: RegexScript) {
    const index = scripts.findIndex((s) => s.id === script.id);
    const next = [...scripts];
    if (index >= 0) next[index] = script;
    else next.push(script);
    editing = null;
    await update(next);
  }

  async function toggle(script: RegexScript, enabled: boolean) {
    await update(scripts.map((s) => (s.id === script.id ? { ...s, disabled: !enabled } : s)));
  }

  async function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= scripts.length) return;
    const next = [...scripts];
    [next[index], next[to]] = [next[to]!, next[index]!];
    await update(next);
  }

  async function duplicate(script: RegexScript) {
    menuFor = null;
    const index = scripts.indexOf(script);
    const copy = { ...structuredClone(script), id: randomId(), scriptName: `${script.scriptName} (copy)` };
    await update([...scripts.slice(0, index + 1), copy, ...scripts.slice(index + 1)]);
  }

  async function remove(script: RegexScript) {
    menuFor = null;
    if (!confirm(t('regex.deleteConfirm', { name: script.scriptName }))) return;
    await update(scripts.filter((s) => s.id !== script.id));
  }

  async function moveTo(target: MoveTarget, script: RegexScript) {
    menuFor = null;
    try {
      await target.move(structuredClone(script));
      await update(scripts.filter((s) => s.id !== script.id));
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  function download(data: unknown, name: string) {
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${name.replace(/[\\/:*?"<>|]+/g, '_')}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importFiles(files: FileList | null) {
    const imported: RegexScript[] = [];
    try {
      for (const file of files ?? []) {
        const data = JSON.parse(await file.text()) as unknown;
        for (const item of Array.isArray(data) ? data : [data]) {
          const script = item as Partial<RegexScript>;
          if (!script || typeof script !== 'object' || !script.scriptName)
            throw new Error(t('regex.invalidFile'));
          // Imported scripts get a new id, as in SillyTavern.
          imported.push(migrateRegexScript({ ...script, id: randomId() }, randomId));
        }
      }
      if (imported.length) {
        await update([...scripts, ...imported]);
        ui.toast(t('regex.imported', { count: imported.length }), 'success');
      }
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }
</script>

<section>
  <div class="head">
    <h3>{title}</h3>
    <span>
      <button
        class="icon-btn"
        title={t('regex.import')}
        aria-label={t('regex.import')}
        onclick={() => fileInput?.click()}><Icon name="upload" /></button
      >
      {#if scripts.length}
        <button
          class="icon-btn"
          title={t('regex.exportAll')}
          aria-label={t('regex.exportAll')}
          onclick={() => download(scripts, exportName)}><Icon name="download" /></button
        >
      {/if}
      <button class="icon-btn" title={t('regex.new')} aria-label={t('regex.new')} onclick={create}
        ><Icon name="plus" /></button
      >
    </span>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      multiple
      hidden
      onchange={(e) => importFiles(e.currentTarget.files)}
    />
  </div>

  {#if allowed !== undefined && scripts.length}
    <label class="check allow"
      ><input type="checkbox" checked={allowed} onchange={(e) => onallow?.(e.currentTarget.checked)} />{t(
        'regex.allow',
      )}</label
    >
  {/if}

  {#if scripts.length}
    <ul class:inactive={allowed === false}>
      {#each scripts as script, index (script.id)}
        <li class:off={script.disabled}>
          <input
            type="checkbox"
            checked={!script.disabled}
            title={t('regex.enabled')}
            aria-label={t('regex.enabledFor', { name: script.scriptName })}
            onchange={(e) => toggle(script, e.currentTarget.checked)}
          />
          <button class="name" onclick={() => (editing = structuredClone($state.snapshot(script)))}>
            {script.scriptName || t('regex.unnamed')}
          </button>
          <span class="tools">
            <button
              class="icon-btn small"
              aria-label={t('common.moveUp')}
              disabled={index === 0}
              onclick={() => move(index, -1)}><Icon name="up" size={14} /></button
            >
            <button
              class="icon-btn small"
              aria-label={t('common.moveDown')}
              disabled={index === scripts.length - 1}
              onclick={() => move(index, 1)}><Icon name="down" size={14} /></button
            >
            <button
              class="icon-btn small"
              aria-label={t('regex.options')}
              aria-expanded={menuFor === script.id}
              onclick={() => (menuFor = menuFor === script.id ? null : script.id)}
              ><Icon name="more" size={14} /></button
            >
            {#if menuFor === script.id}
              <div class="menu" role="menu">
                <button role="menuitem" onclick={() => duplicate(script)}
                  ><Icon name="copy" size={15} />{t('regex.duplicate')}</button
                >
                <button
                  role="menuitem"
                  onclick={() => {
                    menuFor = null;
                    download(script, `regex-${script.scriptName}`);
                  }}><Icon name="download" size={15} />{t('common.export')}</button
                >
                {#each moveTargets as target (target.label)}
                  <button role="menuitem" onclick={() => moveTo(target, script)}
                    ><Icon name="forward" size={15} />{target.label}</button
                  >
                {/each}
                <button role="menuitem" class="danger" onclick={() => remove(script)}
                  ><Icon name="trash" size={15} />{t('common.delete')}</button
                >
              </div>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="faint empty">{t('regex.empty')}</p>
  {/if}
</section>

<RegexEditor script={editing} onsave={save} onclose={() => (editing = null)} />

<style>
  section {
    display: grid;
    gap: 0.4rem;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .head span {
    display: flex;
  }
  h3 {
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .allow {
    font-size: var(--bt-size-sm);
  }
  ul {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.1rem;
  }
  ul.inactive {
    opacity: 0.6;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.1rem 0.3rem;
    border-radius: var(--bt-radius-sm);
  }
  li:hover {
    background: var(--bt-surface-2);
  }
  li input {
    accent-color: var(--bt-accent);
  }
  li.off .name {
    opacity: 0.55;
  }
  .name {
    flex: 1;
    min-width: 0;
    padding: 0.35rem 0.2rem;
    border: 0;
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tools {
    display: flex;
    flex: none;
  }
  .menu {
    position: absolute;
    inset-inline-end: 0.3rem;
    top: 100%;
    z-index: 5;
    display: grid;
    min-width: 12rem;
    padding: 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface);
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
  }
  .menu button:hover {
    background: var(--bt-surface-2);
  }
  .menu .danger {
    color: var(--bt-danger);
  }
  .empty {
    font-size: var(--bt-size-sm);
  }
</style>
