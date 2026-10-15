import type { Lorebook } from '@bakatavern/api-client';
import type { LoadedBook, WorldInfoEntry } from '@bakatavern/core';

import { api } from '../api.ts';
import { library } from '../state/library.svelte.ts';

const cache = new Map<string, { rev: number; book: Lorebook }>();

/** Loads lorebooks by name (cached by revision). Unknown names are skipped. */
export async function loadBooks(names: readonly (string | null | undefined)[]): Promise<LoadedBook[]> {
  const unique = [...new Set(names.filter((n): n is string => !!n))];
  const books = await Promise.all(
    unique.map(async (name) => {
      const info = library.lorebooks.find((b) => b.name === name);
      if (!info) return null;
      const cached = cache.get(info.id);
      if (cached && cached.rev === info.rev) return cached.book;
      const book = await api.getLorebook(info.id);
      cache.set(info.id, { rev: book.rev, book });
      return book;
    }),
  );
  return books
    .filter((b): b is Lorebook => b !== null)
    .map((b) => ({ name: b.name, entries: b.entries as unknown as WorldInfoEntry[] }));
}

export function invalidateBook(id: string) {
  cache.delete(id);
}
