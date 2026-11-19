import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { openApp, waitForServiceWorker, pickFile, pickProvider } from './helpers.js';
import { startMcpServer } from '../fakes/mcp.js';
import { startFakeServer } from '../fakes/model-server.js';
import { ZipWriter } from '../../src/core/zip.js';

// The screen never changes under the traveller's hands (the user, 2026-11-12: "simple and robust solutions", and the timeline spec's no-jumps
// rule). The open item of 2026-11-09: "The plugin form's redraw can lose a typed address on a slow phone." A slow phone is one where something
// started before the traveller began to type ends while they type: a plugin still starting, an action of theirs still working, a check
// still asking. The draw that comes then must leave the field they are typing in: its text, its caret and the phone's keyboard.
//
// The slow plugin (test/fixtures/plugins/slow) starts as slowly as the test says: with the page's `__hold` set, its start waits for `__release()`.
// A field's element is marked, so a draw that put a new one in its place shows even when the text came back (a setting saves as it is let go).

/** A fixture plugin as a zip. @param {string} dir */
async function fixtureZip(dir) {
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) await z.add(`${dir}/${name}`, new Uint8Array(await readFile(new URL(`../fixtures/plugins/${dir}/${name}`, import.meta.url))));
  return Buffer.from(await z.finish().arrayBuffer());
}

