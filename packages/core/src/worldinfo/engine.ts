import { ScanState, WorldInfoBuffer, type ScanStateValue } from './buffer.ts';
import { TimedEffects } from './timed.ts';
import {
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  WorldInfoLogic,
  WorldInfoPosition,
  type GlobalScanData,
  type ScanEntry,
  type TimedWorldInfoState,
  type WorldInfoSettings,
} from './types.ts';

export interface WorldInfoScanInput {
  /** Chat messages as scanned text, newest first (with `Name: ` prefixes when `includeNames`). */
  chat: readonly string[];
  /** Entries from `collectEntries`. */
  entries: readonly ScanEntry[];
  settings: WorldInfoSettings;
  /** Prompt size in tokens; the World Info budget is a percentage of it. */
  maxContext: number;
  global: GlobalScanData;
  /** Extension prompts that opted into scanning (Author's Note, character note, ...). */
  injects?: readonly string[];
  /** The chat's `timedWorldInfo`; mutated unless `dryRun`. */
  timedState: TimedWorldInfoState;
  dryRun?: boolean;
  /** Avatar file name stem and tag ids of the active character, for character filters. */
  character?: { fileName: string; tags: readonly string[] };
  /** Entries forced on by scripts or tools, keyed `world.uid`. */
  externalActivations?: ReadonlyMap<string, ScanEntry>;
  /** Macro substitution for keys and content. */
  substitute: (text: string) => string;
  countTokens: (text: string) => number | Promise<number>;
  /** Regex scripts for the World Info placement; `depth` is set for @depth entries. */
  applyRegex?: (text: string, depth: number | null) => string;
  random?: () => number;
}

export interface WorldInfoDepthInjection {
  depth: number;
  role: number;
  entries: string[];
}

export interface WorldInfoScanResult {
  before: string;
  after: string;
  /** Example-message entries (`EMTop` = before, `EMBottom` = after). */
  examples: { position: 'before' | 'after'; content: string }[];
  anTop: string[];
  anBottom: string[];
  depth: WorldInfoDepthInjection[];
  outlets: Record<string, string[]>;
  activated: ScanEntry[];
  /** True when the budget stopped further activations. */
  budgetOverflowed: boolean;
}

const byOrderDesc = (a: ScanEntry, b: ScanEntry) => b.order - a.order;

