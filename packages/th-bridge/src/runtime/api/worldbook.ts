/**
 * TavernHelper's worldbook functions (`function/worldbook.ts`): entries converted between its
 * nested shape and SillyTavern's, books read and written by the page.
 */

import { parseRegexFromString } from '@bakatavern/core/worldinfo/buffer';
import _ from 'lodash';

import type { Runtime } from '../context.ts';

type Logic = 'and_any' | 'and_all' | 'not_all' | 'not_any';
type PositionType =
  | 'before_character_definition'
  | 'after_character_definition'
  | 'before_example_messages'
  | 'after_example_messages'
  | 'before_author_note'
  | 'after_author_note'
  | 'at_depth'
  | 'outlet';

export interface WorldbookEntry {
  uid: number;
  name: string;
  enabled: boolean;
  strategy: {
    type: 'constant' | 'selective' | 'vectorized';
    keys: (string | RegExp)[];
    keys_secondary: { logic: Logic; keys: (string | RegExp)[] };
    scan_depth: 'same_as_global' | number;
  };
  position: { type: PositionType; role: 'system' | 'assistant' | 'user'; depth: number; order: number };
  content: string;
  probability: number;
  recursion: { prevent_incoming: boolean; prevent_outgoing: boolean; delay_until: null | number };
  effect: { sticky: null | number; cooldown: null | number; delay: null | number };
  extra?: Record<string, unknown>;
  [implicit: string]: unknown;
}

type StEntry = Record<string, unknown> & { uid: number };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
type PartialEntry = DeepPartial<WorldbookEntry> & { uid?: number };

/** SillyTavern fields TavernHelper's shape leaves out but keeps (`_ImplicitKeys`). */
const implicitDefaults: Record<string, unknown> = {
  addMemo: true,
  matchPersonaDescription: false,
  matchCharacterDescription: false,
  matchCharacterPersonality: false,
  matchCharacterDepthPrompt: false,
  matchScenario: false,
  matchCreatorNotes: false,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  ignoreBudget: false,
  outletName: '',
  triggers: [],
  characterFilter: { isExclude: false, names: [], tags: [] },
};

const logicNames: Record<number, Logic> = { 0: 'and_any', 1: 'not_all', 2: 'not_any', 3: 'and_all' };
const logicIds: Record<Logic, number> = { and_any: 0, not_all: 1, not_any: 2, and_all: 3 };
const positionNames: Record<number, PositionType> = {
  0: 'before_character_definition',
  1: 'after_character_definition',
  5: 'before_example_messages',
  6: 'after_example_messages',
  2: 'before_author_note',
  3: 'after_author_note',
  4: 'at_depth',
  7: 'outlet',
};
const positionIds = Object.fromEntries(
  Object.entries(positionNames).map(([id, name]) => [name, Number(id)]),
) as Record<PositionType, number>;
const roleNames = { 0: 'system', 1: 'user', 2: 'assistant' } as const;
const roleIds = { system: 0, user: 1, assistant: 2 } as const;
const positive = (value: unknown) => (typeof value === 'number' && value > 0 ? value : null);

export function toWorldbookEntry(entry: StEntry): WorldbookEntry {
  const e: Record<string, unknown> = entry;
  const keys = (list: unknown) =>
    ((list as string[] | undefined) ?? []).map((v) => parseRegexFromString(v) ?? v);
  const result: WorldbookEntry = {
    uid: entry.uid,
    name: (e.comment as string) ?? '',
    enabled: !e.disable,
    strategy: {
      type: e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'selective',
      keys: keys(e.key),
      keys_secondary: {
        logic: logicNames[(e.selectiveLogic as number) ?? 0] ?? 'and_any',
        keys: keys(e.keysecondary),
      },
      scan_depth: (e.scanDepth as number | null) ?? 'same_as_global',
    },
    position: {
      type: positionNames[(e.position as number) ?? 0] ?? 'before_character_definition',
      role: roleNames[((e.role as number | null) ?? 0) as 0 | 1 | 2] ?? 'system',
      depth: e.depth as number,
      order: e.order as number,
    },
    content: (e.content as string) ?? '',
    probability: e.useProbability ? (e.probability as number) : 100,
    recursion: {
      prevent_incoming: Boolean(e.excludeRecursion),
      prevent_outgoing: Boolean(e.preventRecursion),
      delay_until: positive(e.delayUntilRecursion),
    },
    effect: { sticky: positive(e.sticky), cooldown: positive(e.cooldown), delay: positive(e.delay) },
  };
  if (e.extra) result.extra = e.extra as Record<string, unknown>;
  return { ...result, ..._.pick(entry, Object.keys(implicitDefaults)) };
}

