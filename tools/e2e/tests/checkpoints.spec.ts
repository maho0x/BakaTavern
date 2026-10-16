import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import { importCards, messages, mockReply, send, uniqueName, useMockConnection } from './helpers.ts';

test('checkpoints, branches and the prompt viewer', async ({ page, request }, testInfo) => {
  await useMockConnection(request);
  await mockReply(request, { reply: null });

  await page.goto('/');
  const name = uniqueName('Kit', testInfo);
  await importCards(page, [{ name: 'kit', card: { v3: v3Card(name) } }]);
  await send(page, 'Remember this moment.');
  await expect(messages(page).nth(2)).toContainText('Echo: Remember this moment.');
  const chats = page.getByRole('combobox', { name: 'Chats with this character' });
  const main = (await chats.locator('option:checked').textContent())!;

  // The prompt of the reply: its parts and the text that was sent.
  const reply = messages(page).nth(2);
  await reply.getByRole('button', { name: 'Message options' }).click();
  await page.getByRole('menuitem', { name: 'View the prompt' }).click();
  const viewer = page.getByRole('dialog', { name: 'Prompt' });
  await expect(viewer.getByRole('rowheader', { name: 'Chat history' })).toBeVisible();
  await viewer.getByText('Show the prompt as sent').click();
  await expect(viewer.locator('pre')).toContainText('Remember this moment.');
  await viewer.getByRole('button', { name: 'Close' }).last().click();

  // A checkpoint keeps this chat open; the flag on the message opens it.
  await reply.getByRole('button', { name: 'Message options' }).click();
  page.once('dialog', (dialog) => {
    expect(dialog.defaultValue()).toBe(`${main} - Checkpoint #1`);
    void dialog.accept('');
  });
  await page.getByRole('menuitem', { name: 'Create checkpoint' }).click();
  await expect(page.getByText(`Checkpoint “${main} - Checkpoint #1” saved.`)).toBeVisible();
  await expect(chats.locator('option:checked')).toHaveText(main);
  await reply.getByRole('button', { name: `Open checkpoint “${main} - Checkpoint #1”` }).click();
  await expect(chats.locator('option:checked')).toHaveText(`${main} - Checkpoint #1`);
  await expect(messages(page)).toHaveCount(3);

  // Back to the chat it came from.
  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('menuitem', { name: 'Back to the main chat' }).click();
  await expect(chats.locator('option:checked')).toHaveText(main);

  // A branch opens right away.
  await messages(page).nth(1).getByRole('button', { name: 'Message options' }).click();
  await page.getByRole('menuitem', { name: 'Branch from here' }).click();
  await expect(chats.locator('option:checked')).toHaveText(`${main} - Branch #1`);
  await expect(messages(page)).toHaveCount(2);
});
