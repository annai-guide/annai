import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply } from './helpers.js';

// Updates (the user, 2026-10-18): "currently I need to close the added to homescreen app and reopen for annai
// to check for updates." annai checks when it comes back to the screen, and Settings → Updates checks on a tap.

const root = new URL('../../', import.meta.url);
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8',
};
const SW = await readFile(new URL('sw.js', root), 'utf8');
const BUILD = /const BUILD = '([^']+)'/.exec(SW)?.[1];

/**
 * annai served from a port of the test's own, as scripts/serve.mjs serves it (its _headers too), except the
 * files the test puts in `changed`: a new sw.js, as if annai had shipped a new build, or a stand-in catalog.
 */
async function startSite() {
  const rules = parseHeaders(await readFile(new URL('_headers', root), 'utf8'));
  /** @type {Map<string, string>} */
  const changed = new Map();
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.endsWith('/') ? `${path}index.html` : path;
    for (const [k, v] of headersFor(rules, path)) res.setHeader(k, v);
    try {
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

/** The Settings sections' headings, top to bottom. @param {import('@playwright/test').Page} page */
const sections = (page) => page.locator('main .screen > section.panel > h2').allTextContents();
/** @param {import('@playwright/test').Page} page @param {string} hash */
const go = (page, hash) => page.evaluate((to) => { location.hash = to; }, hash);

test('a new build is found when annai comes back to the screen, without a reload; Restart now waits for Shiori to finish, then brings it', async ({ page }) => {
  const site = await startSite();
  const llm = await startModelServer({ '/b/v1/messages': [{ ...sse(anthropicToolReply([{ name: 'speak', input: { text: 'Low tide is at 5:40.' } }, { name: 'sleep', input: {} }])), delayMs: 4000 }] });
  try {
    await page.clock.install();
    await page.goto(`${site.origin}/#/updates`);
    await waitForServiceWorker(page);
    await expect(page.getByText(`annai 0.1.0 · build ${BUILD}`)).toBeVisible();
    // The check at start (annai's plugins; the browser checks annai itself as it opens the page).
    await expect(page.getByText('Last checked just now. Everything is up to date.')).toBeVisible({ timeout: 30_000 });
    // Coming back is checked at most every 15 minutes: the phone was set aside for 16.
    await page.clock.setSystemTime(Date.now() + 16 * 60_000);
    await go(page, '#/models');
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await go(page, '#/trips');
    await page.getByLabel('Trip name').fill('Big Sur');
    await page.getByRole('button', { name: 'Start trip' }).click();
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

    await page.evaluate(() => { /** @type {any} */ (window).__samePage = true; });
    site.changed.set('/sw.js', SW.replace(/const BUILD = '[^']+';/, "const BUILD = 'e2e-next';"));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const cards = page.getByRole('status');
    await expect(cards.getByText('An update is ready')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => /** @type {any} */ (window).__samePage)).toBe(true);
    // Settings lists Updates first while it waits; Settings → Updates offers Restart now.
    await go(page, '#/settings');
    await expect.poll(() => sections(page).then((s) => s[0])).toBe('Updates');
    await expect(page.getByRole('region', { name: 'Updates' })).toContainText('A new version of annai is ready.');
    await page.getByRole('region', { name: 'Updates' }).getByRole('link', { name: 'Updates' }).click();
    await expect(page.getByRole('region', { name: 'A new version of annai' }).getByRole('button', { name: 'Restart now' })).toBeVisible();

    // Restart now during Shiori's turn waits for it to end (spec §17 rule 5).
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('When is low tide?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    const reloaded = page.waitForEvent('load', { timeout: 30_000 });
    await cards.locator('.notice', { hasText: 'An update is ready' }).getByRole('button', { name: 'Restart now' }).click();
    await expect(cards.getByText('annai restarts once Shiori has finished')).toBeVisible();
    await reloaded;
    await expect(page.locator('.convo .shiori p')).toHaveText('Low tide is at 5:40.');
    await go(page, '#/updates');
    await expect(page.getByText('annai 0.1.0 · build e2e-next')).toBeVisible();
    await expect(page.getByRole('region', { name: 'A new version of annai' })).toHaveCount(0);
  } finally {
    await llm.stop();
    await site.stop();
  }
});

test('Settings → Updates shows the build running and says when everything is up to date; About and Settings link to it', async ({ page }) => {
  await openApp(page, '#/settings');
  await waitForServiceWorker(page);
  expect(await sections(page)).toEqual(['Models', 'Voice', 'Notifications', 'Backup', 'Shiori', 'Languages', 'Photos', 'Tools', 'Plugins', 'Storage',
    'Updates', 'About', 'Diagnostics', 'Developer', 'Experimental', 'Erase']);
  await page.getByRole('link', { name: 'About annai' }).click();
  await page.getByRole('link', { name: 'Check for updates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Updates' })).toBeVisible();
  await expect(page.getByText(`annai 0.1.0 · build ${BUILD}`)).toBeVisible();
  await expect(page.getByText('Last checked just now. Everything is up to date.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Last checked just now. Everything is up to date.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test("Check now finds an official plugin's update in annai's catalog; Settings lists Updates first while it waits; Update applies it", async ({ page }) => {
  const site = await startSite();
  try {
    await page.goto(`${site.origin}/#/add`);
    await waitForServiceWorker(page);
    await page.getByRole('button', { name: 'Install Remote trace (for developers)' }).click();
    await expect(page.getByText('Installed Remote trace (for developers).')).toBeVisible();
    // annai ships the next patch of Remote trace: a new manifest, and the catalog's entry for it.
    const manifest = JSON.parse(await readFile(new URL('plugins-official/remote-trace/annai-plugin.json', root), 'utf8'));
    const now = manifest.version;
    const bumped = now.replace(/\d+$/, (/** @type {string} */ n) => String(Number(n) + 1));
    const next = `${JSON.stringify({ ...manifest, version: bumped }, null, 2)}\n`;
    const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
    const entry = catalog.plugins.find((/** @type {any} */ p) => p.id === 'remote-trace');
    Object.assign(entry, { version: bumped, files: { ...entry.files, 'annai-plugin.json': createHash('sha256').update(next).digest('hex') } });
    site.changed.set('/plugins-official/remote-trace/annai-plugin.json', next);
    site.changed.set('/catalog/plugins.json', JSON.stringify(catalog));

    await go(page, '#/updates');
    await page.getByRole('button', { name: 'Check now' }).click();
    const plugins = page.getByRole('region', { name: 'Plugins' });
    await expect(plugins.locator('.card', { hasText: `Remote trace (for developers) ${now} → ${bumped}` })).toBeVisible();
    await expect(page.getByText('Last checked just now.', { exact: true })).toBeVisible();
    await go(page, '#/settings');
    await expect.poll(() => sections(page).then((s) => s[0])).toBe('Updates');
    await expect(page.getByRole('region', { name: 'Updates' })).toContainText('Plugin updates are ready: Remote trace (for developers).');

    await go(page, '#/updates');
    await plugins.getByRole('button', { name: `Update to ${bumped}` }).click();
    // Its old code ran this session: the new one runs from the next start.
    await expect(page.getByText('Restart annai to use the new versions')).toBeVisible();
    await expect(plugins.getByText('Restart annai to run the new version of Remote trace (for developers).')).toBeVisible();
    await expect(plugins.locator('.card')).toHaveCount(0);
    await expect(plugins.getByRole('button', { name: 'Restart annai' })).toBeVisible();
    const reloaded = page.waitForEvent('load');
    await page.getByRole('status').locator('.notice', { hasText: 'Restart annai to use the new versions' }).getByRole('button', { name: 'Restart now' }).click();
    await reloaded;
    await expect(page.getByText('Last checked just now. Everything is up to date.')).toBeVisible({ timeout: 30_000 });
    await go(page, '#/plugins');
    await expect(page.locator('.card', { hasText: `Remote trace (for developers) ${bumped}` }).getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    await site.stop();
  }
});
