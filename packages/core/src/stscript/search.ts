/** Fuzzy matching as SillyTavern's commands do it (Fuse.js with their options). */

import Fuse, { type IFuseOptions } from 'fuse.js';

/** Items matching `query`, best first. */
export function fuzzySearch<T>(items: readonly T[], query: string, options: IFuseOptions<T> = {}): T[] {
  return new Fuse(items, options).search(query).map((result) => result.item);
}
