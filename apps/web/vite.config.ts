import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Emits `sw.js` with the build's files, so each build gets its own versioned cache. */
function serviceWorker(): Plugin {
  return {
    name: 'bt-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle)
        .filter((f) => !f.fileName.endsWith('.map') && f.fileName !== 'index.html')
        .map((f) => ({
          name: f.fileName,
          size: f.type === 'chunk' ? f.code.length : f.source.length,
          entry: f.type === 'chunk' && f.isEntry,
        }));
      const version = createHash('sha256')
        .update(
          files
            .map((f) => f.name)
            .sort()
            .join('\n'),
        )
        .digest('hex')
        .slice(0, 12);
      // Large lazy chunks (tokenizer vocabularies) are cached when first used instead.
      const precache = files
        .filter((f) => f.name.startsWith('assets/') && (f.entry || f.size < 200_000))
        .map((f) => f.name);
      const source = readFileSync(new URL('./sw/service-worker.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace("['__PRECACHE__']", JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), serviceWorker()],
  server: {
    port: 5173,
    // The Rust server provides the API during development.
    proxy: { '/api': { target: process.env.BT_API ?? 'http://127.0.0.1:8800' } },
  },
  build: {
    target: 'es2023',
    // The dist folder is embedded into the server binary; keep maps opt-in.
    sourcemap: process.env.BT_SOURCEMAP === '1',
    // Tokenizer vocabularies (o200k/cl100k) are large but lazily loaded.
    chunkSizeWarningLimit: 2100,
  },
  test: {
    environment: 'jsdom',
  },
});
