import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { cardPng, v2Card } from './fixtures.ts';
import { isMobile, messages, openPanel, uniqueName } from './helpers.ts';
import { storedZip } from './zip.ts';

test('imports a SillyTavern backup with chats, lorebooks, presets and settings', async ({
  page,
}, testInfo) => {
  // Imported settings are shared by every test on the server: one project is enough.
  test.skip(isMobile(page), 'covered on desktop');
  const name = uniqueName('Kai', testInfo).replace(/\W+/g, '');
  const book = `${name} lore`;
  const script = `${name} script`;
  const chatLines = [
    { user_name: 'User', character_name: name, create_date: '2026-01-01@10h00m00s', chat_metadata: {} },
    {
      name,
      is_user: false,
      is_system: false,
      send_date: 'January 1, 2026 10:00am',
      mes: 'The lighthouse is quiet tonight.',
      swipes: ['The lighthouse is quiet tonight.'],
      swipe_id: 0,
      extra: {},
    },
    {
      name: 'User',
      is_user: true,
      is_system: false,
      send_date: 'January 1, 2026 10:01am',
      mes: 'Any ships?',
      extra: {},
    },
  ];
  const backup = storedZip([
    { path: `characters/${name}.png`, data: cardPng({ v2: v2Card(name) }) },
    {
      path: `chats/${name}/${name} - 2026-01-01@10h00m00s.jsonl`,
      data: chatLines.map((l) => JSON.stringify(l)).join('\n'),
    },
    {
      path: `worlds/${book}.json`,
      data: JSON.stringify({ entries: { 0: { uid: 0, key: [`${name}-never`], content: 'Unused.' } } }),
    },
    { path: `OpenAI Settings/${name} preset.json`, data: JSON.stringify({ temp_openai: 0.65 }) },
    {
      path: 'settings.json',
      data: JSON.stringify({
        world_info_settings: { world_info: { globalSelect: [book] } },
        extension_settings: {
          regex: [{ id: `${name}-r`, scriptName: script, findRegex: `/${name}-never/g`, replaceString: '' }],
        },
      }),
    },
    { path: 'backgrounds/sea.jpg', data: 'not really a picture' },
  ]);

  await page.goto('/');
  await page.getByRole('region', { name: 'Chat', exact: true }).waitFor();
  await openPanel(page, 'Settings');
  await page.locator('input[type=file][accept*=".zip"]').setInputFiles({
    name: 'sillytavern-backup.zip',
    mimeType: 'application/zip',
    buffer: backup,
  });
  const report = page.getByRole('status').filter({ hasText: 'Imported' });
  await expect(report).toContainText('Imported 1 characters, 1 chats, 1 lorebooks, 1 presets');
  await expect(report).toContainText('1 backgrounds');
  await expect(page.getByText('SillyTavern settings applied.')).toBeVisible();

  // The settings arrived: the lorebook is global, the regex script is listed.
  await page.getByRole('tab', { name: 'World Info' }).click();
  await expect(page.getByRole('checkbox', { name: `Use ${book} in all chats` })).toBeChecked();
  await page.getByRole('tab', { name: 'Regex' }).click();
  await expect(page.getByRole('button', { name: script })).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();

  // Everything goes back out as a SillyTavern folder.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export for SillyTavern' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('sillytavern-data.zip');
  const exported = readFileSync((await download.path())!);
  // Entry names are stored uncompressed in a zip.
  for (const path of [
    `characters/${name}.png`,
    `chats/${name}/${name} - 2026-01-01@10h00m00s.jsonl`,
    `worlds/${book}.json`,
    'settings.json',
  ]) {
    expect(exported.includes(Buffer.from(path)), path).toBe(true);
  }

  // The character opens with its imported chat.
  await page.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('navigation', { name: 'Characters' }).getByRole('button', { name }).first().click();
  await expect(messages(page).first()).toContainText('The lighthouse is quiet tonight.');
  await expect(messages(page).nth(1)).toContainText('Any ships?');
});
