import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  isMobile,
  messages,
  mockReply,
  mockRequests,
  mockUrl,
  openPanel,
  send,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

test('chats over Text Completion with an instruct template', async ({ page, request }, testInfo) => {
  // Connection and formatting settings are shared by every test on the server: one project.
  test.skip(isMobile(page), 'covered on desktop');
  await request.put('/api/settings/connection', { headers: { 'x-bt-client': '1' }, data: { data: {} } });
  await mockReply(request, { reply: 'Hello from the text model.' });
  await clearMockRequests(request);

  await page.goto('/');
  const name = uniqueName('Tess', testInfo);
  await importCards(page, [{ name: 'tess', card: { v3: v3Card(name) } }]);

  await openPanel(page, 'Connection');
  await page.getByRole('radio', { name: 'Text Completion' }).click();
  await page.getByRole('combobox', { name: /^Backend/ }).selectOption('koboldcpp');
  await page.getByLabel('Server address').fill(mockUrl);
  await page.getByLabel('Server address').press('Tab');
  await page.getByRole('button', { name: 'Load list' }).click();
  await expect(page.getByText('Found 2 models')).toBeVisible();
  await page.getByRole('button', { name: 'Send a test message' }).click();
  await expect(page.getByText('Connected. Reply: Hello from the text model.')).toBeVisible();

  // Instruct mode with SillyTavern's ChatML templates (seeded for new users).
  await page.getByRole('tab', { name: 'Formatting' }).click();
  await page.getByRole('checkbox', { name: 'Instruct mode' }).check();
  await page.getByRole('combobox', { name: 'Instruct template' }).selectOption({ label: 'ChatML' });
  await page.getByRole('combobox', { name: 'Context template' }).selectOption({ label: 'ChatML' });
  await expect(page.getByRole('textbox', { name: 'Story string' })).toHaveValue(/{{#if system}}/);

  // The sampler preset panel shows what KoboldCpp accepts.
  await page.getByRole('tab', { name: 'Preset' }).click();
  await expect(page.getByRole('combobox', { name: 'Text Completion preset' })).toBeVisible();
  await expect(page.getByText('Showing the settings KoboldCpp accepts.')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  await clearMockRequests(request);
  await send(page, 'Is the reactor stable?');
  await expect(messages(page).nth(2)).toContainText('Hello from the text model.');

  const [generation] = await mockRequests(request);
  expect(generation!.path).toBe('/v1/completions');
  const prompt = String(generation!.body.prompt);
  expect(prompt.startsWith('<|im_start|>system\n')).toBe(true);
  expect(prompt).toContain(`${name} is a terse starship engineer.`);
  expect(prompt).toContain('<|im_start|>user\nIs the reactor stable?<|im_end|>\n');
  expect(prompt.endsWith('<|im_start|>assistant\n')).toBe(true);
  expect(generation!.body.stop).toContain('\n<|im_end|>');
  expect(generation!.body.stream).toBe(true);

  // Back to Chat Completion for the other tests.
  await useMockConnection(request);
});
