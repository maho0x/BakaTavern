<script lang="ts">
  import type { Character } from '@bakatavern/api-client';
  import { cardData, talkativeness as cardTalkativeness, type CardData } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import Avatar from '../../components/Avatar.svelte';
  import Icon from '../../components/Icon.svelte';
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  let character = $state<Character | null>(null);
  let data = $state<CardData | null>(null);
  let tagsText = $state('');
  let saving = $state(false);
  let avatarInput = $state<HTMLInputElement>();

  $effect(() => {
    const id = ui.editingCharacterId;
    if (!id) {
      character = null;
      data = null;
      return;
    }
    void api.getCharacter(id).then((c) => {
      character = c;
      const d = cardData(c.card);
      d.extensions.depth_prompt ??= { prompt: '', depth: 4, role: 'system' };
      data = d;
      tagsText = d.tags.join(', ');
    });
  });

  function close() {
    ui.editingCharacterId = null;
  }

  /** SillyTavern keeps talkativeness as a string; 0.5 when unset. */
  const talkativeness = (d: CardData) => cardTalkativeness({ data: d });

  async function save() {
    if (!character || !data) return;
    saving = true;
    try {
      const card = $state.snapshot(character.card) as Record<string, unknown>;
      const next = $state.snapshot(data);
      next.tags = tagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      next.alternate_greetings = next.alternate_greetings.filter((g) => g.trim());
      const updated = await api.updateCharacter(character.id, { ...card, data: next }, character.rev);
      library.upsertCharacter(updated);
      if (chat.characterId === updated.id) chat.character = updated;
      close();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    } finally {
      saving = false;
    }
  }

  async function changeAvatar(files: FileList | null) {
    const file = files?.[0];
    if (!file || !character) return;
    try {
      character = await api.setCharacterAvatar(character.id, file);
      library.upsertCharacter(character);
      if (chat.characterId === character.id) chat.character = character;
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }

  async function duplicate() {
    if (!character) return;
    const copy = await api.duplicateCharacter(character.id);
    library.upsertCharacter(copy);
    ui.toast(t('char.duplicated', { name: copy.name }), 'success');
  }

  async function remove() {
    if (!character || !confirm(t('char.deleteConfirm', { name: character.name }))) return;
    try {
      await api.deleteCharacter(character.id);
      library.removeCharacter(character.id);
      if (chat.characterId === character.id) chat.close();
      // Groups lose the member.
      if (library.groups.some((g) => g.members.some((m) => m.characterId === character!.id)))
        await library.refreshGroups();
      if (chat.members.some((m) => m.id === character!.id)) await chat.reloadGroup();
      close();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<Modal open={!!ui.editingCharacterId} title={t('char.edit')} onclose={close} wide>
  {#if character && data}
    <div class="top">
      <button class="avatar-btn" onclick={() => avatarInput?.click()} title={t('char.avatar')}>
        <Avatar hash={character.avatar} name={data.name} width={96} />
        <span class="faint">{t('char.avatar')}</span>
      </button>
      <input
        bind:this={avatarInput}
        type="file"
        accept="image/*"
        hidden
        onchange={(e) => changeAvatar(e.currentTarget.files)}
      />
      <div class="top-fields">
        <label class="field"
          ><span>{t('char.name')}</span><input class="input" bind:value={data.name} /></label
        >
        <div class="row2">
          <label class="field"
            ><span>{t('char.creator')}</span><input class="input" bind:value={data.creator} /></label
          >
          <label class="field"
            ><span>{t('char.version')}</span><input
              class="input"
              bind:value={data.character_version}
            /></label
          >
        </div>
        <label class="field"><span>{t('char.tags')}</span><input class="input" bind:value={tagsText} /></label
        >
      </div>
    </div>

    <label class="field"
      ><span>{t('char.description')}</span><textarea
        class="textarea prose"
        rows="8"
        bind:value={data.description}></textarea></label
    >
    <label class="field"
      ><span>{t('char.personality')}</span><textarea
        class="textarea prose"
        rows="3"
        bind:value={data.personality}></textarea></label
    >
    <label class="field"
      ><span>{t('char.scenario')}</span><textarea class="textarea prose" rows="3" bind:value={data.scenario}
      ></textarea></label
    >
    <label class="field"
      ><span>{t('char.firstMes')}</span><textarea class="textarea prose" rows="6" bind:value={data.first_mes}
      ></textarea></label
    >

    <fieldset class="greetings">
      <legend>{t('char.altGreetings')}</legend>
      {#each data.alternate_greetings as _, i (i)}
        <div class="greeting">
          <textarea
            class="textarea prose"
            rows="4"
            bind:value={data.alternate_greetings[i]}
            aria-label={t('char.altGreetingN', { n: i + 1 })}></textarea>
          <div class="greeting-tools">
            <button
              class="icon-btn small"
              aria-label={t('common.moveUp')}
              disabled={i === 0}
              onclick={() => {
                const list = data!.alternate_greetings;
                [list[i - 1], list[i]] = [list[i]!, list[i - 1]!];
              }}><Icon name="up" size={14} /></button
            >
            <button
              class="icon-btn small"
              aria-label={t('common.delete')}
              onclick={() => data!.alternate_greetings.splice(i, 1)}><Icon name="trash" size={14} /></button
            >
          </div>
        </div>
      {/each}
      <button class="btn" onclick={() => data!.alternate_greetings.push('')}
        ><Icon name="plus" size={15} />{t('char.addGreeting')}</button
      >
    </fieldset>

    <label class="field"
      ><span>{t('char.examples')}</span><textarea
        class="textarea prose"
        rows="6"
        bind:value={data.mes_example}></textarea><small>{t('char.examplesHint')}</small></label
    >

    <details>
      <summary>{t('char.advanced')}</summary>
      <div class="advanced">
        <label class="field"
          ><span>{t('char.systemPrompt')}</span><textarea
            class="textarea"
            rows="4"
            bind:value={data.system_prompt}></textarea><small>{t('char.systemPromptHint')}</small></label
        >
        <label class="field"
          ><span>{t('char.phi')}</span><textarea
            class="textarea"
            rows="3"
            bind:value={data.post_history_instructions}></textarea></label
        >
        <label class="field"
          ><span>{t('char.creatorNotes')}</span><textarea
            class="textarea"
            rows="4"
            bind:value={data.creator_notes}></textarea></label
        >
        {#if data.extensions.depth_prompt}
          <label class="field"
            ><span>{t('char.depthPrompt')}</span><textarea
              class="textarea"
              rows="3"
              bind:value={data.extensions.depth_prompt.prompt}></textarea></label
          >
          <div class="row2">
            <label class="field"
              ><span>{t('note.depth')}</span><input
                class="input"
                type="number"
                min="0"
                bind:value={data.extensions.depth_prompt.depth}
              /></label
            >
            <label class="field">
              <span>{t('note.role')}</span>
              <select class="select" bind:value={data.extensions.depth_prompt.role}>
                <option value="system">{t('role.system')}</option>
                <option value="user">{t('role.user')}</option>
                <option value="assistant">{t('role.assistant')}</option>
              </select>
            </label>
          </div>
        {/if}
        <label class="field">
          <span>{t('char.talkativeness')}: {talkativeness(data).toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={talkativeness(data)}
            oninput={(e) => (data!.extensions.talkativeness = e.currentTarget.value)}
          />
          <small>{t('char.talkativenessHint')}</small>
        </label>
        <label class="field">
          <span>{t('char.lorebook')}</span>
          <select class="select" bind:value={data.extensions.world}>
            <option value="">{t('common.none')}</option>
            {#each library.lorebooks as book (book.id)}<option value={book.name}>{book.name}</option>{/each}
          </select>
        </label>
        <label class="check"
          ><input
            type="checkbox"
            checked={data.extensions.fav === true || data.extensions.fav === 'true'}
            onchange={(e) => (data!.extensions.fav = e.currentTarget.checked)}
          />{t('char.favorite')}</label
        >
      </div>
    </details>
  {:else}
    <p class="muted">{t('common.loading')}</p>
  {/if}

  {#snippet footer()}
    {#if character}
      <button class="btn danger ghost" onclick={remove}
        ><Icon name="trash" size={15} />{t('common.delete')}</button
      >
      <button class="btn ghost" onclick={duplicate}
        ><Icon name="copy" size={15} />{t('char.duplicate')}</button
      >
      <a class="btn ghost" href={api.characterExportUrl(character.id, 'png')} download
        ><Icon name="download" size={15} />PNG</a
      >
      <a class="btn ghost" href={api.characterExportUrl(character.id, 'json')} download
        ><Icon name="download" size={15} />JSON</a
      >
      <span class="spacer"></span>
      <button class="btn primary" disabled={saving} onclick={save}>{t('common.save')}</button>
    {/if}
  {/snippet}
</Modal>

<style>
  .top {
    display: flex;
    gap: 1.25rem;
    align-items: flex-start;
  }
  .avatar-btn {
    display: grid;
    justify-items: center;
    gap: 0.35rem;
    border: 0;
    background: transparent;
    font-size: var(--bt-size-xs);
  }
  .top-fields {
    flex: 1;
    display: grid;
    gap: 0.75rem;
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }
  fieldset.greetings {
    display: grid;
    gap: 0.6rem;
    border: 1px solid var(--bt-line);
    border-radius: var(--bt-radius);
    padding: 0.75rem;
  }
  legend {
    padding: 0 0.35rem;
    font-size: var(--bt-size-sm);
    color: var(--bt-ink-muted);
  }
  .greeting {
    display: flex;
    gap: 0.35rem;
  }
  .greeting-tools {
    display: grid;
    align-content: start;
  }
  details summary {
    cursor: pointer;
    color: var(--bt-ink-muted);
    font-size: var(--bt-size-sm);
  }
  .advanced {
    display: grid;
    gap: 1rem;
    margin-top: 0.75rem;
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 640px) {
    .top {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
