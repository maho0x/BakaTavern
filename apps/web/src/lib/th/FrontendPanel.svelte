<script lang="ts">
  import Icon from '../components/Icon.svelte';
  import { t } from '../i18n/index.svelte.ts';
  import { chat } from '../state/chat.svelte.ts';
  import { DebouncedSave } from '../state/pending-saves.ts';
  import { errorText, ui } from '../state/ui.svelte.ts';
  import {
    helperScripts,
    normalizeTrees,
    type Script,
    type ScriptSource,
    type ScriptTree,
  } from './scripts.svelte.ts';

  const prefs = $derived(helperScripts.prefs);
  const character = $derived(chat.character);
  const trusted = $derived(!!character && prefs.trustedCharacters.includes(character.id));

  /** The script being edited: a copy saved shortly after each change. */
  let editing = $state<{ source: ScriptSource; draft: Script } | null>(null);
  let importInput = $state<HTMLInputElement>();

  const saver = new DebouncedSave(async () => {
    const current = editing;
    if (!current) return;
    const draft = JSON.parse(JSON.stringify(current.draft)) as Script;
    try {
      await helperScripts.updateScript(current.source, draft.id, () => draft);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  });

  const sources = $derived(
    [
      { id: 'global' as const, label: t('th.globalScripts'), trees: helperScripts.globalTrees },
      ...(helperScripts.preset
        ? [
            {
              id: 'preset' as const,
              label: t('th.presetScripts'),
              trees: helperScripts.preset.settings.scripts,
            },
          ]
        : []),
      ...(character
        ? [
            {
              id: 'character' as const,
              label: t('th.characterScripts', { name: character.name }),
              trees: helperScripts.characterSettings.scripts,
            },
          ]
        : []),
    ].filter((s) => s.id === 'global' || s.trees.length > 0),
  );

  function setTrusted(on: boolean, input: HTMLInputElement) {
    if (!character) return;
    if (on && !confirm(t('th.trustWarning', { name: character.name }))) {
      input.checked = false;
      return;
    }
    const list = prefs.trustedCharacters.filter((id) => id !== character.id);
    helperScripts.update({ trustedCharacters: on ? [...list, character.id] : list });
  }

  /** Whether the scripts of a source may run (global ones: the switch for all of them). */
  function sourceOn(source: ScriptSource): boolean {
    if (source === 'global') return prefs.globalScripts;
    if (source === 'character') return helperScripts.characterAllowed;
    return helperScripts.presetAllowed;
  }

  function setSourceOn(source: ScriptSource, on: boolean) {
    if (source === 'global') helperScripts.update({ globalScripts: on });
    else if (source === 'character' && chat.characterId)
      helperScripts.setAllowed('allowedCharacters', chat.characterId, on);
    else if (source === 'preset' && helperScripts.preset)
      helperScripts.setAllowed('allowedPresets', helperScripts.preset.id, on);
  }

  async function change(source: ScriptSource, trees: ScriptTree[]) {
    try {
      if (source === 'global') helperScripts.setGlobalTrees(trees);
      else if (source === 'character')
        await helperScripts.setCharacterSettings({ ...helperScripts.characterSettings, scripts: trees });
      else if (helperScripts.preset)
        await helperScripts.setPresetSettings({ ...helperScripts.preset.settings, scripts: trees });
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  function toggle(source: ScriptSource, trees: ScriptTree[], id: string, enabled: boolean) {
    void change(
      source,
      trees.map((tree) =>
        tree.id === id
          ? { ...tree, enabled }
          : tree.type === 'folder'
            ? { ...tree, scripts: tree.scripts.map((s) => (s.id === id ? { ...s, enabled } : s)) }
            : tree,
      ),
    );
  }

  function remove(source: ScriptSource, trees: ScriptTree[], script: Script) {
    if (!confirm(t('th.deleteScriptConfirm', { name: script.name }))) return;
    if (editing?.draft.id === script.id) editing = null;
    void change(
      source,
      trees
        .filter((tree) => tree.id !== script.id)
        .map((tree) =>
          tree.type === 'folder'
            ? { ...tree, scripts: tree.scripts.filter((s) => s.id !== script.id) }
            : tree,
        ),
    );
  }

  function edit(source: ScriptSource, script: Script) {
    void saver.flush();
    editing =
      editing?.draft.id === script.id
        ? null
        : { source, draft: JSON.parse(JSON.stringify(script)) as Script };
  }

  function addScript() {
    const [script] = normalizeTrees([
      { type: 'script', name: t('th.newScriptName'), enabled: false, content: '' },
    ]);
    if (!script || script.type !== 'script') return;
    helperScripts.setGlobalTrees([...helperScripts.globalTrees, script]);
    editing = { source: 'global', draft: script };
  }

  /** TavernHelper's exported scripts: one script or folder, or a list of them. */
  async function importScripts(files: FileList | null) {
    for (const file of files ?? []) {
      try {
        const json: unknown = JSON.parse(await file.text());
        const taken = new Set(
          helperScripts.globalTrees.flatMap((t) => [
            t.id,
            ...(t.type === 'folder' ? t.scripts.map((s) => s.id) : []),
          ]),
        );
        const imported = normalizeTrees(Array.isArray(json) ? json : [json]).map((tree) =>
          taken.has(tree.id) ? { ...tree, id: crypto.getRandomValues(new Uint32Array(2)).join('-') } : tree,
        );
        if (!imported.length) throw new Error(t('th.notScripts'));
        helperScripts.setGlobalTrees([...helperScripts.globalTrees, ...imported]);
      } catch (error) {
        ui.toast(t('th.importFailed', { file: file.name, message: errorText(error) }), 'error');
      }
    }
    if (importInput) importInput.value = '';
  }

  function buttonsText(script: Script) {
    return script.button.buttons.map((b) => b.name).join('\n');
  }
</script>

<div class="stack">
  <section class="card">
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.enabled}
        onchange={(e) => helperScripts.update({ enabled: e.currentTarget.checked })}
      />{t('th.enabled')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.cdn}
        onchange={(e) => helperScripts.update({ cdn: e.currentTarget.checked })}
      />{t('th.cdn')}</label
    >
    {#if character}
      <label class="check"
        ><input
          type="checkbox"
          checked={trusted}
          onchange={(e) => setTrusted(e.currentTarget.checked, e.currentTarget)}
        />{t('th.trust', { name: character.name })}</label
      >
    {/if}
    <p class="faint">{t('th.safeModeHint')}</p>
  </section>

  {#each sources as source (source.id)}
    <section class="card" aria-label={source.label}>
      <div class="head">
        <h3>{source.label}</h3>
        {#if source.id === 'global'}
          <span class="actions">
            <button
              class="icon-btn small"
              title={t('th.addScript')}
              aria-label={t('th.addScript')}
              onclick={addScript}><Icon name="plus" size={15} /></button
            >
            <button
              class="icon-btn small"
              title={t('th.importScripts')}
              aria-label={t('th.importScripts')}
              onclick={() => importInput?.click()}><Icon name="upload" size={15} /></button
            >
          </span>
          <input
            bind:this={importInput}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onchange={(e) => importScripts(e.currentTarget.files)}
          />
        {/if}
      </div>
      <label class="check"
        ><input
          type="checkbox"
          checked={sourceOn(source.id)}
          onchange={(e) => setSourceOn(source.id, e.currentTarget.checked)}
        />{source.id === 'global' ? t('th.runGlobal') : t('th.allowScripts')}</label
      >
      {#if source.trees.length === 0}
        <p class="faint">{t('th.noScripts')}</p>
      {:else}
        <ul class="scripts">
          {#each source.trees as tree (tree.id)}
            {#if tree.type === 'folder'}
              <li class="folder">
                <label class="check"
                  ><input
                    type="checkbox"
                    checked={tree.enabled}
                    onchange={(e) => toggle(source.id, source.trees, tree.id, e.currentTarget.checked)}
                  /><strong>{tree.name}</strong></label
                >
              </li>
            {/if}
            {#each tree.type === 'folder' ? tree.scripts : [tree] as script (script.id)}
              <li class:nested={tree.type === 'folder'}>
                <div class="row">
                  <input
                    type="checkbox"
                    aria-label="{t('th.scriptEnabled')}: {script.name}"
                    checked={script.enabled}
                    onchange={(e) => toggle(source.id, source.trees, script.id, e.currentTarget.checked)}
                  />
                  <span class="name">{script.name || t('th.unnamed')}</span>
                  <button
                    class="icon-btn small"
                    title={t('th.editScript')}
                    aria-label="{t('th.editScript')}: {script.name}"
                    aria-expanded={editing?.draft.id === script.id}
                    onclick={() => edit(source.id, script)}><Icon name="edit" size={15} /></button
                  >
                  <button
                    class="icon-btn small"
                    title={t('common.delete')}
                    aria-label="{t('common.delete')}: {script.name}"
                    onclick={() => remove(source.id, source.trees, script)}
                    ><Icon name="trash" size={15} /></button
                  >
                </div>
                {#if editing && editing.draft.id === script.id}
                  <div class="editor">
                    <label class="field"
                      ><span>{t('th.scriptName')}</span><input
                        class="input"
                        bind:value={editing.draft.name}
                        oninput={() => saver.schedule()}
                      /></label
                    >
                    <label class="field"
                      ><span>{t('th.scriptCode')}</span><textarea
                        class="textarea code"
                        rows="10"
                        spellcheck="false"
                        bind:value={editing.draft.content}
                        oninput={() => saver.schedule()}></textarea></label
                    >
                    <label class="field"
                      ><span>{t('th.scriptButtonsField')}</span><textarea
                        class="textarea compact"
                        rows="2"
                        value={buttonsText(editing.draft)}
                        oninput={(e) => {
                          if (!editing) return;
                          editing.draft.button.buttons = e.currentTarget.value
                            .split('\n')
                            .map((name) => name.trim())
                            .filter(Boolean)
                            .map((name) => ({ name, visible: true }));
                          saver.schedule();
                        }}></textarea></label
                    >
                  </div>
                {/if}
              </li>
            {/each}
          {/each}
        </ul>
      {/if}
    </section>
  {/each}
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
  .row {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .head h3,
  .name {
    flex: 1;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-sm);
  }
  .row input[type='checkbox'] {
    accent-color: var(--bt-accent);
  }
  .scripts {
    list-style: none;
    display: grid;
    gap: 0.25rem;
  }
  .nested {
    padding-left: 1.2rem;
  }
  .editor {
    display: grid;
    gap: 0.5rem;
    padding: 0.5rem 0 0.25rem;
  }
  .faint {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-xs);
  }
</style>
