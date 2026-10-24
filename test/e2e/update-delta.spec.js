import { test, expect } from '@playwright/test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseHeaders, headersFor } from '../../scripts/headers.mjs';
import { brotli, TEXT } from '../../scripts/build-release.mjs';
import { waitForServiceWorker } from './helpers.js';

// "Updates fetch only changes" (the user, 2026-10-23): the service worker keeps each file's hash and copies unchanged files from
// the old version, so an update downloads only what changed. The worker runs as in production (DEV off), from a site of the test's own.

const root = new URL('../../', import.meta.url);
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8',
};
const SW = (await readFile(new URL('sw.js', root), 'utf8')).replace(/^const DEV = .*;$/m, 'const DEV = false;');
const SHELL = new Set([...(/const SHELL = \[([\s\S]*?)\];/.exec(SW)?.[1] ?? '').matchAll(/'(\/[^']*)'/g)].map((m) => m[1]));
const MANIFEST = JSON.parse(await readFile(new URL('shell.json', root), 'utf8'));
const HEADERS = await readFile(new URL('_headers', root), 'utf8');
/** The pages: fetched by every install, as their headers carry the site's policy of the version that has them. */
const PAGES = ['/', '/index.html', '/src/ui/grounding.html'];

/** Each text file's brotli form, made once for its bytes (quality 11, as a release's), by path. @type {Map<string, { own: Buffer, br: Buffer }>} */
const packed = new Map();

/**
 * The repository served as a release is (scripts/serve.mjs, with its .br forms), but for the files in `changed`; each request's
 * path and the bytes sent for it are logged.
 */
async function startSite() {
  const state = { up: true, rules: parseHeaders(HEADERS) };
  /** @type {Map<string, string | Buffer>} */
  const changed = new Map([['/sw.js', SW]]);
  /** @type {{ path: string, bytes: number }[]} */
  const log = [];
  const server = http.createServer(async (req, res) => {
    if (!state.up) {
      req.socket.destroy();
      return;
    }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.endsWith('/') ? `${path}index.html` : path;
    for (const [k, v] of headersFor(state.rules, path)) res.setHeader(k, v);
    try {
      const own = changed.get(file) ?? await readFile(new URL(`.${file}`, root));
      res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
      let body = typeof own === 'string' ? Buffer.from(own) : own;
      if (TEXT.test(file)) {
        if (!packed.get(file)?.own.equals(body)) packed.set(file, { own: body, br: brotli(body) });
        const { br } = /** @type {{ br: Buffer }} */ (packed.get(file));
        res.setHeader('Vary', 'Accept-Encoding');
        if (br.length < body.length && /\bbr\b/.test(String(req.headers['accept-encoding']))) {
          res.setHeader('Content-Encoding', 'br');
          body = br;
        }
      }
      log.push({ path, bytes: body.length });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    origin: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    changed, log, state,
    stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }),
  };
}

/** The requests an install made for the shell and its manifest (the page's own come from the cache, as in production). @param {{ path: string, bytes: number }[]} log */
const shellRequests = (log) => log.filter((r) => SHELL.has(r.path) || r.path === '/shell.json');

/** @typedef {Awaited<ReturnType<typeof startSite>>} Site */

/**
 * Ships a version whose sun.js ends with this line, and waits for its install; with no manifest, as annai was before it had one.
 * Returns the shell requests it made, and sw.js's.
 * @param {import('@playwright/test').Page} page @param {Site} site @param {string} build @param {string} line
 */
async function update(page, site, build, line, { manifest = true } = {}) {
  const sun = `${await readFile(new URL('src/core/sun.js', root), 'utf8')}\n${line}\n`;
  site.changed.set('/src/core/sun.js', sun);
  if (manifest) site.changed.set('/shell.json', JSON.stringify({ build, files: { ...MANIFEST.files, '/src/core/sun.js': createHash('sha256').update(sun).digest('hex').slice(0, 12) } }));
  else site.changed.set('/shell.json', '<html>not found</html>');
  site.changed.set('/sw.js', SW.replace(/^const BUILD = '[^']*';$/m, `const BUILD = '${build}';`));
  site.log.length = 0;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });
  await expect.poll(() => page.evaluate(async (b) => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.waiting?.state === 'installed' && !reg.installing && (await /** @type {any} */ (window).buildOf(reg.waiting)) === b;
  }, build), { timeout: 60_000 }).toBe(true);
  return { shell: shellRequests(site.log), sw: site.log.filter((r) => r.path === '/sw.js') };
}

