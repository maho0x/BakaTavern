import { describe, expect, it } from 'vitest';

import {
  collectEntries,
  convertCharacterBook,
  createEntry,
  defaultWorldInfoSettings,
  scanWorldInfo,
  WorldInfoPosition,
  type TimedWorldInfoState,
  type WorldInfoEntry,
  type WorldInfoScanInput,
} from './index.ts';

const global = {
  personaDescription: '',
  characterDescription: 'She guards the Eldoria forest.',
  characterPersonality: '',
  characterDepthPrompt: '',
  scenario: '',
  creatorNotes: '',
  trigger: 'normal',
};

function scan(entries: WorldInfoEntry[], chat: string[], extra: Partial<WorldInfoScanInput> = {}) {
  return scanWorldInfo({
    chat,
    entries: collectEntries({ global: [], character: [{ name: 'Book', entries }] }, 1),
    settings: { ...defaultWorldInfoSettings, ...extra.settings },
    maxContext: 8000,
    global,
    timedState: {},
    substitute: (t) => t.replaceAll('{{char}}', 'Seraphina'),
    countTokens: (t) => Math.ceil(t.length / 4),
    random: () => 0,
    ...extra,
  });
}

describe('World Info activation', () => {
  it('matches keys within the scan depth, case-insensitively', async () => {
    const entries = [
      createEntry(0, { key: ['dragon'], content: 'Dragons are rare.' }),
      createEntry(1, { key: ['castle'], content: 'The castle is old.' }),
    ];
    const result = await scan(entries, ['A DRAGON appears!', 'hello', 'The castle gates open.']);
    expect(result.before).toBe('Dragons are rare.');
    expect(result.activated.map((e) => e.uid)).toEqual([0]);
  });

  it('supports regex keys, whole words, macros in keys and constants', async () => {
    const entries = [
      createEntry(0, { key: ['/drag(on|ons)\\b/i'], content: 'regex', order: 10 }),
      createEntry(1, { key: ['cat'], content: 'whole', matchWholeWords: true, order: 20 }),
      createEntry(2, { key: ['{{char}}'], content: 'macro key', order: 30 }),
      createEntry(3, { constant: true, content: 'always', order: 40 }),
    ];
    const result = await scan(entries, ['Seraphina sees dragons and a category.']);
    // Lower order first in the joined prompt.
    expect(result.before).toBe('regex\nmacro key\nalways');
  });

  it('applies secondary key logic', async () => {
    const make = (uid: number, logic: number) =>
      createEntry(uid, {
        key: ['sword'],
        keysecondary: ['fire', 'ice'],
        selectiveLogic: logic,
        content: `L${logic}`,
      });
    const text = ['A sword of fire.'];
    const results = await Promise.all([0, 1, 2, 3].map((logic) => scan([make(0, logic)], text)));
    expect(results.map((r) => r.before)).toEqual(['L0', 'L1', '', '']);
  });

  it('recurses into activated content unless prevented', async () => {
    const entries = [
      createEntry(0, { key: ['king'], content: 'The king lives in the citadel.' }),
      createEntry(1, { key: ['citadel'], content: 'The citadel has three towers.' }),
      createEntry(2, { key: ['towers'], content: 'Towers are guarded.', excludeRecursion: true }),
    ];
    const result = await scan(entries, ['Where is the king?']);
    expect(result.activated.map((e) => e.uid).sort()).toEqual([0, 1]);
  });

  it('places entries by position, depth and role, and fills outlets', async () => {
    const entries = [
      createEntry(0, { constant: true, content: 'after', position: WorldInfoPosition.after }),
      createEntry(1, {
        constant: true,
        content: 'depth',
        position: WorldInfoPosition.atDepth,
        depth: 2,
        role: 1,
      }),
      createEntry(2, { constant: true, content: 'an-top', position: WorldInfoPosition.ANTop }),
      createEntry(3, {
        constant: true,
        content: 'outlet',
        position: WorldInfoPosition.outlet,
        outletName: 'lore',
      }),
      createEntry(4, { constant: true, content: 'example', position: WorldInfoPosition.EMBottom }),
    ];
    const result = await scan(entries, ['hi']);
    expect(result.after).toBe('after');
    expect(result.depth).toEqual([{ depth: 2, role: 1, entries: ['depth'] }]);
    expect(result.anTop).toEqual(['an-top']);
    expect(result.outlets).toEqual({ lore: ['outlet'] });
    expect(result.examples).toEqual([{ position: 'after', content: 'example' }]);
  });

  it('respects the token budget', async () => {
    const entries = [0, 1, 2].map((i) =>
      createEntry(i, { constant: true, content: 'x'.repeat(400), order: 100 - i }),
    );
    const result = await scan(entries, ['hi'], { maxContext: 1000 });
    // 25% of 1000 = 250 tokens; each entry is ~100 tokens.
    expect(result.activated.length).toBe(2);
    expect(result.budgetOverflowed).toBe(true);
  });

  it('picks one winner per inclusion group (override first)', async () => {
    const entries = [
      createEntry(0, { constant: true, group: 'weather', content: 'rain' }),
      createEntry(1, { constant: true, group: 'weather', content: 'sun', groupOverride: true }),
    ];
    const result = await scan(entries, ['hi']);
    expect(result.before).toBe('sun');
  });

  it('honours probability, triggers and character filters', async () => {
    const entries = [
      createEntry(0, { constant: true, content: 'rare', probability: 10 }),
      createEntry(1, { constant: true, content: 'only on swipe', triggers: ['swipe'] }),
      createEntry(2, {
        constant: true,
        content: 'not for Sera',
        characterFilter: { isExclude: true, names: ['Seraphina'], tags: [] },
      }),
    ];
    const result = await scan(entries, ['hi'], {
      random: () => 0.5,
      character: { fileName: 'Seraphina', tags: [] },
    });
    expect(result.activated).toEqual([]);
  });

  it('keeps sticky entries active across turns', async () => {
    const state: TimedWorldInfoState = {};
    const entries = [createEntry(0, { key: ['portal'], content: 'Portal lore', sticky: 2 })];
    const first = await scan(entries, ['A portal opens.'], { timedState: state });
    expect(first.activated.length).toBe(1);
    expect(Object.keys(state.sticky ?? {})).toEqual(['Book.0']);
    const second = await scan(entries, ['Nothing here.', 'A portal opens.'].slice(0, 1).concat(['x']), {
      timedState: state,
    });
    expect(second.activated.map((e) => e.uid)).toEqual([0]);
  });

  it('matches additional scan sources when requested', async () => {
    const entries = [
      createEntry(0, { key: ['eldoria'], content: 'Eldoria lore', matchCharacterDescription: true }),
    ];
    const result = await scan(entries, ['hello']);
    expect(result.before).toBe('Eldoria lore');
  });
});

