import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

/**
 * Front-end cards (TavernHelper / 酒馆助手) in safe mode: pages in sandboxed frames that read and
 * change the chat through TavernHelper's functions, and scripts that run beside them. The five
 * cards follow the patterns popular cards use: a status bar fed by an MVU-style script, an
 * interactive panel, a page built on SillyTavern's context, a lorebook-keeping page and a page
 * that asks the model itself.
 */

/** A message's code block holding a page. */
const page = (body: string) => `\`\`\`html\n<!DOCTYPE html>\n<html><body>\n${body}\n</body></html>\n\`\`\``;

function card(name: string, firstMessage: string, extensions: Record<string, unknown> = {}) {
  const base = v3Card(name);
  return { v3: { ...base, data: { ...base.data, first_mes: firstMessage, extensions } } };
}

/** The `n`th page in the chat. */
const frame = (p: Page, n = 0) => p.frameLocator('iframe.frontend').nth(n);

async function settingsFor(request: APIRequestContext) {
  // CDN libraries stay out (no network in tests).
  const response = await request.put('/api/settings/frontend', {
    headers: { 'x-bt-client': '1' },
    data: { data: { enabled: true, cdn: false } },
  });
  expect(response.ok()).toBeTruthy();
}

test.beforeEach(async ({ request, page: p }) => {
  await useMockConnection(request);
  await settingsFor(request);
  await mockReply(request, {});
  await clearMockRequests(request);
  // Scripts ask before they run.
  p.on('dialog', (dialog) => void dialog.accept());
});

test('a status bar shows what an MVU-style script keeps in message variables', async ({
  page: p,
  request,
}, testInfo) => {
  const name = uniqueName('Status', testInfo);
  const bar = page(`<div id="bar">…</div>
<script>
  function show() {
    const id = getCurrentMessageId();
    const vars = getVariables({ type: 'message', message_id: id });
    document.getElementById('bar').textContent = 'Affection ' + _.get(vars, 'stat_data.affection', 0) + ' at ' + id;
  }
  show();
  eventOn('mag_variable_update_ended', show);
</script>`);
  const mvu = `
eventOn(tavern_events.MESSAGE_RECEIVED, async (id) => {
  const [message] = getChatMessages(id);
  const match = message && message.message.match(/_\\.set\\('([^']+)',\\s*(\\d+)\\)/);
  if (!match) return;
  const before = getVariables({ type: 'message', message_id: id });
  const after = _.cloneDeep(before);
  _.set(after, ['stat_data', match[1]], Number(match[2]));
  replaceVariables(after, { type: 'message', message_id: id });
  await eventEmit('mag_variable_update_ended', after, before);
});
initializeGlobal('Mvu', { events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' } });
replaceScriptButtons([{ name: 'Reset affection', visible: true }]);
eventOnButton('Reset affection', () => {
  insertOrAssignVariables({ reset: true }, { type: 'chat' });
  toastr.success('Affection reset');
});`;
  await p.goto('/');
  await importCards(p, [
    {
      name: 'status',
      card: card(name, `*She waves.*\n${bar}`, {
        tavern_helper: {
          scripts: [
            { type: 'script', enabled: true, name: 'MVU', id: 'mvu-1', content: mvu, info: '', data: {} },
          ],
          variables: {},
        },
      }),
    },
  ]);
  await expect(messages(p)).toHaveCount(1);
  await expect(frame(p).locator('#bar')).toHaveText('Affection 0 at 0');
  // The script runs once allowed (the question is answered above); its button shows then.
  const reset = p
    .getByRole('toolbar', { name: 'Script buttons' })
    .getByRole('button', { name: 'Reset affection' });
  await expect(reset).toBeVisible();

  // The reply carries a command; the script stores it before the reply's page shows.
  await mockReply(request, { reply: `She smiles. _.set('affection', 42)\n${bar}` });
  await composer(p).fill('Hello!');
  await p.getByRole('button', { name: 'Send' }).click();
  await expect(messages(p)).toHaveCount(3);
  await expect(frame(p, 1).locator('#bar')).toHaveText('Affection 42 at 2');

  // Script buttons show above the message box.
  await reset.click();
  await expect(p.locator('.toast').filter({ hasText: 'Affection reset' })).toBeVisible();
});

test('an interactive panel sends a choice and asks for the reply', async ({ page: p, request }, testInfo) => {
  const name = uniqueName('Panel', testInfo);
  await p.goto('/');
  await importCards(p, [
    {
      name: 'panel',
      card: card(
        name,
        `Where to?\n${page(`<button id="north">North</button><button id="south">South</button>
<script>
  for (const id of ['north', 'south']) {
    document.getElementById(id).addEventListener('click', () => triggerSlash('/send I go ' + id + ' | /trigger'));
  }
</script>`)}`,
      ),
    },
  ]);
  await expect(messages(p)).toHaveCount(1);
  await mockReply(request, { reply: 'The north road is cold.' });
  await frame(p).getByRole('button', { name: 'North' }).click();
  await expect(messages(p)).toHaveCount(3);
  await expect(messages(p).nth(1)).toContainText('I go north');
  await expect(messages(p).nth(2)).toContainText('The north road is cold.');
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('I go north');
});

