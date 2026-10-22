import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, startTrip } from './helpers.js';

// A page loaded past the service worker that the worker doesn't take (spec §5.3). Playwright gives the page a user
// activation (navigator.userActivation.hasBeenActive) when it traces, evaluates or checks a locator, which annai reads as
// the user having acted, so it would never reload by itself. So this file runs untraced, and while annai decides (its
// first 5 seconds) the tests leave the page alone: they count its loads, and ask over the DevTools protocol.
test.use({ trace: 'off' });

const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Whether a worker controls the page, asked without acting on it. @param {import('@playwright/test').CDPSession} cdp */
const controlledNow = async (cdp) => (await cdp.send('Runtime.evaluate', { expression: 'navigator.serviceWorker.controller !== null', returnByValue: true })).result.value;

/**
 * Test plugins like hello (a /<id>/*.json file in a trip needs a greeting), written straight into storage as an install
 * leaves them, so they first start at the next load.
 * @param {import('@playwright/test').Page} page @param {{ id: string, name: string }[]} list
 */
async function installByHand(page, list) {
  const code = await readFile(new URL('../fixtures/plugins/hello/index.js', import.meta.url), 'utf8');
  await page.evaluate(async ({ list, code }) => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    /** @type {Record<string, any>} */
    const installed = {};
    for (const { id, name } of list) {
      await ws.write('sys:plugins', `/${id}/annai-plugin.json`, { id, name, version: '1.0.0', api: 1, entry: 'index.js' }, { author: 'system' });
      await ws.write('sys:plugins', `/${id}/index.js`, code.replace('/hello/', `/${id}/`), { author: 'system' });
      installed[id] = { version: '1.0.0', name, enabled: true, installed: 1, source: 'test' };
    }
    await ws.write('sys:plugins', '/installed.json', installed, { author: 'system' });
    store.close();
  }, { list, code });
}

/**
 * The page never asks its worker to take it, as if the worker couldn't (what Chromium does in the last test below), until
 * the test lets it (sessionStorage test.claim = 'answered'). @param {import('@playwright/test').Page} page
 */
async function claimFails(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('test.controlledAtStart', String(navigator.serviceWorker.controller !== null));
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (/** @type {any} */ m, /** @type {any} */ ...rest) {
      if (m !== 'claim' || sessionStorage.getItem('test.claim') === 'answered') post.call(this, m, ...rest);
    };
  });
}

/** What annai's plugins recorded about starting. @param {import('@playwright/test').Page} page */
const startFailures = (page) => page.evaluate(async () => {
  const at = (/** @type {string} */ p) => p;
  const { createIdbStore } = await import(at('/src/core/store-idb.js'));
  const { Workspace } = await import(at('/src/core/workspace.js'));
  const store = await createIdbStore();
  const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
  store.close();
  return Object.values(state).map((/** @type {any} */ s) => s.startFailures ?? 0);
});

/** Counts the page's loads from now on. @param {import('@playwright/test').Page} page */
function countLoads(page) {
  const n = { loads: 0 };
  page.on('load', () => { n.loads++; });
  return n;
}

/** hello's check runs: a /hello/*.json file without a greeting is refused. @param {import('@playwright/test').Page} page */
async function helloRuns(page) {
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toContainText('greeting', { timeout: 15_000 });
}

const controlled = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => navigator.serviceWorker.controller !== null);

// The second emulator re-check: one configuration-change reload in three stayed past the worker for minutes, its claim
// unanswered, with a card for every plugin. A page the worker doesn't take within a few seconds reloads once (spec §5.3).
test("a page loaded past the service worker that it doesn't take is reloaded once, and its plugins run", async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'a reload past the service worker over the DevTools protocol is Chromium only');
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Plugin trip');
  await installByHand(page, [{ id: 'hello', name: 'Hello checks' }]);
  await claimFails(page);
  const n = countLoads(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.reload', { ignoreCache: true });

  // The reload past the worker, then annai's own, which the worker takes.
  await expect.poll(() => n.loads, { timeout: 20_000 }).toBe(2);
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  expect(await controlled(page)).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('annai.reloadedForWorker'))).toMatch(/^\d{13}$/);
  await helloRuns(page);
  await expect(page.locator('.notice')).toHaveCount(0);
  expect(n.loads).toBe(2);
});

