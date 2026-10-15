/** SillyTavern World Info data model (field names match ST's JSON). */

export const WorldInfoPosition = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
} as const;

export const WorldInfoLogic = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
} as const;

export const InsertionStrategy = {
  evenly: 0,
  characterFirst: 1,
  globalFirst: 2,
} as const;

/** Extension prompt roles: 0 system, 1 user, 2 assistant. */
export type PromptRoleId = 0 | 1 | 2;

export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;
export const MAX_SCAN_DEPTH = 1000;
export const GENERATION_TRIGGERS = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const;

export interface CharacterFilter {
  isExclude: boolean;
  names: string[];
  tags: string[];
}

export interface WorldInfoEntry {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  vectorized: boolean;
  selective: boolean;
  selectiveLogic: number;
  addMemo: boolean;
  order: number;
  position: number;
  disable: boolean;
  ignoreBudget: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  matchPersonaDescription: boolean;
  matchCharacterDescription: boolean;
  matchCharacterPersonality: boolean;
  matchCharacterDepthPrompt: boolean;
  matchScenario: boolean;
  matchCreatorNotes: boolean;
  delayUntilRecursion: boolean | number;
  probability: number;
  useProbability: boolean;
  depth: number;
  outletName: string;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string;
  role: number | null;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  triggers: string[];
  characterFilter?: CharacterFilter;
  displayIndex?: number;
  [extra: string]: unknown;
}

/** Defaults SillyTavern uses for a new entry (`newWorldInfoEntryTemplate`). */
export function createEntry(uid: number, overrides: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: WorldInfoLogic.AND_ANY,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: DEFAULT_DEPTH,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: DEFAULT_WEIGHT,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
    displayIndex: uid,
    ...overrides,
  };
}

/** Global World Info settings (SillyTavern `world_info_*`). */
export interface WorldInfoSettings {
  depth: number;
  minActivations: number;
  minActivationsDepthMax: number;
  /** Percentage of the context available to World Info. */
  budget: number;
  budgetCap: number;
  includeNames: boolean;
  recursive: boolean;
  maxRecursionSteps: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  useGroupScoring: boolean;
  characterStrategy: number;
  overflowAlert: boolean;
}

export const defaultWorldInfoSettings: WorldInfoSettings = {
  depth: 2,
  minActivations: 0,
  minActivationsDepthMax: 0,
  budget: 25,
  budgetCap: 0,
  includeNames: true,
  recursive: true,
  maxRecursionSteps: 0,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  characterStrategy: InsertionStrategy.characterFirst,
  overflowAlert: false,
};

/** An entry prepared for scanning: tagged with its book, decorators parsed, hashed. */
export interface ScanEntry extends WorldInfoEntry {
  world: string;
  decorators: string[];
  hash: number;
}

/** Per-chat state of sticky/cooldown effects (`chat_metadata.timedWorldInfo`). */
export interface TimedEffect {
  hash: number;
  start: number;
  end: number;
  protected: boolean;
}

export interface TimedWorldInfoState {
  sticky?: Record<string, TimedEffect>;
  cooldown?: Record<string, TimedEffect>;
}

/** Chat-independent text entries may opt into scanning (`match*` flags). */
export interface GlobalScanData {
  personaDescription: string;
  characterDescription: string;
  characterPersonality: string;
  characterDepthPrompt: string;
  scenario: string;
  creatorNotes: string;
  /** Generation type, matched against `entry.triggers`. */
  trigger: string;
}
