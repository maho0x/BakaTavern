import type { CharacterSummary, Persona } from '@bakatavern/api-client';
import { fuzzySearch } from '@bakatavern/core';

import { t } from '../i18n/index.svelte.ts';
import { chat } from '../state/chat.svelte.ts';
import { library } from '../state/library.svelte.ts';
import { ui } from '../state/ui.svelte.ts';

/** Case- and accent-insensitive equality (SillyTavern `equalsIgnoreCaseAndAccents`). */
export function sameName(a: string, b: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return fold(a) === fold(b);
}

/** SillyTavern's file name for a character (`avatar`): its source file, else `Name.png`. */
export function avatarKey(character: Pick<CharacterSummary, 'sourceFile' | 'name'>): string {
  return character.sourceFile ?? `${character.name}.png`;
}

/**
 * A character by name or avatar file (SillyTavern `findChar`): the open character or group
 * members first, then by file, then by name; `tags` keeps only characters with all of them.
 */
export function findCharacter(
  name: string | null | undefined,
  preferCurrent = true,
  { tags, quiet = true }: { tags?: readonly string[]; quiet?: boolean } = {},
): CharacterSummary | null {
  const matches = (c: CharacterSummary) => !name || avatarKey(c) === name || sameName(c.name, name);
  const tagNames = (c: CharacterSummary) =>
    c.tags.map((id) => library.tags.find((tag) => tag.id === id)?.name).filter(Boolean);
  const candidates = tags?.length
    ? library.characters.filter((c) => tags.every((tag) => tagNames(c).includes(tag)))
    : library.characters;
  const several = (list: CharacterSummary[]) => {
    if (list.length > 1 && !quiet) ui.toast(t('script.severalCharacters'), 'warning');
  };
  if (preferCurrent) {
    const currentIds = chat.group
      ? chat.members.map((m) => m.id)
      : chat.characterId
        ? [chat.characterId]
        : [];
    const current = currentIds
      .map((id) => candidates.find((c) => c.id === id))
      .filter((c): c is CharacterSummary => !!c && matches(c));
    several(current);
    if (current[0]) return current[0];
  }
  if (name) {
    const byFile = candidates.find(
      (c) => avatarKey(c) === name || (!name.endsWith('.png') && avatarKey(c) === `${name}.png`),
    );
    if (byFile) return byFile;
  }
  const matching = name ? candidates.filter(matches) : candidates;
  several(matching);
  return matching[0] ?? null;
}

/** A member of the open group by index or by (fuzzy) name or file (SillyTavern `findGroupMemberId`). */
export function findGroupMember(
  arg: unknown,
): { characterId: string; name: string; avatar: string; index: number } | undefined {
  const value = String(arg ?? '').trim();
  const group = chat.group;
  if (!value || !group) return undefined;
  const members = group.members.map((m, index) => {
    const character = library.character(m.characterId);
    return {
      characterId: m.characterId,
      name: character?.name ?? '',
      avatar: character ? avatarKey(character) : '',
      index,
    };
  });
  const index = parseInt(value, 10);
  if (!Number.isNaN(index)) return members[index];
  return fuzzySearch(members, value, { keys: ['avatar', 'name'] })[0];
}

export function findPersona(name: string): Persona | undefined {
  return (
    library.personas.find((p) => p.sourceFile === name) ??
    library.personas.find((p) => sameName(p.name, name))
  );
}

/** The thumbnail URL SillyTavern stores as a message's `force_avatar`. */
export function thumbnailUrl(file: string) {
  return `/thumbnail?type=avatar&file=${encodeURIComponent(file)}`;
}
