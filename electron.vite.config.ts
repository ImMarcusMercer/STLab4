import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import renderer from './renderer.vite.config';

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve('source/desktop/main/index.ts') } } },
  preload: {
    build: {
      rollupOptions: { input: resolve('source/desktop/preload/index.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer,
});
