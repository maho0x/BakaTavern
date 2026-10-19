<script lang="ts">
  import type { RegexScript } from '@bakatavern/core';

  import { t } from '../../i18n/index.svelte.ts';
  import { chat } from '../../state/chat.svelte.ts';
  import { cardScripts, regex } from '../../state/regex.svelte.ts';
  import RegexList from './RegexList.svelte';

  const prefs = $derived(regex.prefs);
  const character = $derived(chat.character);
  const preset = $derived(regex.preset);
  const characterScripts = $derived(character ? cardScripts(character.card) : []);

  function saveGlobal(scripts: RegexScript[]) {
    regex.setGlobal(scripts);
  }

  const saveCharacter = (scripts: RegexScript[]) => regex.setCharacterScripts(scripts);
  const savePreset = (scripts: RegexScript[]) => regex.setPresetScripts(scripts);

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