/** annai with the slow plugin installed and running. @param {import('@playwright/test').Page} page */
async function slowInstalled(page) {
  await openApp(page);
  await waitForServiceWorker(page);
  await pickFile(page, { name: 'slow.zip', mimeType: 'application/zip', buffer: await fixtureZip('slow') });
  await page.getByRole('button', { name: 'Install anyway' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
}

/** Starts typing in a field and leaves the caret in it: its element is marked. @param {import('@playwright/test').Page} page @param {string} label @param {string} text */
async function typeIn(page, label, text) {
  const field = page.getByLabel(label, { exact: true });
  await expect(field).toBeVisible();
  await field.focus();
  await field.pressSequentially(text, { delay: 5 });
  await field.evaluate((el) => { el.dataset.mine = '1'; });
}

/** Where the field is: its text, whether it is the very element the traveller typed in, and which element has the caret. @param {import('@playwright/test').Page} page @param {string} label */
async function fieldNow(page, label) {
  const field = page.getByLabel(label, { exact: true });
  return { value: await field.inputValue(), same: await field.evaluate((el) => el.dataset.mine === '1'), focus: await page.evaluate(() => document.activeElement?.id ?? '') };
}

/** The start of the plugin that is being held ends. @param {import('@playwright/test').Page} page */
async function release(page) {
  await page.waitForFunction(() => typeof (/** @type {any} */ (globalThis)).__release === 'function');
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__release());
}

/** A draw that would have come by now has had time to: the wait looks twice a second. @param {import('@playwright/test').Page} page */
const later = (page) => page.waitForTimeout(1600);

// On main every test below that says "(fails on main)" lost the typed text, the caret and the keyboard: each draw replaced the field.

test("a plugin that finishes starting while its setting is typed: the page waits for the field, and shows it running once it is let go (fails on main)", async ({ page }) => {
  await slowInstalled(page);
  await page.addInitScript(() => { /** @type {any} */ (globalThis).__hold = true; });
  await page.goto('/#/plugins/slow');
  await page.reload();
  await expect(page.getByText('On, but it didn\'t start')).toBeVisible();
  await typeIn(page, 'Server address', 'https://tides.example/api');
  await release(page);
  await later(page);
  expect(await fieldNow(page, 'Server address')).toEqual({ value: 'https://tides.example/api', same: true, focus: 'setting-slow-address' });
  // Let go, it saves and the page is drawn again, running.
  await page.getByLabel('Server address', { exact: true }).blur();
  await expect(page.getByText(/^On( · |$)/)).toBeVisible();
  await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://tides.example/api');
});

test("a key typed and not saved, its field let go, is not drawn away by a plugin that finishes starting (fails on main)", async ({ page }) => {
  await slowInstalled(page);
  await page.addInitScript(() => { /** @type {any} */ (globalThis).__hold = true; });
  await page.goto('/#/plugins/slow');
  await page.reload();
  await typeIn(page, 'Token', 'sk-typed-not-saved-0123456789');
  await page.getByLabel('Token', { exact: true }).blur();
  await release(page);
  await later(page);
  expect(await fieldNow(page, 'Token')).toEqual({ value: 'sk-typed-not-saved-0123456789', same: true, focus: '' });
  // Saved, the field is let go of the key and the page shows it kept.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByLabel('Token', { exact: true })).toHaveAttribute('placeholder', 'saved');
  await expect(page.getByText(/^On( · |$)/)).toBeVisible();
});

test("Turn on, which takes a while to start the plugin, ends while its setting is typed: the page waits for the field, then shows it on (fails on main)", async ({ page }) => {
  await slowInstalled(page);
  await page.goto('/#/plugins/slow');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await page.evaluate(() => { /** @type {any} */ (globalThis).__hold = true; });
  await page.getByRole('button', { name: 'Turn on' }).click();
  await typeIn(page, 'Server address', 'https://tides.example/api');
  await release(page);
  await later(page);
  expect(await fieldNow(page, 'Server address')).toEqual({ value: 'https://tides.example/api', same: true, focus: 'setting-slow-address' });
  await page.getByLabel('Server address', { exact: true }).blur();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://tides.example/api');
});

test("a plugin that adds a page while a setting is typed: the page waits for the field, then lists it (held on main already)", async ({ page }) => {
  await slowInstalled(page);
  await page.goto('/#/plugins/slow');
  await typeIn(page, 'Server address', 'https://tides.example/api');
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
  await later(page);
  expect(await fieldNow(page, 'Server address')).toEqual({ value: 'https://tides.example/api', same: true, focus: 'setting-slow-address' });
  await page.getByLabel('Server address', { exact: true }).blur();
  await expect(page.getByRole('heading', { name: 'Its pages' })).toBeVisible();
  await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://tides.example/api');
});

test("the address of a plugin typed on Add and let go (the keyboard put away): the draw of a plugin that adds a page waits, and the address stays (fails on main)", async ({ page }) => {
  await slowInstalled(page);
  await page.evaluate(() => { location.hash = '#/add'; });
  await typeIn(page, 'Address of a plugin or skill', 'https://example.com/annai-plugin.json');
  await page.getByLabel('Address of a plugin or skill', { exact: true }).blur();
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
  await later(page);
  expect(await fieldNow(page, 'Address of a plugin or skill')).toEqual({ value: 'https://example.com/annai-plugin.json', same: true, focus: '' });
});

test("Search your plugins typed and a chip tapped, then let go: the draw of a plugin that adds a page lands, and the search, the chip and the narrowed list are as left (the box fails on main; the chip fails on 799dd44a4)", async ({ page }) => {
  await slowInstalled(page);
  await page.evaluate(() => { location.hash = '#/plugins'; });
  const search = page.getByLabel('Search your plugins', { exact: true });
  const thirdParty = page.getByRole('button', { name: 'Third-party', exact: true });
  await expect(page.locator('li.card', { hasText: 'Trip record checks' })).toBeVisible();
  await typeIn(page, 'Search your plugins', 'slow');
  await expect(page.locator('li.card', { hasText: 'Trip record checks' })).toHaveCount(0);
  await thirdParty.click();
  await expect(thirdParty).toHaveAttribute('aria-pressed', 'true');
  await search.blur();
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
  // The search and the chip keep their state as a fold stays open (one entry, by the finder's label), and the search says so to the door: the
  // draw comes, with what was typed in its new box and the chip still on.
  await expect(search).not.toHaveAttribute('data-mine', '1');
  expect(await fieldNow(page, 'Search your plugins')).toEqual({ value: 'slow', same: false, focus: '' });
  await expect(thirdParty).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('li.card', { hasText: 'Slow start' })).toBeVisible();
  await expect(page.locator('li.card', { hasText: 'Trip record checks' })).toHaveCount(0);
});

