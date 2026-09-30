import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: resolve('source/desktop/renderer'),
  plugins: [react(), tailwindcss()],
  build: { rollupOptions: { input: resolve('source/desktop/renderer/index.html') } },
});