test('a page reads the chat through SillyTavern’s context and writes messages', async ({
  page: p,
}, testInfo) => {
  const name = uniqueName('Context', testInfo);
  await p.goto('/');
  await importCards(p, [
    {
      name: 'context',
      card: card(
        name,
        `Hi.\n${page(`<div id="who"></div><div id="md"></div><button id="add">Add a note</button>
<script>
  const ctx = SillyTavern.getContext();
  document.getElementById('who').textContent = ctx.name2 + ' talks to ' + ctx.name1 + ' (' + ctx.chat.length + ')';
  document.getElementById('md').innerHTML = formatAsDisplayedMessage('**bold** move');
  document.getElementById('add').addEventListener('click', async () => {
    await createChatMessages([{ role: 'system', message: 'A bell rings.' }]);
    await setChatMessages([{ message_id: 0, data: { seen: true } }], { refresh: 'none' });
    const [first] = getChatMessages(0);
    document.getElementById('who').textContent = 'seen ' + first.data.seen + ', ' + getLastMessageId();
  });
</script>`)}`,
      ),
    },
  ]);
  await expect(frame(p).locator('#who')).toHaveText(`${name} talks to User (1)`);
  await expect(frame(p).locator('#md strong')).toHaveText('bold');
  await frame(p).getByRole('button', { name: 'Add a note' }).click();
  await expect(messages(p)).toHaveCount(2);
  await expect(messages(p).nth(1)).toContainText('A bell rings.');
  await expect(frame(p).locator('#who')).toHaveText('seen true, 1');
});

test('a page keeps notes in the chat’s lorebook', async ({ page: p, request }, testInfo) => {
  const name = uniqueName('Keeper', testInfo);
  await p.goto('/');
  await importCards(p, [
    {
      name: 'keeper',
      card: card(
        name,
        `Notes?\n${page(`<button id="save">Remember</button><div id="out"></div>
<script>
  document.getElementById('save').addEventListener('click', async () => {
    const book = await getOrCreateChatWorldbook('current');
    await createWorldbookEntries(book, [{ name: 'Promise', content: 'The user promised to return.', strategy: { type: 'constant' } }]);
    const entries = await getWorldbook(book);
    document.getElementById('out').textContent = entries.length + ' in ' + (getChatWorldbookName('current') === book);
  });
</script>`)}`,
      ),
    },
  ]);
  await frame(p).getByRole('button', { name: 'Remember' }).click();
  await expect(frame(p).locator('#out')).toHaveText('1 in true');
  // The entry reaches the prompt.
  await mockReply(request, { reply: 'I remember.' });
  await composer(p).fill('Do you remember?');
  await p.getByRole('button', { name: 'Send' }).click();
  await expect(messages(p).last()).toContainText('I remember.');
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('The user promised to return.');
});

test('a page asks the model and shows the answer without adding to the chat', async ({
  page: p,
  request,
}, testInfo) => {
  const name = uniqueName('Oracle', testInfo);
  await p.goto('/');
  await importCards(p, [
    {
      name: 'oracle',
      card: card(
        name,
        `Ask me.\n${page(`<button id="ask">Ask</button><div id="answer"></div>
<script>
  let tokens = '';
  eventOn(iframe_events.GENERATION_ENDED, (text) => { tokens = text; });
  document.getElementById('ask').addEventListener('click', async () => {
    const text = await generate({ user_input: 'What is the omen?' });
    document.getElementById('answer').textContent = text + ' / ' + (tokens === text);
  });
</script>`)}`,
      ),
    },
  ]);
  await mockReply(request, { reply: 'Rain by dusk.' });
  await frame(p).getByRole('button', { name: 'Ask' }).click();
  await expect(frame(p).locator('#answer')).toHaveText('Rain by dusk. / true');
  await expect(messages(p)).toHaveCount(1);
  const [sent] = await mockRequests(request);
  expect(JSON.stringify(sent!.body.messages)).toContain('What is the omen?');
});

test('global scripts are written in the panel and run at once', async ({ page: p }, testInfo) => {
  const name = uniqueName('Host', testInfo);
  await p.goto('/');
  await importCards(p, [{ name: 'host', card: card(name, 'Hello.') }]);
  await expect(messages(p)).toHaveCount(1);
  await openPanel(p, 'Front-end');
  const panel = p.getByRole('tabpanel');
  await panel.getByRole('button', { name: 'New script' }).click();
  const label = `Greeter ${testInfo.project.name}`;
  await panel.getByRole('textbox', { name: 'Name' }).fill(label);
  await panel
    .getByRole('textbox', { name: 'Code (JavaScript module)' })
    .fill(`toastr.success('Script says hi to ' + getCurrentCharacterName());`);
  await panel.getByRole('checkbox', { name: `Enabled: ${label}` }).check();
  await expect(p.locator('.toast').filter({ hasText: `Script says hi to ${name}` })).toBeVisible();
  // Turned off again, so other tests run without it.
  await panel.getByRole('checkbox', { name: `Enabled: ${label}` }).uncheck();
});
