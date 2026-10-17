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
    { name: 'chromium', use: { ...devices['Pixel 7'] }, testIgnore: /push-sw\.spec\.js/ },
    { name: 'webkit', use: { ...devices['iPhone 15'] }, testIgnore: /push-sw\.spec\.js/ },
    // Chromium's new headless mode shows notifications (the default headless shell refuses them), and its
    // DevTools protocol can deliver a push: the phone's side of milestone 6.
    { name: 'chromium-notifications', use: { ...devices['Pixel 7'], channel: 'chromium' }, testMatch: /push-sw\.spec\.js/ },
  ],
});
