import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  isMobile,
  messages,
  mockReply,
  mockRequests,
  mockTokenizeRequests,
  mockUrl,
  openPanel,
  send,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

// Presets and connection settings are shared by every test on the server: desktop only.

test('logit bias lists and token counts use the model’s tokenizer', async ({ page, request }, testInfo) => {
  test.skip(isMobile(page), 'covered on desktop');
  await useMockConnection(request);
  await mockReply(request, { reply: 'A bond of trust.' });

  await page.goto('/');
  const name = uniqueName('Bianca', testInfo);
  await importCards(page, [{ name: 'bianca', card: { v3: v3Card(name) } }]);

  // A new list with one entry, used by the preset.
  await openPanel(page, 'Connection');
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByText('Logit bias', { exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept('E2E bias'));
  await page.getByRole('button', { name: 'New list' }).click();
  await expect(page.getByRole('combobox', { name: 'Logit bias list' })).toHaveValue('E2E bias');
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.getByRole('textbox', { name: 'Text or token ids' }).fill(' bond');
  await page.getByRole('spinbutton', { name: 'Bias' }).fill('-50');
  await page.getByRole('spinbutton', { name: 'Bias' }).press('Tab');
  await page.getByRole('button', { name: 'Close' }).click();

  await clearMockRequests(request);
  await send(page, 'Friends?');
  await expect(messages(page).nth(2)).toContainText('A bond of trust.');
  // " bond" is one token for the mock model's tokenizer (cl100k, like SillyTavern's for Custom).
  const [generation] = await mockRequests(request);
  expect(generation!.body.logit_bias).toEqual({ '11049': -50 });

  // Token counts per message.
  await openPanel(page, 'Settings');
  await page.getByRole('checkbox', { name: 'Show token counts' }).check();
  await expect(messages(page).nth(1).locator('.tokens')).toHaveText('2 tokens');
  await expect(messages(page).nth(2).locator('.tokens')).toHaveText('5 tokens');
  await page.getByRole('checkbox', { name: 'Show token counts' }).uncheck();

  // Back to no bias for the other tests.
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByText('Logit bias', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Logit bias list' }).selectOption('Default (none)');
  await expect(page.getByText('No entries.')).toBeVisible();
});

test('Text Completion asks the backend’s tokenizer for banned tokens', async ({
  page,
  request,
}, testInfo) => {
  test.skip(isMobile(page), 'covered on desktop');
  await request.put('/api/settings/connection', { headers: { 'x-bt-client': '1' }, data: { data: {} } });
  await mockReply(request, { reply: 'Beep.' });

  await page.goto('/');
  const name = uniqueName('Rob', testInfo);
  await importCards(page, [{ name: 'rob', card: { v3: v3Card(name) } }]);

  await openPanel(page, 'Connection');
  await page.getByRole('radio', { name: 'Text Completion' }).click();
  await page.getByRole('combobox', { name: /^Backend/ }).selectOption('llamacpp');
  await page.getByLabel('Server address').fill(mockUrl);
  await page.getByLabel('Server address').press('Tab');
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByText('Other', { exact: true }).click();
  const banned = page.getByRole('textbox', { name: 'Banned tokens and strings' });
  await banned.fill('as a robot');
  await banned.press('Tab');
  await page.getByRole('button', { name: 'Close' }).click();

  await clearMockRequests(request);
  await send(page, 'Are you human?');
  await expect(messages(page).nth(2)).toContainText('Beep.');

  // The mock's tokenizer: one token per word, the id from its length.
  const [generation] = await mockRequests(request);
  expect(generation!.path).toBe('/completion');
  expect(generation!.body.custom_token_bans).toBe('1002,1001,1005');
  const tokenized = await mockTokenizeRequests(request);
  expect(tokenized.map((r) => r.body.content)).toContain('as a robot');

  // Clean up for the other tests.
  await openPanel(page, 'Connection');
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByText('Other', { exact: true }).click();
  await banned.fill('');
  await banned.press('Tab');
  await useMockConnection(request);
});
