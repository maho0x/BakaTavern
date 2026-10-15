import { expect, test } from '@playwright/test';

import { v2Card, v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  composer,
  composerAction,
  importCards,
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

test('imports a V2 card with its lorebook and streams a reply', async ({ page, request }, testInfo) => {
  const name = uniqueName('Aiko', testInfo);
  page.on('dialog', (dialog) => void dialog.accept()); // the offer to import the embedded lorebook
  await page.goto('/');
  await importCards(page, [{ name: 'aiko', card: { v2: v2Card(name) } }]);

  const greeting = messages(page).first();
  await expect(greeting).toContainText(`${name} looks up from the counter.`);
  await expect(greeting).toContainText('Welcome in, User!');

  await mockReply(request, { reply: 'Two matcha lattes, coming up! *She hums while working.*' });
  await send(page, 'What is on the menu today?');
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).nth(1)).toContainText('What is on the menu today?');
  const reply = messages(page).nth(2);
  await expect(reply).toContainText('Two matcha lattes, coming up!');
  await expect(reply.locator('em')).toHaveText('She hums while working.');

  // The prompt carried the card, the example dialogue and the triggered lorebook entry.
  const [sent] = await mockRequests(request);
  expect(sent!.path).toBe('/v1/chat/completions');
  expect(sent!.body.model).toBe('mock-model');
  expect(sent!.body.stream).toBe(true);
  const prompt = JSON.stringify(sent!.body.messages);
  expect(prompt).toContain(`${name} is a cheerful barista at the Moonlit Café.`);
  expect(prompt).toContain('The Moonlit Café serves matcha lattes and lemon tarts.');
  expect(prompt).toContain('Oh, hello there!');
  const last = sent!.body.messages!.at(-1)!;
  expect(last.role).toBe('user');
  expect(String(last.content)).toContain('What is on the menu today?');
});

test('swipes, continues, edits and writes for the user', async ({ page, request }, testInfo) => {
  const name = uniqueName('Ren', testInfo);
  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(name) } }]);
  await expect(messages(page).first()).toContainText('Reactor’s humming.');

  await mockReply(request, { reply: 'First answer.' });
  await send(page, 'Status report?');
  const reply = messages(page).nth(2);
  await expect(reply).toContainText('First answer.');

  // Swiping past the last reply generates a new one.
  await mockReply(request, { reply: 'Second answer.' });
  await page.getByRole('button', { name: /^Next reply/ }).click();
  await expect(reply).toContainText('Second answer.');
  await expect(reply).toContainText('2/2');
  await page.getByRole('button', { name: 'Previous reply' }).click();
  await expect(reply).toContainText('First answer.');
  await expect(reply).toContainText('1/2');

  await mockReply(request, { reply: 'And one more thing.' });
  await composerAction(page, 'Continue the last message');
  await expect(reply).toContainText('First answer. And one more thing.');

  await reply.getByRole('button', { name: 'Edit' }).click();
  await reply.getByRole('textbox').fill('Edited answer.');
  await reply.getByRole('button', { name: 'Save' }).click();
  await expect(reply).toContainText('Edited answer.');

  // "Write for me" fills the composer instead of posting.
  await mockReply(request, { reply: 'Thanks, Chief.' });
  await composerAction(page, 'Write my reply for me');
  await expect(composer(page)).toHaveValue('Thanks, Chief.');
  await expect(messages(page)).toHaveCount(3);

  await page.reload();
  await expect(messages(page).nth(2)).toContainText('Edited answer.');
  await expect(messages(page).nth(2)).toContainText('1/2');
});

test('Stop keeps the text generated so far', async ({ page, request }, testInfo) => {
  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(uniqueName('Ren', testInfo)) } }]);
  await mockReply(request, { reply: 'word '.repeat(150) + 'END', delayMs: 40 });
  await send(page, 'Talk for a while.');
  const reply = messages(page).nth(2);
  await expect(reply).toContainText('word word word');
  await page.getByRole('button', { name: 'Stop generating' }).click();
  await waitIdle(page);
  await expect(reply).not.toContainText('END');
  const shown = await reply.locator('.prose').innerText();

  await page.reload();
  await expect(messages(page)).toHaveCount(3);
  await expect(messages(page).nth(2).locator('.prose')).toHaveText(shown.trim());
});

test('a reply keeps generating across a reload and is stored once', async ({ page, request }, testInfo) => {
  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(uniqueName('Ren', testInfo)) } }]);
  await mockReply(request, { reply: 'tick '.repeat(50) + 'DONE', delayMs: 40 });
  await send(page, 'Count for me.');
  await expect(messages(page).nth(2)).toContainText('tick tick');

  await page.reload();
  await expect(messages(page).nth(2)).toContainText('DONE', { timeout: 20_000 });
  await waitIdle(page);
  await expect(messages(page)).toHaveCount(3);

  await page.reload();
  await expect(messages(page).nth(2)).toContainText('DONE');
  await expect(messages(page)).toHaveCount(3);
  expect(await mockRequests(request)).toHaveLength(1);
});

test('another tab follows a reply live and it is stored once', async ({
  page,
  context,
  request,
}, testInfo) => {
  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(uniqueName('Ren', testInfo)) } }]);
  await expect(messages(page)).toHaveCount(1);

  const other = await context.newPage();
  await other.goto('/');
  await expect(messages(other)).toHaveCount(1);

  await mockReply(request, { reply: 'beep '.repeat(40) + 'END', delayMs: 40 });
  await send(page, 'Ping?');
  await expect(messages(other).last()).toContainText('beep beep');
  await expect(messages(page).nth(2)).toContainText('END');
  await expect(messages(other).nth(2)).toContainText('END');
  await expect(messages(other)).toHaveCount(3);
  await expect(messages(page)).toHaveCount(3);

  await other.reload();
  await expect(messages(other)).toHaveCount(3);
});

test('a reply that finished while offline is recovered when the connection returns', async ({
  page,
  context,
  request,
}, testInfo) => {
  await page.goto('/');
  await importCards(page, [{ name: 'ren', card: { v3: v3Card(uniqueName('Ren', testInfo)) } }]);
  await mockReply(request, { reply: 'zzz '.repeat(40) + 'AWAKE', delayMs: 40 });
  await send(page, 'Wake me up later.');
  await expect(messages(page).nth(2)).toContainText('zzz zzz');

  // Like a phone locking its screen: the page loses the server while the reply is generated.
  await context.setOffline(true);
  await expect(page.getByText(/^Connection lost/)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => ((await (await request.get('/api/llm/jobs')).json()) as { status: string }[]).at(0)?.status,
      { timeout: 15_000 },
    )
    .toBe('completed');
  await context.setOffline(false);

  await expect(messages(page).nth(2)).toContainText('AWAKE', { timeout: 20_000 });
  await expect(page.getByText('Recovered a reply that finished while you were away.')).toBeVisible();
  await expect(messages(page)).toHaveCount(3);
  await page.reload();
  await expect(messages(page)).toHaveCount(3);
});
