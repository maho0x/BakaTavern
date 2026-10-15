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
  send,
  uniqueName,
} from './helpers.ts';

test('sets up a provider, key and model in the connection panel', async ({ page, request }, testInfo) => {
  // Start without any connection.
  await request.put('/api/settings/connection', { headers: { 'x-bt-client': '1' }, data: { data: {} } });
  await mockReply(request, { reply: 'Pong.' });
  await clearMockRequests(request);

  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(uniqueName('Ren', testInfo)) } }]);
  await page.getByRole('button', { name: 'Connection' }).first().click();

  await page.getByLabel('Provider').selectOption('custom');
  await page.getByLabel('API address').fill(`${mockUrl}/v1`);
  await page.getByLabel('API address').press('Tab');

  await page.getByPlaceholder('Paste an API key').fill('sk-e2e-0123456789');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Key saved')).toBeVisible();
  await expect(page.locator('code', { hasText: 'sk-…6789' })).toBeVisible();

  await page.getByRole('button', { name: 'Load list' }).click();
  await expect(page.getByText('Found 2 models')).toBeVisible();
  await page.getByRole('combobox', { name: /^Model/ }).fill('mock-model');
  await page.getByRole('combobox', { name: /^Model/ }).press('Tab');

  await page.getByRole('button', { name: 'Send a test message' }).click();
  await expect(page.getByText('Connected. Reply: Pong.')).toBeVisible();

  // The key went to the provider, never to the page.
  const [test] = await mockRequests(request);
  expect(test!.headers.authorization).toBe('Bearer sk-e2e-0123456789');
  expect(await page.content()).not.toContain('sk-e2e-0123456789');

  await page.getByRole('button', { name: 'Close' }).click();
  if (isMobile(page)) await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await send(page, 'Ping');
  await expect(messages(page).nth(2)).toContainText('Pong.');
});
