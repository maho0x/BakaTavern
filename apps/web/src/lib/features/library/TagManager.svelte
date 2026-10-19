<script lang="ts">
  import type { Tag } from '@bakatavern/api-client';

  import { api } from '../../api.ts';
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let newName = $state('');
  const tags = $derived(
    [...library.tags].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
  );
  const uses = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const item of [...library.characters, ...library.groups]) {
      for (const id of item.tags) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  });

  async function save(tag: Tag, patch: Partial<Tag>) {
    try {
      await api.updateTag({ ...tag, ...patch });
      await library.refreshTags();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function add() {
    const name = newName.trim();
    if (!name) return;
    if (library.tags.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) {
      ui.toast(t('tags.exists', { name }), 'error');
      return;
    }
    try {
      await api.createTag(name);
      newName = '';
      await library.refreshTags();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function remove(tag: Tag) {
    if (!confirm(t('tags.deleteConfirm', { name: tag.name }))) return;
    try {
      await api.deleteTag(tag.id);
      await Promise.all([library.refreshTags(), library.refreshCharacters(), library.refreshGroups()]);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<Modal {open} title={t('tags.title')} {onclose}>
  <p class="faint">{t('tags.hint')}</p>
  <ul class="tags">
    {#each tags as tag (tag.id)}
      <li>
        <input
          type="color"
          class="color"
          value={tag.color ?? '#808080'}
          aria-label="{t('tags.color')}: {tag.name}"
          onchange={(e) => save(tag, { color: e.currentTarget.value })}
        />
        <input
          class="input name"
          value={tag.name}
          aria-label="{t('tags.name')}: {tag.name}"
          onchange={(e) => {
            const name = e.currentTarget.value.trim();
            if (name && name !== tag.name) void save(tag, { name });
          }}
        />
        <select
          class="select folder"
          value={tag.folder}
          aria-label="{t('tags.folder')}: {tag.name}"
          onchange={(e) => save(tag, { folder: e.currentTarget.value })}
        >
          <option value="none">{t('tags.folderNone')}</option>
          <option value="open">{t('tags.folderOpen')}</option>
          <option value="closed">{t('tags.folderClosed')}</option>
        </select>
        <span class="count" title={t('tags.uses')}>{uses[tag.id] ?? 0}</span>
        <button
          class="icon-btn small"
          title={t('common.delete')}
          aria-label="{t('common.delete')}: {tag.name}"
          onclick={() => remove(tag)}><Icon name="trash" size={15} /></button
        >
      </li>
    {:else}
      <li class="faint">{t('tags.none')}</li>
    {/each}
  </ul>
  <form
    class="add"
    onsubmit={(e) => {
      e.preventDefault();
      void add();
    }}
  >
    <input
      class="input"
      placeholder={t('tags.newName')}
      aria-label={t('tags.newName')}
      bind:value={newName}
    />
    <button class="btn" type="submit" disabled={!newName.trim()}
      ><Icon name="plus" size={15} />{t('tags.add')}</button
    >
  </form>
</Modal>

<style>
  .tags {
    list-style: none;
    display: grid;
    gap: 0.35rem;
    margin: 0.75rem 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .folder {
    width: auto;
  }
  .color {
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius-sm);
    background: none;
  }
  .count {
    min-width: 1.5rem;
    text-align: right;
    font-size: var(--bt-size-xs);
    color: var(--bt-ink-faint);
  }
  .add {
    display: flex;
    gap: 0.4rem;
  }
  .faint {
    color: var(--bt-ink-faint);
    font-size: var(--bt-size-sm);
  }
</style>
