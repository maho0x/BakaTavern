import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { bakaTavernRequest } from './bakatavern.ts';
import { scenarios } from './scenarios.ts';

const baselineDir = join(import.meta.dirname, '../baseline');
const read = (file: string) => JSON.parse(readFileSync(join(baselineDir, file), 'utf8'));
const defaultPreset = read('_default-preset.json') as Record<string, unknown>;

describe('requests match SillyTavern 1.19', () => {
  for (const scenario of scenarios) {
    test(`${scenario.id}: ${scenario.title}`, async () => {
      const baseline = read(`${scenario.id}.json`) as {
        request: { path: string; body: Record<string, unknown> };
      };
      const ours = await bakaTavernRequest(scenario, defaultPreset);
      // The query carries the Gemini key; only the path matters.
      expect(ours.path).toBe(baseline.request.path.split('?')[0]);
      // Messages first: their diff is the readable one.
      expect(ours.body.messages).toEqual(baseline.request.body.messages);
      expect(ours.body).toEqual(baseline.request.body);
    });
  }
});

test('the preset new users get is SillyTavern’s Default preset', async () => {
  const { loadStDefaultPreset } = await import('@bakatavern/core');
  expect(await loadStDefaultPreset()).toEqual(defaultPreset);
});
