<script lang="ts">
  import {
    regexFromString,
    RegexPlacement,
    runRegexScript,
    SubstituteRegex,
    type RegexScript,
  } from '@bakatavern/core';

  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t, type MessageKey } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';

  interface Props {
    /** The script being edited (a copy); null closes the editor. */
    script: RegexScript | null;
    onsave: (script: RegexScript) => void;
    onclose: () => void;
  }
  let { script, onsave, onclose }: Props = $props();
  const uid = $props.id();

  let draft = $state<RegexScript | null>(null);
  let trimText = $state('');
  let testInput = $state('');

  $effect(() => {
    draft = script ? structuredClone($state.snapshot(script)) : null;
    trimText = script?.trimStrings?.join('\n') ?? '';
  });

  const placements: { value: number; label: MessageKey }[] = [
    { value: RegexPlacement.USER_INPUT, label: 'regex.userInput' },
    { value: RegexPlacement.AI_OUTPUT, label: 'regex.aiOutput' },
    { value: RegexPlacement.SLASH_COMMAND, label: 'regex.slashCommands' },
    { value: RegexPlacement.WORLD_INFO, label: 'regex.worldInfo' },
    { value: RegexPlacement.REASONING, label: 'regex.reasoning' },
  ];

  const invalid = $derived(
    !!draft?.findRegex && Number(draft.substituteRegex) === SubstituteRegex.NONE
      ? !regexFromString(draft.findRegex)
      : false,
  );

  const testOutput = $derived.by(() => {
    if (!draft || !testInput) return '';
    const test = { ...$state.snapshot(draft), trimStrings: lines(trimText), disabled: false };
    return runRegexScript(test, testInput, chat.regexSubstitute(), {
      characterOverride: chat.character?.name,
    });
  });

  function lines(text: string) {
    return text.split('\n').filter((line) => line.length > 0);
  }

  function togglePlacement(value: number, on: boolean) {
    if (!draft) return;
    const rest = draft.placement.filter((p) => p !== value);
    draft.placement = on ? [...rest, value].sort((a, b) => a - b) : rest;
  }

  function depthValue(text: string): number | null {
    if (text.trim() === '') return null;
    const n = Number.parseInt(text, 10);
    return Number.isNaN(n) ? null : n;
  }

  function save() {
    if (!draft) return;
    if (!draft.scriptName.trim()) {
      alert(t('regex.nameRequired'));
      return;
    }
    onsave({ ...$state.snapshot(draft), trimStrings: lines(trimText) });
  }
</script>

<Modal open={!!draft} title={t('regex.editor')} {onclose} wide>
  {#if draft}
    <label class="field"
      ><span>{t('regex.name')}</span><input class="input" bind:value={draft.scriptName} /></label
    >
    <div class="hinted">
      <label class="field">
        <span>{t('regex.find')}</span>
        <textarea
          class="textarea mono"
          rows="2"
          spellcheck="false"
          placeholder="/pattern/flags"
          aria-describedby="{uid}-find"
          aria-invalid={invalid}
          bind:value={draft.findRegex}></textarea>
      </label>
      {#if invalid}<small id="{uid}-find" class="hint error">{t('regex.invalid')}</small>
      {:else}<small id="{uid}-find" class="hint">{t('regex.findHint')}</small>{/if}
    </div>
    <div class="hinted">
      <label class="field">
        <span>{t('regex.replace')}</span>
        <textarea
          class="textarea mono"
          rows="3"
          spellcheck="false"
          aria-describedby="{uid}-replace"
          bind:value={draft.replaceString}></textarea>
      </label>
      <small id="{uid}-replace" class="hint">{t('regex.replaceHint')}</small>
    </div>
    <div class="hinted">
      <label class="field">
        <span>{t('regex.trim')}</span>
        <textarea
          class="textarea mono"
          rows="2"
          spellcheck="false"
          aria-describedby="{uid}-trim"
          bind:value={trimText}></textarea>
      </label>
      <small id="{uid}-trim" class="hint">{t('regex.trimHint')}</small>
    </div>

    <div class="columns">
      <fieldset>
        <legend>{t('regex.affects')}</legend>
        {#each placements as p (p.value)}
          <label class="check"
            ><input
              type="checkbox"
              checked={draft.placement.includes(p.value)}
              onchange={(e) => togglePlacement(p.value, e.currentTarget.checked)}
            />{t(p.label)}</label
          >
        {/each}
      </fieldset>
      <fieldset>
        <legend>{t('regex.when')}</legend>
        <label class="check"
          ><input type="checkbox" bind:checked={draft.markdownOnly} />{t('regex.displayOnly')}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={draft.promptOnly} />{t('regex.promptOnly')}</label
        >
        <small class="hint">{t('regex.whenHint')}</small>
        <label class="check"
          ><input type="checkbox" bind:checked={draft.runOnEdit} />{t('regex.runOnEdit')}</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={draft.disabled} />{t('regex.disabled')}</label
        >
      </fieldset>
    </div>

    <div class="columns three">
      <label class="field">
        <span>{t('regex.macros')}</span>
        <select
          class="select"
          value={Number(draft.substituteRegex)}
          onchange={(e) => (draft!.substituteRegex = Number(e.currentTarget.value))}
        >
          <option value={SubstituteRegex.NONE}>{t('regex.macrosNone')}</option>
          <option value={SubstituteRegex.RAW}>{t('regex.macrosRaw')}</option>
          <option value={SubstituteRegex.ESCAPED}>{t('regex.macrosEscaped')}</option>
        </select>
      </label>
      <label class="field">
        <span>{t('regex.minDepth')}</span>
        <input
          class="input"
          type="number"
          min="-1"
          placeholder={t('regex.unlimited')}
          value={draft.minDepth ?? ''}
          onchange={(e) => (draft!.minDepth = depthValue(e.currentTarget.value))}
        />
      </label>
      <label class="field">
        <span>{t('regex.maxDepth')}</span>
        <input
          class="input"
          type="number"
          min="0"
          placeholder={t('regex.unlimited')}
          value={draft.maxDepth ?? ''}
          onchange={(e) => (draft!.maxDepth = depthValue(e.currentTarget.value))}
        />
      </label>
    </div>
    <small class="hint">{t('regex.depthHint')}</small>

    <details class="test">
      <summary>{t('regex.test')}</summary>
      <div class="columns">
        <label class="field"
          ><span>{t('regex.testInput')}</span><textarea class="textarea" rows="4" bind:value={testInput}
          ></textarea></label
        >
        <div class="field">
          <span>{t('regex.testOutput')}</span>
          <output class="textarea output">{testOutput}</output>
        </div>
      </div>
    </details>
  {/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={onclose}>{t('common.cancel')}</button>
    <button class="btn primary" onclick={save}><Icon name="check" size={15} />{t('common.save')}</button>
  {/snippet}
</Modal>

<style>
  .mono {
    font-family: var(--bt-font-mono);
    font-size: var(--bt-size-sm);
  }
  .hinted {
    display: grid;
    gap: 0.3rem;
  }
  .hint {
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .hint.error {
    color: var(--bt-danger);
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.75rem 1rem;
  }
  .columns.three {
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  }
  fieldset {
    display: grid;
    gap: 0.35rem;
    align-content: start;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    padding: 0.6rem 0.8rem 0.75rem;
  }
  legend {
    padding: 0 0.3rem;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .test summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
    margin-bottom: 0.5rem;
  }
  .output {
    display: block;
    min-height: 5.5rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--bt-surface-2);
  }
</style>
