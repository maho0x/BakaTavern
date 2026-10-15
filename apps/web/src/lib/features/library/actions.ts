import { convertCharacterBook, newCard, type CharacterBook } from '@bakatavern/core';

import { api } from '../../api.ts';
import { t } from '../../i18n/index.svelte.ts';
import { chat } from '../../state/chat.svelte.ts';
import { library } from '../../state/library.svelte.ts';
import { errorText, ui } from '../../state/ui.svelte.ts';

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
