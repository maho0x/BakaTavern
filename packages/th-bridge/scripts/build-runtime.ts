/** Bundles the frame runtime (`src/runtime/index.ts`) into one classic script: `dist/th-runtime.js`. */

import { fileURLToPath } from 'node:url';

import { build } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  input: `${root}src/runtime/index.ts`,
  platform: 'browser',
  plugins: [
    {
      // zod's error messages in English and Chinese only: the other locales triple the bundle.
      name: 'zod-locales',
      load(id) {
        if (!/[\\/]zod[\\/]v4[\\/]locales[\\/]index\.js$/.test(id)) return null;
        return "export { default as en } from './en.js';\nexport { default as zhCN } from './zh-CN.js';\n";
      },
    },
  ],
  output: {
    file: `${root}dist/th-runtime.js`,
    format: 'iife',
    minify: true,
    sourcemap: false,
  },
});