/** The waiting version takes over, as Restart now has it. @param {import('@playwright/test').Page} page */
async function takeOver(page) {
  await page.evaluate(async () => { (await navigator.serviceWorker.getRegistration())?.waiting?.postMessage('skip-waiting'); });
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !reg?.waiting && reg?.active?.state === 'activated';
  }), { timeout: 30_000 }).toBe(true);
}

/** Puts window.buildOf(worker) in each page update() and the tests ask in: the build a worker says it is. @param {import('@playwright/test').Page} page */
const askable = (page) => page.addInitScript(() => {
  /** @type {any} */ (window).buildOf = (/** @type {ServiceWorker | null | undefined} */ w) => new Promise((resolve) => {
    const c = new MessageChannel();
    c.port1.onmessage = (e) => resolve(e.data.build);
    w?.postMessage('build', [c.port2]);
    setTimeout(() => resolve(null), 3000);
  });
});

const sum = (/** @type {{ bytes: number }[]} */ rs) => rs.reduce((n, r) => n + r.bytes, 0);

test('an update with one changed file downloads that file, the pages and the manifest, and the new version runs whole, offline too', async ({ page }, testInfo) => {
  const site = await startSite();
  await askable(page);
  try {
    await page.goto(`${site.origin}/#/trips`);
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await waitForServiceWorker(page);
    expect(shellRequests(site.log).some((r) => r.path === '/shell.json')).toBe(false); // a first install has nothing to copy from

    // Before: a one-file update with no manifest to go by downloads the whole shell, as every update did.
    const before = await update(page, site, 'b0b0b0b0b0b0', '// e2e: version B', { manifest: false });
    expect(new Set(before.shell.map((r) => r.path))).toEqual(new Set([...SHELL, '/shell.json']));
    // After: the next one-file update downloads that file, the pages and the manifest. It copies from B, the newest, which waits.
    const after = await update(page, site, 'c0c0c0c0c0c0', '// e2e: version C');
    expect(after.shell.map((r) => r.path).sort()).toEqual([...PAGES, '/shell.json', '/src/core/sun.js'].sort());
    console.log(`${testInfo.project.name}, bytes sent: a one-file update before ${sum(before.shell)} (${before.shell.length} requests), after ${sum(after.shell)} (${after.shell.length}); sw.js ${sum(after.sw)} each`);

    // C takes over, and runs from its cache: the changed file is C's, and with the site gone every other file is there.
    await takeOver(page);
    site.state.up = false;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    const running = await page.evaluate(async () => ({
      build: await /** @type {any} */ (window).buildOf(navigator.serviceWorker.controller), sun: await (await fetch('/src/core/sun.js')).text(), names: await caches.keys(),
    }));
    expect(running.build).toBe('c0c0c0c0c0c0');
    expect(running.sun).toContain('// e2e: version C');
    expect(running.names.filter((n) => n.startsWith('annai-shell-'))).toEqual(['annai-shell-0.1.0-c0c0c0c0c0c0']);
  } finally {
    await site.stop();
  }
});

test("a release that changes the site's policy with one file runs under the new policy: pages are never copied", async ({ page }) => {
  // As f3bc5d8 did: wss: joined connect-src (for live sessions), with a script, and index.html unchanged.
  const site = await startSite();
  site.state.rules = parseHeaders(HEADERS.replace(' wss: ws://localhost:* ws://127.0.0.1:*', ''));
  await askable(page);
  try {
    await page.goto(`${site.origin}/#/trips`);
    await waitForServiceWorker(page);
    site.state.rules = parseHeaders(HEADERS);
    await update(page, site, 'b0b0b0b0b0b0', '// e2e: version B');
    await takeOver(page);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    const policy = await page.evaluate(async () => {
      const pages = await Promise.all(['/', '/index.html'].map(async (p) => (await caches.match(p))?.headers.get('content-security-policy') ?? ''));
      // What the running page's policy does to a wss: connection.
      const wss = await new Promise((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => resolve(`blocked (${e.violatedDirective})`), { once: true });
        try {
          const w = new WebSocket('wss://127.0.0.1:9/');
          w.onerror = () => setTimeout(() => resolve('allowed'), 500);
        } catch (e) {
          resolve(`threw ${/** @type {Error} */ (e).name}`);
        }
        setTimeout(() => resolve('allowed'), 4000);
      });
      return { pages: pages.map((c) => c.includes(' wss: ')), wss };
    });
    expect(policy).toEqual({ pages: [true, true], wss: 'allowed' });
  } finally {
    await site.stop();
  }
});
