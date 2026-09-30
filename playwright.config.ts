import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  webServer: [{
    command: 'npm run start:api',
    url: 'http://127.0.0.1:3100/api/v1/system/status',
    reuseExistingServer: false,
    timeout: 30_000,
  }, {
    command: 'npx vite --config renderer.vite.config.ts --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 30_000,
  }],
});
