/**
 * Records the request SillyTavern sends to the model for each scenario into `baseline/<id>.json`.
 * Needs Docker and a Chromium for Playwright (or PW_CHROMIUM_PATH).
 *
 * Usage: node src/record.ts [scenario-id ...]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import { createMockServer } from '../../mock-llm/src/server.ts';
import { scenarios, type Scenario } from './scenarios.ts';
import { scenarioChat, writeStData } from './st-data.ts';

export const ST_IMAGE = process.env.ST_IMAGE ?? 'ghcr.io/sillytavern/sillytavern:1.19.0';
const ST_PORT = Number(process.env.ST_PORT ?? 8010);

/** The part of SillyTavern's `getContext()` the recorder uses. */
interface StContext {
  characters: { avatar: string }[];
  chat: unknown[];
  chatMetadata: Record<string, unknown>;
  onlineStatus: string;
  eventSource: { on(event: string, listener: () => void): void };
  eventTypes: { APP_READY: string } & Record<string, string>;
  selectCharacterById(id: number): Promise<void>;
  generate(type: string): Promise<unknown>;
}

declare global {
  interface Window {
    SillyTavern?: { getContext(): StContext };
  }
}
const CONTAINER = 'bt-st-diff';
const baselineDir = resolve(import.meta.dirname, '../baseline');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readFromImage = (path: string) => docker('run', '--rm', '--entrypoint', 'cat', ST_IMAGE, path);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

async function trigger(page: Page, scenario: Scenario) {
  if (scenario.type === 'normal') {
    // SillyTavern resets the input box asynchronously after opening a chat: fill it until it sticks.
    const input = page.locator('#send_textarea');
    for (let i = 0; i < 20 && (await input.inputValue()) !== scenario.input; i++) {
      await input.fill(scenario.input ?? '');
      await sleep(250);
    }
    if ((await input.inputValue()) !== scenario.input) throw new Error('could not fill the input box');
    await page.locator('#send_but').click();
  } else {
    // Not awaited: the reply arrives through the mock, and saving it is not part of the test.
    await page.evaluate((type) => void window.SillyTavern!.getContext().generate(type), scenario.type);
  }
}

async function recordScenario(
  scenario: Scenario,
  mock: ReturnType<typeof createMockServer>,
  mockUrl: string,
  base: { settings: Record<string, unknown>; preset: Record<string, unknown> },
) {
  const root = mkdtempSync(join(tmpdir(), `st-diff-${scenario.id}-`));
  const [config, data] = [join(root, 'config'), join(root, 'data')];
  mkdirSync(config);
  writeStData(data, scenario, base.settings, base.preset, mockUrl);
  docker('rm', '-f', CONTAINER);
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--network',
    'host',
    ...(user ? ['--user', user] : []),
    '-v',
    `${config}:/home/node/app/config`,
    '-v',
    `${data}:/home/node/app/data`,
    ST_IMAGE,
    '--port',
    String(ST_PORT),
  );
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH || undefined });
  try {
    await waitForHttp(`http://127.0.0.1:${ST_PORT}/`);
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.warn(`  [${scenario.id}] page error: ${e.message}`));
    if (process.env.ST_DIFF_DEBUG)
      page.on('console', (m) => console.log(`  [console] ${m.type()} ${m.text().slice(0, 300)}`));
    await page.goto(`http://127.0.0.1:${ST_PORT}/`);
    const avatar = `${scenario.card.name}.png`;
    await page.waitForFunction(
      (avatar) => window.SillyTavern?.getContext?.().characters?.some((c) => c.avatar === avatar),
      avatar,
      { timeout: 60_000 },
    );
    // Extensions (Author's Note, ...) hook into chat changes during startup: wait until it ends.
    // APP_READY is re-fired for listeners registered after it happened.
    await page.evaluate(async () => {
      const ctx = window.SillyTavern!.getContext();
      await new Promise<void>((resolve) => ctx.eventSource.on(ctx.eventTypes.APP_READY, () => resolve()));
    });
    await page.evaluate(async (avatar) => {
      const ctx = window.SillyTavern!.getContext();
      await ctx.selectCharacterById(ctx.characters.findIndex((c) => c.avatar === avatar));
    }, avatar);
    const expected = scenarioChat(scenario).length;
    await page.waitForFunction((n) => window.SillyTavern!.getContext().chat.length === n, expected, {
      timeout: 30_000,
    });
    // Connect (the status check also goes to the mock).
    await page.evaluate(() => (document.querySelector('#api_button_openai') as HTMLElement | null)?.click());
    await page.waitForFunction(
      () => window.SillyTavern!.getContext().onlineStatus !== 'no_connection',
      null,
      {
        timeout: 30_000,
      },
    );
    await sleep(1000);
    if (process.env.ST_DIFF_DEBUG) {
      console.log(
        '  [state]',
        await page.evaluate(() => ({
          box: (document.querySelector('#extension_floating_prompt') as HTMLTextAreaElement | null)?.value,
          meta: window.SillyTavern!.getContext().chatMetadata,
        })),
      );
    }
    mock.requests.length = 0;
    await trigger(page, scenario);
    const deadline = Date.now() + 30_000;
    while (!mock.requests.some((r) => r.method === 'POST')) {
      if (Date.now() > deadline) throw new Error(`no request for ${scenario.id}`);
      await sleep(100);
    }
    if (process.env.ST_DIFF_DEBUG) {
      await sleep(3000);
      for (const r of mock.requests) {
        const messages = (r.body as { messages?: { content: string }[] } | null)?.messages;
        console.log(
          `  [mock] ${r.method} ${r.path} last: ${JSON.stringify(messages?.at(-1))?.slice(0, 120)}`,
        );
      }
    }
    const request = mock.requests.find((r) => r.method === 'POST')!;
    return { path: request.path, body: request.body };
  } finally {
    await browser.close();
    if (process.env.ST_DIFF_KEEP) console.log(`  kept ${root}`);
    else docker('rm', '-f', CONTAINER);
    if (!process.env.ST_DIFF_KEEP) rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const only = process.argv.slice(2);
  const selected = only.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios;
  const base = {
    settings: JSON.parse(readFromImage('/home/node/app/default/content/settings.json')) as Record<
      string,
      unknown
    >,
    preset: JSON.parse(readFromImage('/home/node/app/default/content/presets/openai/Default.json')) as Record<
      string,
      unknown
    >,
  };
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, '_default-preset.json'), JSON.stringify(base.preset, null, 2) + '\n');

  const mock = createMockServer({ reply: 'OK', delayMs: 0 });
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));
  const mockUrl = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}/v1`;
  try {
    for (const scenario of selected) {
      process.stdout.write(`${scenario.id} … `);
      const request = await recordScenario(scenario, mock, mockUrl, base);
      const baseline = {
        scenario: scenario.id,
        image: ST_IMAGE,
        recordedAt: new Date().toISOString(),
        request,
      };
      writeFileSync(join(baselineDir, `${scenario.id}.json`), JSON.stringify(baseline, null, 2) + '\n');
      console.log('recorded');
    }
  } finally {
    mock.server.close();
  }
}

await main();
