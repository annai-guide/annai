import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { VERSION } from '../../src/app/version.js';

const root = new URL('../../', import.meta.url);

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
  const expected = ['/', '/index.html', '/manifest.webmanifest', ...(await walk('src')), ...(await walk('assets')), ...(await walk('skills'))].sort();
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
  vm.runInNewContext(source, { self, caches, Request: SwRequest, Response, URL, console });
  /** @type {Promise<unknown> | undefined} */
  let done;
  handlers.install({ waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
  await done;
  assert.ok(added.length > 10);
  for (const r of added) assert.equal(r instanceof Request ? r.cache : 'default', 'reload', `${r instanceof Request ? r.url : r} is fetched through the HTTP cache`);
});
