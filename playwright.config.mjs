import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: { command: 'npm run build && node scripts/serve.mjs --dir=dist --port=4174 --host=127.0.0.1', port: 4174, reuseExistingServer: false },
});
