import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';

// `npm run build`         → dist/ (for hosting)
// `npm run build:single`  → dist-single/index.html — ONE file you can open by double-click (for testing)
export default defineConfig(({ mode }) => ({
  base: './',
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  plugins: [preact(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  resolve: { alias: { '@srs/core': fileURLToPath(new URL('../../packages/core/src/index.js', import.meta.url)) } },
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist', target: 'es2020' },
  server: { host: true },
}));
