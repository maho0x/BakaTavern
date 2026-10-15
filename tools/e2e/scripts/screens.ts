// Captures screenshots of a running BakaTavern for visual review.
// Usage: node scripts/screens.ts [baseUrl] [outDir]
import { chromium, devices } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:8800';
const out = process.argv[3] ?? 'screens';
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

const browser = await chromium.launch({ executablePath });
for (const [label, options] of [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['mobile', devices['Pixel 7']],
] as const) {
  for (const scheme of ['dark', 'light'] as const) {
    const context = await browser.newContext({ ...options, colorScheme: scheme, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log(`[${label}] console:`, m.text()));
    page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message));
    await page.goto(base);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${label}-${scheme}.png` });
    await context.close();
  }
}
await browser.close();
