import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  isMobile,
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
  await mockReply(request, {});
  await clearMockRequests(request);
});

const lastPrompt = async (request: Parameters<typeof mockRequests>[0]) =>
  JSON.stringify((await mockRequests(request)).at(-1)!.body.messages);

test('a global regex script changes what is shown, then what is sent', async ({
  page,
  request,
}, testInfo) => {
  // Global scripts are shared by every test on the server: one project is enough.
  test.skip(isMobile(page), 'global scripts are covered on desktop');
  const name = uniqueName('Mina', testInfo);
  const token = `zebra${testInfo.workerIndex}x${testInfo.retry}`;
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await importCards(page, [{ name: 'mina', card: { v3: v3Card(name) } }]);

  await openPanel(page, 'Regex');
  const global = page.locator('section', { has: page.getByRole('heading', { name: 'Global scripts' }) });
  await global.getByRole('button', { name: 'New script' }).click();
  const editor = page.getByRole('dialog', { name: 'Regex script' });
  await editor.getByLabel('Name', { exact: true }).fill(`Hide ${token}`);
  await editor.getByLabel('Find', { exact: true }).fill(`/${token}/g`);
  await editor.getByLabel('Replace with', { exact: true }).fill('[redacted]');
  // New scripts change only what is shown, for user messages (SillyTavern's defaults).
  await editor.getByText('Try it').click();
  await editor.getByLabel('Text', { exact: true }).fill(`a ${token} b`);
  await expect(editor.locator('output')).toHaveText('a [redacted] b');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(global.getByRole('button', { name: `Hide ${token}` })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).first().click();

  await mockReply(request, { reply: 'Noted.' });
  await send(page, `my ${token} plan`);
  await expect(messages(page).nth(2)).toContainText('Noted.');
  await expect(messages(page).nth(1)).toContainText('my [redacted] plan');
  expect(await lastPrompt(request)).toContain(`my ${token} plan`);

  // Now only the prompt.
  await openPanel(page, 'Regex');
  await global.getByRole('button', { name: `Hide ${token}` }).click();
  await editor.getByLabel('Only what is shown').uncheck();
  await editor.getByLabel('Only what is sent to the model').check();
  await editor.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Close' }).first().click();

  await send(page, `${token} again`);
  await expect(messages(page).nth(4)).toContainText('Noted.');
  await expect(messages(page).nth(3)).toContainText(`${token} again`);
  expect(await lastPrompt(request)).toContain('[redacted] again');

  // Clean up the shared global list.
  await openPanel(page, 'Regex');
  const row = global.getByRole('listitem').filter({ hasText: `Hide ${token}` });
  await row.getByRole('button', { name: 'Script options' }).click();
  await row.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(global.getByRole('button', { name: `Hide ${token}` })).toHaveCount(0);
});

test('regex scripts in a card run once allowed', async ({ page, request }, testInfo) => {
  const name = uniqueName('Juno', testInfo);
  const card = v3Card(name);
  card.data.extensions = {
    regex_scripts: [
      {
        id: 'e2e-purr',
        scriptName: 'Purring engine',
        findRegex: '/humming/g',
        replaceString: 'purring',
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
      },
    ],
  };
  const asked: string[] = [];
  page.on('dialog', (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await page.goto('/');
  await importCards(page, [{ name: 'juno', card: { v3: card } }]);
  await expect.poll(() => asked.some((m) => m.includes('comes with regex scripts'))).toBe(true);

  // Character replies are changed as they arrive and stored that way.
  await mockReply(request, { reply: 'The engine is humming.' });
  await send(page, 'How is the ship?');
  await expect(messages(page).nth(2)).toContainText('The engine is purring.');
});
