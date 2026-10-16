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

test('connection profiles save and restore the connection', async ({ page, request }, testInfo) => {
  // Connection settings are shared by every test on the server: one project.
  test.skip(isMobile(page), 'covered on desktop');
  await useMockConnection(request);
  await mockReply(request, { reply: 'Profiled.' });
  page.on('dialog', (dialog) => void dialog.accept());

  await page.goto('/');
  const name = uniqueName('Pia', testInfo);
  await importCards(page, [{ name: 'pia', card: { v3: v3Card(name) } }]);

  // Save the current connection as a profile; SillyTavern's name suggestion comes first.
  await openPanel(page, 'Connection');
  await page.getByRole('button', { name: 'Save as a new profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as a new profile' });
  await expect(dialog.getByLabel('Profile name')).toHaveValue(/^custom mock-model - /);
  await expect(dialog.getByText('mock-model', { exact: true })).toBeVisible();
  await dialog.getByLabel('Profile name').fill('E2E mock');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('combobox', { name: 'Connection profile' })).toHaveValue(/.+/);

  // Another model, then back through the profile.
  const model = page.getByLabel('Model');
  await model.fill('mock-model-large');
  await model.press('Tab');
  await page.getByRole('combobox', { name: 'Connection profile' }).selectOption({ label: 'No profile' });
  await page.getByRole('combobox', { name: 'Connection profile' }).selectOption({ label: 'E2E mock' });
  await expect(page.getByText('Profile “E2E mock” applied.')).toBeVisible();
  await expect(model).toHaveValue('mock-model');
  await page.getByRole('button', { name: 'Close' }).click();

  await clearMockRequests(request);
  await send(page, 'Which model?');
  await expect(messages(page).nth(2)).toContainText('Profiled.');
  const [generation] = await mockRequests(request);
  expect(generation!.body.model).toBe('mock-model');

  // Delete it again.
  await openPanel(page, 'Connection');
  await page.getByRole('combobox', { name: 'Connection profile' }).selectOption({ label: 'E2E mock' });
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await expect(page.getByRole('combobox', { name: 'Connection profile' })).toHaveValue('');
});
