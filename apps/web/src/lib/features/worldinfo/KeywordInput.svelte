<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';

  interface Props {
    keys: string[];
    onchange: (keys: string[]) => void;
    label: string;
    placeholder?: string;
    /** Suggestions shown while typing (values are what gets stored). */
    options?: { value: string; label: string }[];
  }
  let { keys, onchange, label, placeholder, options }: Props = $props();
  const listId = $props.id();
  let text = $state('');

  /** `/pattern/flags` keys are regexes; inside one a comma does not end the key. */
  const isRegex = (key: string) => /^\/.+\/[a-z]*$/i.test(key);
  const typingRegex = (value: string) => value.startsWith('/') && !isRegex(value);

  function display(key: string) {
    return options?.find((o) => o.value === key)?.label ?? key;
  }

  function add(values: string[]) {
    const next = [...keys];
    for (const raw of values) {
      const typed = raw.trim();
      // Picking a suggestion stores its value.
      const value = options?.find((o) => o.label === typed)?.value ?? typed;
      if (value && !next.includes(value)) next.push(value);
    }
    if (next.length !== keys.length) onchange(next);
  }

  function commit() {
    if (!text.trim()) return;
    add([text]);
    text = '';
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || (event.key === ',' && !typingRegex(text))) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !text && keys.length) {
      // Take the last key back into the input for editing.
      text = keys.at(-1)!;
      onchange(keys.slice(0, -1));
      event.preventDefault();
    }
  }

  function onpaste(event: ClipboardEvent) {
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (!pasted.includes(',') || isRegex(pasted.trim())) return;
    event.preventDefault();
    add(pasted.split(','));
  }

  function edit(index: number) {
    commit();
    text = keys[index]!;
    onchange(keys.filter((_, i) => i !== index));
  }
</script>

<div class="chips" role="group" aria-label={label}>
  {#each keys as key, index (`${index}:${key}`)}
    <span class="chip" class:regex={isRegex(key)}>
      <button class="text" title={t('wi.editKey')} onclick={() => edit(index)}>{display(key)}</button>
      <button
        class="remove"
        aria-label={t('wi.removeKey', { key: display(key) })}
        onclick={() => onchange(keys.filter((_, i) => i !== index))}><Icon name="close" size={12} /></button
      >
    </span>
  {/each}
  <input
    aria-label={label}
    placeholder={keys.length ? '' : placeholder}
    list={options ? listId : undefined}
    bind:value={text}
    {onkeydown}
    {onpaste}
    onblur={commit}
    onchange={() => {
      // Choosing from the suggestion list fires change without a key press.
      if (options?.some((o) => o.label === text.trim())) commit();
    }}
  />
  {#if options}
    <datalist id={listId}>
      <!-- Several options may share a value (two cards from files with the same name). -->
      {#each options as option, index (index)}<option value={option.label}></option>{/each}
    </datalist>
  {/if}
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
    min-height: 2.4rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: var(--bt-bg);
  }
  .chips:focus-within {
    outline: 2px solid var(--bt-focus);
    outline-offset: -1px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    border-radius: 999px;
    background: var(--bt-surface-3);
    font-size: var(--bt-size-sm);
  }
  .chip.regex {
    font-family: var(--bt-font-mono);
    background: color-mix(in oklch, var(--bt-action) 30%, var(--bt-surface-3));
  }
  .chip button {
    border: 0;
    background: transparent;
    color: inherit;
  }
  .text {
    padding: 0.15rem 0.2rem 0.15rem 0.6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove {
    display: grid;
    place-items: center;
    padding: 0.2rem 0.45rem 0.2rem 0.15rem;
    color: var(--bt-ink-muted);
  }
  input {
    flex: 1;
    min-width: 6rem;
    border: 0;
    background: transparent;
    padding: 0.2rem;
    outline: none;
  }
</style>
