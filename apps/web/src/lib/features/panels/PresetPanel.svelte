<script lang="ts">
  import type { Preset } from '@bakatavern/api-client';
  import {
    DEFAULT_BIAS_LIST,
    defaultChatCompletionPreset,
    GLOBAL_PROMPT_ORDER_ID,
    NamesBehavior,
    normalizeChatCompletionPreset,
    PostProcessing,
    supportsLogitBias,
    uuidv4,
    type ChatCompletionPreset,
    type LogitBiasEntry,
    type PromptDefinition,
  } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { invalidatePreset } from '../../generation/pipeline.ts';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { DebouncedSave } from '../../state/pending-saves.ts';
  import { connectionDefaults, logitBiasDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import LogitBiasList from './LogitBiasList.svelte';

  const prefs = $derived(settings.get('connection', connectionDefaults));
  const presets = $derived(library.presets.filter((p) => p.kind === 'openai'));
  const activeId = $derived(
    prefs.presetId && presets.some((p) => p.id === prefs.presetId)
      ? prefs.presetId
      : (presets[0]?.id ?? null),
  );

  let preset = $state<Preset | null>(null);
  let draft = $state<ChatCompletionPreset | null>(null);
  const saver = new DebouncedSave(save);
  let fileInput = $state<HTMLInputElement>();
  let editing = $state<PromptDefinition | null>(null);
  let editingIsNew = $state(false);

  // Make sure a preset exists and load the active one.
  $effect(() => {
    const id = activeId;
    if (!id) {
      void createDefault();
      return;
    }
    if (preset?.id === id) return;
    void api.getPreset(id).then((p) => {
      preset = p;
      draft = normalizeChatCompletionPreset(p.data);
    });
  });

  async function createDefault() {
    if (presets.length) return;
    const created = await api.upsertPreset(
      'openai',
      'Default',
      defaultChatCompletionPreset() as unknown as Record<string, unknown>,
    );
    await library.refreshPresets();
    settings.update('connection', { presetId: created.id });
  }

  function changed() {
    saver.schedule();
  }

  async function save() {
    if (!preset || !draft) return;
    try {
      preset = await api.updatePreset(preset.id, {
        data: $state.snapshot(draft) as unknown as Record<string, unknown>,
        rev: preset.rev,
      });
      library.presets = library.presets.map((p) => (p.id === preset!.id ? { ...p, rev: preset!.rev } : p));
      invalidatePreset();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function importPreset(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      if (!Array.isArray(data.prompts) && !('temp_openai' in data) && !('temperature' in data))
        throw new Error(t('preset.notCC'));
      const name = file.name.replace(/\.json$/i, '');
      const created = await api.upsertPreset('openai', name, data);
      await library.refreshPresets();
      settings.update('connection', { presetId: created.id });
      preset = null;
      ui.toast(t('preset.imported', { name }), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      if (fileInput) fileInput.value = '';
    }
  }

  async function saveAs() {
    if (!draft) return;
    const name = prompt(t('preset.saveAsPrompt'), `${preset?.name ?? 'Preset'} (copy)`)?.trim();
    if (!name) return;
    const created = await api.upsertPreset(
      'openai',
      name,
      $state.snapshot(draft) as unknown as Record<string, unknown>,
    );
    await library.refreshPresets();
    settings.update('connection', { presetId: created.id });
    preset = null;
  }

  async function removePreset() {
    if (!preset || !confirm(t('preset.deleteConfirm', { name: preset.name }))) return;
    await api.deletePreset(preset.id);
    await library.refreshPresets();
    settings.update('connection', { presetId: null });
    preset = null;
  }

  function exportPreset() {
    if (!draft || !preset) return;
    const blob = new Blob([JSON.stringify($state.snapshot(draft), null, 4)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${preset.name}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Prompt manager
  const order = $derived.by(() => {
    if (!draft) return [];
    let list = draft.prompt_order.find((l) => String(l.character_id) === String(GLOBAL_PROMPT_ORDER_ID));
    if (!list) {
      list = { character_id: GLOBAL_PROMPT_ORDER_ID, order: [] };
      draft.prompt_order.push(list);
    }
    return list.order;
  });
  const promptById = (id: string) => draft?.prompts.find((p) => p.identifier === id);

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    [order[index], order[to]] = [order[to]!, order[index]!];
    changed();
  }

  function newPrompt() {
    editing = {
      identifier: uuidv4(),
      name: '',
      role: 'system',
      content: '',
      system_prompt: false,
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
    };
    editingIsNew = true;
  }

  function savePrompt() {
    if (!draft || !editing) return;
    const prompt = $state.snapshot(editing);
    const index = draft.prompts.findIndex((p) => p.identifier === prompt.identifier);
    if (index >= 0) draft.prompts[index] = prompt;
    else draft.prompts.push(prompt);
    if (editingIsNew) order.push({ identifier: prompt.identifier, enabled: true });
    editing = null;
    changed();
  }

  function deletePrompt(id: string) {
    if (!draft || !confirm(t('preset.deletePromptConfirm'))) return;
    draft.prompts = draft.prompts.filter((p) => p.identifier !== id);
    const i = order.findIndex((e) => e.identifier === id);
    if (i >= 0) order.splice(i, 1);
    changed();
  }

  // Logit bias lists live in the settings; the preset names the one it uses.
  const biasLists = $derived(settings.get('logitbias', logitBiasDefaults).lists);
  const biasName = $derived(
    draft && draft.bias_preset_selected in biasLists ? draft.bias_preset_selected : DEFAULT_BIAS_LIST,
  );
  let biasFile = $state<HTMLInputElement>();
  const setBiasLists = (lists: Record<string, LogitBiasEntry[]>) => settings.update('logitbias', { lists });
  function selectBias(name: string) {
    if (!draft) return;
    draft.bias_preset_selected = name;
    changed();
  }
  function addBiasList(name: string | undefined, entries: LogitBiasEntry[] = []) {
    name = name?.trim();
    if (!name) return;
    if (name in biasLists) {
      ui.toast(t('bias.exists', { name }), 'error');
      return;
    }
    setBiasLists({ ...biasLists, [name]: entries });
    selectBias(name);
  }
  function removeBiasList() {
    if (!confirm(t('bias.deleteConfirm', { name: biasName }))) return;
    const rest = { ...biasLists };
    delete rest[biasName];
    setBiasLists(rest);
    selectBias(Object.keys(rest)[0] ?? DEFAULT_BIAS_LIST);
  }
  /** Lists are files with an array of `{ text, value }`, as SillyTavern exports them. */
  async function importBiasList(file: File | undefined) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      if (!Array.isArray(data)) throw new Error(t('bias.notList'));
      const entries = data
        .filter(
          (e): e is { text: string; value: number } =>
            typeof e?.text === 'string' && typeof e?.value === 'number',
        )
        .map((e) => ({ id: uuidv4(), text: e.text, value: e.value }));
      addBiasList(file.name.replace(/\.json$/i, ''), entries);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
  function exportBiasList() {
    const blob = new Blob([JSON.stringify(biasLists[biasName] ?? [], null, 4)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${biasName}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const samplers: {
    key: keyof ChatCompletionPreset;
    label: MessageKey;
    min: number;
    max: number;
    step: number;
  }[] = [
    { key: 'temp_openai', label: 'preset.temperature', min: 0, max: 2, step: 0.01 },
    { key: 'top_p_openai', label: 'preset.topP', min: 0, max: 1, step: 0.01 },
    { key: 'top_k_openai', label: 'preset.topK', min: 0, max: 500, step: 1 },
    { key: 'min_p_openai', label: 'preset.minP', min: 0, max: 1, step: 0.001 },
    { key: 'top_a_openai', label: 'preset.topA', min: 0, max: 1, step: 0.001 },
    { key: 'freq_pen_openai', label: 'preset.freqPenalty', min: -2, max: 2, step: 0.01 },
    { key: 'pres_pen_openai', label: 'preset.presPenalty', min: -2, max: 2, step: 0.01 },
    { key: 'repetition_penalty_openai', label: 'preset.repPenalty', min: 1, max: 2, step: 0.01 },
  ];

  const utility: { key: keyof ChatCompletionPreset; label: MessageKey }[] = [
    { key: 'impersonation_prompt', label: 'preset.impersonationPrompt' },
    { key: 'continue_nudge_prompt', label: 'preset.continueNudge' },
    { key: 'new_chat_prompt', label: 'preset.newChat' },
    { key: 'new_group_chat_prompt', label: 'preset.newGroupChat' },
    { key: 'new_example_chat_prompt', label: 'preset.newExampleChat' },
    { key: 'group_nudge_prompt', label: 'preset.groupNudge' },
    { key: 'wi_format', label: 'preset.wiFormat' },
    { key: 'scenario_format', label: 'preset.scenarioFormat' },
    { key: 'personality_format', label: 'preset.personalityFormat' },
    { key: 'send_if_empty', label: 'preset.sendIfEmpty' },
  ];
</script>

<div class="stack">
  <div class="row">
    <select
      class="select"
      value={activeId}
      onchange={(e) => {
        settings.update('connection', { presetId: e.currentTarget.value });
        preset = null;
      }}
      aria-label={t('preset.select')}
    >
      {#each presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
    <button
      class="icon-btn"
      title={t('preset.import')}
      aria-label={t('preset.import')}
      onclick={() => fileInput?.click()}><Icon name="upload" /></button
    >
    <button class="icon-btn" title={t('preset.export')} aria-label={t('preset.export')} onclick={exportPreset}
      ><Icon name="download" /></button
    >
    <button class="icon-btn" title={t('preset.saveAs')} aria-label={t('preset.saveAs')} onclick={saveAs}
      ><Icon name="copy" /></button
    >
    <button
      class="icon-btn"
      title={t('common.delete')}
      aria-label={t('common.delete')}
      onclick={removePreset}
      disabled={presets.length < 2}><Icon name="trash" /></button
    >
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={(e) => importPreset(e.currentTarget.files)}
    />
  </div>

  {#if draft}
    <section>
      <h3>{t('preset.context')}</h3>
      <div class="pair">
        <label class="field"
          ><span>{t('preset.maxContext')}</span><input
            class="input"
            type="number"
            min="512"
            step="256"
            bind:value={draft.openai_max_context}
            onchange={changed}
          /></label
        >
        <label class="field"
          ><span>{t('preset.maxTokens')}</span><input
            class="input"
            type="number"
            min="1"
            bind:value={draft.openai_max_tokens}
            onchange={changed}
          /></label
        >
      </div>
      <label class="check"
        ><input type="checkbox" bind:checked={draft.stream_openai} onchange={changed} />{t(
          'preset.stream',
        )}</label
      >
    </section>

    <section>
      <h3>{t('preset.samplers')}</h3>
      {#each samplers as s (s.key)}
        <label class="slider">
          <span>{t(s.label)}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            bind:value={draft[s.key] as number}
            onchange={changed}
          />
          <input
            class="input num"
            type="number"
            min={s.min}
            max={s.max}
            step={s.step}
            bind:value={draft[s.key] as number}
            onchange={changed}
          />
        </label>
      {/each}
      <div class="pair">
        <label class="field">
          <span>{t('preset.reasoningEffort')}</span>
          <select class="select" bind:value={draft.reasoning_effort} onchange={changed}>
            {#each ['auto', 'min', 'low', 'medium', 'high', 'max'] as level (level)}<option value={level}
                >{level}</option
              >{/each}
          </select>
        </label>
        <label class="field"
          ><span>{t('preset.seed')}</span><input
            class="input"
            type="number"
            bind:value={draft.seed}
            onchange={changed}
          /></label
        >
      </div>
      <label class="field">
        <span>{t('preset.verbosity')}</span>
        <select class="select" bind:value={draft.verbosity} onchange={changed}>
          {#each ['auto', 'low', 'medium', 'high'] as level (level)}<option value={level}>{level}</option
            >{/each}
        </select>
      </label>
      <label class="check"
        ><input type="checkbox" bind:checked={draft.show_thoughts} onchange={changed} />{t(
          'preset.showThoughts',
        )}</label
      >
      <label class="check"
        ><input
          type="checkbox"
          checked={!!draft.enable_web_search}
          onchange={(e) => {
            draft!.enable_web_search = e.currentTarget.checked;
            changed();
          }}
        />{t('preset.webSearch')}</label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={draft.function_calling} onchange={changed} />{t(
          'preset.functionCalling',
        )}</label
      >
      {#if draft.function_calling && ['custom', 'openrouter'].includes(prefs.providerId)}
        <label class="field">
          <span>{t('preset.toolReasoning')}</span>
          <select
            class="select"
            value={String(draft.tool_reasoning_mode ?? 'disabled')}
            onchange={(e) => {
              draft!.tool_reasoning_mode = e.currentTarget.value;
              changed();
            }}
          >
            <option value="disabled">{t('preset.toolReasoningOff')}</option>
            <option value="active_chain">{t('preset.toolReasoningChain')}</option>
            <option value="since_last_user">{t('preset.toolReasoningSinceUser')}</option>
          </select>
        </label>
      {/if}
      <label class="check"
        ><input type="checkbox" bind:checked={draft.media_inlining} onchange={changed} />{t(
          'preset.mediaInlining',
        )}</label
      >
      {#if draft.media_inlining}
        <label class="field">
          <span>{t('preset.imageQuality')}</span>
          <select class="select" bind:value={draft.inline_image_quality} onchange={changed}>
            <option value="auto">{t('preset.imageQualityAuto')}</option>
            <option value="low">{t('preset.imageQualityLow')}</option>
            <option value="high">{t('preset.imageQualityHigh')}</option>
          </select>
        </label>
      {/if}
    </section>

    <section>
      <div class="section-head">
        <h3>{t('preset.prompts')}</h3>
        <button class="btn" onclick={newPrompt}><Icon name="plus" size={15} />{t('preset.addPrompt')}</button>
      </div>
      <ul class="prompts">
        {#each order as entry, i (entry.identifier)}
          {@const p = promptById(entry.identifier)}
          {#if p}
            <li class:off={!entry.enabled}>
              <input
                type="checkbox"
                bind:checked={entry.enabled}
                onchange={changed}
                aria-label={t('preset.enablePrompt', { name: p.name ?? p.identifier })}
              />
              <button
                class="prompt-name"
                onclick={() => {
                  editing = structuredClone($state.snapshot(p));
                  editingIsNew = false;
                }}
                disabled={p.marker}
              >
                <span>{p.name || p.identifier}</span>
                <span class="meta">
                  {#if p.marker}{t('preset.marker')}{:else}{p.role ?? 'system'}{/if}
                  {#if p.injection_position === 1}
                    · @{p.injection_depth ?? 4}{/if}
                </span>
              </button>
              <button
                class="icon-btn small"
                aria-label={t('common.moveUp')}
                onclick={() => move(i, -1)}
                disabled={i === 0}><Icon name="up" size={14} /></button
              >
              <button
                class="icon-btn small"
                aria-label={t('common.moveDown')}
                onclick={() => move(i, 1)}
                disabled={i === order.length - 1}><Icon name="down" size={14} /></button
              >
            </li>
          {/if}
        {/each}
      </ul>
    </section>

    <details>
      <summary>{t('preset.behavior')}</summary>
      <div class="stack inner">
        <label class="field">
          <span>{t('preset.namesBehavior')}</span>
          <select class="select" bind:value={draft.names_behavior} onchange={changed}>
            <option value={NamesBehavior.NONE}>{t('preset.namesNone')}</option>
            <option value={NamesBehavior.DEFAULT}>{t('preset.namesDefault')}</option>
            <option value={NamesBehavior.COMPLETION}>{t('preset.namesCompletion')}</option>
            <option value={NamesBehavior.CONTENT}>{t('preset.namesContent')}</option>
          </select>
        </label>
        <label class="field">
          <span>{t('preset.postProcessing')}</span>
          <select class="select" bind:value={draft.custom_prompt_post_processing} onchange={changed}>
            <option value={PostProcessing.NONE}>{t('common.none')}</option>
            <option value={PostProcessing.MERGE}>{t('preset.ppMerge')}</option>
            <option value={PostProcessing.SEMI}>{t('preset.ppSemi')}</option>
            <option value={PostProcessing.STRICT}>{t('preset.ppStrict')}</option>
            <option value={PostProcessing.SINGLE}>{t('preset.ppSingle')}</option>
          </select>
        </label>
        <label class="check"
          ><input type="checkbox" bind:checked={draft.squash_system_messages} onchange={changed} />{t(
            'preset.squash',
          )}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={draft.use_sysprompt} onchange={changed} />{t(
            'preset.useSysprompt',
          )}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={draft.continue_prefill} onchange={changed} />{t(
            'preset.continuePrefill',
          )}</label
        >
        <label class="field"
          ><span>{t('preset.assistantPrefill')}</span><textarea
            class="textarea"
            rows="2"
            bind:value={draft.assistant_prefill}
            onchange={changed}></textarea></label
        >
        <label class="field"
          ><span>{t('preset.assistantImpersonation')}</span><textarea
            class="textarea"
            rows="2"
            bind:value={draft.assistant_impersonation}
            onchange={changed}></textarea></label
        >
      </div>
    </details>

    {#if supportsLogitBias(prefs.providerId)}
      <details>
        <summary>{t('bias.title')}</summary>
        <div class="stack inner">
          <div class="row">
            <select
              class="select"
              value={biasName}
              onchange={(e) => selectBias(e.currentTarget.value)}
              aria-label={t('bias.list')}
            >
              {#each Object.keys(biasLists) as name (name)}<option value={name}>{name}</option>{/each}
            </select>
            <button
              class="icon-btn"
              title={t('bias.new')}
              aria-label={t('bias.new')}
              onclick={() => addBiasList(prompt(t('bias.newPrompt')) ?? undefined)}
              ><Icon name="plus" /></button
            >
            <button
              class="icon-btn"
              title={t('preset.import')}
              aria-label={t('preset.import')}
              onclick={() => biasFile?.click()}><Icon name="upload" /></button
            >
            <button
              class="icon-btn"
              title={t('preset.export')}
              aria-label={t('preset.export')}
              onclick={exportBiasList}><Icon name="download" /></button
            >
            <button
              class="icon-btn"
              title={t('common.delete')}
              aria-label={t('common.delete')}
              disabled={Object.keys(biasLists).length < 2}
              onclick={removeBiasList}><Icon name="trash" /></button
            >
            <input
              bind:this={biasFile}
              type="file"
              accept=".json,application/json"
              hidden
              onchange={(e) => {
                void importBiasList(e.currentTarget.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
          </div>
          <LogitBiasList
            entries={biasLists[biasName] ?? []}
            onchange={(entries) => setBiasLists({ ...biasLists, [biasName]: entries as LogitBiasEntry[] })}
          />
        </div>
      </details>
    {/if}

    <details>
      <summary>{t('preset.utility')}</summary>
      <div class="stack inner">
        {#each utility as u (u.key)}
          <label class="field"
            ><span>{t(u.label)}</span><textarea
              class="textarea"
              rows="2"
              bind:value={draft[u.key] as string}
              onchange={changed}></textarea></label
          >
        {/each}
      </div>
    </details>
  {/if}
</div>

<Modal
  open={!!editing}
  title={editingIsNew ? t('preset.addPrompt') : t('preset.editPrompt')}
  onclose={() => (editing = null)}
>
  {#if editing}
    <label class="field"
      ><span>{t('preset.promptName')}</span><input class="input" bind:value={editing.name} /></label
    >
    <div class="pair">
      <label class="field">
        <span>{t('note.role')}</span>
        <select class="select" bind:value={editing.role}>
          <option value="system">{t('role.system')}</option>
          <option value="user">{t('role.user')}</option>
          <option value="assistant">{t('role.assistant')}</option>
        </select>
      </label>
      <label class="field">
        <span>{t('preset.position')}</span>
        <select class="select" bind:value={editing.injection_position}>
          <option value={0}>{t('preset.relative')}</option>
          <option value={1}>{t('preset.inChat')}</option>
        </select>
      </label>
    </div>
    {#if editing.injection_position === 1}
      <div class="pair">
        <label class="field"
          ><span>{t('note.depth')}</span><input
            class="input"
            type="number"
            min="0"
            bind:value={editing.injection_depth}
          /></label
        >
        <label class="field"
          ><span>{t('preset.order')}</span><input
            class="input"
            type="number"
            bind:value={editing.injection_order}
          /></label
        >
      </div>
    {/if}
    <label class="field"
      ><span>{t('preset.promptContent')}</span><textarea
        class="textarea"
        rows="12"
        bind:value={editing.content}></textarea></label
    >
    <label class="field">
      <span>{t('preset.triggers')}</span>
      <select class="select" multiple size="6" bind:value={editing.injection_trigger}>
        {#each ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as trigger (trigger)}<option
            value={trigger}>{trigger}</option
          >{/each}
      </select>
      <small>{t('preset.triggersHint')}</small>
    </label>
  {/if}
  {#snippet footer()}
    {#if editing && !editing.system_prompt && !editingIsNew}
      <button
        class="btn danger ghost"
        onclick={() => {
          deletePrompt(editing!.identifier);
          editing = null;
        }}>{t('common.delete')}</button
      >
    {/if}
    <button class="btn ghost" onclick={() => (editing = null)}>{t('common.cancel')}</button>
    <button class="btn primary" onclick={savePrompt}>{t('common.save')}</button>
  {/snippet}
</Modal>

<style>
  .stack {
    display: grid;
    gap: 1.1rem;
  }
  .stack.inner {
    margin-top: 0.75rem;
  }
  .row {
    display: flex;
    gap: 0.2rem;
    align-items: center;
  }
  .row .select {
    flex: 1;
    min-width: 0;
  }
  section {
    display: grid;
    gap: 0.6rem;
  }
  h3 {
    font-size: var(--bt-size-sm);
    font-weight: 650;
    color: var(--bt-ink-muted);
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .slider {
    display: grid;
    grid-template-columns: 7.5rem 1fr 4.5rem;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .num {
    padding: 0.25rem 0.35rem;
    font-size: var(--bt-size-sm);
  }
  .prompts {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.15rem;
  }
  .prompts li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.3rem;
    border-radius: var(--bt-radius-sm);
  }
  .prompts li:hover {
    background: var(--bt-surface-2);
  }
  .prompts li.off .prompt-name {
    opacity: 0.5;
  }
  .prompts input[type='checkbox'] {
    accent-color: var(--bt-accent);
  }
  .prompt-name {
    flex: 1;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.3rem 0.2rem;
    border: 0;
    background: transparent;
    text-align: start;
    font-size: var(--bt-size-sm);
  }
  .prompt-name:disabled {
    cursor: default;
  }
  .prompt-name span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    flex: none;
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-xs);
  }
  details summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
</style>