describe('collectEntries', () => {
  it('orders chat lore first and de-duplicates books', () => {
    const book = (name: string, order: number) => ({
      name,
      entries: [createEntry(0, { order, content: name })],
    });
    const entries = collectEntries(
      {
        global: [book('G', 50)],
        character: [book('C', 10), book('G', 50)],
        chat: book('Chat', 1),
        persona: book('P', 1),
      },
      0,
    );
    expect(entries.map((e) => e.world)).toEqual(['Chat', 'P', 'G', 'C']);
    expect(entries[0]!.hash).toBeTypeOf('number');
  });

  it('parses decorators', () => {
    const [entry] = collectEntries(
      { global: [], character: [{ name: 'B', entries: [createEntry(0, { content: '@@activate\nText' })] }] },
      0,
    );
    expect(entry!.decorators).toEqual(['@@activate']);
    expect(entry!.content).toBe('Text');
  });
});

describe('convertCharacterBook', () => {
  it('maps character book fields', () => {
    const { entries } = convertCharacterBook({
      entries: [
        {
          keys: ['a'],
          content: 'c',
          enabled: true,
          insertion_order: 5,
          position: 'before_char',
          extensions: { depth: 7 },
        },
      ],
    });
    expect(entries[0]).toMatchObject({ uid: 0, key: ['a'], order: 5, position: 0, depth: 7, disable: false });
  });
});
