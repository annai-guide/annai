import { test, expect } from '@playwright/test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers.js';

// What an update check costs when nothing is new (the user, 2026-10-24, asked that a check cost about 1 KB, not the 8 KB of sw.js).
// sw.js is sent with an ETag (scripts/serve.mjs), and both browsers' checks ask with it: a 304, headers only. A browser profile of
// its own, as a phone has: Playwright's default WebKit context keeps no HTTP cache at all, so it fetches everything whole.

test('an update check with nothing new is a 304 with no body, in both browsers', async ({ playwright, browserName }, testInfo) => {
  const server = await startServer(8891 + testInfo.parallelIndex);
  /** Each request for sw.js through the proxy: its status, body bytes and header bytes. @type {{ status: number, body: number, head: number }[]} */
  const checks = [];
  // A proxy in front of serve.mjs, which counts what goes back for sw.js.
  const proxy = http.createServer((req, res) => {
    const up = http.request(`${server.origin}${req.url}`, { method: req.method, headers: req.headers }, (r) => {
      let body = 0;
      r.on('data', (d) => { body += d.length; });
      r.on('end', () => {
        if (new URL(req.url ?? '/', 'http://x').pathname === '/sw.js') checks.push({ status: r.statusCode ?? 0, body, head: r.rawHeaders.join(': ').length });
      });
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (proxy.address()).port}`;
  const dir = await mkdtemp(join(tmpdir(), 'annai-profile-'));
  const context = await playwright[/** @type {'chromium' | 'webkit'} */ (browserName)].launchPersistentContext(dir, { locale: 'en-US' });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${origin}/#/trips`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
    expect(checks[0]?.status).toBe(200);
    await page.waitForTimeout(2000); // the checks annai makes as it starts
    checks.length = 0;
    // annai's own checks (coming back to the screen, Check now), and a reopen, which the browser checks.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
      await page.waitForTimeout(1000);
    }
    await page.goto('about:blank');
    await page.goto(`${origin}/#/trips`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await page.waitForTimeout(2000);
    console.log(`${browserName}: update checks with nothing new: ${JSON.stringify(checks)}`);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const c of checks) {
      expect(c.status).toBe(304);
      expect(c.body).toBe(0);
      expect(c.head).toBeLessThan(1024);
    }
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve(undefined)); });
    await server.stop();
  }
});
