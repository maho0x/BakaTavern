<script lang="ts">
  import Modal from '../../components/Modal.svelte';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { noteDefaults } from '../../state/prefs.ts';
  import { settings } from '../../state/settings.svelte.ts';
  import { errorText, ui } from '../../state/ui.svelte.ts';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let prompt = $state('');
  let interval = $state(1);
  let position = $state(1);
  let depth = $state(4);
  let role = $state(0);
  let charPrompt = $state('');
  let charPosition = $state(0);
  let charEnabled = $state(false);

  $effect(() => {
    if (!open) return;
    const meta = chat.chat?.metadata ?? {};
    const prefs = settings.get('note', noteDefaults);
    prompt = String(meta.note_prompt ?? prefs.defaultPrompt);
    interval = Number(meta.note_interval ?? prefs.defaultInterval);
    position = Number(meta.note_position ?? prefs.defaultPosition);
    depth = Number(meta.note_depth ?? prefs.defaultDepth);
    role = Number(meta.note_role ?? prefs.defaultRole);
    const note = chat.characterId ? prefs.characterNotes[chat.characterId] : undefined;
    charPrompt = note?.prompt ?? '';
    charPosition = note?.position ?? 0;
    charEnabled = note?.enabled ?? false;
  });

  async function save() {
    try {
      await chat.updateMetadata({
        note_prompt: prompt,
        note_interval: interval,
        note_position: position,
        note_depth: depth,
        note_role: role,
      });
      if (chat.characterId) {
        const prefs = settings.get('note', noteDefaults);
        settings.update('note', {
          characterNotes: {
            ...prefs.characterNotes,
            [chat.characterId]: { prompt: charPrompt, position: charPosition, enabled: charEnabled },
          },
        });
      }
      onclose();
    } catch (error) {
      ui.toast(errorText(error), 'error');
    }
  }
</script>

<Modal {open} title={t('chat.authorsNote')} {onclose}>
  <label class="field">
    <span>{t('note.chatNote')}</span>
    <textarea class="textarea prose" rows="5" bind:value={prompt}></textarea>
  </label>
  <div class="grid">
    <label class="field">
      <span>{t('note.position')}</span>
      <select class="select" bind:value={position}>
        <option value={1}>{t('note.inChat')}</option>
        <option value={0}>{t('note.afterMain')}</option>
        <option value={2}>{t('note.beforeMain')}</option>
      </select>
    </label>
    <label class="field">
      <span>{t('note.depth')}</span>
      <input class="input" type="number" min="0" bind:value={depth} disabled={position !== 1} />
    </label>
    <label class="field">
      <span>{t('note.role')}</span>
      <select class="select" bind:value={role} disabled={position !== 1}>
        <option value={0}>{t('role.system')}</option>
        <option value={1}>{t('role.user')}</option>
        <option value={2}>{t('role.assistant')}</option>
      </select>
    </label>
    <label class="field">
      <span>{t('note.interval')}</span>
      <input class="input" type="number" min="0" bind:value={interval} />
      <small>{t('note.intervalHint')}</small>
    </label>
  </div>
  <hr />
  <label class="check"><input type="checkbox" bind:checked={charEnabled} />{t('note.useCharNote')}</label>
  <label class="field">
    <span>{t('note.charNote', { name: chat.character?.name ?? '' })}</span>
    <textarea class="textarea prose" rows="3" bind:value={charPrompt} disabled={!charEnabled}></textarea>
  </label>
  <label class="field">
    <span>{t('note.charNotePosition')}</span>
    <select class="select" bind:value={charPosition} disabled={!charEnabled}>
      <option value={0}>{t('note.replace')}</option>
      <option value={1}>{t('note.before')}</option>
      <option value={2}>{t('note.after')}</option>
    </select>
  </label>
  {#snippet footer()}
    <button class="btn ghost" onclick={onclose}>{t('common.cancel')}</button>
    <button class="btn primary" onclick={save}>{t('common.save')}</button>
  {/snippet}
</Modal>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
  }
</style>