/** Port of SillyTavern's `checkWorldInfo`: which entries activate and where they go. */
export async function scanWorldInfo(input: WorldInfoScanInput): Promise<WorldInfoScanResult> {
  const { settings, substitute } = input;
  const random = input.random ?? Math.random;
  const buffer = new WorldInfoBuffer(input.chat, input.global, settings);
  for (const inject of input.injects ?? []) if (inject) buffer.addInject(inject);

  let budget = Math.round((settings.budget * input.maxContext) / 100) || 1;
  if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap;

  const entries = input.entries;
  const timed = new TimedEffects(input.chat.length, entries, input.timedState, !!input.dryRun);
  timed.checkTimedEffects();

  const empty: WorldInfoScanResult = {
    before: '',
    after: '',
    examples: [],
    anTop: [],
    anBottom: [],
    depth: [],
    outlets: {},
    activated: [],
    budgetOverflowed: false,
  };
  if (entries.length === 0) return empty;

  const delayLevels = [
    ...new Set(
      entries
        .filter((e) => e.delayUntilRecursion)
        .map((e) => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion))),
    ),
  ].sort((a, b) => a - b);
  let currentDelayLevel = delayLevels.shift() ?? 0;

  const allActivated = new Map<string, ScanEntry>();
  const failedProbability = new Set<ScanEntry>();
  let allActivatedText = '';
  let overflowed = false;
  let scanState: ScanStateValue = ScanState.INITIAL;
  let loops = 0;
  const order = new Map(entries.map((e, i) => [e, i]));
  const keyOf = (e: ScanEntry) => `${e.world}.${e.uid}`;

  while (scanState) {
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= loops) break;
    loops++;
    let nextState: ScanStateValue = ScanState.NONE;
    const activatedNow = new Set<ScanEntry>();

    for (const entry of entries) {
      if (failedProbability.has(entry) || allActivated.has(keyOf(entry))) continue;
      if (entry.disable) continue;
      if (
        Array.isArray(entry.triggers) &&
        entry.triggers.length &&
        !entry.triggers.includes(input.global.trigger)
      )
        continue;

      const filter = entry.characterFilter;
      if (filter?.names?.length && input.character) {
        const included = filter.names.includes(input.character.fileName);
        if (filter.isExclude ? included : !included) continue;
      }
      if (filter?.tags?.length && input.character) {
        const hasTag = input.character.tags.some((t) => filter.tags.includes(t));
        if (filter.isExclude ? hasTag : !hasTag) continue;
      }

      const sticky = timed.isActive('sticky', entry);
      if (timed.isActive('delay', entry)) continue;
      if (timed.isActive('cooldown', entry) && !sticky) continue;
      if (scanState !== ScanState.RECURSION && entry.delayUntilRecursion && !sticky) continue;
      if (
        scanState === ScanState.RECURSION &&
        entry.delayUntilRecursion &&
        Number(entry.delayUntilRecursion) > currentDelayLevel &&
        !sticky
      ) {
        continue;
      }
      if (scanState === ScanState.RECURSION && settings.recursive && entry.excludeRecursion && !sticky)
        continue;

      if (entry.decorators.includes('@@activate')) {
        activatedNow.add(entry);
        continue;
      }
      if (entry.decorators.includes('@@dont_activate')) continue;
      const external = input.externalActivations?.get(keyOf(entry));
      if (external) {
        activatedNow.add(external);
        continue;
      }
      if (entry.constant || sticky) {
        activatedNow.add(entry);
        continue;
      }
      if (!Array.isArray(entry.key) || !entry.key.length) continue;

      const text = buffer.get(entry, scanState);
      const primary = entry.key.some((key) => {
        const k = substitute(key);
        return k && buffer.matchKeys(text, k.trim(), entry);
      });
      if (!primary) continue;

      const secondaryKeys = entry.selective && Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
      if (!secondaryKeys.length) {
        activatedNow.add(entry);
        continue;
      }
      const logic = entry.selectiveLogic ?? WorldInfoLogic.AND_ANY;
      let anyMatch = false;
      let allMatch = true;
      let passed = false;
      for (const key of secondaryKeys) {
        const k = substitute(key);
        const matched = Boolean(k) && buffer.matchKeys(text, k.trim(), entry);
        if (matched) anyMatch = true;
        else allMatch = false;
        if (logic === WorldInfoLogic.AND_ANY && matched) {
          passed = true;
          break;
        }
        if (logic === WorldInfoLogic.NOT_ALL && !matched) {
          passed = true;
          break;
        }
      }
      if (!passed && logic === WorldInfoLogic.NOT_ANY && !anyMatch) passed = true;
      if (!passed && logic === WorldInfoLogic.AND_ALL && allMatch) passed = true;
      if (passed) activatedNow.add(entry);
    }

    // Sticky entries first, then the original order.
    const newEntries = [...activatedNow].sort((a, b) => {
      const stickyDiff = (timed.isActive('sticky', b) ? 1 : 0) - (timed.isActive('sticky', a) ? 1 : 0);
      return stickyDiff || (order.get(a) ?? -1) - (order.get(b) ?? -1);
    });

    filterByInclusionGroups(newEntries, allActivated, buffer, scanState, timed, settings, random);

    const activatedTextTokens = await input.countTokens(allActivatedText);
    let newContent = '';
    let ignoresBudget = newEntries.filter((e) => e.ignoreBudget).length;
    for (const entry of newEntries) {
      ignoresBudget -= entry.ignoreBudget ? 1 : 0;
      if (overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue;
        break;
      }
      const rollNeeded =
        entry.useProbability && entry.probability !== 100 && !timed.isActive('sticky', entry);
      if (rollNeeded && random() * 100 > entry.probability) {
        failedProbability.add(entry);
        continue;
      }
      entry.content = substitute(entry.content);
      newContent += `${entry.content}\n`;
      if (!entry.ignoreBudget && activatedTextTokens + (await input.countTokens(newContent)) >= budget) {
        overflowed = true;
        continue;
      }
      allActivated.set(keyOf(entry), entry);
    }

    const successful = newEntries.filter((e) => !failedProbability.has(e));
    const forRecursion = successful.filter((e) => !e.preventRecursion);

    if (settings.recursive && !overflowed && forRecursion.length) nextState = ScanState.RECURSION;
    if (settings.recursive && !overflowed && scanState === ScanState.MIN_ACTIVATIONS && buffer.hasRecurse()) {
      nextState = ScanState.RECURSION;
    }
    const minNotMet = settings.minActivations > 0 && allActivated.size < settings.minActivations;
    if (!nextState && !overflowed && minNotMet) {
      const overMax =
        (settings.minActivationsDepthMax > 0 && buffer.getDepth() > settings.minActivationsDepthMax) ||
        buffer.getDepth() > input.chat.length;
      if (!overMax) {
        nextState = ScanState.MIN_ACTIVATIONS;
        buffer.advanceScan();
      }
    }
    if (nextState === ScanState.NONE && delayLevels.length) {
      nextState = ScanState.RECURSION;
      currentDelayLevel = delayLevels.shift()!;
    }

    scanState = nextState;
    if (scanState) {
      const text = forRecursion.map((e) => e.content).join('\n');
      if (text) {
        buffer.addRecurse(text);
        allActivatedText = `${text}\n${allActivatedText}`;
      }
    }
  }

  // Build the prompt parts; entries are joined from lowest to highest order.
  const result = { ...empty, budgetOverflowed: overflowed, activated: [...allActivated.values()] };
  const before: string[] = [];
  const after: string[] = [];
  for (const entry of [...allActivated.values()].sort(byOrderDesc)) {
    const regexDepth = entry.position === WorldInfoPosition.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
    const content = input.applyRegex ? input.applyRegex(entry.content, regexDepth) : entry.content;
    if (!content) continue;
    switch (entry.position) {
      case WorldInfoPosition.before:
        before.unshift(content);
        break;
      case WorldInfoPosition.after:
        after.unshift(content);
        break;
      case WorldInfoPosition.EMTop:
        result.examples.unshift({ position: 'before', content });
        break;
      case WorldInfoPosition.EMBottom:
        result.examples.unshift({ position: 'after', content });
        break;
      case WorldInfoPosition.ANTop:
        result.anTop.unshift(content);
        break;
      case WorldInfoPosition.ANBottom:
        result.anBottom.unshift(content);
        break;
      case WorldInfoPosition.atDepth: {
        const depth = entry.depth ?? DEFAULT_DEPTH;
        const role = entry.role ?? 0;
        const existing = result.depth.find((d) => d.depth === depth && d.role === role);
        if (existing) existing.entries.unshift(content);
        else result.depth.push({ depth, role, entries: [content] });
        break;
      }
      case WorldInfoPosition.outlet:
        if (entry.outletName) (result.outlets[entry.outletName] ??= []).push(content);
        break;
    }
  }
  result.before = before.join('\n');
  result.after = after.join('\n');
  timed.setTimedEffects(allActivated.values());
  return result;
}

