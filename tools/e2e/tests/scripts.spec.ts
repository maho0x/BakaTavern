import { expect, test, type Page } from '@playwright/test';

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

test.beforeEach(async ({ request }) => {
  await useMockConnection(request);
  await mockReply(request, {});
  await clearMockRequests(request);
});

/** Types a script into the message box and runs it. */
async function run(page: Page, script: string) {
  await composer(page).fill(script);
  await page.getByRole('button', { name: 'Send' }).click();
}

const toast = (page: Page, text: string | RegExp) => page.locator('.toast').filter({ hasText: text });

test('scripts typed into the message box run as STscript', async ({ page, request }, testInfo) => {
  const name = uniqueName('Scripted', testInfo);
  await page.goto('/');
  await importCards(page, [{ name: 'scripted', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);

  // Variables, pipes and macros; nothing is sent to the model.
  await run(page, '/setvar key=score 5 | /addvar key=score 3 | /getvar score | /echo Score: {{pipe}}');
  await expect(toast(page, 'Score: 8')).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  expect(await mockRequests(request)).toHaveLength(0);

  // Messages from scripts.
  await run(page, `/send Hello from the script | /sendas name="${name}" Hello back | /sys The rain stops.`);
  await expect(messages(page)).toHaveCount(4);
  await expect(messages(page).nth(1)).toContainText('Hello from the script');
  await expect(messages(page).nth(2)).toContainText('Hello back');
  await expect(messages(page).nth(3)).toContainText('The rain stops.');
  await run(page, '/hide 3 | /messages names=off 1-3');
  await expect(messages(page).nth(3)).toHaveClass(/hidden/);

  // A background generation, its result put into the box.
  await mockReply(request, { reply: 'A quiet answer.' });
  await run(page, '/gen Summarize the chat. | /setinput');
  await expect(composer(page)).toHaveValue('A quiet answer.');
  const [quiet] = await mockRequests(request);
  expect(JSON.stringify(quiet!.body.messages)).toContain('Summarize the chat.');
  expect(quiet!.body.stream).toBe(false);
  await composer(page).fill('');

  // Dialogs wait for the user.
  await run(page, '/input default=Mika What is your name? | /echo Hi {{pipe}}');
  const dialog = page.getByRole('dialog', { name: 'Script' });
  await expect(dialog.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Mika');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(toast(page, 'Hi Mika')).toBeVisible();
  await run(page, '/buttons labels=["Tea","Coffee"] Pick one | /echo Picked {{pipe}}');
  await page.getByRole('dialog', { name: 'Script' }).getByRole('button', { name: 'Coffee' }).click();
  await expect(toast(page, 'Picked Coffee')).toBeVisible();

  // Injections reach the next prompt.
  await clearMockRequests(request);
  await mockReply(request, { reply: 'Noted.' });
  await run(page, '/inject id=mood position=chat depth=0 [It is snowing.]');
  await composer(page).fill('What is the weather?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(messages(page).last()).toContainText('Noted.');
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('[It is snowing.]');

  // Errors are reported, not thrown.
  await run(page, '/no-such-command');
  await expect(toast(page, /Unknown command/)).toBeVisible();
});

test('Quick Replies run scripts from buttons', async ({ page }, testInfo) => {
  const name = uniqueName('Quick', testInfo);
  const set = uniqueName('Tools', testInfo).replace(/\s/g, '_');
  await page.goto('/');
  await importCards(page, [{ name: 'quick', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);

  // A set made by a script, shown everywhere.
  await run(
    page,
    `/qr-set-create ${set} | /qr-create set=${set} label=Greet /echo Greetings from {{arg::who}} | /qr-arg who friend | /qr-set-on ${set}`,
  );
  const button = page.getByRole('toolbar', { name: 'Quick Replies' }).getByRole('button', { name: 'Greet' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(toast(page, 'Greetings from')).toBeVisible();

  // /run calls it by name with arguments.
  await run(page, '/run who=Ren Greet');
  await expect(toast(page, 'Greetings from Ren')).toBeVisible();

  // The panel lists the set and edits its replies.
  await openPanel(page, 'Quick Replies');
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('combobox', { name: 'Set to edit' }).selectOption(set);
  await expect(panel.getByRole('textbox', { name: 'Label' }).first()).toHaveValue('Greet');
  await panel.getByRole('textbox', { name: 'Label' }).first().fill('Wave');
  await expect(
    page.getByRole('toolbar', { name: 'Quick Replies' }).getByRole('button', { name: 'Wave' }),
  ).toBeVisible();
});

test('commands reach World Info, notes, tags, personas and checkpoints', async ({
  page,
  request,
}, testInfo) => {
  const name = uniqueName('Keeper', testInfo);
  await page.goto('/');
  await importCards(page, [{ name: 'keeper', card: { v3: v3Card(name) } }]);
  await expect(messages(page)).toHaveCount(1);

  // A chat lorebook made by a script, with an entry written and read back.
  await run(
    page,
    '/getchatbook | /setvar key=book {{pipe}} | /createentry file={{getvar::book}} key=dragon A red dragon. | ' +
      '/setentryfield file={{getvar::book}} uid={{pipe}} field=keysecondary wyrm,drake | ' +
      '/setentryfield file={{getvar::book}} uid=0 A red dragon.\\{\\{setglobalvar::seen::dragon\\}\\} | ' +
      '/findentry file={{getvar::book}} dragon | /getentryfield file={{getvar::book}} field=keysecondary {{pipe}} | ' +
      '/echo Keys: {{pipe}}',
  );
  await expect(toast(page, 'Keys: ["wyrm","drake"]')).toBeVisible();
  await mockReply(request, { reply: 'Roar.' });
  await clearMockRequests(request);
  await composer(page).fill('Tell me about the dragon, the old wyrm.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(messages(page).last()).toContainText('Roar.');
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('A red dragon.');
  // Macros in the prompt keep what they set.
  await run(page, '/getglobalvar seen | /echo Seen: {{pipe}}');
  await expect(toast(page, 'Seen: dragon')).toBeVisible();

  // Author's Note settings.
  await run(
    page,
    '/note Keep it short. | /note-depth 2 | /note-position chat | /note-role user | /echo Role: {{pipe}}',
  );
  await expect(toast(page, 'Role: user')).toBeVisible();

  // Tags on the open character.
  await run(page, '/tag-add Hero | /tag-exists Hero | /echo Tagged: {{pipe}}');
  await expect(toast(page, 'Tagged: true')).toBeVisible();

  // A temporary name for the user.
  await run(page, '/persona-set mode=temp Wanderer | /send I arrive.');
  await expect(messages(page).last()).toContainText('Wanderer');

  // A checkpoint at the last message.
  await run(page, '/checkpoint-create Before the dragon | /checkpoint-list | /echo Checkpoints: {{pipe}}');
  await expect(toast(page, /Checkpoints: \[\d+\]/)).toBeVisible();

  // Help lists the commands.
  await run(page, '/?');
  const help = page.getByRole('dialog', { name: 'STscript commands' });
  await expect(help).toContainText('/createentry');
  await help.getByRole('button', { name: 'OK' }).click();
});
