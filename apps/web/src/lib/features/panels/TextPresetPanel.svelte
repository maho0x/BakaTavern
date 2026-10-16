<script lang="ts">
  import {
    getTextgenType,
    normalizeTextgenSettings,
    textgenPresetExcludedKeys,
    textgenSupports,
    type TextgenSettings,
  } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import { textPrefs } from '../../generation/pipeline.ts';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { connectionDefaults, type TextConnectionPrefs } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import LogitBiasList from './LogitBiasList.svelte';
  import { PresetEditor } from './preset-editor.svelte.ts';

  const prefs = $derived(textPrefs(settings.get('connection', connectionDefaults)));
  const type = $derived(prefs.type);
  const backend = $derived(getTextgenType(type));

  /** Preset files keep samplers only; connection settings stay out of them. */
  const editor = new PresetEditor<TextgenSettings>('textgen', normalizeTextgenSettings, (draft) => {
    const data: Record<string, unknown> = { ...draft };
    for (const key of textgenPresetExcludedKeys) delete data[key];
    return data;
  });
  const activeId = $derived(
    editor.presets.find((p) => p.id === prefs.presetId)?.id ??
      editor.presets.find((p) => p.name === 'Default')?.id ??
      editor.presets[0]?.id ??
      null,
  );
  $effect(() => {
    void editor.load(activeId);
  });
  const draft = $derived(editor.draft);
  let fileInput = $state<HTMLInputElement>();

  function updatePrefs(patch: Partial<TextConnectionPrefs>) {
    settings.update('connection', { text: { ...prefs, ...patch } });
  }

  /** Selecting a preset also takes its context size and response length, like SillyTavern. */
  async function select(id: string | null) {
    if (!id) return;
    updatePrefs({ presetId: id });
    await editor.load(id);
    const data = editor.draft as Record<string, unknown> | null;
    const patch: Partial<TextConnectionPrefs> = { presetId: id };
    if (typeof data?.genamt === 'number') patch.maxResponse = data.genamt;
    if (typeof data?.max_length === 'number') patch.maxContext = data.max_length;
    updatePrefs(patch);
  }

  /** Context size and response length are remembered by the preset too. */
  function setLength(key: 'maxContext' | 'maxResponse', value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    updatePrefs({ [key]: value });
    if (draft) {
      (draft as Record<string, unknown>)[key === 'maxContext' ? 'max_length' : 'genamt'] = value;
      editor.changed();
    }
  }

  const supports = (key: string) => textgenSupports(type, key);
  type Slider = { key: string; label: MessageKey; min: number; max: number; step: number; group?: string };
  const basic: Slider[] = [
    { key: 'temp', label: 'preset.temperature', min: 0, max: 5, step: 0.01 },
    { key: 'top_p', label: 'preset.topP', min: 0, max: 1, step: 0.01 },
    { key: 'top_k', label: 'preset.topK', min: -1, max: 500, step: 1 },
    { key: 'min_p', label: 'preset.minP', min: 0, max: 1, step: 0.001 },
    { key: 'typical_p', label: 'tc.typicalP', min: 0, max: 1, step: 0.01 },
    { key: 'top_a', label: 'preset.topA', min: 0, max: 1, step: 0.01 },
    { key: 'tfs', label: 'tc.tfs', min: 0, max: 1, step: 0.01 },
    { key: 'nsigma', label: 'tc.nsigma', min: 0, max: 5, step: 0.01 },
    { key: 'min_keep', label: 'tc.minKeep', min: 0, max: 100, step: 1 },
    { key: 'epsilon_cutoff', label: 'tc.epsilonCutoff', min: 0, max: 9, step: 0.01 },
    { key: 'eta_cutoff', label: 'tc.etaCutoff', min: 0, max: 20, step: 0.01 },
  ];
  const penalties: Slider[] = [
    { key: 'rep_pen', label: 'preset.repPenalty', min: 1, max: 3, step: 0.01 },
    { key: 'rep_pen_range', label: 'tc.repPenRange', min: -1, max: 8192, step: 1 },
    { key: 'rep_pen_slope', label: 'tc.repPenSlope', min: 0, max: 10, step: 0.01 },
    { key: 'rep_pen_decay', label: 'tc.repPenDecay', min: 0, max: 8192, step: 1 },
    { key: 'freq_pen', label: 'preset.freqPenalty', min: -2, max: 2, step: 0.01 },
    { key: 'presence_pen', label: 'preset.presPenalty', min: -2, max: 2, step: 0.01 },
    { key: 'encoder_rep_pen', label: 'tc.encoderRepPen', min: 0.8, max: 1.5, step: 0.01 },
    { key: 'no_repeat_ngram_size', label: 'tc.noRepeatNgram', min: 0, max: 20, step: 1 },
  ];
  const groups: { id: string; label: MessageKey; toggle?: string; sliders: Slider[] }[] = [
    {
      id: 'dry',
      label: 'tc.dry',
      sliders: [
        { key: 'dry_multiplier', label: 'tc.dryMultiplier', min: 0, max: 5, step: 0.01 },
        { key: 'dry_base', label: 'tc.dryBase', min: 1, max: 4, step: 0.01 },
        { key: 'dry_allowed_length', label: 'tc.dryAllowedLength', min: 1, max: 20, step: 1 },
        {
          key: 'dry_penalty_last_n',
          label: 'tc.dryPenaltyLastN',
          min: 0,
          max: 8192,
          step: 1,
          group: 'dry_penalty_last_n',
        },
      ],
    },
    {
      id: 'xtc',
      label: 'tc.xtc',
      sliders: [
        { key: 'xtc_threshold', label: 'tc.xtcThreshold', min: 0, max: 0.5, step: 0.01 },
        { key: 'xtc_probability', label: 'tc.xtcProbability', min: 0, max: 1, step: 0.01 },
      ],
    },
    {
      id: 'dynatemp',
      label: 'tc.dynatemp',
      toggle: 'dynatemp',
      sliders: [
        { key: 'min_temp', label: 'tc.minTemp', min: 0, max: 5, step: 0.01 },
        { key: 'max_temp', label: 'tc.maxTemp', min: 0, max: 5, step: 0.01 },
        { key: 'dynatemp_exponent', label: 'tc.dynatempExponent', min: 0.01, max: 10, step: 0.01 },
      ],
    },
    {
      id: 'smoothing_factor',
      label: 'tc.smoothing',
      sliders: [
        { key: 'smoothing_factor', label: 'tc.smoothingFactor', min: 0, max: 10, step: 0.01 },
        {
          key: 'smoothing_curve',
          label: 'tc.smoothingCurve',
          min: 1,
          max: 10,
          step: 0.01,
          group: 'smoothing_curve',
        },
      ],
    },
    {
      id: 'mirostat',
      label: 'tc.mirostat',
      sliders: [
        { key: 'mirostat_mode', label: 'tc.mirostatMode', min: 0, max: 2, step: 1 },
        { key: 'mirostat_tau', label: 'tc.mirostatTau', min: 0, max: 20, step: 0.01 },
        { key: 'mirostat_eta', label: 'tc.mirostatEta', min: 0, max: 1, step: 0.01 },
      ],
    },
    {
      id: 'adaptive_target',
      label: 'tc.adaptive',
      sliders: [
        { key: 'adaptive_target', label: 'tc.adaptiveTarget', min: -0.01, max: 1, step: 0.01 },
        { key: 'adaptive_decay', label: 'tc.adaptiveDecay', min: 0, max: 0.99, step: 0.01 },
      ],
    },
  ];
  const checks: { key: string; label: MessageKey }[] = [
    { key: 'temperature_last', label: 'tc.temperatureLast' },
    { key: 'ban_eos_token', label: 'tc.banEos' },
    { key: 'ignore_eos_token', label: 'tc.ignoreEos' },
    { key: 'add_bos_token', label: 'tc.addBos' },
    { key: 'skip_special_tokens', label: 'tc.skipSpecial' },
    { key: 'spaces_between_special_tokens', label: 'tc.spacesSpecial' },
    { key: 'do_sample', label: 'tc.doSample' },
    { key: 'speculative_ngram', label: 'tc.speculativeNgram' },
  ];
  const orderLists = $derived(
    [
      { key: 'sampler_order', label: 'tc.samplerOrder' as MessageKey },
      { key: 'samplers', label: 'tc.samplerOrder' as MessageKey },
      { key: 'sampler_priority', label: 'tc.samplerOrder' as MessageKey },
      { key: 'samplers_priorities', label: 'tc.samplerOrder' as MessageKey },
    ].filter((l) => supports(l.key)),
  );

  const value = (key: string) => (draft as Record<string, unknown> | null)?.[key];
  function set(key: string, next: unknown) {
    if (!draft) return;
    (draft as Record<string, unknown>)[key] = next;
    editor.changed();
  }
  function move(key: string, index: number, delta: number) {
    const list = [...((value(key) as unknown[]) ?? [])];
    const to = index + delta;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    set(key, list);
  }
  const bannedPlaceholder = '"as an AI"\n[1, 2]';
  /** KoboldCpp numbers its samplers. */
  const koboldSamplers = [
    'Top K',
    'Top A',
    'Top P',
    'Tail Free',
    'Typical',
    'Temperature',
    'Repetition penalty',
  ];
  const orderLabel = (key: string, item: unknown) =>
    key === 'sampler_order' ? (koboldSamplers[Number(item)] ?? String(item)) : String(item);
