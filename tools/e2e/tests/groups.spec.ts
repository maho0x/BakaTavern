import { expect, test, type Page } from '@playwright/test';

import { v2Card, v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  composerAction,
  importCards,
  isMobile,
  messages,
  mockReply,
  mockRequests,
  send,
  uniqueName,
  useMockConnection,
  waitIdle,
} from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await useMockConnection(request);
  await mockReply(request, {});
  await clearMockRequests(request);
});

async function openLibrary(page: Page) {
  if (isMobile(page)) await page.getByRole('button', { name: 'Characters' }).first().click();
}

test('a group chat: members greet, reply in turn, can be muted and asked', async ({
  page,
  request,
}, testInfo) => {
  const aiko = uniqueName('Grouped Aiko', testInfo);
  const ren = uniqueName('Grouped Ren', testInfo);
  await page.goto('/');
  await importCards(page, [
    { name: 'aiko', card: { v2: v2Card(aiko) } },
    { name: 'ren', card: { v3: v3Card(ren) } },
  ]);
  await expect(page.getByRole('region', { name: 'Chat', exact: true })).toBeVisible();

  // A new group with both, replying in list order.
  await openLibrary(page);
  await page.getByRole('button', { name: 'New group' }).click();
  const editor = page.getByRole('dialog', { name: 'New group' });
  const group = uniqueName('Night shift', testInfo);
  await editor.getByLabel('Name', { exact: true }).fill(group);
  for (const name of [aiko, ren]) {
    await editor.getByRole('searchbox', { name: 'Search characters' }).fill(name);
    await editor.getByRole('button', { name, exact: true }).click();
  }
  await editor.getByLabel('Who replies').selectOption({ label: 'Every member, in order' });
  await editor.getByRole('button', { name: 'Create group' }).click();
  await expect(editor).toBeHidden();

  // Every member greets (with one of their greetings, picked at random).
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).getByText(group)).toBeVisible();
  await expect(messages(page)).toHaveCount(2);
  await expect(messages(page).nth(0)).toContainText(
    new RegExp(`${aiko} (looks up from the counter|waves from behind the espresso machine)`),
  );
  await expect(messages(page).nth(1)).toContainText('Reactor’s humming.');

  // Both reply, in order, each with the others' names in the prompt.
  await mockReply(request, { replies: ['Tea is ready.', 'Coffee for me.'] });
  await send(page, 'Evening, both of you.');
  await expect(messages(page)).toHaveCount(5);
  await expect(messages(page).nth(3).locator('.name')).toHaveText(aiko);
  await expect(messages(page).nth(3)).toContainText('Tea is ready.');
  await expect(messages(page).nth(4).locator('.name')).toHaveText(ren);
  await expect(messages(page).nth(4)).toContainText('Coffee for me.');
  await waitIdle(page);
  const [first, second] = await mockRequests(request);
  const prompt = (r: typeof first) => r!.body.messages!.map((m) => String(m.content));
  expect(prompt(first).at(-1)).toBe(`[Write the next reply only as ${aiko}.]`);
  expect(prompt(second)).toContain(`${aiko}: Tea is ready.`);
  expect(prompt(second).at(-1)).toBe(`[Write the next reply only as ${ren}.]`);

  // Muted members stay quiet...
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('button', { name: `Mute (replies only when asked): ${ren}` }).click();
  await expect(page.getByRole('button', { name: `Unmute: ${ren}` })).toBeVisible();
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await clearMockRequests(request);
  await mockReply(request, { replies: ['Just me this time.'] });
  await send(page, 'Anyone?');
  await expect(messages(page)).toHaveCount(7);
  await expect(messages(page).nth(6)).toContainText('Just me this time.');
  await waitIdle(page);
  expect(await mockRequests(request)).toHaveLength(1);

  // ...until asked to reply.
  await mockReply(request, { replies: ['Fine, fine.'] });
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('button', { name: `Reply now: ${ren}` }).click();
  await expect(messages(page)).toHaveCount(8);
  await expect(messages(page).nth(7).locator('.name')).toHaveText(ren);
  await expect(messages(page).nth(7)).toContainText('Fine, fine.');
  await waitIdle(page);

  // Regenerating replaces the last round of replies; the unmuted members answer again.
  await mockReply(request, { replies: ['Tea again.'] });
  await composerAction(page, 'Regenerate the last reply');
  await expect(messages(page).nth(7)).toContainText('Tea again.');
  await expect(messages(page).nth(7).locator('.name')).toHaveText(aiko);
  await expect(messages(page)).toHaveCount(8);
  await waitIdle(page);

  // The group chat is open again after a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).getByText(group)).toBeVisible();
  await expect(messages(page)).toHaveCount(8);
  await expect(messages(page).nth(4).locator('.name')).toHaveText(ren);
});