// The same entry holds the chips and the query, and a move to the screen puts both away: Plugins, a chip on, Settings, Plugins again.
test("Plugins: a chip tapped is off again after a move away and back", async ({ page }) => {
  await slowInstalled(page);
  await page.evaluate(() => { location.hash = '#/plugins'; });
  const thirdParty = page.getByRole('button', { name: 'Third-party', exact: true });
  await thirdParty.click();
  await expect(thirdParty).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => { location.hash = '#/plugins'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
  await expect(thirdParty).toHaveAttribute('aria-pressed', 'false');
});

// A plugin still starting, its row on Plugins saying so, and a search typed (or typed and emptied) and let go: when the plugin has started, the
// row says On, the search as it was left. On b9b40d958 the draw waited for good: the search was typed in and no save stored it.
for (const emptied of [false, true]) {
  test(`Plugins: a plugin still starting, Search your plugins ${emptied ? 'typed and emptied' : 'typed'} and let go: when it has started, its row says On, and the search is as it was left (fails on b9b40d958)`, async ({ page }) => {
    await slowInstalled(page);
    await page.addInitScript(() => { /** @type {any} */ (globalThis).__hold = true; });
    await page.goto('/#/plugins');
    await page.reload();
    const row = page.locator('li.card', { hasText: 'Slow start' });
    await expect(row.getByText('On, but it didn\'t start')).toBeVisible();
    await typeIn(page, 'Search your plugins', 'slow');
    const search = page.getByLabel('Search your plugins', { exact: true });
    if (emptied) await search.fill('');
    await search.blur();
    await release(page);
    await expect(row.getByText('On', { exact: true })).toBeVisible();
    await expect(search).toHaveValue(emptied ? '' : 'slow');
  });
}

// Shiori's quiet hours save as the two times are both set; the save says so to the door, as an autosaved field does.
test("Shiori's quiet hours saved and let go: a draw of annai's own lands, and the times stay (fails on b9b40d958)", async ({ page }) => {
  await slowInstalled(page);
  await page.evaluate(() => { location.hash = '#/shiori'; });
  const from = page.getByLabel('Quiet from', { exact: true });
  const until = page.getByLabel('Quiet until', { exact: true });
  await from.fill('22:00');
  await until.fill('07:00');
  await from.evaluate((el) => { el.dataset.mine = '1'; });
  await until.blur();
  await expect(page.locator('.saved', { hasText: 'Saved' })).toBeVisible();
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
  await expect(from).not.toHaveAttribute('data-mine', '1');
  await expect(from).toHaveValue('22:00');
  await expect(until).toHaveValue('07:00');
});

// A provider page's "Filter the list" never saves anything: what is typed in it is a search, said `stored` at each keystroke as the finders do.
test("a provider's Filter the list typed and let go: the draw of a plugin that adds a page lands (fails on 799dd44a4: the filter held it for good)", async ({ page }) => {
  const key = 'sk-filter-stored-stand-in-0123';
  const s = await startFakeServer({ flavour: 'llamacpp', key, models: [{ id: 'qwen3.8-flash', object: 'model', owned_by: 'llamacpp' }, { id: 'gemma5-small', object: 'model', owned_by: 'llamacpp' }] });
  try {
    await slowInstalled(page);
    await page.evaluate(() => { location.hash = '#/models'; });
    await pickProvider(page, 'llama.cpp');
    await page.getByLabel('Address', { exact: true }).fill(`${s.origin}/v1`);
    await page.getByLabel('API key').fill(key);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /^saved/);
    await page.getByRole('button', { name: 'Fetch model list' }).click();
    await expect(page.getByText('2 models.')).toBeVisible();
    await typeIn(page, 'Filter the list', 'qwen');
    await page.getByLabel('Filter the list', { exact: true }).blur();
    await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
    // The draw lands: the filter is a new, empty box, and the list is not shown until it is asked for again.
    await expect(page.getByLabel('Filter the list', { exact: true })).toHaveCount(0, { timeout: 5000 });
  } finally {
    await s.stop();
  }
});

