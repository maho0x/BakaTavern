// Screenshots of the main screens for design review: SCREENS=<dir> pnpm e2e screens.spec.ts
import { test } from '@playwright/test';

import { v2Card } from './fixtures.ts';
import { importCards, mockReply, send, uniqueName, useMockConnection } from './helpers.ts';

const dir = process.env.SCREENS;

test.skip(!dir, 'set SCREENS to a directory to capture screenshots');

for (const scheme of ['dark', 'light'] as const) {
  test(`screens (${scheme})`, async ({ page, request }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await useMockConnection(request);
    page.on('dialog', (d) => void d.accept());
    const shot = (name: string) =>
      page.screenshot({ path: `${dir}/${testInfo.project.name}-${scheme}-${name}.png` });

    await page.goto('/');
    await shot('1-welcome');
    const name = uniqueName(`Aiko ${scheme}`, testInfo);
    await importCards(page, [{ name: 'aiko', card: { v2: v2Card(name) } }]);
    await mockReply(request, {
      reply:
        '*Aiko sets down a steaming cup.* "Two matcha lattes, coming up!"\n\nShe hums while she works, glancing at the rain. "You picked a good night to stay in."',
      reasoning: 'The user asked about the menu; recommend the matcha.',
    });
    await send(page, 'What is on the menu today?');
    await page.getByText('You picked a good night').waitFor();
    await shot('2-chat');
    await page.getByRole('button', { name: 'Connection' }).first().click();
    await shot('3-connection');
    await page.getByRole('tab', { name: 'Preset' }).click();
    await shot('4-preset');
    await page.getByRole('tab', { name: 'World Info' }).click();
    await shot('5-worldinfo');
    await page.getByRole('button', { name: new RegExp(`^${name}'s café`) }).click();
    const lorebook = page.getByRole('dialog', { name: `${name}'s café` });
    await lorebook
      .getByRole('button', { name: /^By keywords/ })
      .first()
      .click();
    await shot('5b-lorebook-editor');
    await lorebook.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('tab', { name: 'Regex' }).click();
    const global = page.locator('section', { has: page.getByRole('heading', { name: 'Global scripts' }) });
    await global.getByRole('button', { name: 'New script' }).click();
    const editor = page.getByRole('dialog', { name: 'Regex script' });
    await editor.getByLabel('Name', { exact: true }).fill('Narration in italics');
    await editor.getByLabel('Find', { exact: true }).fill('/\\((.+?)\\)/g');
    await editor.getByLabel('Replace with', { exact: true }).fill('*$1*');
    await editor.getByText('Try it').click();
    await editor.getByLabel('Text', { exact: true }).fill('(She smiles.) Hello!');
    await shot('6-regex-editor');
    await editor.getByRole('button', { name: 'Save' }).click();
    await shot('7-regex');
  });
}

test('group screens', async ({ page, request }, testInfo) => {
  await useMockConnection(request);
  const shot = (name: string) =>
    page.screenshot({ path: `${dir}/${testInfo.project.name}-group-${name}.png` });
  await page.goto('/');
  const names = ['Aiko', 'Ren', 'Mei'].map((n) => uniqueName(`${n} group`, testInfo));
  await importCards(
    page,
    names.map((name, i) => ({ name: `member${i}`, card: { v2: v2Card(name) } })),
  );
  if ((page.viewportSize()?.width ?? 1280) < 900)
    await page.getByRole('button', { name: 'Characters' }).first().click();
  await page.getByRole('button', { name: 'New group' }).click();
  const editor = page.getByRole('dialog', { name: 'New group' });
  await editor.getByLabel('Name', { exact: true }).fill(uniqueName('Moonlit regulars', testInfo));
  for (const name of names) {
    await editor.getByRole('searchbox', { name: 'Search characters' }).fill(name);
    await editor.getByRole('button', { name }).click();
  }
  await editor.getByRole('searchbox', { name: 'Search characters' }).fill('');
  await editor.getByLabel('Who replies').selectOption({ label: 'Every member, in order' });
  await editor.getByLabel('Character cards in the prompt').selectOption({ index: 1 });
  await shot('1-editor');
  await editor.getByRole('button', { name: 'Create group' }).click();
  await mockReply(request, {
    replies: ['*She slides two cups across.* "Tea for you."', 'Coffee. Black.', '"I saved you a croissant."'],
  });
  await send(page, 'Evening, everyone.');
  await page.getByText('I saved you a croissant').waitFor();
  await shot('2-chat');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await shot('3-members');
});
