/**
 * Runs the STscript cases in SillyTavern 1.19 (Docker) and stores what each one produced in
 * `baseline/stscript.json`. Usage: node src/record-stscript.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { chromium } from '@playwright/test';

import { stscriptCases } from './stscript-cases.ts';
import { stscriptScenario, type StscriptOutcome } from './stscript-harness.ts';
import { writeStData } from './st-data.ts';

const ST_IMAGE = process.env.ST_IMAGE ?? 'ghcr.io/sillytavern/sillytavern:1.19.0';
const ST_PORT = Number(process.env.ST_PORT ?? 8011);
const CONTAINER = 'bt-st-diff-stscript';
const toolsDir = resolve(import.meta.dirname, '../..');
const baselineFile = resolve(import.meta.dirname, '../baseline/stscript.json');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StContext {
  characters: { avatar: string }[];
  chat: unknown[];
  chatMetadata: Record<string, unknown>;
  extensionSettings: { variables: { global: Record<string, unknown> } };
  eventSource: { on(event: string, listener: () => void): void };
  eventTypes: Record<string, string>;
  selectCharacterById(id: number): Promise<void>;
  executeSlashCommandsWithOptions(
    text: string,
    options: Record<string, unknown>,
  ): Promise<{
    pipe: unknown;
    isAborted: boolean;
    isQuietlyAborted: boolean;
    abortReason: string;
    isBreak: boolean;
  }>;
}

/** The page's global (declared apart from record.ts's narrower one). */
type StWindow = { SillyTavern?: { getContext(): StContext } };

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'st-diff-stscript-'));
  const [config, data] = [join(root, 'config'), join(root, 'data')];
  mkdirSync(config);
  const scenario = stscriptScenario();
  const settings = JSON.parse(
    docker('run', '--rm', '--entrypoint', 'cat', ST_IMAGE, '/home/node/app/default/content/settings.json'),
  ) as Record<string, unknown>;
  const preset = JSON.parse(
    docker(
      'run',
      '--rm',
      '--entrypoint',
      'cat',
      ST_IMAGE,
      '/home/node/app/default/content/presets/openai/Default.json',
    ),
  ) as Record<string, unknown>;
  writeStData(data, scenario, settings, preset, 'http://127.0.0.1:1/v1');
  docker('rm', '-f', CONTAINER);
  const user = process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined;
  docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `127.0.0.1:${ST_PORT}:${ST_PORT}`,
    ...(user ? ['--user', user] : []),
    '-e',
    'SILLYTAVERN_WHITELISTMODE=false',
    '-e',
    'SILLYTAVERN_SECURITYOVERRIDE=true',
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
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${ST_PORT}/`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error('SillyTavern did not start');
      await sleep(500);
    }
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.warn(`  page error: ${e.message}`));
    await page.goto(`http://127.0.0.1:${ST_PORT}/`);
    const avatar = `${scenario.card.name}.png`;
    await page.waitForFunction(
      (avatar) =>
        (window as unknown as StWindow).SillyTavern?.getContext?.().characters?.some(
          (c) => c.avatar === avatar,
        ),
      avatar,
      { timeout: 60_000 },
    );
    await page.evaluate(async () => {
      const ctx = (window as unknown as StWindow).SillyTavern!.getContext();
      await new Promise<void>((resolve) => ctx.eventSource.on(ctx.eventTypes.APP_READY!, () => resolve()));
    });
    await page.evaluate(async (avatar) => {
      const ctx = (window as unknown as StWindow).SillyTavern!.getContext();
      await ctx.selectCharacterById(ctx.characters.findIndex((c) => c.avatar === avatar));
    }, avatar);
    await page.waitForFunction(
      () => (window as unknown as StWindow).SillyTavern!.getContext().chat.length > 0,
      null,
      { timeout: 30_000 },
    );
    await sleep(1000);

    const outcomes: Record<string, StscriptOutcome> = {};
    for (const c of stscriptCases) {
      process.stdout.write(`${c.id} … `);
      outcomes[c.id] = await page.evaluate(
        async ({ script, local, global }) => {
          const ctx = (window as unknown as StWindow).SillyTavern!.getContext();
          ctx.chatMetadata.variables = { ...local };
          ctx.extensionSettings.variables.global = { ...global };
          let outcome: Record<string, unknown>;
          try {
            const r = await ctx.executeSlashCommandsWithOptions(script, {
              handleParserErrors: false,
              handleExecutionErrors: false,
            });
            outcome = {
              pipe: r.pipe === undefined ? null : String(r.pipe),
              isAborted: r.isAborted,
              isQuietlyAborted: r.isQuietlyAborted,
              abortReason: r.abortReason ?? null,
              isBreak: r.isBreak,
            };
          } catch (error) {
            outcome = { error: (error as Error).message };
          }
          // Through JSON: the values a script left behind, as they would be saved.
          return JSON.parse(
            JSON.stringify({
              ...outcome,
              local: ctx.chatMetadata.variables,
              global: ctx.extensionSettings.variables.global,
            }),
          ) as StscriptOutcome;
        },
        { script: c.script, local: c.local ?? {}, global: c.global ?? {} },
      );
      console.log('recorded');
    }
    writeFileSync(
      baselineFile,
      JSON.stringify({ image: ST_IMAGE, recordedAt: new Date().toISOString(), outcomes }, null, 2) + '\n',
    );
    try {
      execFileSync('pnpm', ['exec', 'prettier', '--write', baselineFile], { cwd: toolsDir, stdio: 'ignore' });
    } catch {
      // formatting is optional
    }
  } finally {
    await browser.close();
    docker('rm', '-f', CONTAINER);
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