/** MCP servers with trail added, and a tap on its Refresh tools, which takes 3 s: a slow server, its tools in two pages, 1.5 s each. @param {import('@playwright/test').Page} page @param {{ url: string, slowList: (ms: number) => void }} mcp */
async function refreshing(page, mcp) {
  await openApp(page, '#/mcp');
  await waitForServiceWorker(page);
  await page.getByLabel('Name', { exact: true }).fill('trail');
  await page.getByLabel('Address', { exact: true }).fill(mcp.url);
  await page.getByRole('button', { name: 'Add server' }).click();
  await expect(page.getByRole('button', { name: 'Refresh tools' })).toBeVisible();
  mcp.slowList(1500);
  await page.getByRole('button', { name: 'Refresh tools' }).click();
}

/** The refresh has ended, and asked for its draw: its toast shows. @param {import('@playwright/test').Page} page */
const refreshed = (page) => expect(page.getByText(/^trail: \d+ tools?\.$/)).toBeVisible({ timeout: 20_000 });
/** What was typed after the tap on Refresh tools came before the refresh ended (it takes 3 s): its toast is not there yet. @param {import('@playwright/test').Page} page */
const stillRefreshing = (page) => expect(page.getByText(/^trail: \d+ tools?\.$/)).toHaveCount(0);

test("Settings → Tools → MCP servers: Refresh tools ends while the address of a new server is typed; the screen waits for the field, and for what it holds once let go (fails on main)", async ({ page }) => {
  const mcp = await startMcpServer({});
  try {
    await refreshing(page, mcp);
    await typeIn(page, 'Address', 'https://next.example/mcp');
    await stillRefreshing(page);
    await refreshed(page);
    await later(page);
    expect(await fieldNow(page, 'Address')).toEqual({ value: 'https://next.example/mcp', same: true, focus: 'mcp-address' });
    // Let go, what was typed after the tap on Refresh is still the traveller's: the screen still waits.
    await page.getByLabel('Address', { exact: true }).blur();
    await later(page);
    expect(await fieldNow(page, 'Address')).toEqual({ value: 'https://next.example/mcp', same: true, focus: '' });
  } finally {
    await mcp.stop();
  }
});

// Fix round 1: each below failed on 20656a0ea, where a draw that waited for the traveller came at their next field or tap, and copied only
// the text over.

test("MCP: with the draw of Refresh tools waiting for the new server's Name, the caret moved to its Address keeps the screen: the keys typed there go in", async ({ page }) => {
  const mcp = await startMcpServer({});
  try {
    await refreshing(page, mcp);
    await typeIn(page, 'Name', 'next');
    await stillRefreshing(page);
    await refreshed(page);
    const address = page.getByLabel('Address', { exact: true });
    await address.click();
    await later(page);
    await page.keyboard.type('https://next.example/mcp', { delay: 5 });
    expect(await fieldNow(page, 'Name')).toEqual({ value: 'next', same: true, focus: 'mcp-address' });
    await expect(address).toHaveValue('https://next.example/mcp');
  } finally {
    await mcp.stop();
  }
});

test("Turn on, which takes a while, ends with the caret put in its setting and nothing typed yet: the field, its caret and the keyboard stay", async ({ page }) => {
  await slowInstalled(page);
  await page.goto('/#/plugins/slow');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await page.evaluate(() => { /** @type {any} */ (globalThis).__hold = true; });
  await page.getByRole('button', { name: 'Turn on' }).click();
  const field = page.getByLabel('Server address', { exact: true });
  await field.click();
  await field.evaluate((el) => { el.dataset.mine = '1'; });
  await release(page);
  await later(page);
  expect(await fieldNow(page, 'Server address')).toEqual({ value: '', same: true, focus: 'setting-slow-address' });
  await page.keyboard.type('https://tides.example/api', { delay: 5 });
  await field.blur();
  await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();
  await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://tides.example/api');
});