</script>

{#snippet slider(s: Slider)}
  {#if supports(s.group ?? s.key)}
    <label class="slider">
      <span>{t(s.label)}</span>
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={s.step}
        value={Number(value(s.key) ?? 0)}
        oninput={(e) => set(s.key, Number(e.currentTarget.value))}
      />
      <input
        class="input num"
        type="number"
        min={s.min}
        max={s.max}
        step={s.step}
        value={Number(value(s.key) ?? 0)}
        onchange={(e) => set(s.key, Number(e.currentTarget.value))}
      />
    </label>
  {/if}
{/snippet}

<div class="stack">
  <div class="row">
    <select
      class="select"
      value={activeId}
      onchange={(e) => void select(e.currentTarget.value)}
      aria-label={t('tc.presetSelect')}
    >
      {#each editor.presets as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
    </select>
    <button
      class="icon-btn"
      title={t('preset.import')}
      aria-label={t('preset.import')}
      onclick={() => fileInput?.click()}><Icon name="upload" /></button
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
      onclick={async () => select(await editor.saveAs())}><Icon name="copy" /></button
    >
    <button
      class="icon-btn"
      title={t('common.delete')}
      aria-label={t('common.delete')}
      disabled={editor.presets.length < 2}
      onclick={async () => {
        if (await editor.remove()) updatePrefs({ presetId: null });
      }}><Icon name="trash" /></button
    >
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={async (e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file)
          await select(await editor.import(file, (d) => 'temp' in d || 'rep_pen' in d || 'top_p' in d));
      }}
    />
  </div>

  <section>
    <h3>{t('preset.context')}</h3>
    <div class="pair">
      <label class="field"
        ><span>{t('preset.maxContext')}</span><input
          class="input"
          type="number"
          min="512"
          step="256"
          value={prefs.maxContext}
          onchange={(e) => setLength('maxContext', Number(e.currentTarget.value))}
        /></label
      >
      <label class="field"
        ><span>{t('preset.maxTokens')}</span><input
          class="input"
          type="number"
          min="1"
          value={prefs.maxResponse}
          onchange={(e) => setLength('maxResponse', Number(e.currentTarget.value))}
        /></label
      >
    </div>
    {#if backend}<small class="hint">{t('tc.samplersFor', { backend: backend.name })}</small>{/if}
  </section>

  {#if draft}
    <section>
      <h3>{t('preset.samplers')}</h3>
      {#each basic as s (s.key)}{@render slider(s)}{/each}
    </section>

    <section>
      <h3>{t('tc.penalties')}</h3>
      {#each penalties as s (s.key)}{@render slider(s)}{/each}
    </section>

    {#each groups.filter((g) => supports(g.id)) as g (g.id)}
      <details>
        <summary>{t(g.label)}</summary>
        <div class="stack inner">
          {#if g.toggle}
            <label class="check"
              ><input
                type="checkbox"
                checked={Boolean(value(g.toggle))}
                onchange={(e) => set(g.toggle!, e.currentTarget.checked)}
              />{t('tc.enabled')}</label
            >
          {/if}
          {#each g.sliders as s (s.key)}{@render slider(s)}{/each}
          {#if g.id === 'dry'}
            <label class="field"
              ><span>{t('tc.drySequenceBreakers')}</span><input
                class="input code"
                value={String(value('dry_sequence_breakers') ?? '')}
                onchange={(e) => set('dry_sequence_breakers', e.currentTarget.value)}
              /></label
            >
          {/if}
        </div>
      </details>
    {/each}

    <details>
      <summary>{t('tc.other')}</summary>
      <div class="stack inner">
        {#if supports('seed')}
          <label class="field"
            ><span>{t('preset.seed')}</span><input
              class="input"
              type="number"
              value={Number(value('seed') ?? -1)}
              onchange={(e) => set('seed', Number(e.currentTarget.value))}
            /></label
          >
        {/if}
        {#if supports('min_length')}
          <label class="field"
            ><span>{t('tc.minLength')}</span><input
              class="input"
              type="number"
              min="0"
              value={Number(value('min_length') ?? 0)}
              onchange={(e) => set('min_length', Number(e.currentTarget.value))}
            /></label
          >
        {/if}
        {#each checks.filter((c) => supports(c.key)) as c (c.key)}
          <label class="check"
            ><input
              type="checkbox"
              checked={Boolean(value(c.key))}
              onchange={(e) => set(c.key, e.currentTarget.checked)}
            />{t(c.label)}</label
          >
        {/each}
        {#if supports('banned_tokens')}
          <label class="field"
            ><span>{t('tc.bannedTokens')}</span><textarea
              class="textarea code"
              rows="3"
              spellcheck="false"
              placeholder={bannedPlaceholder}
              value={String(value('banned_tokens') ?? '')}
              onchange={(e) => set('banned_tokens', e.currentTarget.value)}></textarea><small
              >{t('tc.bannedTokensHint')}</small
            ></label
          >
        {/if}
        {#if supports('logit_bias')}
          <div class="field">
            <span>{t('bias.title')}</span>
            <LogitBiasList
              entries={(value('logit_bias') as { text?: string; value?: number }[] | undefined) ?? []}
              onchange={(entries) => set('logit_bias', entries)}
            />
          </div>
        {/if}
        {#if supports('grammar_string')}
          <label class="field"
            ><span>{t('tc.grammar')}</span><textarea
              class="textarea code"
              rows="3"
              spellcheck="false"
              value={String(value('grammar_string') ?? '')}
              onchange={(e) => set('grammar_string', e.currentTarget.value)}></textarea></label
          >
        {/if}
        {#if supports('guidance_scale')}
          <label class="field"
            ><span>{t('tc.negativePrompt')}</span><textarea
              class="textarea"
              rows="2"
              value={String(value('negative_prompt') ?? '')}
              onchange={(e) => set('negative_prompt', e.currentTarget.value)}></textarea></label
          >
          {@render slider({ key: 'guidance_scale', label: 'tc.guidanceScale', min: 0.1, max: 4, step: 0.05 })}
        {/if}
        {#each orderLists as l (l.key)}
          <div class="field">
            <span>{t(l.label)}</span>
            <ol class="order">
              {#each (value(l.key) as unknown[]) ?? [] as item, i (String(item))}
                <li>
                  <span>{orderLabel(l.key, item)}</span>
                  <button
                    class="icon-btn small"
                    aria-label={t('common.moveUp')}
                    onclick={() => move(l.key, i, -1)}><Icon name="up" size={14} /></button
                  >
                  <button
                    class="icon-btn small"
                    aria-label={t('common.moveDown')}
                    onclick={() => move(l.key, i, 1)}><Icon name="down" size={14} /></button
                  >
                </li>
              {/each}
            </ol>
          </div>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1.1rem;
  }
  .stack.inner {
    margin-top: 0.75rem;
    gap: 0.6rem;
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
  .hint {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  details summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .order {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.1rem;
  }
  .order li {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--bt-size-sm);
  }
  .order li span {
    flex: 1;
  }
</style>
