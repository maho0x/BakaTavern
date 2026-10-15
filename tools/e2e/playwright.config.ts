import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the real server binary, the built web app and the mock LLM.
 * Build first: `pnpm --filter @bakatavern/web build && cargo build -p bt-cli`.
 * Without Playwright's own Chromium, point PW_CHROMIUM_PATH at a local Chromium build.
 */
const port = Number(process.env.BT_E2E_PORT ?? 8801);
const mockPort = Number(process.env.BT_E2E_MOCK_PORT ?? 5056);

export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  // One server and one mock for all tests: run them one after another.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: `node ../mock-llm/src/main.ts ${mockPort}`,
      url: `http://127.0.0.1:${mockPort}/__requests`,
    },
    {
      command: `node scripts/serve.ts ${port}`,
      url: `http://127.0.0.1:${port}/api/health`,
      timeout: 60_000,
    },
  ],
});
