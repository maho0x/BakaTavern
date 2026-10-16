<script lang="ts">
  import {
    estimateTokens,
    GENERATION_TRIGGERS,
    WorldInfoLogic,
    WorldInfoPosition,
    type WorldInfoEntry,
  } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import KeywordInput from './KeywordInput.svelte';
  import { characterKey, placementOf, placements, strategyOf } from './entries.ts';

  interface Props {
    entry: WorldInfoEntry;
    /** Applies changed fields (the owner updates its copy and saves it). */
    onchange: (patch: Partial<WorldInfoEntry>) => void;
    ondelete: () => void;
    onduplicate: () => void;
  }
  let { entry, onchange, ondelete, onduplicate }: Props = $props();

  const tokens = $derived(estimateTokens(entry.content));
  const placement = $derived(placementOf(entry));
  const strategy = $derived(strategyOf(entry));
  const filter = $derived(entry.characterFilter ?? { isExclude: false, names: [], tags: [] });
  // Character filters match SillyTavern's avatar file name, which two cards may share.
  const characterOptions = $derived([
    ...new Map(
      library.characters.map((c) => [characterKey(c), { value: characterKey(c), label: c.name }]),
    ).values(),
  ]);
  const tagOptions = $derived(library.tags.map((tag) => ({ value: tag.id, label: tag.name })));
  const delayLevel = $derived(typeof entry.delayUntilRecursion === 'number' ? entry.delayUntilRecursion : 1);

  function set<K extends keyof WorldInfoEntry>(key: K, value: WorldInfoEntry[K]) {
    onchange({ [key]: value } as Partial<WorldInfoEntry>);
  }

  function setPlacement(value: string) {
    const option = placements.find((p) => p.value === value)!;
    onchange(
      option.role !== undefined
        ? { position: option.position, role: option.role }
        : { position: option.position },
    );
  }

  function setStrategy(value: string) {
    onchange({ constant: value === 'constant', vectorized: value === 'vectorized' });
  }

  /** Nullable number fields: empty means "use the global setting". */
  function optionalNumber(text: string): number | null {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  function triState(value: boolean | null): string {
    return value === null || value === undefined ? '' : String(value);
  }

  function setTriState(key: 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring', value: string) {
    set(key, value === '' ? null : value === 'true');
  }

  function setFilter(patch: Partial<NonNullable<WorldInfoEntry['characterFilter']>>) {
    onchange({ characterFilter: { ...filter, ...patch } });
  }

  function toggleTrigger(trigger: string, on: boolean) {
    const rest = (entry.triggers ?? []).filter((x) => x !== trigger);
    set('triggers', on ? [...rest, trigger] : rest);
  }

  const sources: { key: keyof WorldInfoEntry; label: MessageKey }[] = [
    { key: 'matchPersonaDescription', label: 'wi.matchPersona' },
    { key: 'matchCharacterDescription', label: 'wi.matchDescription' },
    { key: 'matchCharacterPersonality', label: 'wi.matchPersonality' },
    { key: 'matchCharacterDepthPrompt', label: 'wi.matchDepthPrompt' },
    { key: 'matchScenario', label: 'wi.matchScenario' },
    { key: 'matchCreatorNotes', label: 'wi.matchCreatorNotes' },
  ];
  const triggerLabels: Record<string, MessageKey> = {
    normal: 'wi.triggerNormal',
    continue: 'wi.triggerContinue',
    impersonate: 'wi.triggerImpersonate',
    swipe: 'wi.triggerSwipe',
    regenerate: 'wi.triggerRegenerate',
    quiet: 'wi.triggerQuiet',
  };
</script>

<div class="editor">
  <div class="title-row">
    <label class="field grow"
      ><span>{t('wi.comment')}</span><input
        class="input"
        value={entry.comment}
        oninput={(e) => set('comment', e.currentTarget.value)}
      /></label
    >
    <label class="check enabled"
      ><input
        type="checkbox"
        checked={!entry.disable}
        onchange={(e) => set('disable', !e.currentTarget.checked)}
      />{t('wi.enabled')}</label
    >
  </div>

  <div class="grid">
    <label class="field">
      <span>{t('wi.strategy')}</span>
      <select class="select" value={strategy} onchange={(e) => setStrategy(e.currentTarget.value)}>
        <option value="keyword">{t('wi.strategyKeyword')}</option>
        <option value="constant">{t('wi.strategyConstant')}</option>
        <option value="vectorized">{t('wi.strategyVector')}</option>
      </select>
    </label>
    <label class="field wide">
      <span>{t('wi.position')}</span>
      <select class="select" value={placement} onchange={(e) => setPlacement(e.currentTarget.value)}>
        {#each placements as option (option.value)}<option value={option.value}>{t(option.label)}</option
          >{/each}
      </select>
    </label>
    {#if entry.position === WorldInfoPosition.atDepth}
      <label class="field"
        ><span>{t('note.depth')}</span><input
          class="input"
          type="number"
          min="0"
          value={entry.depth}
          onchange={(e) => set('depth', Number(e.currentTarget.value))}
        /></label
      >
    {/if}
    {#if entry.position === WorldInfoPosition.outlet}
      <label class="field"
        ><span>{t('wi.outletName')}</span><input
          class="input"
          value={entry.outletName}
          oninput={(e) => set('outletName', e.currentTarget.value)}
        /></label
      >
    {/if}
    <label class="field"
      ><span>{t('wi.order')}</span><input
        class="input"
        type="number"
        value={entry.order}
        onchange={(e) => set('order', Number(e.currentTarget.value))}
      /></label
    >
    <label class="field"
      ><span>{t('wi.probability')}</span><input
        class="input"
        type="number"
        min="0"
        max="100"
        disabled={!entry.useProbability}
        value={entry.probability}
        onchange={(e) => set('probability', Number(e.currentTarget.value))}
      /></label
    >
  </div>

  {#if strategy !== 'constant'}
    <div class="field">
      <span id="primary-keys">{t('wi.keys')}</span>
      <KeywordInput
        keys={entry.key ?? []}
        label={t('wi.keys')}
        placeholder={t('wi.keysPlaceholder')}
        onchange={(keys) => set('key', keys)}
      />
    </div>
    <div class="secondary">
      <label class="field">
        <span>{t('wi.logic')}</span>
        <select
          class="select"
          value={entry.selectiveLogic ?? WorldInfoLogic.AND_ANY}
          onchange={(e) => set('selectiveLogic', Number(e.currentTarget.value))}
        >
          <option value={WorldInfoLogic.AND_ANY}>{t('wi.logicAndAny')}</option>
          <option value={WorldInfoLogic.AND_ALL}>{t('wi.logicAndAll')}</option>
          <option value={WorldInfoLogic.NOT_ANY}>{t('wi.logicNotAny')}</option>
          <option value={WorldInfoLogic.NOT_ALL}>{t('wi.logicNotAll')}</option>
        </select>
      </label>
      <div class="field grow">
        <span>{t('wi.secondary')}</span>
        <KeywordInput
          keys={entry.keysecondary ?? []}
          label={t('wi.secondary')}
          onchange={(keys) => onchange({ selective: true, keysecondary: keys })}
        />
      </div>
    </div>
  {/if}

  <label class="field content">
    <span>{t('wi.content')} <span class="faint">· {t('wi.tokens', { count: tokens })}</span></span>
    <textarea
      class="textarea prose"
      rows="10"
      value={entry.content}
      oninput={(e) => set('content', e.currentTarget.value)}></textarea>
  </label>

  <details>
    <summary>{t('wi.sectionActivation')}</summary>
    <div class="grid">
      <label class="field"
        ><span>{t('wi.entryScanDepth')}</span><input
          class="input"
          type="number"
          min="0"
          placeholder={t('wi.useGlobal')}
          value={entry.scanDepth ?? ''}
          onchange={(e) => set('scanDepth', optionalNumber(e.currentTarget.value))}
        /></label
      >
      <label class="field">
        <span>{t('wi.caseSensitive')}</span>
        <select
          class="select"
          value={triState(entry.caseSensitive)}
          onchange={(e) => setTriState('caseSensitive', e.currentTarget.value)}
        >
          <option value="">{t('wi.useGlobal')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      </label>
      <label class="field">
        <span>{t('wi.wholeWords')}</span>
        <select
          class="select"
          value={triState(entry.matchWholeWords)}
          onchange={(e) => setTriState('matchWholeWords', e.currentTarget.value)}
        >
          <option value="">{t('wi.useGlobal')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      </label>
      <label class="field"
        ><span>{t('wi.automationId')}</span><input
          class="input"
          value={entry.automationId}
          oninput={(e) => set('automationId', e.currentTarget.value)}
        /></label
      >
    </div>
    <label class="check"
      ><input
        type="checkbox"
        checked={entry.useProbability}
        onchange={(e) => set('useProbability', e.currentTarget.checked)}
      />{t('wi.useProbability')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={entry.ignoreBudget}
        onchange={(e) => set('ignoreBudget', e.currentTarget.checked)}
      />{t('wi.ignoreBudget')}</label
    >
  </details>

  <details>
    <summary>{t('wi.sectionGroups')}</summary>
    <div class="grid">
      <label class="field"
        ><span>{t('wi.group')}</span><input
          class="input"
          placeholder={t('wi.groupPlaceholder')}
          value={entry.group}
          oninput={(e) => set('group', e.currentTarget.value)}
        /></label
      >
      <label class="field"
        ><span>{t('wi.groupWeight')}</span><input
          class="input"
          type="number"
          min="1"
          value={entry.groupWeight}
          onchange={(e) => set('groupWeight', Number(e.currentTarget.value))}
        /></label
      >
      <label class="field">
        <span>{t('wi.groupScoring')}</span>
        <select
          class="select"
          value={triState(entry.useGroupScoring)}
          onchange={(e) => setTriState('useGroupScoring', e.currentTarget.value)}
        >
          <option value="">{t('wi.useGlobal')}</option>
          <option value="true">{t('common.yes')}</option>
          <option value="false">{t('common.no')}</option>
        </select>
      </label>
    </div>
    <label class="check"
      ><input
        type="checkbox"
        checked={entry.groupOverride}
        onchange={(e) => set('groupOverride', e.currentTarget.checked)}
      />{t('wi.groupOverride')}</label
    >
  </details>

  <details>
    <summary>{t('wi.sectionTiming')}</summary>
    <div class="grid">
      <label class="field"
        ><span>{t('wi.sticky')}</span><input
          class="input"
          type="number"
          min="0"
          placeholder="0"
          value={entry.sticky ?? ''}
          onchange={(e) => set('sticky', optionalNumber(e.currentTarget.value))}
        /></label
      >
      <label class="field"
        ><span>{t('wi.cooldown')}</span><input
          class="input"
          type="number"
          min="0"
          placeholder="0"
          value={entry.cooldown ?? ''}
          onchange={(e) => set('cooldown', optionalNumber(e.currentTarget.value))}
        /></label
      >
      <label class="field"
        ><span>{t('wi.delay')}</span><input
          class="input"
          type="number"
          min="0"
          placeholder="0"
          value={entry.delay ?? ''}
          onchange={(e) => set('delay', optionalNumber(e.currentTarget.value))}
        /></label
      >
    </div>
    <small class="hint">{t('wi.timingHint')}</small>
  </details>

  <details>
    <summary>{t('wi.sectionRecursion')}</summary>
    <label class="check"
      ><input
        type="checkbox"
        checked={entry.excludeRecursion}
        onchange={(e) => set('excludeRecursion', e.currentTarget.checked)}
      />{t('wi.excludeRecursion')}</label
    >
    <label class="check"
      ><input
        type="checkbox"
        checked={entry.preventRecursion}
        onchange={(e) => set('preventRecursion', e.currentTarget.checked)}
      />{t('wi.preventRecursion')}</label
    >
    <div class="inline">
      <label class="check"
        ><input
          type="checkbox"
          checked={!!entry.delayUntilRecursion}
          onchange={(e) => set('delayUntilRecursion', e.currentTarget.checked)}
        />{t('wi.delayUntilRecursion')}</label
      >
      {#if entry.delayUntilRecursion}
        <label class="field level"
          ><span>{t('wi.recursionLevel')}</span><input
            class="input"
            type="number"
            min="1"
            value={delayLevel}
            onchange={(e) => {
              const level = Number(e.currentTarget.value);
              set('delayUntilRecursion', level > 1 ? level : true);
            }}
          /></label
        >
      {/if}
    </div>
  </details>

  <details>
    <summary>{t('wi.sectionFilters')}</summary>
    <div class="field">
      <span>{t('wi.filterCharacters')}</span>
      <KeywordInput
        keys={filter.names}
        label={t('wi.filterCharacters')}
        options={characterOptions}
        onchange={(names) => setFilter({ names })}
      />
    </div>
    <div class="field">
      <span>{t('wi.filterTags')}</span>
      <KeywordInput
        keys={filter.tags}
        label={t('wi.filterTags')}
        options={tagOptions}
        onchange={(tags) => setFilter({ tags })}
      />
    </div>
    <label class="check"
      ><input
        type="checkbox"
        checked={filter.isExclude}
        onchange={(e) => setFilter({ isExclude: e.currentTarget.checked })}
      />{t('wi.filterExclude')}</label
    >
    <fieldset>
      <legend>{t('wi.triggers')}</legend>
      {#each GENERATION_TRIGGERS as trigger (trigger)}
        <label class="check"
          ><input
            type="checkbox"
            checked={(entry.triggers ?? []).includes(trigger)}
            onchange={(e) => toggleTrigger(trigger, e.currentTarget.checked)}
          />{t(triggerLabels[trigger]!)}</label
        >
      {/each}
      <small class="hint">{t('wi.triggersHint')}</small>
    </fieldset>
  </details>

  <details>
    <summary>{t('wi.sectionSources')}</summary>
    <small class="hint">{t('wi.sourcesHint')}</small>
    {#each sources as source (source.key)}
      <label class="check"
        ><input
          type="checkbox"
          checked={!!entry[source.key]}
          onchange={(e) => set(source.key, e.currentTarget.checked as never)}
        />{t(source.label)}</label
      >
    {/each}
  </details>

  <div class="actions">
    <button class="btn ghost" onclick={onduplicate}
      ><Icon name="copy" size={15} />{t('wi.duplicateEntry')}</button
    >
    <button class="btn danger ghost" onclick={ondelete}
      ><Icon name="trash" size={15} />{t('wi.deleteEntry')}</button
    >
  </div>
</div>

<style>
  .editor {
    display: grid;
    gap: 0.9rem;
    align-content: start;
  }
  .title-row,
  .secondary,
  .inline {
    display: flex;
    gap: 0.75rem;
    align-items: end;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
    min-width: 12rem;
  }
  .enabled {
    padding-bottom: 0.55rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
    gap: 0.6rem 0.75rem;
  }
  /* Position labels are long ("In the chat at a depth, as assistant"). */
  .grid .wide {
    grid-column: span 2;
  }
  .secondary .field:first-child {
    width: 9.5rem;
  }
  .content textarea {
    min-height: 12rem;
    resize: vertical;
  }
  details {
    display: grid;
    gap: 0.5rem;
    border-top: 1px solid var(--bt-line);
    padding-top: 0.6rem;
  }
  details[open] {
    padding-bottom: 0.2rem;
  }
  details > :not(summary) {
    margin-top: 0.5rem;
  }
  summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .hint {
    display: block;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .level {
    width: 8rem;
  }
  fieldset {
    display: grid;
    gap: 0.3rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    padding: 0.5rem 0.75rem 0.65rem;
  }
  legend {
    padding: 0 0.3rem;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
    border-top: 1px solid var(--bt-line);
    padding-top: 0.75rem;
  }
</style>
