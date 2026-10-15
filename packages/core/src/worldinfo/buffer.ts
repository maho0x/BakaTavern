import { escapeRegex } from '../util/text.ts';
import { MAX_SCAN_DEPTH, WorldInfoLogic, type GlobalScanData, type ScanEntry } from './types.ts';

export const ScanState = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
} as const;
export type ScanStateValue = (typeof ScanState)[keyof typeof ScanState];

/** Parses `/pattern/flags` keys. Returns null for anything that is not a valid delimited regex. */
export function parseRegexFromString(input: string): RegExp | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input);
  if (!match) return null;
  let pattern = match[1]!;
  // An unescaped delimiter inside the pattern means it is not a valid delimited regex.
  if (/(^|[^\\])\//.test(pattern)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, match[2]);
  } catch {
    return null;
  }
}

const regexCache = new Map<string, RegExp | null>();

function cachedRegex(key: string): RegExp | null {
  let re = regexCache.get(key);
  if (re === undefined) {
    re = parseRegexFromString(key);
    if (regexCache.size > 5000) regexCache.clear();
    regexCache.set(key, re);
  }
  if (re) re.lastIndex = 0;
  return re;
}

export interface BufferSettings {
  depth: number;
  caseSensitive: boolean;
  matchWholeWords: boolean;
}

/** The text World Info keys are matched against (port of SillyTavern's `WorldInfoBuffer`). */
export class WorldInfoBuffer {
  #depthBuffer: string[] = [];
  #recurseBuffer: string[] = [];
  #injectBuffer: string[] = [];
  #skew = 0;
  readonly #global: GlobalScanData;
  readonly #settings: BufferSettings;

  /** `messages` newest first. */
  constructor(messages: readonly string[], global: GlobalScanData, settings: BufferSettings) {
    const limit = Math.min(messages.length, MAX_SCAN_DEPTH);
    for (let depth = 0; depth < limit; depth++) {
      if (messages[depth]) this.#depthBuffer[depth] = messages[depth]!.trim();
    }
    this.#global = global;
    this.#settings = settings;
  }

  #transform(str: string, entry: ScanEntry): string {
    return (entry.caseSensitive ?? this.#settings.caseSensitive) ? str : str.toLowerCase();
  }

  getDepth(): number {
    return this.#settings.depth + this.#skew;
  }

  get(entry: ScanEntry, scanState: ScanStateValue): string {
    let depth = entry.scanDepth ?? this.getDepth();
    if (depth <= 0) return '';
    depth = Math.min(depth, MAX_SCAN_DEPTH);
    const MATCHER = '\x01';
    const JOINER = '\n' + MATCHER;
    let result = MATCHER + this.#depthBuffer.slice(0, depth).join(JOINER);
    const g = this.#global;
    if (entry.matchPersonaDescription && g.personaDescription) result += JOINER + g.personaDescription;
    if (entry.matchCharacterDescription && g.characterDescription) result += JOINER + g.characterDescription;
    if (entry.matchCharacterPersonality && g.characterPersonality) result += JOINER + g.characterPersonality;
    if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) result += JOINER + g.characterDepthPrompt;
    if (entry.matchScenario && g.scenario) result += JOINER + g.scenario;
    if (entry.matchCreatorNotes && g.creatorNotes) result += JOINER + g.creatorNotes;
    if (this.#injectBuffer.length) result += JOINER + this.#injectBuffer.join(JOINER);
    if (this.#recurseBuffer.length && scanState !== ScanState.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER);
    }
    return result;
  }

  matchKeys(haystack: string, needle: string, entry: ScanEntry): boolean {
    const keyRegex = cachedRegex(needle);
    if (keyRegex) return keyRegex.test(haystack);
    const text = this.#transform(haystack, entry);
    const key = this.#transform(needle, entry);
    if (entry.matchWholeWords ?? this.#settings.matchWholeWords) {
      if (key.split(/\s+/).length > 1) return text.includes(key);
      return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text);
    }
    return text.includes(key);
  }

  addRecurse(text: string): void {
    this.#recurseBuffer.push(text);
  }

  addInject(text: string): void {
    this.#injectBuffer.push(text);
  }

  hasRecurse(): boolean {
    return this.#recurseBuffer.length > 0;
  }

  advanceScan(): void {
    this.#skew++;
  }

  /** Number of keys found, used to pick the best entry of an inclusion group. */
  getScore(entry: ScanEntry, scanState: ScanStateValue): number {
    const text = this.get(entry, scanState);
    const primary = Array.isArray(entry.key) ? entry.key : [];
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
    if (!primary.length) return 0;
    const primaryScore = primary.filter((k) => this.matchKeys(text, k, entry)).length;
    const secondaryScore = secondary.filter((k) => this.matchKeys(text, k, entry)).length;
    if (secondary.length > 0) {
      if (entry.selectiveLogic === WorldInfoLogic.AND_ANY) return primaryScore + secondaryScore;
      if (entry.selectiveLogic === WorldInfoLogic.AND_ALL) {
        return secondaryScore === secondary.length ? primaryScore + secondaryScore : primaryScore;
      }
    }
    return primaryScore;
  }
}
