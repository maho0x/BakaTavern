import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  messages,
  mockReply,
  mockRequests,
  send,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

test('attached images and files reach the model', async ({ page, request }, testInfo) => {
  await useMockConnection(request);
  await mockReply(request, { reply: 'A red dot and your notes.' });

  await page.goto('/');
  const name = uniqueName('Iris', testInfo);
  await importCards(page, [{ name: 'iris', card: { v3: v3Card(name) } }]);

  await page.locator('form.composer input[type=file]').setInputFiles([
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Buy oat milk.') },
  ]);
  const pending = page.getByRole('list', { name: 'Attachments to send' });
  await expect(pending.getByText('dot.png')).toBeVisible();
  await expect(pending.getByText('notes.txt')).toBeVisible();

  await clearMockRequests(request);
  await send(page, 'What do you see?');
  await expect(messages(page).nth(2)).toContainText('A red dot and your notes.');
  await expect(pending).toHaveCount(0);

  // The message shows its attachments.
  const sent = messages(page).nth(1);
  await expect(sent.getByRole('img', { name: 'dot.png' })).toBeVisible();
  await expect(sent.getByRole('link', { name: /notes\.txt/ })).toBeVisible();

  // The file's text comes first, the image follows (Custom models accept images).
  const [generation] = await mockRequests(request);
  const last = generation!.body.messages!.at(-1)!;
  expect(last.role).toBe('user');
  expect(last.content).toEqual([
    { type: 'text', text: 'Buy oat milk.\n\nWhat do you see?' },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'auto' },
    },
  ]);
});
