/**
 * Records the request SillyTavern sends to the model for each scenario into `baseline/<id>.json`.
 * Needs Docker and a Chromium for Playwright (or PW_CHROMIUM_PATH).
 *
 * SillyTavern runs in the network namespace of a small container that serves the mock model API:
 * plain HTTP for the Custom source and reverse proxies, HTTPS for every provider with a fixed host
 * (its /etc/hosts points those hosts at the mock, and SillyTavern accepts the self-signed
 * certificate). Nothing has to listen on the host's own ports 80/443.
 *
 * Usage: node src/record.ts [scenario-id ...]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadStTemplates, type StTemplates } from '@bakatavern/core';
import { chromium, type Page } from '@playwright/test';

import { tokenizePaths, type RecordedRequest } from '../../mock-llm/src/server.ts';
import { interceptedHosts, scenarioModel, scenarios, type Scenario } from './scenarios.ts';
import { scenarioChat, writeStData } from './st-data.ts';

export const ST_IMAGE = process.env.ST_IMAGE ?? 'ghcr.io/sillytavern/sillytavern:1.19.0';
const MOCK_IMAGE = process.env.MOCK_IMAGE ?? 'node:22-alpine';
const ST_PORT = Number(process.env.ST_PORT ?? 8010);
const MOCK_PORT = 5057;
/** The mock as SillyTavern reaches it (same network namespace). */
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
/** The mock as the recorder reaches it (published port). */
const MOCK_CONTROL = `http://127.0.0.1:${MOCK_PORT}`;

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
  registerFunctionTool(tool: Record<string, unknown>): void;
}

