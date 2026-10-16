import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

/**
 * Starts a dev server of the test's own, so a test can take the network away for real by stopping it.
 * (Playwright's offline mode in WebKit also blocks requests the service worker answers itself.)
 * @param {number} port
 */
export async function startServer(port) {
  const script = fileURLToPath(new URL('../../scripts/serve.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  try {
    await expect.poll(async () => { try { return (await fetch(`${origin}/_headers`)).ok; } catch { return false; } }).toBe(true);
  } catch (e) {
    await stop();
    throw e;
  }
  return { origin, stop };
}

/** Collects console errors and uncaught page errors. @param {import('@playwright/test').Page} page */
export function watchConsole(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Opens annai and waits for the first screen. Exports always download in tests (no share sheet). @param {import('@playwright/test').Page} page @param {string} [hash] */
export async function openApp(page, hash = '') {
  await page.addInitScript(() => { try { localStorage.setItem('annai.forceDownload', '1'); } catch { /* storage blocked */ } });
  await page.goto('/' + hash);
  await expect(page.locator('main.view > *')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
export async function waitForServiceWorker(page) {
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 });
}

/** Builds the file, then saves it with a separate tap (the iOS share sheet needs a fresh tap). @param {import('@playwright/test').Page} page */
export async function buildAndSave(page) {
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeHidden();
  await page.getByRole('button', { name: 'Build file' }).click();
  await expect(save).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  return /** @type {string} */ (await download.path());
}

/**
 * A stand-in model server on a port of its own, answering each path with a fixed response and
 * allowing browser access (CORS), as a real endpoint must. Requests from a page a service worker
 * controls can't be intercepted with page.route in WebKit, so model calls go to a real server.
 * @param {Record<string, { status: number, type: string, body: string }>} routes by path
 */
export async function startModelServer(routes) {
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type'),
    };
    req.resume();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const r = routes[new URL(req.url ?? '/', 'http://localhost').pathname];
    if (!r) res.writeHead(404, cors).end('not found');
    else res.writeHead(r.status, { ...cors, 'content-type': r.type }).end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${port}`, stop: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
