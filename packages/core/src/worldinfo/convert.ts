import {
  createEntry,
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  WorldInfoLogic,
  WorldInfoPosition,
  type WorldInfoEntry,
} from './types.ts';

/** Character Card V2/V3 `character_book` entry. */
export interface CharacterBookEntry {
  keys?: string[];
  secondary_keys?: string[];
  content?: string;
  comment?: string;
  name?: string;
  enabled?: boolean;
  insertion_order?: number;
  constant?: boolean;
  selective?: boolean;
  position?: 'before_char' | 'after_char' | string;
  id?: number;
  extensions?: Record<string, unknown>;
}

export interface CharacterBook {
  name?: string;
  entries: CharacterBookEntry[];
  [key: string]: unknown;
}

/**
 * Converts an embedded character book into SillyTavern World Info entries, the same way ST does
 * when importing a card's lorebook. Returns the book-level data (`originalData`) and entries.
 */
export function convertCharacterBook(book: CharacterBook): {
  data: Record<string, unknown>;
  entries: WorldInfoEntry[];
} {
  const entries = (book.entries ?? []).map((entry, index) => {
    const id = entry.id ?? index;
    const x = (entry.extensions ?? {}) as Record<string, unknown>;
    const pick = <T>(key: string, fallback: T): T => (x[key] ?? fallback) as T;
    return createEntry(id, {
      key: Array.isArray(entry.keys) ? entry.keys : [],
      keysecondary: entry.secondary_keys ?? [],
      comment: entry.comment ?? '',
      content: entry.content ?? '',
      constant: entry.constant ?? false,
      selective: entry.selective ?? false,
      order: entry.insertion_order ?? 100,
      position: pick(
        'position',
        entry.position === 'before_char' ? WorldInfoPosition.before : WorldInfoPosition.after,
      ),
      excludeRecursion: pick('exclude_recursion', false),
      preventRecursion: pick('prevent_recursion', false),
      delayUntilRecursion: pick('delay_until_recursion', false),
      disable: !entry.enabled,
      addMemo: !!entry.comment,
      displayIndex: pick('display_index', index),
      probability: pick('probability', 100),
      useProbability: pick('useProbability', true),
      depth: pick('depth', DEFAULT_DEPTH),
      selectiveLogic: pick('selectiveLogic', WorldInfoLogic.AND_ANY),
      outletName: pick('outlet_name', ''),
      group: pick('group', ''),
      groupOverride: pick('group_override', false),
      groupWeight: pick('group_weight', DEFAULT_WEIGHT),
      scanDepth: pick('scan_depth', null),
      caseSensitive: pick('case_sensitive', null),
      matchWholeWords: pick('match_whole_words', null),
      useGroupScoring: pick('use_group_scoring', null),
      automationId: pick('automation_id', ''),
      role: pick('role', 0),
      vectorized: pick('vectorized', false),
      sticky: pick('sticky', null),
      cooldown: pick('cooldown', null),
      delay: pick('delay', null),
      matchPersonaDescription: pick('match_persona_description', false),
      matchCharacterDescription: pick('match_character_description', false),
      matchCharacterPersonality: pick('match_character_personality', false),
      matchCharacterDepthPrompt: pick('match_character_depth_prompt', false),
      matchScenario: pick('match_scenario', false),
      matchCreatorNotes: pick('match_creator_notes', false),
      extensions: x,
      triggers: (x.triggers as string[] | undefined) || [],
      ignoreBudget: pick('ignore_budget', false),
    });
  });
  return { data: { originalData: book }, entries };
}
