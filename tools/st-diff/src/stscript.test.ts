import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { stscriptCases } from './stscript-cases.ts';
import { bakaTavernStscript, type StscriptOutcome } from './stscript-harness.ts';

const baseline = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../baseline/stscript.json'), 'utf8'),
) as { outcomes: Record<string, StscriptOutcome> };

describe('STscript behaves like SillyTavern 1.19', () => {
  test.each(stscriptCases.map((c) => [c.id, c] as const))('%s', async (id, c) => {
    const expected = baseline.outcomes[id];
    expect(expected, `no baseline for ${id}: run pnpm record:stscript`).toBeDefined();
    expect(await bakaTavernStscript(c)).toEqual(expected);
  });
});
