import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { waitForServiceWorker } from './helpers.js';

// annai's own plugins carry no translations in their packages (plugin-l10n-fetch; the user, 2026-10-28: "Build per-language fetch
// first"): a phone fetches its official plugins' words in its screens' language only, from beside the catalog, checked against the
// hash catalog/l10n/<tag>.json lists. Remote trace stands for every official plugin: no code names it.

const root = new URL('../../', import.meta.url);
/** @type {Record<string, string>} */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };

/**
 * annai served from a port of the test's own, as scripts/serve.mjs serves it (its _headers too). asked: every path that reached the
 * server, the service worker's requests too; changed: files served in place of the repository's; failing: paths answered 503.
 */
async function startSite() {
  const rules = parseHeaders(await readFile(new URL('_headers', root), 'utf8'));
  const site = {
    /** @type {string[]} */ asked: [],
    /** @type {Map<string, string>} */ changed: new Map(),
    /** @type {Set<string>} */ failing: new Set(),
    origin: '',
    /** Paths asked for that start so. @param {string} prefix */
    under: (prefix) => site.asked.filter((p) => p.startsWith(prefix)),
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    site.asked.push(path);
    const file = path.endsWith('/') ? `${path}index.html` : path;
    for (const [k, v] of headersFor(rules, path)) res.setHeader(k, v);
    if (site.failing.has(path)) return void res.writeHead(503).end('unavailable');
    try {
      const body = site.changed.get(file) ?? await readFile(new URL(`.${file}`, root));
      res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  site.origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return site;
}

/** @param {import('@playwright/test').Page} page @param {string} hash */
const go = (page, hash) => page.evaluate((to) => { location.hash = to; }, hash);
const JA_WORDS = '/catalog/l10n/ja/remote-trace.json';
const JA = JSON.parse(await readFile(new URL(`.${JA_WORDS}`, root), 'utf8'));
const ZH = JSON.parse(await readFile(new URL('./catalog/l10n/zh-Hans/remote-trace.json', root), 'utf8'));
const EN = JSON.parse(await readFile(new URL('./plugins-official/remote-trace/annai-plugin.json', root), 'utf8'));

/**
 * Installs Remote trace from Add, as the user does, once the service worker serves the page. names: the screens' words for its
 * button and the toast that says it is installed. @param {import('@playwright/test').Page} page @param {any} site
 * @param {{ install: string, installed: string }} names
 */
async function install(page, site, names) {
  await page.goto(`${site.origin}/#/add?kind=developer`);
  await waitForServiceWorker(page);
  await page.getByRole('button', { name: names.install }).click();
  await expect(page.getByText(names.installed)).toBeVisible({ timeout: 30_000 });
}
/** Its page's description: the page's one paragraph with no class and no link. @param {import('@playwright/test').Page} page */
const description = async (page) => {
  await go(page, '#/plugins/remote-trace');
  return page.locator('.plugin-page > p:not([class])').filter({ hasNot: page.locator('a') });
};
/**
 * Settings → Updates → Check now, until this check is over (its own request for the catalog, and the button back): the line that
 * everything is up to date may be the start's own check's. words: "Check now" and "Everything is up to date." on the screens.
 * @param {import('@playwright/test').Page} page @param {any} site @param {[string, string]} words
 */
async function checkNow(page, site, [check, current]) {
  await go(page, '#/updates');
  const before = site.under('/catalog/plugins.json').length;
  await page.getByRole('button', { name: check }).click();
  await expect.poll(() => site.under('/catalog/plugins.json').length, { timeout: 30_000 }).toBeGreaterThan(before);
  await expect(page.getByRole('button', { name: check })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText(current, { exact: false })).toBeVisible();
}
const JA_NAMES = { install: 'リモート記録（開発者向け）をインストール', installed: 'リモート記録（開発者向け）をインストールしました。' };
/** @type {[string, string]} */
const JA_CHECK = ['今すぐ確認', 'すべて最新です。'];

test.describe('on Japanese screens', () => {
  test.use({ locale: 'ja-JP' });

  test("installing an official plugin fetches its Japanese only, once; it shows on its page, and the plugin is still annai's own, current", async ({ page }) => {
    const site = await startSite();
    try {
      await install(page, site, JA_NAMES);
      expect(site.under(JA_WORDS)).toHaveLength(1);
      expect(site.under('/catalog/l10n/').filter((p) => !p.startsWith('/catalog/l10n/ja')), 'no other language').toEqual([]);
      expect(site.under('/catalog/l10n/ja/'), 'no other plugin').toEqual([JA_WORDS]);
      expect(site.under('/plugins-official/remote-trace/l10n/'), 'its package has none').toEqual([]);
      const own = await description(page);
      await expect(own).toHaveText(JA.manifest.description);
      expect(await own.getAttribute('lang')).toBeNull();
      await expect(page.getByText(JA.manifest['settings.properties.device.title'], { exact: true })).toBeVisible();
      // Its translation isn't its package: a check finds nothing changed, and fetches its words no more.
      await checkNow(page, site, JA_CHECK);
      expect(site.under(JA_WORDS)).toHaveLength(1);
    } finally {
      await site.stop();
    }
  });

  test("a translation the catalog lists with a new hash is fetched alone at the next check: no update is offered, and the plugin shows it", async ({ page }) => {
    const site = await startSite();
    try {
      await install(page, site, JA_NAMES);
      // annai ships a fix to the Japanese words alone: the file, and its hash in the language's catalog.
      const fixed = `${JSON.stringify({ ...JA, manifest: { ...JA.manifest, description: '開発者向け：テスト用に直した説明。annai の記録を送ります。' } }, null, 2)}\n`;
      const list = JSON.parse(await readFile(new URL('./catalog/l10n/ja.json', root), 'utf8'));
      list.translations['remote-trace'] = createHash('sha256').update(fixed).digest('hex');
      site.changed.set(JA_WORDS, fixed);
      site.changed.set('/catalog/l10n/ja.json', JSON.stringify(list));
      site.asked.length = 0;
      await checkNow(page, site, JA_CHECK);
      expect(site.under(JA_WORDS)).toHaveLength(1);
      expect(site.under('/plugins-official/'), 'no package file').toEqual([]);
      await expect(page.getByText('プラグインのアップデートがあります')).toHaveCount(0);
      await expect(await description(page)).toHaveText('開発者向け：テスト用に直した説明。annai の記録を送ります。');
    } finally {
      await site.stop();
    }
  });

  test('a translation that fails to come leaves the English, marked, and installs anyway; the next check gets it', async ({ page }) => {
    const site = await startSite();
    try {
      site.failing.add(JA_WORDS);
      await install(page, site, JA_NAMES);
      const own = await description(page);
      await expect(own).toHaveText(EN.description);
      await expect(own).toHaveAttribute('lang', 'en');
      site.failing.clear();
      await checkNow(page, site, JA_CHECK);
      const after = await description(page);
      await expect(after).toHaveText(JA.manifest.description);
      expect(await after.getAttribute('lang')).toBeNull();
    } finally {
      await site.stop();
    }
  });

  test("choosing 简体中文 fetches its words before the restart; the plugin opens in it, and nothing is fetched again", async ({ page }) => {
    const site = await startSite();
    try {
      await install(page, site, JA_NAMES);
      await go(page, '#/languages');
      const restarted = page.waitForEvent('load');
      await page.locator('#language-ui').selectOption('zh-Hans');
      await restarted;
      await expect(page.locator('html')).toHaveAttribute('lang', /^zh-Hans/);
      await expect(await description(page)).toHaveText(ZH.manifest.description);
      // The restart's own check finds its words current.
      await expect.poll(() => site.under('/catalog/l10n/zh-Hans.json').length).toBeGreaterThan(1);
      expect(site.under('/catalog/l10n/zh-Hans/remote-trace.json')).toHaveLength(1);
    } finally {
      await site.stop();
    }
  });
});

test('an English phone fetches no translation of an official plugin', async ({ page }) => {
  const site = await startSite();
  try {
    await install(page, site, { install: 'Install Remote trace (for developers)', installed: 'Installed Remote trace (for developers).' });
    await checkNow(page, site, ['Check now', 'Everything is up to date.']);
    await expect(await description(page)).toHaveText(EN.description);
    expect(site.under('/catalog/l10n/')).toEqual([]);
  } finally {
    await site.stop();
  }
});
