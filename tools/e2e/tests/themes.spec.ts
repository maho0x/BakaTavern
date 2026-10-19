import { expect, test } from '@playwright/test';

import { openPanel } from './helpers.ts';

test('a SillyTavern theme recolors the app and can be switched off', async ({ page }, testInfo) => {
  const name = `Cappuccino ${testInfo.project.name}`;
  await page.goto('/');
  await openPanel(page, 'Settings');
  const panel = page.getByRole('tabpanel');
  await panel
    .locator('input[type=file][accept=".json,application/json"]')
    .first()
    .setInputFiles({
      name: 'Cappuccino.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          name,
          main_text_color: 'rgba(235, 235, 235, 1)',
          quote_text_color: 'rgba(165, 140, 115, 1)',
          chat_tint_color: 'rgba(50, 45, 50, 0.75)',
          blur_tint_color: 'rgba(34, 30, 32, 0.95)',
          font_scale: 1.1,
          custom_css: '',
        }),
      ),
    });
  await expect(page.locator('.toast').filter({ hasText: `Theme “${name}” applied.` })).toBeVisible();
  const token = (property: string) =>
    page.evaluate((p) => document.documentElement.style.getPropertyValue(p), property);
  await expect.poll(() => token('--bt-bg')).toBe('rgb(50, 45, 50)');
  await expect.poll(() => token('--bt-dialogue')).toBe('rgba(165, 140, 115, 1)');
  await expect.poll(() => token('--bt-text-scale')).toBe('1.1');

  await panel.getByRole('combobox', { name: 'Colors' }).selectOption('');
  await expect.poll(() => token('--bt-bg')).toBe('');
  // The theme's text size stays; back to the usual one for the tests that follow.
  await panel.getByRole('slider', { name: /^Text size/ }).fill('1');
  await expect.poll(() => token('--bt-text-scale')).toBe('1');
});
