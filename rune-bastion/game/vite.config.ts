import { defineConfig } from 'vite';

// Relative base so the same bundle works from Capacitor's webview (file-like origin) and any web path.
export default defineConfig({
  base: './',
  build: { target: 'es2020', outDir: 'dist', assetsInlineLimit: 0, chunkSizeWarningLimit: 1200 },
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 120000 },
} as any);
