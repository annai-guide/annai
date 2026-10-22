import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, pickFile, pickProvider, fixtureFiles, zipOf, startTrip } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

/** A test plugin from test/fixtures/plugins, as a zip. @param {string} [dir] */
/** A plugin fixture as a zip; with version, its manifest says that version. @param {string} [dir] @param {string} [version] */
async function fixtureZip(dir = 'hello', version) {
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) {
    let bytes = new Uint8Array(await readFile(new URL(`../fixtures/plugins/${dir}/${name}`, import.meta.url)));
    if (version && name === 'annai-plugin.json') bytes = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), version }));
    await z.add(`${dir}/${name}`, bytes);
  }
  return Buffer.from(await z.finish().arrayBuffer());
}

test('install a plugin, see it work, turn it off, uninstall it', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await page.getByLabel('Trip name').fill('Plugin trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  const tripUrl = page.url();

  await page.goto('/#/plugins');
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByText('Trip record checks')).toBeVisible();
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await expect(page.getByRole('heading', { name: 'Install Hello checks?' })).toBeVisible();
  await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toContainText('greeting');

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await page.goto(tripUrl);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/hello/a.json' })).toBeVisible();

  await page.goto('/#/plugins');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to remove' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toHaveCount(0);
});

test('a bad plugin file is refused with a reason', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  await expect(page.getByText("That file isn't something annai can install")).toBeVisible();
});

test("a plugin that never finishes starting doesn't keep annai from opening", async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const files = await Promise.all(['annai-plugin.json', 'index.js'].map(async (name) => [name, await readFile(new URL(`../fixtures/plugins/hang/${name}`, import.meta.url), 'utf8')]));
  await page.evaluate(async (files) => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (const [name, body] of files) await ws.write('sys:plugins', `/hang/${name}`, body, { author: 'system' });
    await ws.write('sys:plugins', '/installed.json', { hang: { version: '1.0.0', name: 'Never starts', enabled: true, installed: 1, source: 'test' } }, { author: 'system' });
    store.close();
  }, files);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible({ timeout: 5_000 });
  // By its name, never its id (the second emulator re-check).
  await expect(page.getByText(`The plugin "Never starts" didn't start`)).toBeVisible({ timeout: 15_000 });
});

test('reinstalling a plugin that is running asks for a restart, which runs the new version', async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
  // A new version: its code differs from what ran (the same files again start at once, with no restart).
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip('hello', '1.0.1') });
  await expect(page.getByText('Version 1.0.0 is installed now. Installing replaces it.')).toBeVisible();
  await page.getByRole('button', { name: 'Install anyway' }).click();

  await expect(page.getByText('Restart annai to run the new version of Hello checks.')).toBeVisible();
  await page.getByRole('status').getByRole('button', { name: 'Restart annai' }).click();
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByText('On', { exact: true })).toBeVisible();
});

test("a plugin that installs but won't start says so, and stays installed", async ({ page }) => {
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'broken.zip', mimeType: 'application/zip', buffer: await fixtureZip('broken') });
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByText("Broken was installed, but it didn't start")).toBeVisible();
  await expect(page.getByText('Broken 0.0.1')).toBeVisible();
});

