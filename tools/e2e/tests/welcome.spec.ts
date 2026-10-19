import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  importCards,
  isMobile,
  messages,
  mockReply,
  send,
  uniqueName,
  useMockConnection,
  waitIdle,
} from './helpers.ts';

test('home shows recent chats to pick up again', async ({ page, request }, testInfo) => {
  const name = uniqueName('Homebound', testInfo);
  await useMockConnection(request);
  await page.goto('/');
  await importCards(page, [{ name: 'homebound', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);
  await mockReply(request, { reply: 'See you soon.' });
  await send(page, 'Goodbye for now.');
  await expect(messages(page)).toHaveCount(3);
  await waitIdle(page);

  if (isMobile(page)) await page.getByRole('button', { name: 'Characters' }).first().click();
  await page.getByRole('button', { name: 'BakaTavern' }).click();
  const recent = page.getByRole('region', { name: 'Recent chats' });
  const entry = recent.getByRole('button', { name: new RegExp(name) }).first();
  await expect(entry).toContainText('See you soon.');
  await entry.click();
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).last()).toContainText('See you soon.');
});
