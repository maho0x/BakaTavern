<script lang="ts">
  import {
    normalizeContextTemplate,
    normalizeInstructTemplate,
    normalizeSystemPrompt,
    tokenizerIds,
    type ContextTemplate,
    type InstructTemplate,
    type SystemPromptTemplate,
    type TokenizerId,
  } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { chatDefaults, formattingDefaults, type FormattingPrefs } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';
  import { PresetEditor, type PresetPickerEditor } from './preset-editor.svelte.ts';

  const prefs = $derived({ ...formattingDefaults, ...settings.get('formatting', formattingDefaults) });
  const update = (patch: Partial<FormattingPrefs>) => settings.update('formatting', patch);

  const context = new PresetEditor<ContextTemplate>('context', normalizeContextTemplate);
  const instruct = new PresetEditor<InstructTemplate>('instruct', normalizeInstructTemplate);
  const sysprompt = new PresetEditor<SystemPromptTemplate>('sysprompt', normalizeSystemPrompt);

  const pick = (editor: PresetPickerEditor, id: string | null, fallback: string) =>
    editor.presets.find((p) => p.id === id)?.id ??
    editor.presets.find((p) => p.name === fallback)?.id ??
    editor.presets[0]?.id ??
    null;
  const contextId = $derived(pick(context, prefs.contextId, 'Default'));
  const instructId = $derived(pick(instruct, prefs.instructId, 'Alpaca'));
  const syspromptId = $derived(pick(sysprompt, prefs.syspromptId, 'Neutral - Chat'));
  $effect(() => void context.load(contextId));
  $effect(() => void instruct.load(instructId));
  $effect(() => void sysprompt.load(syspromptId));

  /** Templates named alike go together when instruct mode follows the context template. */
  function selectContext(id: string) {
    const patch: Partial<FormattingPrefs> = { contextId: id };
    const name = context.presets.find((p) => p.id === id)?.name;
    const match = instruct.presets.find((p) => p.name === name);
    if (prefs.bindToContext && match) patch.instructId = match.id;
    update(patch);
  }
  function selectInstruct(id: string) {
    const patch: Partial<FormattingPrefs> = { instructId: id };
    const name = instruct.presets.find((p) => p.id === id)?.name;
    const match = context.presets.find((p) => p.name === name);
    if (prefs.bindToContext && match) patch.contextId = match.id;
    update(patch);
  }

  const reasoningTemplates = $derived(library.presets.filter((p) => p.kind === 'reasoning'));
  async function applyReasoning(id: string) {
    try {
      const preset = await api.getPreset(id);
      const data = preset.data as Record<string, unknown>;
      settings.update('chat', {
        reasoningTemplate: preset.name,
        reasoningPrefix: String(data.prefix ?? ''),
        reasoningSuffix: String(data.suffix ?? ''),
        reasoningSeparator: String(data.separator ?? ''),
      });
      ui.toast(t('fmt.reasoningApplied', { name: preset.name }), 'success');
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
  const chatPrefs = $derived(settings.get('chat', chatDefaults));
  const currentReasoning = $derived(
    reasoningTemplates.find((p) => p.name === chatPrefs.reasoningTemplate)?.id ?? '',
  );

  const instructSequences: { key: keyof InstructTemplate; label: MessageKey }[] = [
    { key: 'input_sequence', label: 'fmt.inputSequence' },
    { key: 'input_suffix', label: 'fmt.inputSuffix' },
    { key: 'output_sequence', label: 'fmt.outputSequence' },
    { key: 'output_suffix', label: 'fmt.outputSuffix' },
    { key: 'system_sequence', label: 'fmt.systemSequence' },
    { key: 'system_suffix', label: 'fmt.systemSuffix' },
    { key: 'first_input_sequence', label: 'fmt.firstInputSequence' },
    { key: 'last_input_sequence', label: 'fmt.lastInputSequence' },
    { key: 'first_output_sequence', label: 'fmt.firstOutputSequence' },
    { key: 'last_output_sequence', label: 'fmt.lastOutputSequence' },
    { key: 'last_system_sequence', label: 'fmt.lastSystemSequence' },
    { key: 'story_string_prefix', label: 'fmt.storyStringPrefix' },
    { key: 'story_string_suffix', label: 'fmt.storyStringSuffix' },
    { key: 'stop_sequence', label: 'fmt.stopSequence' },
    { key: 'user_alignment_message', label: 'fmt.userAlignment' },
    { key: 'activation_regex', label: 'fmt.activationRegex' },
  ];
  const instructChecks: { key: keyof InstructTemplate; label: MessageKey }[] = [
    { key: 'wrap', label: 'fmt.wrap' },
    { key: 'macro', label: 'fmt.macro' },
    { key: 'skip_examples', label: 'fmt.skipExamples' },
    { key: 'system_same_as_user', label: 'fmt.systemSameAsUser' },
    { key: 'sequences_as_stop_strings', label: 'fmt.sequencesAsStop' },
  ];
  const contextChecks: { key: keyof ContextTemplate; label: MessageKey }[] = [
    { key: 'names_as_stop_strings', label: 'fmt.namesAsStop' },
    { key: 'use_stop_strings', label: 'fmt.separatorsAsStop' },
    { key: 'always_force_name2', label: 'fmt.alwaysForceName' },
    { key: 'trim_sentences', label: 'fmt.trimSentences' },
    { key: 'single_line', label: 'fmt.singleLine' },
  ];

  /** Tokenizers by name (product names stay untranslated). */
  const tokenizerNames: Record<Exclude<TokenizerId, 'estimate'>, string> = {
    o200k: 'GPT-4o (o200k)',
    cl100k: 'GPT-4 / GPT-3.5 (cl100k)',
    p50k: 'GPT-3 (p50k)',
    gpt2: 'GPT-2',
    llama: 'Llama 1/2',
    llama3: 'Llama 3',
    mistral: 'Mistral',
    nemo: 'Mistral Nemo',
    yi: 'Yi',
    gemma: 'Gemma / Gemini',
    jamba: 'Jamba',
    qwen2: 'Qwen2',
    'command-r': 'Command-R',
    'command-a': 'Command-A',
    deepseek: 'DeepSeek V3',
    claude: 'Claude',
    nerdstash: 'NerdStash (NovelAI Clio)',
    nerdstash_v2: 'NerdStash v2 (NovelAI Kayra)',
  };

  let files = $state<Record<string, HTMLInputElement | undefined>>({});
  const looksLike: Record<string, (d: Record<string, unknown>) => boolean> = {
    context: (d) => 'story_string' in d,
    instruct: (d) => 'input_sequence' in d || 'output_sequence' in d,
    sysprompt: (d) => 'content' in d,
  };
</script>

{#snippet picker(
  editor: PresetPickerEditor,
  id: string | null,
  onselect: (id: string) => void,
  label: MessageKey,
)}
  <div class="row">
    <select class="select" value={id} onchange={(e) => onselect(e.currentTarget.value)} aria-label={t(label)}>
      {#each editor.presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
    <button
      class="icon-btn"
      title={t('preset.import')}
      aria-label={t('preset.import')}
      onclick={() => files[editor.kind]?.click()}><Icon name="upload" /></button
    >
    <button
      class="icon-btn"
      title={t('preset.export')}
      aria-label={t('preset.export')}
      onclick={() => editor.export()}><Icon name="download" /></button
    >
    <button
      class="icon-btn"
      title={t('preset.saveAs')}
      aria-label={t('preset.saveAs')}
      onclick={async () => {
        const created = await editor.saveAs();
        if (created) onselect(created);
      }}><Icon name="copy" /></button
    >
    <button
      class="icon-btn"
      title={t('common.delete')}
      aria-label={t('common.delete')}
      disabled={editor.presets.length < 2}
      onclick={() => void editor.remove()}><Icon name="trash" /></button
    >
    <input
      bind:this={files[editor.kind]}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={async (e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        const created = file ? await editor.import(file, looksLike[editor.kind]!) : null;
        if (created) onselect(created);
      }}
    />
  </div>
{/snippet}

<div class="stack">
  <p class="intro">{t('fmt.intro')}</p>

  <section>
    <h3>{t('fmt.context')}</h3>
    {@render picker(context, contextId, selectContext, 'fmt.context')}
    {#if context.draft}
      {@const d = context.draft}
      <label class="field"
        ><span>{t('fmt.storyString')}</span><textarea
          class="textarea code"
          rows="8"
          spellcheck="false"
          bind:value={d.story_string}
          onchange={() => context.changed()}></textarea><small>{t('fmt.storyStringHint')}</small></label
      >
      <div class="pair">
        <label class="field"
          ><span>{t('fmt.exampleSeparator')}</span><input
            class="input code"
            bind:value={d.example_separator}
            onchange={() => context.changed()}
          /></label
        >
        <label class="field"
          ><span>{t('fmt.chatStart')}</span><input
            class="input code"
            bind:value={d.chat_start}
            onchange={() => context.changed()}
          /></label
        >
      </div>
      <label class="field">
        <span>{t('fmt.storyStringPosition')}</span>
        <select
          class="select"
          value={d.story_string_position}
          onchange={(e) => {
            d.story_string_position = Number(e.currentTarget.value);
            context.changed();
          }}
        >
          <option value={0}>{t('fmt.positionPrompt')}</option>
          <option value={1}>{t('fmt.positionChat')}</option>
        </select>
      </label>
      {#if d.story_string_position === 1}
        <div class="pair">
          <label class="field"
            ><span>{t('note.depth')}</span><input
              class="input"
              type="number"
              min="0"
              bind:value={d.story_string_depth}
              onchange={() => context.changed()}
            /></label
          >
          <label class="field">
            <span>{t('note.role')}</span>
            <select
              class="select"
              value={d.story_string_role}
              onchange={(e) => {
                d.story_string_role = Number(e.currentTarget.value);
                context.changed();
              }}
            >
              <option value={0}>{t('role.system')}</option>
              <option value={1}>{t('role.user')}</option>
              <option value={2}>{t('role.assistant')}</option>
            </select>
          </label>
        </div>
      {/if}
      {#each contextChecks as c (c.key)}
        <label class="check"
          ><input type="checkbox" bind:checked={d[c.key] as boolean} onchange={() => context.changed()} />{t(
            c.label,
          )}</label
        >
      {/each}
    {/if}
  </section>

  <section>
    <div class="section-head">
      <h3>{t('fmt.instruct')}</h3>
      <label class="check"
        ><input
          type="checkbox"
          checked={prefs.instructEnabled}
          onchange={(e) => update({ instructEnabled: e.currentTarget.checked })}
        />{t('fmt.instructEnabled')}</label
      >
    </div>
    {@render picker(instruct, instructId, selectInstruct, 'fmt.instruct')}
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.bindToContext}
        onchange={(e) => update({ bindToContext: e.currentTarget.checked })}
      />{t('fmt.bindToContext')}</label
    >
    {#if instruct.draft}
      {@const d = instruct.draft}
      <label class="field">
        <span>{t('fmt.namesBehavior')}</span>
        <select class="select" bind:value={d.names_behavior} onchange={() => instruct.changed()}>
          <option value="none">{t('fmt.namesNone')}</option>
          <option value="force">{t('fmt.namesForce')}</option>
          <option value="always">{t('fmt.namesAlways')}</option>
        </select>
      </label>
      {#each instructChecks as c (c.key)}
        <label class="check"
          ><input type="checkbox" bind:checked={d[c.key] as boolean} onchange={() => instruct.changed()} />{t(
            c.label,
          )}</label
        >
      {/each}
      <details>
        <summary>{t('fmt.sequences')}</summary>
        <div class="stack inner">
          {#each instructSequences as s (s.key)}
            <label class="field"
              ><span>{t(s.label)}</span><textarea
                class="textarea code compact"
                rows="1"
                spellcheck="false"
                bind:value={d[s.key] as string}
                onchange={() => instruct.changed()}></textarea></label
            >
          {/each}
        </div>
      </details>
    {/if}
  </section>

  <section>
    <div class="section-head">
      <h3>{t('fmt.sysprompt')}</h3>
      <label class="check"
        ><input
          type="checkbox"
          checked={prefs.syspromptEnabled}
          onchange={(e) => update({ syspromptEnabled: e.currentTarget.checked })}
        />{t('fmt.syspromptEnabled')}</label
      >
    </div>
    {@render picker(sysprompt, syspromptId, (id) => update({ syspromptId: id }), 'fmt.sysprompt')}
    {#if sysprompt.draft}
      {@const d = sysprompt.draft}
      <label class="field"
        ><span>{t('fmt.syspromptContent')}</span><textarea
          class="textarea"
          rows="5"
          bind:value={d.content}
          onchange={() => sysprompt.changed()}></textarea></label
      >
      <label class="field"
        ><span>{t('fmt.postHistory')}</span><textarea
          class="textarea"
          rows="2"
          bind:value={d.post_history}
          onchange={() => sysprompt.changed()}></textarea></label
      >
    {/if}
  </section>

  <section>
    <h3>{t('fmt.reasoning')}</h3>
    <select
      class="select"
      value={currentReasoning}
      onchange={(e) => e.currentTarget.value && void applyReasoning(e.currentTarget.value)}
      aria-label={t('fmt.reasoning')}
    >
      <option value="">{t('fmt.reasoningPick')}</option>
      {#each reasoningTemplates as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
    <small class="hint">{t('fmt.reasoningHint')}</small>
  </section>

  <section>
    <h3>{t('fmt.options')}</h3>
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.preferCharacterPrompt}
        onchange={(e) => update({ preferCharacterPrompt: e.currentTarget.checked })}
      />{t('fmt.preferCharPrompt')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.preferCharacterJailbreak}
        onchange={(e) => update({ preferCharacterJailbreak: e.currentTarget.checked })}
      />{t('fmt.preferCharJailbreak')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.pinExamples}
        onchange={(e) => update({ pinExamples: e.currentTarget.checked })}
      />{t('fmt.pinExamples')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.stripExamples}
        onchange={(e) => update({ stripExamples: e.currentTarget.checked })}
      />{t('fmt.stripExamples')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.collapseNewlines}
        onchange={(e) => update({ collapseNewlines: e.currentTarget.checked })}
      />{t('fmt.collapseNewlines')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={prefs.trimSpaces}
        onchange={(e) => update({ trimSpaces: e.currentTarget.checked })}
      />{t('fmt.trimSpaces')}</label
    >
    <label class="field">
      <span>{t('fmt.tokenizer')}</span>
      <select
        class="select"
        value={prefs.tokenizer}
        onchange={(e) => update({ tokenizer: e.currentTarget.value })}
      >
        <option value="auto">{t('fmt.tokenizerAuto')}</option>
        <option value="remote">{t('fmt.tokenizerRemote')}</option>
        <option value="estimate">{t('fmt.tokenizerEstimate')}</option>
        {#each tokenizerIds.filter((id) => id !== 'estimate') as id (id)}<option value={id}
            >{tokenizerNames[id as Exclude<TokenizerId, 'estimate'>]}</option
          >{/each}
      </select>
      <small>{t('fmt.tokenizerHint')}</small>
    </label>
    <label class="field"
      ><span>{t('fmt.tokenPadding')}</span><input
        class="input"
        type="number"
        value={prefs.tokenPadding}
        onchange={(e) => update({ tokenPadding: Number(e.currentTarget.value) || 0 })}
      /></label
    >
  </section>
</div>

<style>
  .stack {
    display: grid;
    gap: 1.25rem;
  }
  .stack.inner {
    margin-top: 0.75rem;
    gap: 0.6rem;
  }
  .intro,
  .hint {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
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
    gap: 0.5rem;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  details summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
</style>
