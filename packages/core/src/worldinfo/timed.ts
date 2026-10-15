import type { ScanEntry, TimedEffect, TimedWorldInfoState } from './types.ts';

type EffectType = 'sticky' | 'cooldown' | 'delay';

const keyOf = (entry: ScanEntry) => `${entry.world}.${entry.uid}`;

/** Sticky / cooldown / delay bookkeeping (port of SillyTavern's `WorldInfoTimedEffects`). */
export class TimedEffects {
  readonly #chatLength: number;
  readonly #entries: readonly ScanEntry[];
  readonly #dryRun: boolean;
  readonly #state: Required<TimedWorldInfoState>;
  readonly #active: Record<EffectType, ScanEntry[]> = { sticky: [], cooldown: [], delay: [] };

  /** `state` is the chat's `timedWorldInfo` object; it is mutated unless this is a dry run. */
  constructor(
    chatLength: number,
    entries: readonly ScanEntry[],
    state: TimedWorldInfoState,
    dryRun: boolean,
  ) {
    this.#chatLength = chatLength;
    this.#entries = entries;
    this.#dryRun = dryRun;
    for (const type of ['sticky', 'cooldown'] as const) {
      const map = state[type];
      if (!map || typeof map !== 'object') state[type] = {};
      for (const [key, value] of Object.entries(state[type]!)) {
        if (!value || typeof value !== 'object') delete state[type]![key];
      }
    }
    this.#state = state as Required<TimedWorldInfoState>;
  }

  #effect(type: 'sticky' | 'cooldown', entry: ScanEntry, isProtected: boolean): TimedEffect {
    return {
      hash: entry.hash,
      start: this.#chatLength,
      end: this.#chatLength + Number(entry[type]),
      protected: isProtected,
    };
  }

  #check(type: 'sticky' | 'cooldown', onEnded?: (entry: ScanEntry) => void): void {
    const map = this.#state[type];
    for (const [key, value] of Object.entries(map)) {
      const entry = this.#entries.find((e) => String(e.hash) === String(value.hash));
      if (this.#chatLength <= Number(value.start) && !value.protected) {
        delete map[key];
        continue;
      }
      if (!entry) {
        if (this.#chatLength >= Number(value.end)) delete map[key];
        continue;
      }
      if (!entry[type]) {
        delete map[key];
        continue;
      }
      if (this.#chatLength >= Number(value.end)) {
        delete map[key];
        onEnded?.(entry);
        continue;
      }
      this.#active[type].push(entry);
    }
  }

  checkTimedEffects(): void {
    if (!this.#dryRun) {
      this.#check('sticky', (entry) => {
        if (!entry.cooldown) return;
        this.#state.cooldown[keyOf(entry)] = this.#effect('cooldown', entry, true);
        this.#active.cooldown.push(entry);
      });
      this.#check('cooldown');
    }
    for (const entry of this.#entries) {
      if (entry.delay && this.#chatLength < entry.delay) this.#active.delay.push(entry);
    }
  }

  isActive(type: EffectType, entry: ScanEntry): boolean {
    return this.#active[type].some((e) => e.hash === entry.hash);
  }

  setTimedEffects(activated: Iterable<ScanEntry>): void {
    if (this.#dryRun) return;
    for (const entry of activated) {
      for (const type of ['sticky', 'cooldown'] as const) {
        if (!entry[type]) continue;
        const key = keyOf(entry);
        if (!this.#state[type][key]) this.#state[type][key] = this.#effect(type, entry, false);
      }
    }
  }
}