test('the installed list can be searched and filtered: provider plugins under Model providers name their providers; a skill under Skills and personalities', async ({ page }) => {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'OpenAI');
  await page.getByLabel('Name', { exact: true }).fill('OpenAI (work)');
  await page.getByLabel('Name', { exact: true }).blur();
  await expect(page.getByRole('heading', { level: 1, name: 'OpenAI (work)' })).toBeVisible();
  await pickFile(page, { name: 'tide-pools.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('tide-pools'), 'tide-pools-main') });
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();

  // Nothing typed: grouped by kind, only kinds with something in them.
  const providers = page.getByRole('region', { name: 'Model providers' });
  await expect(providers.locator('.card')).toHaveCount(1);
  await expect(providers).toContainText('Providers: OpenAI (work).');
  await expect(page.getByRole('region', { name: 'Skills and personalities' })).toContainText('tide-pools 1.2');
  await expect(page.getByRole('region', { name: 'Developer' })).toContainText('OpenAI Responses');
  await expect(page.getByRole('region', { name: 'Tools and MCP' })).toContainText('Trip record checks');
  await expect(page.getByRole('region', { name: 'Backup places' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Add', exact: true })).toHaveAttribute('href', '#/add');
  // annai's catalog is on the Add screen now, not here.
  await expect(page.getByRole('button', { name: /^Install / })).toHaveCount(0);

  const cards = page.locator('.found .card');
  await page.getByLabel('Search your plugins').fill('tide');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('tide-pools 1.2');
  // Found by what it does, as in the catalog: the voices of OpenAI, and the speech protocol it needs.
  await page.getByLabel('Search your plugins').fill('voices');
  await expect(cards).toHaveCount(2);
  await page.getByLabel('Search your plugins').fill('');
  // The Voice chip keeps the provider plugin that has a voice, not the protocol it talks through.
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('Providers: OpenAI (work).');
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Third-party', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('tide-pools 1.2');
  await page.getByRole('button', { name: 'Third-party', exact: true }).click();
  await page.getByRole('button', { name: 'Model providers', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Developer' })).toHaveCount(0);
});

// Android Chrome reloads annai past its service worker when dark mode, the screen size or its density changes,
// as a hard reload does: the worker is active but doesn't control the page (the emulator pass, 2026-10-20).
test('after a reload that skips the service worker, a code plugin still runs', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'a hard reload over the DevTools protocol is Chromium only');
  await openApp(page);
  await waitForServiceWorker(page);
  await page.getByLabel('Trip name').fill('Plugin trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  const tripUrl = page.url();
  await page.goto('/#/plugins');
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await page.goto(tripUrl);
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  const loaded = page.waitForEvent('load');
  await cdp.send('Page.reload', { ignoreCache: true });
  await loaded;
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  await expect(page.getByText(`The plugin "hello" didn't start`)).toHaveCount(0);
  await page.getByLabel('File path').fill('/hello/a.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('alert')).toContainText('greeting', { timeout: 15_000 });
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test("installing a code plugin that isn't annai's own says plainly what it can do with the keys saved now, naming whose, never a key; annai's own keep their note (fixes-ui 15)", async ({ page }) => {
  const GEMINI = 'AIza-test-gemini-key-0123456789';
  const JINA = 'jina_test_key_0123456789';
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await pickProvider(page, 'Google Gemini');
  await page.getByLabel('API key').fill(GEMINI);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
  await page.goto('/#/tools');
  await page.getByLabel('Jina key').fill(JINA);
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('A key is set.')).toBeVisible();
  await pickFile(page, { name: 'hello.zip', mimeType: 'application/zip', buffer: await fixtureZip() });
  await expect(page.getByRole('heading', { name: 'Install Hello checks?' })).toBeVisible();
  const note = page.getByRole('note');
  await expect(note).toContainText('It can read every key saved in annai and send it anywhere: now your keys for Google Gemini and Jina.');
  const text = await page.locator('main.view').innerText();
  expect(text).not.toContain(GEMINI);
  expect(text).not.toContain(JINA);
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByText('Hello checks 1.0.0')).toBeVisible();
  // annai's own: its page keeps the note it had, and names no keys.
  await page.goto('/#/plugins/gemini-api');
  await expect(page.getByRole('heading', { level: 1, name: 'Gemini API' })).toBeVisible();
  await expect(page.getByText('This plugin gets full access to your trips and API keys.')).toBeVisible();
  await expect(page.getByText(/send it anywhere/)).toHaveCount(0);
});

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

/** The page never asks its worker to take it, as if the worker couldn't (what Chromium does in the test below). @param {import('@playwright/test').Page} page */
async function claimFails(page) {
  await page.addInitScript(() => {
    const post = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (/** @type {any} */ m, /** @type {any} */ ...rest) {
      if (m !== 'claim') post.call(this, m, ...rest);
    };
  });
}

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

test("the reload happens once: a page still not taken after it says, in one card, to close annai and open it again", async ({ page, browserName }) => {
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

  const card = page.locator('.notice').filter({ hasText: 'annai needs to be closed and opened again' });
  await expect(card).toBeVisible({ timeout: 25_000 });
  expect(n.loads).toBe(2);
  // One card, naming the plugins by their names; none of them was tried, so none says it didn't start.
  await expect(page.locator('.notice')).toHaveCount(1);
  await expect(card).toContainText('Hello checks, Hola checks');
  await expect(card).not.toContainText('"hello"');
  await expect(page.getByText("didn't start")).toHaveCount(0);
  // Never a second reload.
  await page.waitForTimeout(7_000);
  expect(n.loads).toBe(2);
  expect(await controlled(page)).toBe(false);

  // Opened again, as a page the worker takes: the plugins run, and were never counted as failing.
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  await helloRuns(page);
  await expect(page.locator('.notice')).toHaveCount(0);
  const failures = await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const store = await createIdbStore();
    const state = await new Workspace(store).readJSON('sys:plugins', '/installed.json');
    store.close();
    return [state.hello.startFailures ?? 0, state.hola.startFailures ?? 0];
  });
  expect(failures).toEqual([0, 0]);
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
  await other.waitForTimeout(1_000);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBypassServiceWorker', { bypass: true });
  await other.goto(tripUrl, { waitUntil: 'commit' });
  await cdp.send('Network.setBypassServiceWorker', { bypass: false });

  await expect.poll(() => controlled(other), { timeout: 20_000 }).toBe(true);
  await expect(other.getByRole('heading', { name: 'Plugin trip' })).toBeVisible();
  await helloRuns(other);
  await expect(other.locator('.notice')).toHaveCount(0);
});
