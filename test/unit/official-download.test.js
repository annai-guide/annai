import { test } from 'node:test';
import assert from 'node:assert/strict';
import { download, installOfficial, DOWNLOADS_AT_ONCE } from '../../src/core/llm/official.js';
import { sha256Hex } from '../../src/core/hash.js';

const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s);
/** A catalog entry of n files f0.js…, with one hash wrong when bad is given. @param {number} n @param {number} [bad] */
async function entryOf(n, bad) {
  /** @type {Record<string, string>} */ const files = {};
  for (let i = 0; i < n; i++) files[`f${i}.js`] = i === bad ? '0'.repeat(64) : await sha256Hex(bytes(`f${i}`));
  return /** @type {any} */ ({ id: 'many', name: 'Many', version: '0.1.0', files });
}
/** A stub fetch that serves each file after a few ms, and counts requests in flight. @param {Record<string, number>} [status] */
function stub(status = {}) {
  const s = { now: 0, most: 0, started: /** @type {string[]} */ ([]), fetch: /** @type {any} */ (null) };
  s.fetch = async (/** @type {string} */ url) => {
    const name = decodeURIComponent(url.split('/').pop() ?? '');
    s.started.push(name);
    s.most = Math.max(s.most, ++s.now);
    await new Promise((r) => setTimeout(r, 5));
    s.now--;
    return new Response(bytes(name.replace(/\.js$/, '')), { status: status[name] ?? 200 });
  };
  return /** @type {any} */ (s);
}

test("an official plugin's files come six at a time, every one checked, in the catalog's order", async () => {
  const s = stub();
  const files = await download(await entryOf(20), { fetch: s.fetch });
  assert.equal(DOWNLOADS_AT_ONCE, 6);
  assert.equal(s.most, 6);
  assert.deepEqual([...files.keys()], Array.from({ length: 20 }, (_, i) => `f${i}.js`));
});

test("one file that doesn't match the catalog installs nothing, with the same words, and nothing starts after it", async () => {
  const s = stub();
  /** @type {any[]} */ const installed = [];
  const host = /** @type {any} */ ({ install: async (/** @type {any} */ f) => { installed.push(f); }, start: async () => {} });
  await assert.rejects(installOfficial(host, await entryOf(20, 7), { fetch: s.fetch }), /wasn't installed: f7\.js doesn't match annai's catalog/);
  assert.deepEqual(installed, []);
  assert.ok(s.started.length < 20, 'the rest were not asked for');
  const after = s.started.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.started.length, after, 'no request starts after the failure');
});

test('a file the site refuses: the same words as before, naming it', async () => {
  await assert.rejects(download(await entryOf(10), { fetch: stub({ 'f3.js': 404 }).fetch }), /couldn't be downloaded \(f3\.js: HTTP 404\)/);
});
