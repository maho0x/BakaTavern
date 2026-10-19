import { expect, test } from '@playwright/test';

import { cardPng, v3Card } from './fixtures.ts';
import { mockUrl, uniqueName } from './helpers.ts';

test('imports a character card from a URL', async ({ page, request }, testInfo) => {
  const name = uniqueName('Rin', testInfo);
  const path = `/cards/${testInfo.project.name}-${testInfo.workerIndex}.png`;
  await request.post(`${mockUrl}/__files`, {
    data: { [path]: { type: 'image/png', base64: cardPng({ v3: v3Card(name) }).toString('base64') } },
  });
  // `localhost` is one of the hosts plain card files may come from, as in SillyTavern.
  const address = mockUrl.replace('127.0.0.1', 'localhost') + path;

  await page.goto('/');
  await page.getByRole('region', { name: 'Chat', exact: true }).waitFor();
  const button = page.getByRole('button', { name: 'Import from a URL' }).first();
  // On phones the library may be behind its button.
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'Characters' }).first().click();
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Import from a URL' });
  await dialog.getByLabel('Addresses or ids, one per line').fill(`${address}\nhttps://example.com/nope.png`);
  await dialog.getByRole('button', { name: 'Import' }).click();

  // The card arrives and opens; the address that cannot be imported stays in the box.
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).getByText(name).first()).toBeVisible();
  await expect(page.getByText('Could not import https://example.com/nope.png')).toBeVisible();
  await expect(dialog.getByLabel('Addresses or ids, one per line')).toHaveValue(
    'https://example.com/nope.png',
  );
});
