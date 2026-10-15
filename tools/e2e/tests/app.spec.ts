import { expect, test } from '@playwright/test';

test('a new user gets SillyTavern’s Default preset', async ({ page, request }) => {
  await page.goto('/');
  await expect
    .poll(async () =>
      ((await (await request.get('/api/presets')).json()) as { kind: string; name: string }[]).map(
        (p) => `${p.kind}/${p.name}`,
      ),
    )
    .toContain('openai/Default');
});

test('the app shell opens offline once installed', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The first load happened before the worker took control; load once more through it.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Cannot reach the BakaTavern server.')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
});
