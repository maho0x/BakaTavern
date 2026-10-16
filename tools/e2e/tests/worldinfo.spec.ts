import { expect, test, type Page } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  messages,
  mockReply,
  mockRequests,
  openPanel,
  send,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await useMockConnection(request);
  await mockReply(request, { reply: 'Indeed.' });
  await clearMockRequests(request);
});

const lastPrompt = async (request: Parameters<typeof mockRequests>[0]) =>
  JSON.stringify((await mockRequests(request)).at(-1)!.body.messages);

/** Answers `prompt()` with `answer` and accepts confirmations. */
function answerDialogs(page: Page, answer: () => string) {
  page.on(
    'dialog',
    (dialog) => void (dialog.type() === 'prompt' ? dialog.accept(answer()) : dialog.accept()),
  );
}

test('a new lorebook entry reaches the prompt and can be disabled in bulk', async ({
  page,
  request,
}, testInfo) => {
  const name = uniqueName('Selene', testInfo);
  const book = `Lore of ${name}`;
  answerDialogs(page, () => book);
  await page.goto('/');
  await importCards(page, [{ name: 'selene', card: { v3: v3Card(name) } }]);

  await openPanel(page, 'World Info');
  await page.getByRole('button', { name: 'New lorebook' }).click();
  const editor = page.getByRole('dialog', { name: book });
  await editor.getByRole('button', { name: 'New entry' }).click();
  await editor.getByLabel('Title').fill('Moon');
  const keywords = editor.getByRole('textbox', { name: 'Keywords', exact: true });
  await keywords.fill('moon');
  await keywords.press('Enter');
  await editor.getByLabel(/^Content/).fill('The moon here is made of cheese.');
  await expect(editor.getByRole('group', { name: 'Keywords', exact: true })).toContainText('moon');
  // Closing saves pending edits.
  await editor.getByRole('button', { name: 'Close' }).click();

  await page.getByLabel('Lorebook for this chat').selectOption(book);
  await expect(page.getByRole('listitem').filter({ hasText: book })).toContainText('chat');
  await page.getByRole('button', { name: 'Close' }).first().click();

  await send(page, 'Look at the moon!');
  await expect(messages(page).nth(2)).toContainText('Indeed.');
  expect(await lastPrompt(request)).toContain('The moon here is made of cheese.');

  // Disable every entry from the list.
  await openPanel(page, 'World Info');
  await page.getByRole('button', { name: new RegExp(`^${book}`) }).click();
  await editor.getByLabel('Select all').check();
  await editor
    .getByRole('toolbar', { name: 'Selected entries' })
    .getByRole('button', { name: 'Disable' })
    .click();
  await expect(editor.getByRole('listitem').filter({ hasText: 'Moon' })).toHaveClass(/off/);
  await editor.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();

  await send(page, 'The moon again.');
  await expect(messages(page).nth(4)).toContainText('Indeed.');
  expect(await lastPrompt(request)).not.toContain('made of cheese');
});

test('imports a NovelAI lorebook', async ({ page }, testInfo) => {
  const file = `nai-${testInfo.project.name}-${testInfo.workerIndex}-${testInfo.retry}`;
  answerDialogs(page, () => '');
  await page.goto('/');
  await page.getByRole('region', { name: 'Chat' }).waitFor();
  await openPanel(page, 'World Info');
  const novel = {
    lorebookVersion: 5,
    entries: [
      { keys: ['dragon'], text: 'Dragons hoard books.', displayName: 'Dragons', enabled: true },
      { keys: ['tea'], text: 'Tea is sacred.', displayName: 'Tea', enabled: false },
    ],
  };
  await page.locator('input[type=file][accept*=".lorebook"]').setInputFiles({
    name: `${file}.lorebook`,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(novel)),
  });
  const row = page.getByRole('button', { name: new RegExp(`^${file}`) });
  await expect(row).toContainText('2');
  await row.click();
  const editor = page.getByRole('dialog', { name: file });
  await expect(editor.getByRole('listitem').filter({ hasText: 'Dragons' })).not.toHaveClass(/off/);
  await expect(editor.getByRole('listitem').filter({ hasText: 'Tea' })).toHaveClass(/off/);
});