test("MCP: with the draw of Refresh tools waiting, Add server tapped and refused: its words and what was typed stay", async ({ page }) => {
  const mcp = await startMcpServer({});
  try {
    await refreshing(page, mcp);
    await typeIn(page, 'Name', 'trail'); // taken: Add says so at once
    await typeIn(page, 'Address', 'https://next.example/mcp');
    await stillRefreshing(page);
    await refreshed(page);
    await page.getByRole('button', { name: 'Add server' }).click();
    const refused = page.getByText('There is a server called trail already.');
    await expect(refused).toBeVisible();
    await later(page);
    await expect(refused).toBeVisible();
    expect(await fieldNow(page, 'Name')).toMatchObject({ value: 'trail', same: true });
    expect(await fieldNow(page, 'Address')).toMatchObject({ value: 'https://next.example/mcp', same: true });
  } finally {
    await mcp.stop();
  }
});

test("MCP: with the draw of Refresh tools waiting, Remove tapped once stays armed for the second tap, and what was typed stays", async ({ page }) => {
  const mcp = await startMcpServer({});
  try {
    await refreshing(page, mcp);
    await typeIn(page, 'Name', 'next');
    await stillRefreshing(page);
    await refreshed(page);
    await page.getByRole('button', { name: 'Remove' }).click();
    const armed = page.locator('.two-step > span:not(.off)', { hasText: 'Tap again to remove' });
    await expect(armed).toBeVisible();
    await later(page);
    await expect(armed).toBeVisible();
    expect(await fieldNow(page, 'Name')).toMatchObject({ value: 'next', same: true });
  } finally {
    await mcp.stop();
  }
});

test("MCP: with the draw of Refresh tools waiting, a Bearer token picked and typed for the new server: the choice, the token and the rest stay", async ({ page }) => {
  const mcp = await startMcpServer({});
  try {
    await refreshing(page, mcp);
    await typeIn(page, 'Name', 'next');
    await typeIn(page, 'Address', 'https://next.example/mcp');
    await page.getByRole('combobox', { name: 'Key' }).selectOption('token');
    await typeIn(page, 'Token', 'sk-next-0123456789');
    await page.getByLabel('Token', { exact: true }).blur();
    await stillRefreshing(page);
    await refreshed(page);
    await later(page);
    await expect(page.getByRole('combobox', { name: 'Key' })).toHaveValue('token');
    expect(await fieldNow(page, 'Token')).toEqual({ value: 'sk-next-0123456789', same: true, focus: '' });
    await expect(page.getByLabel('Token', { exact: true })).toBeVisible();
    expect(await fieldNow(page, 'Name')).toMatchObject({ value: 'next', same: true });
    expect(await fieldNow(page, 'Address')).toMatchObject({ value: 'https://next.example/mcp', same: true });
  } finally {
    await mcp.stop();
  }
});

test("MCP: a choice made and nothing typed (Key: Headers), then a plugin adds a page: its draw waits, and the choice stays", async ({ page }) => {
  await slowInstalled(page);
  await page.evaluate(() => { location.hash = '#/mcp'; });
  const kind = page.getByRole('combobox', { name: 'Key' });
  await kind.selectOption('headers');
  await kind.evaluate((el) => { el.dataset.mine = '1'; });
  await kind.blur();
  await page.evaluate(() => (/** @type {any} */ (globalThis)).__addPage());
  await later(page);
  await expect(kind).toHaveValue('headers');
  await expect(kind).toHaveAttribute('data-mine', '1');
  await expect(page.getByLabel('Headers, one "Name: value" a line', { exact: true })).toBeVisible();
});

// annai served from a port of the test's own, with a new Remote trace in its catalog once the test says (as updates.spec.js does).
const root = new URL('../../', import.meta.url);
/** @type {Record<string, string>} */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };

