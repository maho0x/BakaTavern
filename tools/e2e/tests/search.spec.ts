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

test.beforeEach(async ({ request }) => {
  await useMockConnection(request);
});

test('chats are searched by their text and a result opens its message', async ({
  page,
  request,
}, testInfo) => {
  const first = uniqueName('Lantern', testInfo);
  const word = `quasar${testInfo.project.name}`;
  await page.goto('/');
  await importCards(page, [{ name: 'lantern', card: { v3: v3Card(first) } }]);
  await expect(messages(page)).toHaveCount(1);
  await mockReply(request, { reply: `The ${word} burns over the bay.` });
  await send(page, 'What is that light?');
  await expect(messages(page)).toHaveCount(3);
  await waitIdle(page);

  // From another chat, the search still finds it.
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(messages(page)).toHaveCount(1);
  if (isMobile(page)) await page.getByRole('button', { name: 'Characters' }).first().click();
  await page.getByRole('button', { name: 'Search chats' }).click();
  const dialog = page.getByRole('dialog', { name: 'Search chats' });
  await dialog.getByRole('searchbox', { name: 'Search for' }).fill(word.toUpperCase());
  const hit = dialog.getByRole('list', { name: 'Messages found' }).getByRole('button');
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText(`${first}:`);
  await expect(hit.locator('mark')).toHaveText(word);
  await hit.click();
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).nth(2)).toHaveClass(/found/);
});