export function fromWorldbookEntry(entry: PartialEntry & { uid: number }, displayIndex: number): StEntry {
  const s = entry.strategy;
  const p = entry.position;
  const result: StEntry = {
    uid: entry.uid,
    displayIndex,
    comment: entry.name ?? '',
    disable: !(entry.enabled ?? true),
    constant: s?.type ? s.type === 'constant' : true,
    selective: s?.type === 'selective',
    key: (s?.keys ?? []).map((k) => String(k)),
    selectiveLogic: logicIds[s?.keys_secondary?.logic ?? 'and_any'],
    keysecondary: (s?.keys_secondary?.keys ?? []).map((k) => String(k)),
    scanDepth: s?.scan_depth === 'same_as_global' ? null : (s?.scan_depth ?? null),
    vectorized: s?.type === 'vectorized',
    position: positionIds[p?.type ?? 'at_depth'],
    role: roleIds[p?.role ?? 'system'],
    depth: p?.depth ?? 4,
    order: p?.order ?? 100,
    content: entry.content ?? '',
    useProbability: true,
    probability: entry.probability ?? 100,
    excludeRecursion: entry.recursion?.prevent_incoming ?? false,
    preventRecursion: entry.recursion?.prevent_outgoing ?? false,
    delayUntilRecursion: entry.recursion?.delay_until ?? false,
    sticky: entry.effect?.sticky ?? null,
    cooldown: entry.effect?.cooldown ?? null,
    delay: entry.effect?.delay ?? null,
  };
  if (entry.extra) result.extra = entry.extra;
  return { ...result, ...structuredClone(implicitDefaults), ..._.pick(entry, Object.keys(implicitDefaults)) };
}

/** Unique uids: taken ones move on by squares, missing ones are random (`handleWorldbookEntriesCollision`). */
function withUniqueUids(entries: PartialEntry[]): (PartialEntry & { uid: number })[] {
  const MAX_UID = 1_000_000;
  const used = new Set<number>();
  return entries.map((entry) => {
    let uid = entry.uid ?? Math.floor(Math.random() * MAX_UID);
    for (let i = 1; used.has(uid); i++) uid = (uid + i * i) % MAX_UID;
    used.add(uid);
    return { ...entry, uid };
  });
}

export function worldbookApi(rt: Runtime) {
  const { mirror, transport } = rt;
  const books = () => mirror.state.lorebooks;

  async function getWorldbook(name: string): Promise<WorldbookEntry[]> {
    const entries = await transport.call<StEntry[] | null>('getLorebook', name);
    if (!entries) throw new Error(`未能找到世界书 '${name}'`);
    return entries.map(toWorldbookEntry);
  }

  async function replaceWorldbook(name: string, entries: PartialEntry[]) {
    const st = withUniqueUids(entries).map((entry, i) => fromWorldbookEntry(entry, i));
    await transport.call('replaceLorebook', name, st);
  }

  async function updateWorldbookWith(
    name: string,
    updater: (entries: WorldbookEntry[]) => PartialEntry[] | Promise<PartialEntry[]>,
  ): Promise<WorldbookEntry[]> {
    const entries = await updater(await getWorldbook(name));
    await replaceWorldbook(name, entries);
    return getWorldbook(name);
  }

  return {
    getWorldbookNames: () => [...books().names],
    getGlobalWorldbookNames: () => [...books().global],
    rebindGlobalWorldbooks: (names: string[]) => transport.call('bindLorebooks', 'global', names),
    getCharWorldbookNames: (name: string) => {
      const state = mirror.state;
      if (name === 'current') return structuredClone(books().character);
      const found =
        state.characters.find((c) => c.avatar === name) ?? state.characters.find((c) => c.name === name);
      return structuredClone(found?.lorebooks ?? { primary: null, additional: [] });
    },
    rebindCharWorldbooks: (name: string, value: { primary: string | null; additional: string[] }) =>
      transport.call('bindLorebooks', 'character', value, name),
    getChatWorldbookName: () => books().chat,
    rebindChatWorldbook: (_chat: string, name: string) => transport.call('bindLorebooks', 'chat', name),
    getOrCreateChatWorldbook: (_chat: string, name?: string) =>
      transport.call<string>('getOrCreateChatLorebook', name ?? null),
    getWorldbook,
    createWorldbook: async (name: string, entries: PartialEntry[] = []) => {
      if (books().names.includes(name)) return false;
      await transport.call('createLorebook', name);
      if (entries.length) await replaceWorldbook(name, entries);
      return true;
    },
    createOrReplaceWorldbook: async (name: string, entries: PartialEntry[] = []) => {
      const exists = books().names.includes(name);
      if (!exists) await transport.call('createLorebook', name);
      await replaceWorldbook(name, entries);
      return !exists;
    },
    deleteWorldbook: (name: string) => transport.call<boolean>('deleteLorebook', name),
    replaceWorldbook,
    updateWorldbookWith,
    createWorldbookEntries: async (name: string, created: PartialEntry[]) => {
      const current = await getWorldbook(name);
      const taken = new Set(current.map((e) => e.uid));
      const fresh = withUniqueUids([...current, ...created.map((e) => ({ ...e, uid: undefined }))]).slice(
        current.length,
      );
      const all = [...current, ...fresh];
      await replaceWorldbook(name, all as PartialEntry[]);
      const worldbook = await getWorldbook(name);
      return { worldbook, new_entries: worldbook.filter((e) => !taken.has(e.uid)) };
    },
    deleteWorldbookEntries: async (name: string, predicate: (entry: WorldbookEntry) => boolean) => {
      const current = await getWorldbook(name);
      const deleted = current.filter((e) => predicate(e));
      const kept = current.filter((e) => !deleted.includes(e));
      await replaceWorldbook(name, kept as PartialEntry[]);
      return { worldbook: await getWorldbook(name), deleted_entries: deleted };
    },
  };
}
