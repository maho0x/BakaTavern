<script lang="ts">
  import type { Group, GroupMember } from '@bakatavern/api-client';
  import {
    GroupActivation,
    GroupGenerationMode,
    groupSettingsDefaults,
    normalizeGroupSettings,
    type GroupSettings,
  } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import GroupAvatar from '../../components/GroupAvatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  /** The group being edited; null while creating one. */
  let group = $state<Group | null>(null);
  let name = $state('');
  let fav = $state(false);
  let members = $state<GroupMember[]>([]);
  let settings = $state<GroupSettings>({ ...groupSettingsDefaults });
  let query = $state('');
  let saving = $state(false);
  let avatarInput = $state<HTMLInputElement>();

  const creating = $derived(ui.editingGroupId === 'new');

  $effect(() => {
    const id = ui.editingGroupId;
    query = '';
    if (!id || id === 'new') {
      group = null;
      name = '';
      fav = false;
      members = [];
      settings = { ...groupSettingsDefaults };
      return;
    }
    void api.getGroup(id).then((g) => {
      group = g;
      name = g.name;
      fav = g.fav;
      members = g.members.map((m) => ({ ...m }));
      settings = normalizeGroupSettings(g.settings);
    });
  });

  const memberIds = $derived(new Set(members.map((m) => m.characterId)));
  const candidates = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return library.characters
      .filter((c) => !memberIds.has(c.id) && (!q || c.name.toLowerCase().includes(q)))
      .slice(0, 50);
  });

  function close() {
    ui.editingGroupId = null;
  }

  function move(index: number, delta: number) {
    const next = index + delta;
    if (next < 0 || next >= members.length) return;
    [members[index], members[next]] = [members[next]!, members[index]!];
  }

  /** SillyTavern names an unnamed group after its members. */
  function groupName() {
    const names = members.map((m) => library.character(m.characterId)?.name).filter(Boolean);
    return name.trim() || t('group.defaultName', { names: names.join(', ') });
  }

  async function save() {
    if (!members.length) {
      ui.toast(t('group.noMembers'), 'error');
      return;
    }
    saving = true;
    try {
      const body = {
        name: groupName(),
        fav,
        members: $state.snapshot(members),
        settings: $state.snapshot(settings) as Record<string, unknown>,
      };
      if (creating) {
        const created = await api.createGroup(body);
        library.upsertGroup(created);
        close();
        await chat.openGroup(created.id);
      } else if (group) {
        const updated = await api.updateGroup(group.id, body, group.rev);
        library.upsertGroup(updated);
        if (chat.groupId === updated.id) await chat.reloadGroup();
        close();
      }
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      saving = false;
    }
  }

  async function changeAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file || !group) return;
    try {
      group = await api.setGroupAvatar(group.id, file);
      library.upsertGroup(group);
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function resetAvatar() {
    if (!group) return;
    group = await api.clearGroupAvatar(group.id);
    library.upsertGroup(group);
  }

  async function remove() {
    if (!group || !confirm(t('group.deleteConfirm', { name: group.name }))) return;
    try {
      await api.deleteGroup(group.id);
      library.groups = library.groups.filter((g) => g.id !== group!.id);
      if (chat.groupId === group.id) chat.close();
      close();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<Modal open={!!ui.editingGroupId} title={creating ? t('group.new') : t('group.edit')} onclose={close} wide>
  {#if creating || group}
    <div class="top">
      {#if group}
        <div class="avatar">
          <button class="avatar-btn" onclick={() => avatarInput?.click()} title={t('group.avatar')}>
            <GroupAvatar group={{ ...group, members }} width={80} />
            <span class="faint">{t('group.avatar')}</span>
          </button>
          {#if group.avatar}
            <button class="btn ghost small" onclick={resetAvatar}>{t('group.avatarReset')}</button>
          {/if}
        </div>
        <input
          bind:this={avatarInput}
          type="file"
          accept="image/*"
          hidden
          onchange={(e) => changeAvatar(e.currentTarget.files)}
        />
      {/if}
      <div class="top-fields">
        <label class="field">
          <span>{t('group.name')}</span>
          <input
            class="input"
            bind:value={name}
            placeholder={t('group.defaultName', {
              names: members.map((m) => library.character(m.characterId)?.name ?? '').join(', '),
            })}
          />
        </label>
        <label class="check"><input type="checkbox" bind:checked={fav} />{t('group.favorite')}</label>
      </div>
    </div>

    <section class="members" aria-label={t('group.members')}>
      <h3>{t('group.members')}</h3>
      {#if members.length === 0}
        <p class="muted">{t('group.noMembers')}</p>
      {/if}
      <ul class="list">
        {#each members as member, i (member.characterId)}
          {@const character = library.character(member.characterId)}
          <li class:muted-member={member.muted}>
            <Avatar hash={character?.avatar} name={character?.name ?? '?'} width={32} />
            <span class="name">{character?.name ?? member.characterId}</span>
            {#if member.muted}<span class="faint tag">{t('group.muted')}</span>{/if}
            <span class="row-actions">
              <button
                class="icon-btn small"
                title={member.muted ? t('group.unmute') : t('group.mute')}
                aria-label={member.muted ? t('group.unmute') : t('group.mute')}
                aria-pressed={member.muted}
                onclick={() => (member.muted = !member.muted)}><Icon name="mute" size={15} /></button
              >
              <button
                class="icon-btn small"
                title={t('common.moveUp')}
                aria-label={t('common.moveUp')}
                disabled={i === 0}
                onclick={() => move(i, -1)}><Icon name="up" size={15} /></button
              >
              <button
                class="icon-btn small"
                title={t('common.moveDown')}
                aria-label={t('common.moveDown')}
                disabled={i === members.length - 1}
                onclick={() => move(i, 1)}><Icon name="down" size={15} /></button
              >
              <button
                class="icon-btn small"
                title={t('group.remove')}
                aria-label={t('group.remove')}
                onclick={() => (members = members.filter((m) => m.characterId !== member.characterId))}
                ><Icon name="close" size={15} /></button
              >
            </span>
          </li>
        {/each}
      </ul>

      <details class="add" open={creating}>
        <summary>{t('group.addMembers')}</summary>
        <input
          class="input"
          type="search"
          placeholder={t('group.searchCharacters')}
          aria-label={t('group.searchCharacters')}
          bind:value={query}
        />
        {#if candidates.length === 0}
          <p class="faint">{t('group.allAdded')}</p>
        {/if}
        <ul class="list candidates">
          {#each candidates as character (character.id)}
            <li>
              <button
                class="pick"
                onclick={() => (members = [...members, { characterId: character.id, muted: false }])}
              >
                <Avatar hash={character.avatar} name={character.name} width={28} />
                <span class="name">{character.name}</span>
                <Icon name="plus" size={15} />
              </button>
            </li>
          {/each}
        </ul>
      </details>
    </section>

    <section class="settings">
      <label class="field">
        <span>{t('group.strategy')}</span>
        <select class="select" bind:value={settings.activation_strategy}>
          <option value={GroupActivation.NATURAL}>{t('group.strategyNatural')}</option>
          <option value={GroupActivation.LIST}>{t('group.strategyList')}</option>
          <option value={GroupActivation.POOLED}>{t('group.strategyPooled')}</option>
          <option value={GroupActivation.MANUAL}>{t('group.strategyManual')}</option>
        </select>
      </label>
      <label class="field">
        <span>{t('group.mode')}</span>
        <select class="select" bind:value={settings.generation_mode}>
          <option value={GroupGenerationMode.SWAP}>{t('group.modeSwap')}</option>
          <option value={GroupGenerationMode.APPEND}>{t('group.modeAppend')}</option>
          <option value={GroupGenerationMode.APPEND_DISABLED}>{t('group.modeAppendMuted')}</option>
        </select>
      </label>
      {#if settings.generation_mode !== GroupGenerationMode.SWAP}
        <div class="row2">
          <label class="field">
            <span>{t('group.joinPrefix')}</span>
            <textarea class="textarea code compact" rows="2" bind:value={settings.generation_mode_join_prefix}
            ></textarea>
          </label>
          <label class="field">
            <span>{t('group.joinSuffix')}</span>
            <textarea class="textarea code compact" rows="2" bind:value={settings.generation_mode_join_suffix}
            ></textarea>
          </label>
        </div>
        <small class="faint">{t('group.joinHint')}</small>
      {/if}
      <label class="check"
        ><input type="checkbox" bind:checked={settings.allow_self_responses} />{t(
          'group.selfResponses',
        )}</label
      >
      <label class="field narrow-field">
        <span>{t('group.autoDelay')}</span>
        <input class="input" type="number" min="1" max="999" bind:value={settings.auto_mode_delay} />
      </label>
    </section>
  {:else}
    <p class="muted">{t('common.loading')}</p>
  {/if}

  {#snippet footer()}
    {#if group}
      <button class="btn danger ghost" onclick={remove}
        ><Icon name="trash" size={15} />{t('group.delete')}</button
      >
    {/if}
    <span class="spacer"></span>
    <button class="btn ghost" onclick={close}>{t('common.cancel')}</button>
    <button class="btn primary" disabled={saving || !members.length} onclick={save}>
      <Icon name="check" size={15} />{creating ? t('group.create') : t('group.save')}
    </button>
  {/snippet}
</Modal>

<style>
  .top {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
  }
  .avatar {
    display: grid;
    justify-items: center;
    gap: 0.25rem;
  }
  .avatar-btn {
    display: grid;
    justify-items: center;
    gap: 0.35rem;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: var(--bt-size-xs);
  }
  .top-fields {
    flex: 1;
    display: grid;
    gap: 0.75rem;
  }
  h3 {
    font-size: var(--bt-size-md);
    font-weight: 600;
    margin-bottom: 0.4rem;
  }
  .members,
  .settings {
    display: grid;
    gap: 0.6rem;
  }
  .list {
    list-style: none;
    display: grid;
    gap: 0.25rem;
    padding: 0;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }
  .list .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .muted-member .name {
    color: var(--bt-ink-muted);
  }
  .tag {
    font-size: var(--bt-size-xs);
  }
  .row-actions {
    display: flex;
  }
  .row-actions [aria-pressed='true'] {
    color: var(--bt-danger);
  }
  .add {
    display: grid;
    gap: 0.5rem;
  }
  .add summary {
    cursor: pointer;
    font-size: var(--bt-size-sm);
    color: var(--bt-accent);
  }
  .add .input {
    margin-block: 0.5rem;
  }
  .candidates {
    max-height: 16rem;
    overflow-y: auto;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
  }
  .pick:hover {
    background: var(--bt-surface-2);
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  .narrow-field {
    max-width: 14rem;
  }
  .spacer {
    flex: 1;
  }
  .small {
    min-height: 1.75rem;
    font-size: var(--bt-size-xs);
  }
  @media (max-width: 640px) {
    .row2 {
      grid-template-columns: 1fr;
    }
  }
</style>
