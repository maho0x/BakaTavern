import { createEntry } from '@bakatavern/core/worldinfo/types';
import { describe, expect, it } from 'vitest';

import { fromWorldbookEntry, toWorldbookEntry } from './worldbook.ts';

describe('worldbook entries', () => {
  it('reads SillyTavern entries in TavernHelper shape', () => {
    const entry = toWorldbookEntry(
      createEntry(5, {
        comment: 'Dragon',
        key: ['dragon', '/wyrm/i'],
        keysecondary: ['red'],
        selectiveLogic: 3,
        position: 4,
        role: 2,
        depth: 2,
        order: 50,
        content: 'A red dragon.',
        useProbability: false,
        probability: 30,
        sticky: 3,
        cooldown: 0,
      }) as never,
    );
    expect(entry).toMatchObject({
      uid: 5,
      name: 'Dragon',
      enabled: true,
      strategy: {
        type: 'selective',
        keys_secondary: { logic: 'and_all', keys: ['red'] },
        scan_depth: 'same_as_global',
      },
      position: { type: 'at_depth', role: 'assistant', depth: 2, order: 50 },
      content: 'A red dragon.',
      probability: 100,
      effect: { sticky: 3, cooldown: null, delay: null },
      recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    });
    expect(entry.strategy.keys[0]).toBe('dragon');
    expect(entry.strategy.keys[1]).toBeInstanceOf(RegExp);
  });

  it('writes them back with the fields TavernHelper keeps implicit', () => {
    const st = fromWorldbookEntry(
      {
        uid: 2,
        name: 'Glade',
        strategy: { type: 'selective', keys: ['glade'] },
        position: { type: 'before_character_definition' },
        content: 'A quiet glade.',
      },
      0,
    );
    expect(st).toMatchObject({
      uid: 2,
      displayIndex: 0,
      comment: 'Glade',
      disable: false,
      constant: false,
      selective: true,
      key: ['glade'],
      position: 0,
      role: 0,
      depth: 4,
      order: 100,
      addMemo: true,
      characterFilter: { isExclude: false, names: [], tags: [] },
    });
    expect(toWorldbookEntry(st)).toMatchObject({ name: 'Glade', strategy: { keys: ['glade'] } });
  });
});
