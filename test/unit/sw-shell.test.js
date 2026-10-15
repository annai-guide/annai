import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
  const expected = ['/', '/index.html', '/manifest.webmanifest', ...(await walk('src')), ...(await walk('assets'))].sort();
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
});
