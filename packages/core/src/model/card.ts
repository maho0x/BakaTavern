/** Character Card V3 data (the `data` object of a card). Unknown fields are preserved. */
export interface CardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book?: { entries: unknown[]; [key: string]: unknown };
  tags: string[];
  creator: string;
  character_version: string;
  extensions: CardExtensions;
  group_only_greetings: string[];
  [extra: string]: unknown;
}

export interface CardExtensions {
  talkativeness?: string | number;
  fav?: boolean | string;
  /** Name of the primary lorebook. */
  world?: string;
  depth_prompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' | string };
  regex_scripts?: unknown[];
  [extra: string]: unknown;
}

export interface CharacterCard {
  spec: string;
  spec_version: string;
  data: CardData;
  [extra: string]: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Reads card data with every field defaulted. */
export function cardData(card: unknown): CardData {
  const raw = ((card as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
  return {
    ...raw,
    name: str(raw.name),
    description: str(raw.description),
    personality: str(raw.personality),
    scenario: str(raw.scenario),
    first_mes: str(raw.first_mes),
    mes_example: str(raw.mes_example),
    creator_notes: str(raw.creator_notes),
    system_prompt: str(raw.system_prompt),
    post_history_instructions: str(raw.post_history_instructions),
    alternate_greetings: list(raw.alternate_greetings),
    tags: list(raw.tags),
    creator: str(raw.creator),
    character_version: str(raw.character_version),
    extensions: (raw.extensions && typeof raw.extensions === 'object'
      ? raw.extensions
      : {}) as CardExtensions,
    group_only_greetings: list(raw.group_only_greetings),
  } as CardData;
}

/** A blank V3 card. */
export function newCard(name: string): CharacterCard {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '',
      extensions: {
        talkativeness: '0.5',
        fav: false,
        world: '',
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
      },
      group_only_greetings: [],
    },
  };
}
