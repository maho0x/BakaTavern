import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';

import { cardPng } from './fixtures.ts';

export const mockUrl = `http://127.0.0.1:${process.env.BT_E2E_MOCK_PORT ?? 5056}`;

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { messages?: { role: string; content: unknown }[] };
}

/** Scripts the mock LLM. `reply: null` makes it echo the last user message again. */
export async function mockReply(
  request: APIRequestContext,
  state: { reply?: string | null; reasoning?: string | null; delayMs?: number },
) {
  await request.post(`${mockUrl}/__reply`, { data: { reply: null, reasoning: null, delayMs: 5, ...state } });
}

export async function mockRequests(request: APIRequestContext): Promise<MockRequest[]> {
  const all = (await (await request.get(`${mockUrl}/__requests`)).json()) as MockRequest[];
  return all.filter((r) => r.method === 'POST');
}

export async function clearMockRequests(request: APIRequestContext) {
  await request.delete(`${mockUrl}/__requests`);
}

/** Points the app at the mock LLM through the Custom (OpenAI-compatible) provider. */
export async function useMockConnection(request: APIRequestContext) {
  const response = await request.put('/api/settings/connection', {
    headers: { 'x-bt-client': '1' },
    data: {
      data: {
        providerId: 'custom',
        models: { custom: 'mock-model' },
        baseUrls: { custom: `${mockUrl}/v1` },
        endpoints: {},
        secretIds: {},
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

/** A character name unique to this test and project (desktop and mobile share one server). */
export function uniqueName(base: string, testInfo: TestInfo) {
  return `${base} ${testInfo.project.name}-${testInfo.workerIndex}${testInfo.retry ? `-r${testInfo.retry}` : ''}`;
}

export function isMobile(page: Page) {
  return (page.viewportSize()?.width ?? 1280) < 900;
}

/** Imports PNG cards through the library's file picker and waits for the chat to open. */
export async function importCards(page: Page, files: { name: string; card: { v2?: object; v3?: object } }[]) {
  const input = page.locator('input[type=file][accept*=".png"]');
  await page.getByRole('region', { name: 'Chat' }).waitFor();
  // The welcome screen has its own import; on phones an open chat hides the library.
  if ((await input.count()) === 0) await page.getByRole('button', { name: 'Characters' }).first().click();
  await input
    .first()
    .setInputFiles(
      files.map((f) => ({ name: `${f.name}.png`, mimeType: 'image/png', buffer: cardPng(f.card) })),
    );
}

export function messages(page: Page) {
  return page.locator('article.message');
}

export function composer(page: Page) {
  return page.getByRole('textbox', { name: /^Write as / });
}

export async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** Opens one of the composer's extra actions (continue, regenerate, write for me). */
export async function composerAction(page: Page, name: string) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}

export async function waitIdle(page: Page) {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
}
