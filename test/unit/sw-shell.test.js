import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { VERSION } from '../../src/app/version.js';

const root = new URL('../../', import.meta.url);
/** The pseudo-locales are made at load in development only, and are not shipped (localization design, "Tests"). */
const PSEUDO = '/src/core/l10n-pseudo.js';

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(`/${p}`);
  }
  return out;
}

test('the service worker caches exactly the files the app ships', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const shell = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  // LICENSE too, so Settings → About → Read the licence works offline.
  const expected = ['/', '/index.html', '/manifest.webmanifest', '/LICENSE', ...(await walk('src')).filter((p) => p !== PSEUDO), ...(await walk('assets')), ...(await walk('skills'))].sort();
  assert.deepEqual(shell, expected);
});

test('one version everywhere', async () => {
  const sw = await readFile(new URL('sw.js', root), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(/const VERSION = '([^']+)'/.exec(sw)?.[1], VERSION);
  assert.equal(pkg.version, VERSION);
});

test('the manifest is installable and offers the share target', async () => {
  const m = JSON.parse(await readFile(new URL('manifest.webmanifest', root), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((/** @type {any} */ i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.equal(m.share_target.action, '/share-target');
  assert.ok(m.share_target.params.files[0].accept.includes('image/*'), 'photos can be shared to annai');
});

test('installing fetches the shell past the HTTP cache, so an update never stores stale files', async () => {
  const source = await readFile(new URL('sw.js', root), 'utf8');
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  /** @type {any[]} */
  let added = [];
  const self = { location: new URL('https://annai.guide/sw.js'), addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; } };
  const caches = { open: async () => ({ addAll: async (/** @type {any[]} */ reqs) => { added = reqs; } }) };
  // In a service worker, relative URLs resolve against its own location.
  class SwRequest extends Request {
    constructor(/** @type {string} */ u, /** @type {RequestInit} */ init) { super(new URL(u, self.location.href), init); }
  }
  vm.runInNewContext(source, { self, caches, Request: SwRequest, Response, URL, console, setTimeout: () => 0 });
  /** @type {Promise<unknown> | undefined} */
  let done;
  handlers.install({ waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
  await done;
  assert.ok(added.length > 10);
  for (const r of added) assert.equal(r instanceof Request ? r.cache : 'default', 'reload', `${r instanceof Request ? r.url : r} is fetched through the HTTP cache`);
});

test('the service worker tells a page its build, on the port the page sends, for Settings → About', async () => {
  const source = await readFile(new URL('sw.js', root), 'utf8');
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  const self = { location: new URL('https://annai.guide/sw.js'), addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; }, skipWaiting: () => {} };
  vm.runInNewContext(source, { self, caches: {}, Request, Response, URL, console });
  /** @type {any[]} */
  const said = [];
  handlers.message({ data: 'build', ports: [{ postMessage: (/** @type {any} */ m) => said.push(m) }] });
  // Through JSON: the object comes from the worker's own realm.
  assert.deepEqual(JSON.parse(JSON.stringify(said)), [{ version: VERSION, build: /const BUILD = '([^']+)'/.exec(source)?.[1] }]);
  // Anything else, or no port, is ignored.
  handlers.message({ data: 'build', ports: [] });
  handlers.message({ data: 'something else', ports: [{ postMessage: (/** @type {any} */ m) => said.push(m) }] });
  assert.equal(said.length, 1);
});

test("a page opens as the app, except the frame Google's search suggestions are drawn in, which is a page of its own (G4)", async () => {
  const source = await readFile(new URL('sw.js', root), 'utf8');
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  const self = { location: new URL('https://annai.guide/sw.js'), addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; } };
  // The cache holds each shipped file under its path.
  const caches = { open: async () => ({ match: async (/** @type {any} */ r) => new Response(new URL(typeof r === 'string' ? r : r.url, 'https://annai.guide').pathname) }) };
  vm.runInNewContext(source, { self, caches, Request, Response, URL, console, fetch: async () => new Response('network') });
  /** @param {string} path @param {string} mode */
  const open = async (path, mode) => {
    /** @type {Promise<Response> | undefined} */
    let answer;
    handlers.fetch({ request: { url: `https://annai.guide${path}`, method: 'GET', mode }, respondWith: (/** @type {Promise<Response>} */ p) => { answer = p; } });
    return (await /** @type {Promise<Response>} */ (answer)).text();
  };
  assert.equal(await open('/trips', 'navigate'), '/index.html');
  assert.equal(await open('/src/ui/grounding.html', 'navigate'), '/src/ui/grounding.html');
  assert.equal(await open('/src/ui/grounding.js', 'no-cors'), '/src/ui/grounding.js');
});
