import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';

/** Emits integrity.json (sha256 of every JS/CSS file) for the runtime self-check. */
function integrityManifest(): Plugin {
  return {
    name: 'integrity-manifest',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const out: Record<string, string> = {};
      for (const [file, item] of Object.entries(bundle)) {
        if (!/\.(js|css)$/.test(file)) continue;
        const src = item.type === 'chunk' ? item.code : item.source;
        out[file] = createHash('sha256').update(src).digest('hex');
      }
      this.emitFile({ type: 'asset', fileName: 'integrity.json', source: JSON.stringify(out) });
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
