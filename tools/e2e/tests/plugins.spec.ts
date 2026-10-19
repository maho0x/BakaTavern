import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  composer,
  importCards,
  messages,
  mockReply,
  mockRequests,
  openPanel,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

/** A plugin as an author writes it (plain ES module, default export). */
const plugin = (id: string, name: string) => `
export default {
  id: '${id}',
  name: '${name}',
  version: '1.2.0',
  description: 'A plugin for the tests.',
  permissions: ['commands', 'prompt', 'ui', 'chat'],
  activate(ctx) {
    ctx.commands.register({ name: 'shout', callback: (_args, value) => String(value).toUpperCase() });
    ctx.macros.register('plugin_greeting', () => 'Hello from a plugin');
    ctx.prompt.inject('note', { content: '[Plugin note]', position: 'in_chat', depth: 0 });
    ctx.prompt.hooks({ afterResponse: (text) => text + ' (checked)' });
    ctx.ui.messageAction({
      label: 'Count words',
      onClick: (index) => ctx.ui.toast('Words: ' + ctx.chat.messages()[index].text.split(/\\s+/).length),
    });
    ctx.ui.settings((element) => {
      ctx.storage.set('opened', (ctx.storage.get('opened') ?? 0) + 1);
      element.textContent = 'Echo Tools settings';
    });
    return () => ctx.ui.toast('${name} stopped');
  },
};
`;

test.beforeEach(async ({ request }) => {
  await useMockConnection(request);
  await mockReply(request, {});
  await clearMockRequests(request);
});

test('a plugin adds commands, macros, prompt changes and menu entries, and goes away when off', async ({
  page,
  request,
}, testInfo) => {
  const name = uniqueName('Plugged', testInfo);
  const id = `echo-${testInfo.project.name}`;
  const tools = `Echo Tools ${testInfo.project.name}`;
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto('/');
  await importCards(page, [{ name: 'plugged', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);

  await openPanel(page, 'Plugins');
  const panel = page.getByRole('tabpanel');
  await panel.locator('input[type=file]').setInputFiles({
    name: 'echo.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from(plugin(id, tools)),
  });
  await expect(page.locator('.toast').filter({ hasText: 'Plugin installed.' })).toBeVisible();
  const card = panel.getByRole('region', { name: tools });
  await expect(card).toContainText('1.2.0');
  await expect(card).toContainText('Add STscript commands and macros');
  await expect(card).toContainText('Echo Tools settings');
  await page.getByRole('button', { name: 'Close' }).click();

  // A command and a macro.
  await composer(page).fill('/shout hello | /echo {{pipe}} {{plugin_greeting}}');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'HELLO Hello from a plugin' })).toBeVisible();

  // An injection reaches the prompt, and the reply passes the plugin's hook.
  await mockReply(request, { reply: 'Fine.' });
  await composer(page).fill('How are you?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(messages(page).last()).toContainText('Fine. (checked)');
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('[Plugin note]');

  // An entry in the message menu.
  await messages(page).nth(1).getByRole('button', { name: 'Message options' }).click();
  await page.getByRole('menuitem', { name: 'Count words' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Words: 3' })).toBeVisible();

  // Off: what it registered is gone.
  await openPanel(page, 'Plugins');
  await page
    .getByRole('tabpanel')
    .getByRole('checkbox', { name: `Enabled: ${tools}` })
    .uncheck();
  await expect(page.locator('.toast').filter({ hasText: `${tools} stopped` })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await composer(page).fill('/shout again');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.toast').filter({ hasText: /Unknown command/ })).toBeVisible();

  await openPanel(page, 'Plugins');
  await page
    .getByRole('tabpanel')
    .getByRole('button', { name: `Uninstall: ${tools}` })
    .click();
  await expect(page.getByRole('tabpanel').getByRole('region', { name: tools })).toHaveCount(0);
});
