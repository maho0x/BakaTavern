<script lang="ts">
  import { ApiError } from '@bakatavern/api-client';
  import type { RegexScript } from '@bakatavern/core';

  import { api } from '../../api.ts';
  import { invalidatePreset } from '../../generation/pipeline.ts';
  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { library } from '../../state/library.svelte.ts';
  import { cardScripts, regex } from '../../state/regex.svelte.ts';
  import RegexList from './RegexList.svelte';

  const prefs = $derived(regex.prefs);
  const character = $derived(chat.character);
  const preset = $derived(regex.preset);
  const characterScripts = $derived(character ? cardScripts(character.card) : []);

  /** Retries once after a revision conflict (the preset or card changed elsewhere meanwhile). */
  async function withRetry(write: () => Promise<void>) {
    try {
      await write();
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'conflict')) throw error;
      await write();
    }
  }

  function saveGlobal(scripts: RegexScript[]) {
    regex.setGlobal(scripts);
  }

  async function saveCharacter(scripts: RegexScript[]) {
    const id = chat.character?.id;
    if (!id) return;
    await chat.updateCard((card) => {
      const data = (card.data ??= {});
      data.extensions = {
        ...(data.extensions as Record<string, unknown> | undefined),
        regex_scripts: scripts,
      };
    });
    // Editing a character's scripts allows them, as in SillyTavern.
    regex.setAllowed('allowedCharacters', id, true);
  }

  async function savePreset(scripts: RegexScript[]) {
    const id = regex.preset?.id;
    if (!id) return;
    await withRetry(async () => {
      const current = await api.getPreset(id);
      const data = structuredClone(current.data);
      data.extensions = {
        ...(data.extensions as Record<string, unknown> | undefined),
        regex_scripts: scripts,
      };
      await api.updatePreset(id, { data, rev: current.rev });
    });
    invalidatePreset();
    await library.refreshPresets();
    await regex.syncPreset();
    regex.setAllowed('allowedPresets', id, true);
  }

  const toGlobal = $derived({
    label: t('regex.moveToGlobal'),
    move: (s: RegexScript) => saveGlobal([...prefs.scripts, s]),
  });
  const toPreset = $derived(
    preset
      ? [{ label: t('regex.moveToPreset'), move: (s: RegexScript) => savePreset([...preset.scripts, s]) }]
      : [],
  );
  const toCharacter = $derived(
    character
      ? [
          {
            label: t('regex.moveToCharacter'),
            move: (s: RegexScript) => saveCharacter([...characterScripts, s]),
          },
        ]
      : [],
  );
</script>

<div class="stack">
  <p class="faint intro">{t('regex.intro')}</p>

  <RegexList
    title={t('regex.global')}
    scripts={prefs.scripts}
    onchange={saveGlobal}
    moveTargets={[...toPreset, ...toCharacter]}
    exportName="regex-global"
  />

  {#if preset}
    <RegexList
      title={t('regex.presetScripts', { name: preset.name })}
      scripts={preset.scripts}
      onchange={savePreset}
      allowed={prefs.allowedPresets.includes(preset.id)}
      onallow={(on) => regex.setAllowed('allowedPresets', preset.id, on)}
      moveTargets={[toGlobal, ...toCharacter]}
      exportName={`regex-${preset.name}`}
    />
  {/if}

  {#if character}
    <RegexList
      title={t('regex.characterScripts', { name: character.name })}
      scripts={characterScripts}
      onchange={saveCharacter}
      allowed={prefs.allowedCharacters.includes(character.id)}
      onallow={(on) => regex.setAllowed('allowedCharacters', character.id, on)}
      moveTargets={[toGlobal, ...toPreset]}
      exportName={`regex-${character.name}`}
    />
  {/if}
</div>

<style>
  .stack {
    display: grid;
    gap: 1.1rem;
  }
  .intro {
    font-size: var(--bt-size-sm);
  }
</style>
