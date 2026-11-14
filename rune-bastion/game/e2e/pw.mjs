// Resolves Playwright from the project when installed, otherwise from a global/tooling install
// (set PLAYWRIGHT_DIR to the folder that contains node_modules/playwright).
import { createRequire } from 'node:module';
import path from 'node:path';

function load() {
  const bases = [import.meta.url, path.join(process.env.PLAYWRIGHT_DIR ?? '/opt/node-tools', 'x.js')];
  for (const b of bases) {
    try { return createRequire(b)('playwright'); } catch { /* try next */ }
  }
  throw new Error('playwright not found: npm i -D playwright, or set PLAYWRIGHT_DIR');
}
export const { chromium, devices } = load();
export const GL_ARGS = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
