import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure', acceptDownloads: true, actionTimeout: 15_000 },
  webServer: {
    command: 'node scripts/serve.mjs --port 8790',
    url: 'http://127.0.0.1:8790/_headers',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'] } },
    { name: 'webkit', use: { ...devices['iPhone 15'] } },
  ],
});
