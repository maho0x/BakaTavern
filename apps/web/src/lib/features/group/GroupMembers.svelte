<script lang="ts">
  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  const muted = $derived(new Map(chat.group?.members.map((m) => [m.characterId, m.muted])));
  // The member writing now, or about to.
  const speaking = $derived(chat.generation?.speaker?.id);

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<div class="panel" role="dialog" aria-label={t('group.members')}>
  <ul>
    {#each chat.members as member (member.id)}
      {@const isMuted = muted.get(member.id) ?? false}
      <li class:muted={isMuted} class:speaking={speaking === member.id}>
        <button
          class="who"
          title={t('group.openCharacter')}
          onclick={() => {
            onclose();
            ui.editingCharacterId = member.id;
          }}
        >
          <Avatar hash={member.avatar} name={member.name} width={30} round />
          <span class="name">{member.name}</span>
          {#if isMuted}<span class="faint state">{t('group.muted')}</span>{/if}
        </button>
        <button
          class="icon-btn small"
          title={t('group.speak')}
          aria-label="{t('group.speak')}: {member.name}"
          disabled={chat.busy}
          onclick={() => {
            onclose();
            void act(() => chat.trigger(member.id));
          }}><Icon name="play" size={15} /></button
        >
        <button
          class="icon-btn small"
          title={isMuted ? t('group.unmute') : t('group.mute')}
          aria-label="{isMuted ? t('group.unmute') : t('group.mute')}: {member.name}"
          aria-pressed={isMuted}
          onclick={() => act(() => chat.setMuted(member.id, !isMuted))}><Icon name="mute" size={15} /></button
        >
      </li>
    {/each}
  </ul>
  <label class="auto" title={t('group.autoModeHint')}>
    <input
      type="checkbox"
      checked={chat.autoMode}
      onchange={(e) => chat.setAutoMode(e.currentTarget.checked)}
    />
    <span>{t('group.autoMode')}</span>
  </label>
  <button
    class="btn ghost edit"
    onclick={() => {
      onclose();
      ui.editingGroupId = chat.groupId;
    }}><Icon name="edit" size={15} />{t('group.edit')}</button
  >
</div>

<style>
  .panel {
    position: absolute;
    inset-inline-end: 0;
    top: 2.5rem;
    z-index: 10;
    display: grid;
    gap: 0.35rem;
    width: min(20rem, calc(100vw - 2rem));
    padding: 0.4rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    background: var(--bt-surface-2);
    box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
  }
  /* On phones the button sits mid-bar: the panel spans the screen below the bar instead. */
  @media (max-width: 900px) {
    .panel {
      position: fixed;
      inset-inline: 0.75rem;
      top: calc(3.5rem + env(safe-area-inset-top));
      width: auto;
    }
  }
  ul {
    list-style: none;
    display: grid;
    gap: 0.15rem;
    max-height: 22rem;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    border-radius: var(--bt-radius-sm);
  }
  li.speaking {
    background: color-mix(in oklch, var(--bt-accent) 14%, transparent);
  }
  .who {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
    padding: 0.25rem 0.35rem;
    border: 0;
    border-radius: var(--bt-radius-sm);
    background: transparent;
    text-align: start;
  }
  .who:hover {
    background: var(--bt-surface-3);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--bt-size-sm);
    font-weight: 550;
  }
  li.muted .name {
    color: var(--bt-ink-muted);
  }
  .state {
    font-size: var(--bt-size-xs);
  }
  [aria-pressed='true'] {
    color: var(--bt-danger);
  }
  .auto {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.5rem 0.2rem;
    border-top: 1px solid var(--bt-line);
    font-size: var(--bt-size-sm);
  }
  .auto input {
    accent-color: var(--bt-accent);
  }
  .edit {
    justify-content: flex-start;
  }
</style>
