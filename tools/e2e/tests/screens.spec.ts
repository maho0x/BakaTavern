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