declare global {
  interface Window {
    SillyTavern?: { getContext(): StContext };
  }
}
const CONTAINER = 'bt-st-diff';
const NET_CONTAINER = 'bt-st-diff-net';
const toolsDir = resolve(import.meta.dirname, '../..');
const baselineDir = resolve(import.meta.dirname, '../baseline');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readFromImage = (path: string) => docker('run', '--rm', '--entrypoint', 'cat', ST_IMAGE, path);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTimeout<T>(what: string, promise: Promise<T>, ms = 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttp(url: string, timeoutMs = 120_000) {
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

const mock = {
  configure: (state: Record<string, unknown>) =>
    fetch(`${MOCK_CONTROL}/__reply`, { method: 'POST', body: JSON.stringify(state) }),
  clear: () => fetch(`${MOCK_CONTROL}/__requests`, { method: 'DELETE' }),
  requests: async () => (await (await fetch(`${MOCK_CONTROL}/__requests`)).json()) as RecordedRequest[],
};

/** Starts the mock's container, whose network namespace SillyTavern joins. */
async function startMockHost(root: string) {
  const certs = join(root, 'certs');
  mkdirSync(certs);
  // prettier-ignore
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=st-diff mock',
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ], { stdio: 'ignore' });
  docker('rm', '-f', NET_CONTAINER);
  docker(
    'run',
    '-d',
    '--name',
    NET_CONTAINER,
    // SillyTavern's port is published here: it lives in this container's network namespace.
    '-p',
    `127.0.0.1:${ST_PORT}:${ST_PORT}`,
    '-p',
    `127.0.0.1:${MOCK_PORT}:${MOCK_PORT}`,
    ...interceptedHosts.flatMap((host) => ['--add-host', `${host}:127.0.0.1`]),
    '-v',
    `${toolsDir}:/tools:ro`,
    '-v',
    `${certs}:/certs:ro`,
    MOCK_IMAGE,
    'node',
    '/tools/st-diff/src/mock-host.ts',
    '/certs/key.pem',
    '/certs/cert.pem',
  );
  await waitForHttp(`${MOCK_CONTROL}/__requests`);
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
  base: { settings: Record<string, unknown>; preset: Record<string, unknown>; templates: StTemplates },
) {
  const root = mkdtempSync(join(tmpdir(), `st-diff-${scenario.id}-`));
  const [config, data] = [join(root, 'config'), join(root, 'data')];
  mkdirSync(config);
  writeStData(data, scenario, base.settings, base.preset, MOCK_URL, base.templates);
  // The source's model list must offer the scenario's model, or SillyTavern picks another one.
  await mock.configure({ models: [scenarioModel(scenario)] });
  docker('rm', '-f', CONTAINER);
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--network',
    `container:${NET_CONTAINER}`,
    ...(user ? ['--user', user] : []),
    // Requests arrive through the published port, not from 127.0.0.1; this instance only exists
    // for the recording.
    '-e',
    'SILLYTAVERN_WHITELISTMODE=false',
    '-e',
    'SILLYTAVERN_SECURITYOVERRIDE=true',
    // Accept the mock's self-signed certificate for the intercepted provider hosts.
    '-e',
    'NODE_TLS_REJECT_UNAUTHORIZED=0',
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
    await withTimeout(
      'startup',
      page.evaluate(async () => {
        const ctx = window.SillyTavern!.getContext();
        await new Promise<void>((resolve) => ctx.eventSource.on(ctx.eventTypes.APP_READY, () => resolve()));
      }),
    );
    // A popup (a question SillyTavern asks) would keep this from finishing.
    await withTimeout(
      'opening the character',
      page.evaluate(async (avatar) => {
        const ctx = window.SillyTavern!.getContext();
        await ctx.selectCharacterById(ctx.characters.findIndex((c) => c.avatar === avatar));
      }, avatar),
    );
    const expected = scenarioChat(scenario).length;
    await page.waitForFunction((n) => window.SillyTavern!.getContext().chat.length === n, expected, {
      timeout: 30_000,
    });
    // Connect (the status check also goes to the mock).
    const connect = scenario.text ? '#api_button_textgenerationwebui' : '#api_button_openai';
    await page.evaluate((id) => (document.querySelector(id) as HTMLElement | null)?.click(), connect);
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
    for (const tool of scenario.tools ?? []) {
      await page.evaluate((t) => {
        window.SillyTavern!.getContext().registerFunctionTool({
          ...t,
          action: async () => 'ok',
          formatMessage: () => '',
        });
      }, tool);
    }
    await mock.clear();
    await trigger(page, scenario);
    const deadline = Date.now() + 30_000;
    let posted: RecordedRequest | undefined;
    // The generation request, not the backend tokenizer's.
    const isGeneration = (r: RecordedRequest) => r.method === 'POST' && !tokenizePaths.includes(r.path);
    while (!(posted = (await mock.requests()).find(isGeneration))) {
      if (Date.now() > deadline) throw new Error(`no request for ${scenario.id}`);
      await sleep(200);
    }
    if (process.env.ST_DIFF_DEBUG) {
      await sleep(3000);
      for (const r of await mock.requests()) {
        const messages = (r.body as { messages?: { content: string }[] } | null)?.messages;
        console.log(
          `  [mock] ${r.method} ${r.headers.host} ${r.path} last: ${JSON.stringify(messages?.at(-1))?.slice(0, 120)}`,
        );
      }
    }
    return { path: posted.path, body: posted.body };
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
    templates: await loadStTemplates(),
  };
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(join(baselineDir, '_default-preset.json'), JSON.stringify(base.preset, null, 2) + '\n');

  const root = mkdtempSync(join(tmpdir(), 'st-diff-mock-'));
  const written: string[] = [];
  await startMockHost(root);
  try {
    for (const scenario of selected) {
      process.stdout.write(`${scenario.id} … `);
      let request;
      try {
        request = await recordScenario(scenario, base);
      } catch (error) {
        // SillyTavern sometimes starts slowly: one more try.
        process.stdout.write(`retrying (${(error as Error).message}) … `);
        request = await recordScenario(scenario, base);
      }
      const baseline = {
        scenario: scenario.id,
        image: ST_IMAGE,
        recordedAt: new Date().toISOString(),
        request,
      };
      const file = join(baselineDir, `${scenario.id}.json`);
      writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
      written.push(file);
      console.log('recorded');
    }
  } finally {
    // Keep the baselines in the repository's format.
    if (written.length) {
      try {
        execFileSync('pnpm', ['exec', 'prettier', '--write', ...written], { cwd: toolsDir, stdio: 'ignore' });
      } catch {
        console.warn('prettier was not available: run `pnpm exec prettier --write tools/st-diff/baseline`');
      }
    }
    if (!process.env.ST_DIFF_KEEP) docker('rm', '-f', CONTAINER, NET_CONTAINER);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
