import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Writes integrity.json (sha256 of every JS/CSS file) for the runtime self-check.
 * Hashes are taken from the files on disk after the bundle is fully written, so they match
 * exactly what ships.
 */
function integrityManifest(): Plugin {
  let outDir = 'dist';
  return {
    name: 'integrity-manifest',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const out: Record<string, string> = {};
      const walk = (dir: string, rel: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f), r = rel ? `${rel}/${f}` : f;
          if (statSync(p).isDirectory()) walk(p, r);
          else if (/\.(js|css)$/.test(f)) out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
        }
      };
      walk(outDir, '');
      writeFileSync(join(outDir, 'integrity.json'), JSON.stringify(out));
    },
  };
}

// Relative base so the same bundle works inside Capacitor's webview and under any web path.
export default defineConfig({
  base: './',
  plugins: [integrityManifest()],
  build: { target: 'es2020', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 120000 },
} as any);
