import { expect, test } from '@playwright/test';

import { v3Card } from './fixtures.ts';
import {
  clearMockRequests,
  importCards,
  isMobile,
  messages,
  mockReply,
  mockRequests,
  openPanel,
  send,
  uniqueName,
  useMockConnection,
} from './helpers.ts';

test('the model calls a tool and answers with its result', async ({ page, request }, testInfo) => {
  // The preset is shared by every test on the server: one project.
  test.skip(isMobile(page), 'covered on desktop');
  await useMockConnection(request);
  await mockReply(request, {
    reply: 'You rolled a 4.',
    toolCall: { name: 'roll_dice', arguments: { sides: 6 } },
  });

  await page.goto('/');
  const name = uniqueName('Dee', testInfo);
  await importCards(page, [{ name: 'dee', card: { v3: v3Card(name) } }]);
  await page.evaluate(() => {
    const page = window as unknown as { BakaTavern: { tools: { register(tool: object): void } } };
    page.BakaTavern.tools.register({
      name: 'roll_dice',
      displayName: 'Roll dice',
      description: 'Rolls a die.',
      parameters: { type: 'object', properties: { sides: { type: 'number' } }, required: ['sides'] },
      action: (p: Record<string, unknown>) => `rolled ${p.sides === 6 ? 4 : 0}`,
    });
  });

  await openPanel(page, 'Connection');
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByRole('checkbox', { name: 'Let the model call tools (function calling)' }).check();
  await page.getByRole('button', { name: 'Close' }).click();

  await clearMockRequests(request);
  await send(page, 'Roll a d6 for me.');
  await expect(messages(page).nth(3)).toContainText('You rolled a 4.');
  // The calls are recorded in a hidden message between the request and the answer.
  await expect(messages(page).nth(2)).toContainText('Tool calls: Roll dice');

  const [first, second] = await mockRequests(request);
  expect(first!.body.tools).toEqual([
    {
      type: 'function',
      function: {
        name: 'roll_dice',
        description: 'Rolls a die.',
        parameters: { type: 'object', properties: { sides: { type: 'number' } }, required: ['sides'] },
      },
    },
  ]);
  const tail = second!.body.messages!.slice(-2);
  expect(tail[0]).toMatchObject({
    role: 'assistant',
    tool_calls: [{ type: 'function', function: { name: 'roll_dice', arguments: '{"sides":6}' } }],
  });
  expect(tail[1]).toMatchObject({ role: 'tool', content: 'rolled 4' });

  // Back to no tools for the other tests.
  await mockReply(request, { reply: null });
  await openPanel(page, 'Connection');
  await page.getByRole('tab', { name: 'Preset' }).click();
  await page.getByRole('checkbox', { name: 'Let the model call tools (function calling)' }).uncheck();
});