test("a page still not taken after annai's own reload isn't reloaded again within 2 minutes: one card names its plugins, with Reload now", async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'a reload past the service worker over the DevTools protocol is Chromium only');
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Plugin trip');
  await installByHand(page, [{ id: 'hello', name: 'Hello checks' }, { id: 'hola', name: 'Hola checks' }]);
  await claimFails(page);
  const n = countLoads(page);
  const cdp = await page.context().newCDPSession(page);
  // annai's own reload goes past the worker too.
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await cdp.send('Page.reload', { ignoreCache: true });

  // annai's reload; the page after it, past the worker again, decides alone and doesn't reload.
  await expect.poll(() => n.loads, { timeout: 20_000 }).toBe(2);
  await pause(7_000);
  expect(n.loads).toBe(2);
  expect(await controlledNow(cdp)).toBe(false);
  const card = page.locator('.notice').filter({ hasText: 'annai needs a reload' });
  await expect(card).toBeVisible();
  // One card, naming the plugins by their names; none of them was tried, so none says it didn't start.
  await expect(page.locator('.notice')).toHaveCount(1);
  await expect(card).toContainText("these plugins can't start: Hello checks and Hola checks.");
  await expect(card).not.toContainText('"hello"');
  await expect(page.getByText("didn't start")).toHaveCount(0);

  // Reload now is the user's own: the next page, past the worker again, still asks to be taken, and now is (the
  // bypass ends once it has loaded, so its plugins' files come through the worker).
  await page.evaluate(() => sessionStorage.setItem('test.claim', 'answered'));
  const committed = page.waitForEvent('framenavigated', (f) => f === page.mainFrame());
  await card.getByRole('button', { name: 'Reload now' }).click();
  await committed;
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });
  await expect.poll(() => n.loads).toBe(3);
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  await expect.poll(() => controlled(page)).toBe(true);
  expect(await page.evaluate(() => sessionStorage.getItem('test.controlledAtStart'))).toBe('false');
  await helloRuns(page);
  await expect(page.locator('.notice')).toHaveCount(0);
  expect(await startFailures(page)).toEqual([0, 0]);
});

test('annai never reloads itself over what the user has started: a page not taken waits for their Reload now', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'a reload past the service worker over the DevTools protocol is Chromium only');
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Plugin trip');
  await installByHand(page, [{ id: 'hello', name: 'Hello checks' }]);
  await claimFails(page);
  const n = countLoads(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.reload', { ignoreCache: true });
  // Typing, within the few seconds annai waits to be taken.
  await page.getByLabel('File path').click();
  await page.keyboard.type('/hello/a.json');

  const card = page.locator('.notice').filter({ hasText: 'annai needs a reload' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("this plugin can't start: Hello checks.");
  await page.waitForTimeout(2_000);
  expect(n.loads).toBe(1);
  await expect(page.getByLabel('File path')).toHaveValue(/\/hello\/a\.json$/);
  await card.getByRole('button', { name: 'Reload now' }).click();
  await expect.poll(() => n.loads).toBe(2);
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  expect(await controlled(page)).toBe(true);
  await helloRuns(page);
});

// A sign-in that comes back to a page loaded past the worker (the review's probe): its code and note stay until plugins
// are up, so annai's reload finishes it, never losing it without a word.
test("a sign-in that comes back to a page the service worker doesn't take is finished after annai's reload", async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'a reload past the service worker over the DevTools protocol is Chromium only');
  let authUrl = '';
  await page.route('https://openrouter.ai/auth**', (route) => {
    authUrl = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OpenRouter</p>' });
  });
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ key: 'sk-or-test-key-123' }) });
  });
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await page.getByRole('button', { name: 'Sign in with OpenRouter' }).click();
  await expect.poll(() => authUrl).toContain('key_label=annai');
  await claimFails(page);
  const n = countLoads(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await page.goto(`/?code=test-code&state=${new URL(authUrl).searchParams.get('state')}`, { waitUntil: 'commit' });
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });

  await expect.poll(() => n.loads, { timeout: 20_000 }).toBe(2);
  await expect(page.locator('.notice', { hasText: 'Signed in with OpenRouter' })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByText("didn't finish")).toHaveCount(0);
});

// What Chromium does (found for the second re-check): a page loaded past the worker is given only the registrations in
// memory as it begins to load, and claim() passes over a page that wasn't, for as long as it lives. Here nothing holds
// annai's registration: its only page is closed and its worker stopped. A normal reload is taken.
test('a page loaded past the worker before its registration was in memory, which claim() never takes, recovers', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'loading past the service worker over the DevTools protocol is Chromium only');
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Plugin trip');
  await installByHand(page, [{ id: 'hello', name: 'Hello checks' }]);
  const tripUrl = page.url();
  const other = await page.context().newPage();
  await page.close();
  const cdp = await other.context().newCDPSession(other);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.send('ServiceWorker.disable');
  await pause(1_000);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  const n = countLoads(other);
  await other.goto(tripUrl, { waitUntil: 'commit' });
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });

  // Not taken (2 seconds in, its claim long answered had it worked), then annai's reload, which is.
  await pause(2_000);
  expect(await controlledNow(cdp)).toBe(false);
  await expect.poll(() => n.loads, { timeout: 20_000 }).toBe(2);
  await expect.poll(() => controlled(other)).toBe(true);
  await expect(other.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  await helloRuns(other);
  await expect(other.locator('.notice')).toHaveCount(0);
});
