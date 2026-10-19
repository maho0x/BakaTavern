/**
 * The frame's copy of the chat state, kept current by the page, and TavernHelper's rules for
 * reading it: message ranges, roles, swipes.
 */

import type { BridgeState, FrameConfig, MessageState } from '../protocol.ts';

export class Mirror {
  state: BridgeState;
  readonly config: FrameConfig;
  readonly #listeners: (() => void)[] = [];

  constructor(config: FrameConfig) {
    this.config = config;
    this.state = config.state;
  }

  replace(state: BridgeState) {
    this.state = state;
    for (const listener of this.#listeners) listener();
  }

  onChange(listener: () => void) {
    this.#listeners.push(listener);
  }

  get messages(): MessageState[] {
    return this.state.messages;
  }

  /** A message index, negative ones counting from the end (`normalizeMessageId`). */
  normalize(id: number): number {
    return id < 0 ? this.messages.length + id : id;
  }

  /** `[start, end]` from `5`, `-1`, `2-4` or `0-{{lastMessageId}}` (macros already replaced). */
  range(input: string): { start: number; end: number } | null {
    const max = this.messages.length - 1;
    const clamp = (value: number) => Math.min(Math.max(value < 0 ? max + value + 1 : value, 0), max);
    let start: number;
    let end: number;
    if (/^(-?\d+)$/.test(input)) {
      start = end = clamp(Number(input));
    } else {
      const match = input.match(/^(-?\d+)-(-?\d+)$/);
      if (!match) return null;
      [start, end] = [clamp(Number(match[1])), clamp(Number(match[2]))].sort((a, b) => a - b) as [
        number,
        number,
      ];
    }
    if (Number.isNaN(start) || Number.isNaN(end) || max < 0) return null;
    return { start, end };
  }
}

/** A message with its per-swipe lists filled to the number of swipes. */
export function swipeLists(message: MessageState) {
  const count = Math.max(message.swipes.length, 1);
  const pad = <T>(list: T[], fill: () => T) => Array.from({ length: count }, (_v, i) => list[i] ?? fill());
  return {
    swipes: pad(message.swipes, () => ''),
    swipes_data: pad(message.swipes_data, () => ({})),
    swipes_info: pad(message.swipes_info, () => ({})),
  };
}

export function currentText(message: MessageState): string {
  return message.swipes[message.swipe_id] ?? '';
}

export function lastMessageId(state: BridgeState): number {
  return state.messages.length - 1;
}
