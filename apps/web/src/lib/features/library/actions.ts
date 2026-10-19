import {
  convertCharacterBook,
  importFromUrl,
  newCard,
  type CharacterBook,
  type ImportFetch,
} from '@bakatavern/core';

import { api } from '../../api.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import { errorText, ui } from '../../state/ui.svelte.ts';

/** Requests through the server (its outgoing proxy), so other sites' rules for browsers do not apply. */
const fetchThroughServer: ImportFetch = async (url, init) => {
  const response = await api.proxy({
    url,
    method: init?.method ?? 'GET',
    headers: init?.headers,
    body: init?.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    contentType: (response.headers.get('content-type') ?? '').split(';')[0]!.trim(),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
};

/**
 * Imports characters and lorebooks from site addresses or ids (Chub, JanitorAI, RisuRealm, ...),
 * one per line. Returns the lines that failed.
 */
export async function importFromUrls(lines: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const line of lines) {
    try {
      const result = await importFromUrl(line, fetchThroughServer);
      if (result.kind === 'lorebook') {
        const created = await api.importLorebook(
          new File([result.file.bytes as BlobPart], result.file.name, { type: 'application/json' }),
          result.file.name.replace(/\.json$/i, ''),
        );
        await library.refreshLorebooks();
        ui.toast(t('library.urlBookImported', { name: created.name }), 'success');
      } else if ('file' in result) {
        await importCharacterFiles([
          new File([result.file.bytes as BlobPart], result.file.name, { type: result.file.type }),
        ]);
      } else {
        const avatar = result.avatar
          ? await api.uploadFile(new Blob([result.avatar.bytes as BlobPart], { type: result.avatar.type }))
          : null;
        const created = await api.createCharacter(result.card, avatar?.hash);
        library.upsertCharacter(created);
        await offerEmbeddedBook(created.id, created.name, created.card as { data?: Record<string, unknown> });
        ui.toast(t('library.imported', { count: 1 }), 'success');
        await chat.openCharacter(created.id);
      }
    } catch (error) {
      failed.push(line);
      ui.toast(t('library.urlFailed', { url: line, message: errorText(error) }), 'error');
    }
  }
  return failed;
}

/** Imports character cards (PNG, JSON, CHARX) and opens the first one. */
export async function importCharacterFiles(files: FileList | File[] | null | undefined) {
  if (!files?.length) return;
  try {
    const result = await api.importCharacters([...files]);
    for (const failure of result.failures) {
      ui.toast(t('library.importFailed', { file: failure.fileName, message: failure.message }), 'error');
    }
    for (const character of result.characters) {
      library.upsertCharacter(character);
      await offerEmbeddedBook(
        character.id,
        character.name,
        character.card as { data?: Record<string, unknown> },
      );
    }
    if (result.characters.length) {
      ui.toast(t('library.imported', { count: result.characters.length }), 'success');
      await chat.openCharacter(result.characters[0]!.id);
    }
  } catch (error) {
    ui.toast(errorText(error), 'error');
  }
}

/** Offers to import a card's embedded lorebook and links it to the character, as SillyTavern does. */
async function offerEmbeddedBook(id: string, name: string, card: { data?: Record<string, unknown> }) {
  const data = card.data ?? {};
  const book = data.character_book as CharacterBook | undefined;
  const extensions = (data.extensions ?? {}) as Record<string, unknown>;
  if (!book?.entries?.length || extensions.world) return;
  if (!confirm(t('library.embeddedBook', { name }))) return;
  const converted = convertCharacterBook(book);
  let bookName = String(book.name || name);
  if (library.lorebooks.some((b) => b.name === bookName)) bookName = `${bookName} (${name})`;
  const created = await api.createLorebook(
    bookName,
    converted.entries as unknown as Record<string, unknown>[],
    converted.data,
  );
  const fresh = await api.getCharacter(id);
  const updatedCard = structuredClone(fresh.card) as { data: { extensions: Record<string, unknown> } };
  updatedCard.data.extensions = { ...updatedCard.data.extensions, world: created.name };
  library.upsertCharacter(await api.updateCharacter(id, updatedCard, fresh.rev));
  await library.refreshLorebooks();
}

/** Asks for a name, creates an empty character and opens its editor. */
export async function createCharacter() {
  const name = prompt(t('library.newName'))?.trim();
  if (!name) return;
  try {
    const created = await api.createCharacter(newCard(name) as unknown as Record<string, unknown>);
    library.upsertCharacter(created);
    await chat.openCharacter(created.id);
    ui.editingCharacterId = created.id;
  } catch (error) {
    ui.toast(errorText(error), 'error');
  }
}

/** A card excerpt for lists, with the name macros filled in. */
export function excerptText(excerpt: string, name: string) {
  return excerpt.replace(/\{\{char\}\}|<BOT>|<CHAR>/gi, name).replace(/\{\{user\}\}|<USER>/gi, chat.userName);
}

/** A character or group in the library, as lists hold them. */
export type LibraryEntry = { kind: 'character'; id: string } | { kind: 'group'; id: string };

/** Marks characters and groups as favorites or not (a character's in its card, as SillyTavern does). */
export async function setFavorite(entries: readonly LibraryEntry[], fav: boolean) {
  for (const entry of entries) {
    if (entry.kind === 'group') {
      const group = library.group(entry.id);
      if (!group || group.fav === fav) continue;
      library.upsertGroup(await api.updateGroup(entry.id, { fav }, group.rev));
      continue;
    }
    const character = await api.getCharacter(entry.id);
    const card = structuredClone(character.card) as { data?: { extensions?: Record<string, unknown> } };
    const data = (card.data ??= {});
    data.extensions = { ...data.extensions, fav };
    const updated = await api.updateCharacter(entry.id, card as Record<string, unknown>, character.rev);
    library.upsertCharacter(updated);
    if (chat.character?.id === entry.id) chat.character = updated;
  }
}

/** Adds a tag (made when it is new) to characters and groups. */
export async function addTag(entries: readonly LibraryEntry[], name: string) {
  const wanted = name.trim();
  if (!wanted) return;
  let tag = library.tags.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
  if (!tag) {
    tag = await api.createTag(wanted);
    await library.refreshTags();
  }
  await retag(entries, (tags) => (tags.includes(tag.id) ? tags : [...tags, tag.id]));
}

export async function removeTag(entries: readonly LibraryEntry[], tagId: string) {
  await retag(entries, (tags) => tags.filter((id) => id !== tagId));
}

async function retag(entries: readonly LibraryEntry[], change: (tags: string[]) => string[]) {
  for (const entry of entries) {
    const current =
      entry.kind === 'group' ? library.group(entry.id)?.tags : library.character(entry.id)?.tags;
    if (!current) continue;
    const next = change([...current]);
    if (next.length === current.length && next.every((id, i) => id === current[i])) continue;
    if (entry.kind === 'group') library.upsertGroup(await api.setGroupTags(entry.id, next));
    else library.upsertCharacter(await api.setCharacterTags(entry.id, next));
  }
}

/** Deletes characters (their chats too); groups lose them as members. */
export async function deleteCharacters(ids: readonly string[]) {
  for (const id of ids) {
    await api.deleteCharacter(id);
    library.removeCharacter(id);
    if (chat.characterId === id) chat.close();
  }
  if (library.groups.some((g) => g.members.some((m) => ids.includes(m.characterId))))
    await library.refreshGroups();
  if (chat.members.some((m) => ids.includes(m.id))) await chat.reloadGroup();
}

export async function deleteGroups(ids: readonly string[]) {
  for (const id of ids) {
    await api.deleteGroup(id);
    if (chat.groupId === id) chat.close();
  }
  await library.refreshGroups();
}