/** @param {() => Promise<void>} held what a request for the catalog waits for */
async function startSite(held) {
  const rules = parseHeaders(await readFile(new URL('_headers', root), 'utf8'));
  /** @type {Map<string, string>} */
  const changed = new Map();
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.endsWith('/') ? `${path}index.html` : path;
    for (const [k, v] of headersFor(rules, path)) res.setHeader(k, v);
    try {
      if (file === '/catalog/plugins.json') await held();
      const body = changed.get(file) ?? await readFile(new URL(`.${file}`, root));
      res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    origin: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    changed,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
}

/** annai ships the next patch of Remote trace: the site's catalog lists it. @param {{ changed: Map<string, string> }} site @returns {Promise<string>} its version */
async function shipNextPatch(site) {
  const manifest = JSON.parse(await readFile(new URL('plugins-official/remote-trace/annai-plugin.json', root), 'utf8'));
  const bumped = manifest.version.replace(/\d+$/, (/** @type {string} */ n) => String(Number(n) + 1));
  const next = `${JSON.stringify({ ...manifest, version: bumped }, null, 2)}\n`;
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const entry = catalog.plugins.find((/** @type {any} */ p) => p.id === 'remote-trace');
  Object.assign(entry, { version: bumped, files: { ...entry.files, 'annai-plugin.json': createHash('sha256').update(next).digest('hex') } });
  site.changed.set('/plugins-official/remote-trace/annai-plugin.json', next);
  site.changed.set('/catalog/plugins.json', JSON.stringify(catalog));
  return bumped;
}

test("an update check that ends while a setting is typed: the page waits for the field, then offers the update (held on main already)", async ({ page }) => {
  /** @type {() => void} */
  let open = () => {};
  let hold = false;
  const gate = new Promise((resolve) => { open = () => resolve(undefined); });
  const site = await startSite(() => (hold ? gate.then(() => {}) : Promise.resolve()));
  try {
    await page.goto(`${site.origin}/#/add`);
    await waitForServiceWorker(page);
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
    const bumped = await shipNextPatch(site);
    // The check starts on Updates and waits for the catalog; the traveller goes to the plugin's page and types its server's address.
    hold = true;
    await page.evaluate(() => { location.hash = '#/updates'; });
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.evaluate(() => { location.hash = '#/plugins/remote-trace'; });
    await typeIn(page, 'Server address', 'https://sink.example/trace');
    open();
    await later(page);
    expect(await fieldNow(page, 'Server address')).toEqual({ value: 'https://sink.example/trace', same: true, focus: 'setting-remote-trace-server' });
    await page.getByLabel('Server address', { exact: true }).blur();
    await expect(page.getByRole('button', { name: `Update to ${bumped}` })).toBeVisible();
    await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://sink.example/trace');
  } finally {
    await site.stop();
  }
});

// Update's button says what it did: after an update that went through it says Updated, as a listed Add says Added, and does not come back while the
// plugin's row stays (its draw waits for what is typed after the tap); a second tap would download and install the same version again.
test("Update tapped, with a setting typed after the tap: when the update has gone through, the button says Updated and a second tap is not offered (fails on 799dd44a4)", async ({ page }) => {
  const site = await startSite(() => Promise.resolve());
  try {
    await page.goto(`${site.origin}/#/add`);
    await waitForServiceWorker(page);
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
    const bumped = await shipNextPatch(site);
    await page.evaluate(() => { location.hash = '#/updates'; });
    await page.getByRole('button', { name: 'Check now' }).click();
    await page.evaluate(() => { location.hash = '#/plugins/remote-trace'; });
    const update = page.getByRole('button', { name: `Update to ${bumped}` });
    await expect(update).toBeVisible();
    // The tap, and a setting typed in the same turn, after it: the draw the update asks for waits for the field.
    await update.evaluate((b) => {
      const input = /** @type {HTMLInputElement} */ (document.getElementById('setting-remote-trace-server'));
      /** @type {HTMLElement} */ (b).click();
      input.value = 'https://sink.example/trace';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByRole('button', { name: 'Updated', exact: true })).toBeDisabled({ timeout: 20_000 });
    await later(page);
    await expect(page.getByRole('button', { name: 'Updated', exact: true })).toBeDisabled(); // the draw waits for the field: nothing has put the row right
    await expect(page.getByRole('button', { name: `Update to ${bumped}` })).toHaveCount(0);
    await expect(page.getByLabel('Server address', { exact: true })).toHaveValue('https://sink.example/trace');
  } finally {
    await site.stop();
  }
});
