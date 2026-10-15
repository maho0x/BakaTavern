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
    await importCards(page, [{ name: 'aiko', card: { v2: v2Card(uniqueName('Aiko', testInfo)) } }]);
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
  });
}
