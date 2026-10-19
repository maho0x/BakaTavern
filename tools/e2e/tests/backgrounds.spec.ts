import { expect, test } from '@playwright/test';

import { cardPng, v3Card } from './fixtures.ts';
import { composer, importCards, messages, uniqueName } from './helpers.ts';

test('a background picture shows behind the chat, everywhere or in one chat', async ({ page }, testInfo) => {
  const name = uniqueName('Backdrop', testInfo);
  const picture = `dusk-${testInfo.project.name}.png`;
  await page.goto('/');
  await importCards(page, [{ name: 'backdrop', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);
  const pane = page.getByRole('region', { name: 'Chat', exact: true });

  await page.getByRole('button', { name: 'Chat options' }).click();
  await page.getByRole('menuitem', { name: 'Background' }).click();
  const dialog = page.getByRole('dialog', { name: 'Background' });
  await dialog.locator('input[type=file]').setInputFiles({
    name: picture,
    mimeType: 'image/png',
    buffer: cardPng({}, [40, 60, 120]),
  });
  await dialog.getByRole('button', { name: picture, exact: true }).click();
  await expect(pane).toHaveClass(/with-bg/);
  await expect(pane).toHaveAttribute('style', /--bt-chat-bg: url\("\/api\/files\//);

  // Locked to this chat, it stays when the usual background goes.
  await dialog.getByRole('button', { name: `Use in this chat only: ${picture}` }).click();
  await dialog.getByRole('button', { name: 'No background' }).click();
  await expect(pane).toHaveClass(/with-bg/);
  await dialog.getByRole('button', { name: 'Use the usual background in this chat' }).click();
  await expect(pane).not.toHaveClass(/with-bg/);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The same through STscript.
  await composer(page).fill(`/bg ${picture.slice(0, 8)} | /bg | /echo Now: {{pipe}}`);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.toast').filter({ hasText: `Now: ${picture}` })).toBeVisible();
  await expect(pane).toHaveClass(/with-bg/);
});
