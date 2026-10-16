// Runs the server binary on a fresh, temporary data directory (removed again on exit).
// Usage: node scripts/serve.ts [port]; BT_BIN overrides the binary path.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const port = process.argv[2] ?? '8801';
const binary = process.env.BT_BIN ?? resolve(import.meta.dirname, '../../../target/debug/bakatavern');
const dataDir = mkdtempSync(join(tmpdir(), 'bt-e2e-'));
// Tests never download tokenizer files: tokenizers without one fall back to the estimate.
writeFileSync(join(dataDir, 'config.toml'), '[tokenizers]\ndownload = false\n');

const child = spawn(binary, ['serve', '--data-dir', dataDir, '--host', '127.0.0.1', '--port', port], {
  stdio: 'inherit',
  env: { ...process.env, BT_LOG: process.env.BT_LOG ?? 'warn' },
});

const cleanup = () => rmSync(dataDir, { recursive: true, force: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
