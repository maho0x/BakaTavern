import { stringHash } from '../util/hash.ts';
import { InsertionStrategy, type ScanEntry, type WorldInfoEntry } from './types.ts';

export interface LoadedBook {
  name: string;
  entries: readonly WorldInfoEntry[];
}

export interface WorldInfoSources {
  /** Globally selected books. */
  global: readonly LoadedBook[];
  /** The character's primary and additional books. */
  character: readonly LoadedBook[];
  /** The chat-bound book. */
  chat?: LoadedBook | null;
  /** The persona-bound book. */
  persona?: LoadedBook | null;
}

const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];

/** Splits `@@decorator` lines off the top of an entry's content. */
export function parseDecorators(content: string): [string[], string] {
  if (!content.startsWith('@@')) return [[], content];
  const isKnown = (line: string) => {
    const data = line.startsWith('@@@') ? line.slice(1) : line;
    return KNOWN_DECORATORS.some((d) => data.startsWith(d));
  };
  const lines = content.split('\n');
  const decorators: string[] = [];
  let fallbacked = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (line.startsWith('@@@') && !fallbacked) continue;
      if (isKnown(line)) {
        decorators.push(line.startsWith('@@@') ? line.slice(1) : line);
        fallbacked = false;
      } else {
        fallbacked = true;
      }
    } else {
      return [decorators, lines.slice(i).join('\n')];
    }
  }
  return [decorators, content];
}

const byOrderDesc = (a: { order: number }, b: { order: number }) => b.order - a.order;

function tag(book: LoadedBook): WorldInfoEntry[] {
  return book.entries.map(({ uid, ...rest }) => ({ uid, world: book.name, ...rest }) as WorldInfoEntry);
}

/**
 * Collects and orders entries the way SillyTavern's `getSortedEntries` does: chat lore first, then
 * persona lore, then global and character lore by the insertion strategy. A book attached in more
 * than one place is only used once (global wins, then chat, then persona).
 */
export function collectEntries(sources: WorldInfoSources, strategy: number): ScanEntry[] {
  const globalNames = new Set(sources.global.map((b) => b.name));
  const chat = sources.chat && !globalNames.has(sources.chat.name) ? sources.chat : null;
  const persona =
    sources.persona && sources.persona.name !== sources.chat?.name && !globalNames.has(sources.persona.name)
      ? sources.persona
      : null;
  const characterBooks = sources.character.filter(
    (b) => !globalNames.has(b.name) && b.name !== sources.chat?.name && b.name !== sources.persona?.name,
  );

  const globalLore = sources.global.flatMap(tag);
  const characterLore = characterBooks.flatMap(tag);
  let entries: WorldInfoEntry[];
  switch (Number(strategy)) {
    case InsertionStrategy.characterFirst:
      entries = [...characterLore.sort(byOrderDesc), ...globalLore.sort(byOrderDesc)];
      break;
    case InsertionStrategy.globalFirst:
      entries = [...globalLore.sort(byOrderDesc), ...characterLore.sort(byOrderDesc)];
      break;
    default:
      entries = [...globalLore, ...characterLore].sort(byOrderDesc);
  }
  entries = [
    ...(chat ? tag(chat).sort(byOrderDesc) : []),
    ...(persona ? tag(persona).sort(byOrderDesc) : []),
    ...entries,
  ];

  return entries.map((entry) => {
    const [decorators, content] = parseDecorators(String(entry.content ?? ''));
    const withDecorators = { ...entry, decorators, content };
    const hash = stringHash(JSON.stringify(withDecorators));
    return structuredClone({ ...withDecorators, hash }) as ScanEntry;
  });
}
