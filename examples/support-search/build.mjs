/**
 * Builds the extension into ./dist using Vite (resolved from the repo root's
 * node_modules — run `npm install` in the repo root first).
 *
 * Three outputs, two module formats:
 *   - worker.js  (ES module — manifest declares the SW as type:module)
 *   - panel.js   (ES module — loaded by panel.html)
 *   - slack-token.js (IIFE — MV3 content scripts are classic scripts)
 *
 * `mv3-fetch-bridge` is aliased to the library source in this same repo, so
 * the example builds without publishing/installing the library.
 */

import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = { 'mv3-fetch-bridge': path.resolve(root, '../../src/index.ts') };
const common = {
  root,
  resolve: { alias },
  logLevel: 'warn',
};

async function buildEntry(entry, name, { format, emptyOutDir }) {
  await build({
    ...common,
    build: {
      outDir: 'dist',
      emptyOutDir,
      target: 'chrome114',
      minify: false,
      lib: {
        entry: path.resolve(root, entry),
        formats: [format],
        name: name.replace(/-/g, '_'),
        fileName: () => `${name}.js`,
      },
    },
  });
}

// First build empties dist; the rest append.
await buildEntry('src/worker.ts', 'worker', { format: 'es', emptyOutDir: true });
await buildEntry('src/panel.ts', 'panel', { format: 'es', emptyOutDir: false });
await buildEntry('src/slack-token.ts', 'slack-token', { format: 'iife', emptyOutDir: false });

console.log('\n✓ Built extension to ./dist — load ./examples/support-search as an unpacked extension.');