function filterByInclusionGroups(
  newEntries: ScanEntry[],
  allActivated: Map<string, ScanEntry>,
  buffer: WorldInfoBuffer,
  scanState: ScanStateValue,
  timed: TimedEffects,
  settings: WorldInfoSettings,
  random: () => number,
): void {
  const groups: Record<string, ScanEntry[]> = {};
  for (const entry of newEntries) {
    if (!entry.group) continue;
    for (const name of entry.group.split(/,\s*/).filter(Boolean)) (groups[name] ??= []).push(entry);
  }
  if (!Object.keys(groups).length) return;

  const remove = (entry: ScanEntry) => {
    const i = newEntries.indexOf(entry);
    if (i >= 0) newEntries.splice(i, 1);
  };
  const removeAllBut = (group: ScanEntry[], keep: ScanEntry | null) =>
    group.filter((e) => e !== keep).forEach(remove);

  const hasSticky = new Map<string, boolean>();
  for (const [key, group] of Object.entries(groups)) {
    const sticky = group.filter((e) => timed.isActive('sticky', e));
    hasSticky.set(key, sticky.length > 0);
    if (sticky.length) group.filter((e) => !sticky.includes(e)).forEach(remove);
    group.filter((e) => timed.isActive('cooldown', e) || timed.isActive('delay', e)).forEach(remove);
  }

  for (const [key, group] of Object.entries(groups)) {
    if (!settings.useGroupScoring && !group.some((e) => e.useGroupScoring)) continue;
    if (hasSticky.get(key)) continue;
    const scores = group.map((e) => buffer.getScore(e, scanState));
    const max = Math.max(...scores);
    for (let i = 0; i < group.length; i++) {
      if (!(group[i]!.useGroupScoring ?? settings.useGroupScoring)) continue;
      if (scores[i]! < max) {
        remove(group[i]!);
        group.splice(i, 1);
        scores.splice(i, 1);
        i--;
      }
    }
  }

  for (const [key, group] of Object.entries(groups)) {
    if (hasSticky.get(key)) continue;
    if ([...allActivated.values()].some((e) => e.group === key)) {
      removeAllBut(group, null);
      continue;
    }
    if (group.length <= 1) continue;
    const prio = group.filter((e) => e.groupOverride).sort(byOrderDesc);
    if (prio.length) {
      removeAllBut(group, prio[0]!);
      continue;
    }
    const total = group.reduce((sum, e) => sum + (e.groupWeight ?? DEFAULT_WEIGHT), 0);
    const roll = random() * total;
    let acc = 0;
    let winner: ScanEntry | null = null;
    for (const entry of group) {
      acc += entry.groupWeight ?? DEFAULT_WEIGHT;
      if (roll <= acc) {
        winner = entry;
        break;
      }
    }
    if (winner) removeAllBut(group, winner);
  }
}
