import { defineConfig, devices } from '@playwright/test';

// No test reaches a real outside service. Every browser goes through a proxy on a port nothing listens on (9, as the specs'
// own "nothing there" addresses), with this machine's addresses bypassed: page.route and routeWebSocket stand-ins and the
// local servers answer as before, and a request for any other host fails where it is made, with net::ERR_PROXY_CONNECTION_FAILED
// in Chromium and "Could not connect to proxy server 127.0.0.1: Connection refused" in WebKit (ECONNREFUSED 127.0.0.1:9 for the
// request fixture and route.fetch). Why: on 2026-11-25 a voice test's failure path sent about ten requests to Gemini's real
// address with the test's fake key and a fixture clip. `docker run --network none` (or an internal Docker network) stops that
// too, but the browsers then read offline (navigator.onLine false) and six voice tests fail. Naming 127.0.0.1 keeps Chromium's
// own loopback bypass (Playwright otherwise adds <-loopback>); WebKit bypasses only what is listed.
const NOWHERE = { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,::1,[::1]' };

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://127.0.0.1:8790', trace: 'retain-on-failure', acceptDownloads: true, actionTimeout: 15_000,
    // The interface is English whatever the machine is set to, so the locators by role, text and label hold (localization design, "Tests").
    locale: 'en-US', proxy: NOWHERE },
  webServer: {
    command: 'node scripts/serve.mjs --port 8790',
    url: 'http://127.0.0.1:8790/_headers',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Pixel 7'] }, testIgnore: /push-sw\.spec\.js/ },
    { name: 'webkit', use: { ...devices['iPhone 15'] }, testIgnore: /push-sw\.spec\.js/ },
    // Chromium's new headless mode shows notifications (the default headless shell refuses them), and its
    // DevTools protocol can deliver a push: the phone's side of milestone 6. This Chromium also calls Google's services for
    // itself (update, time, accounts: 2026-11-25) outside any page's context, so its launch goes through the proxy too.
    { name: 'chromium-notifications', use: { ...devices['Pixel 7'], channel: 'chromium', launchOptions: { proxy: NOWHERE } }, testMatch: /push-sw\.spec\.js/ },
  ],
});
