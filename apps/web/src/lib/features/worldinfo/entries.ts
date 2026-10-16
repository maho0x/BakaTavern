import { estimateTokens, WorldInfoPosition, type WorldInfoEntry } from '@bakatavern/core';

import type { MessageKey } from '../../i18n/index.svelte.ts';

export { characterKey } from '../../generation/pipeline.ts';

/** Where an entry goes: SillyTavern's position plus, for @depth, the message role. */
export const placements: {
  value: string;
  position: number;
  role?: number;
  label: MessageKey;
  short: string;
}[] = [
  { value: 'before', position: WorldInfoPosition.before, label: 'wi.posBefore', short: '↑Char' },
  { value: 'after', position: WorldInfoPosition.after, label: 'wi.posAfter', short: '↓Char' },
  { value: 'emTop', position: WorldInfoPosition.EMTop, label: 'wi.posEMTop', short: '↑EM' },
  { value: 'emBottom', position: WorldInfoPosition.EMBottom, label: 'wi.posEMBottom', short: '↓EM' },
  { value: 'anTop', position: WorldInfoPosition.ANTop, label: 'wi.posANTop', short: '↑AN' },
  { value: 'anBottom', position: WorldInfoPosition.ANBottom, label: 'wi.posANBottom', short: '↓AN' },
  { value: 'depth0', position: WorldInfoPosition.atDepth, role: 0, label: 'wi.posDepthSystem', short: '@D⚙' },
  { value: 'depth1', position: WorldInfoPosition.atDepth, role: 1, label: 'wi.posDepthUser', short: '@D👤' },
  {
    value: 'depth2',
    position: WorldInfoPosition.atDepth,
    role: 2,
    label: 'wi.posDepthAssistant',
    short: '@D🤖',
  },
  { value: 'outlet', position: WorldInfoPosition.outlet, label: 'wi.posOutlet', short: '➡' },
];

export function placementOf(entry: WorldInfoEntry): string {
  if (entry.position === WorldInfoPosition.atDepth) return `depth${entry.role ?? 0}`;
  return placements.find((p) => p.position === entry.position && p.role === undefined)?.value ?? 'before';
}

/** Short position label for lists (`@D⚙ 4` for depth entries). */
export function placementBadge(entry: WorldInfoEntry): string {
  const option = placements.find((p) => p.value === placementOf(entry));
  if (!option) return '';
  return entry.position === WorldInfoPosition.atDepth ? `${option.short} ${entry.depth}` : option.short;
}

export type Strategy = 'constant' | 'keyword' | 'vectorized';

export function strategyOf(entry: WorldInfoEntry): Strategy {
  if (entry.constant) return 'constant';
  if (entry.vectorized) return 'vectorized';
  return 'keyword';
}

export function entryTitle(entry: WorldInfoEntry): string {
  return entry.comment || (entry.key ?? []).join(', ') || `#${entry.uid}`;
}

export type EntrySort = 'order' | 'title' | 'uid' | 'tokens' | 'depth' | 'probability';

export const entrySorts: { value: EntrySort; label: MessageKey }[] = [
  { value: 'order', label: 'wi.sortOrder' },
  { value: 'title', label: 'wi.sortTitle' },
  { value: 'uid', label: 'wi.sortUid' },
  { value: 'tokens', label: 'wi.sortTokens' },
  { value: 'depth', label: 'wi.sortDepth' },
  { value: 'probability', label: 'wi.sortProbability' },
];

export function sortEntries(entries: readonly WorldInfoEntry[], sort: EntrySort): WorldInfoEntry[] {
  const list = [...entries];
  const by = (f: (e: WorldInfoEntry) => number) => list.sort((a, b) => f(a) - f(b) || a.uid - b.uid);
  switch (sort) {
    case 'order':
      return by((e) => -e.order);
    case 'title':
      return list.sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)) || a.uid - b.uid);
    case 'uid':
      return by((e) => e.uid);
    case 'tokens':
      return by((e) => -estimateTokens(e.content));
    case 'depth':
      return by((e) => (e.position === WorldInfoPosition.atDepth ? e.depth : -1));
    case 'probability':
      return by((e) => (e.useProbability ? e.probability : 100));
  }
}

/** Search over titles, keys and content. */
export function matchesQuery(entry: WorldInfoEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.comment.toLowerCase().includes(q) ||
    (entry.key ?? []).some((k) => k.toLowerCase().includes(q)) ||
    (entry.keysecondary ?? []).some((k) => k.toLowerCase().includes(q)) ||
    entry.content.toLowerCase().includes(q)
  );
}
