import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { download, installOfficial, ensureProvided, officialPlugins, DOWNLOADS_AT_ONCE, QUIET_MS } from '../../src/core/llm/official.js';
import { messageOf } from '../../src/ui/dom.js';
import { sha256Hex } from '../../src/core/hash.js';
import { setWords } from '../../src/core/l10n.js';
import { hostKit } from './package-kit.js';
import { site } from './provider-kit.js';
import { dead, watch, turns } from './dead-kit.js';

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

test("what a screen shows of a download that failed names the plugin, as a sentence with its full stop (words-next: a bare 'It' read as the place being added)", async () => {
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(download(await entryOf(3), { fetch: offline }), (/** @type {any} */ e) => messageOf(e) === "The plugin couldn't be downloaded. Check the connection and try again.");
  await assert.rejects(download(await entryOf(10), { fetch: stub({ 'f3.js': 404 }).fetch }), (/** @type {any} */ e) => messageOf(e) === "The plugin couldn't be downloaded (f3.js: HTTP 404). Try again later.");
  await assert.rejects(download(await entryOf(20, 7), { fetch: stub().fetch }), (/** @type {any} */ e) => messageOf(e) === "The plugin wasn't installed: f7.js doesn't match annai's catalog.");
});

test("a plugin that starts and gives no type of the kind asked for: the screen says the plugin didn't provide it, by kind, with its full stop (words-next)", async () => {
  const host = /** @type {any} */ ({
    registry: { list: () => [], owner: () => undefined, isDisabled: () => false },
    builtins: new Map(),
    installed: async () => ({ hollow: { source: 'official', version: '1.0.0', enabled: true } }),
    verifyOfficial: async () => true,
    start: async () => {},
  });
  const catalog = { plugins: [{ id: 'hollow', name: 'Hollow', version: '1.0.0', files: {}, provides: { 'storage-type': ['void'], 'endpoint-type': ['void'] } }] };
  const fetch = async () => new Response(JSON.stringify(catalog));
  await assert.rejects(ensureProvided(host, 'storage-type', 'void', { fetch }), (/** @type {any} */ e) => messageOf(e) === "The plugin didn't provide a kind of backup place void.");
  await assert.rejects(ensureProvided(host, 'endpoint-type', 'void', { fetch }), (/** @type {any} */ e) => messageOf(e) === "The plugin didn't provide an endpoint type void.");
});

/**
 * annai's site on this machine, each request answered by answer(path, res): one that writes nothing leaves the request waiting, as a
 * connection gone dead does. asked: the paths requested. fetch: Node's own, counting in answered the answers it has had and in seen
 * the body bytes it has passed on.
 * @param {(path: string, res: import('node:http').ServerResponse) => void} answer
 */
async function siteOn(answer) {
  /** @type {string[]} */
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    answer(req.url ?? '', res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const s = {
    base: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    asked,
    seen: 0,
    answered: 0,
    /** @param {string} url @param {RequestInit} [init] */
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      s.answered++;
      const body = res.body?.pipeThrough(new TransformStream({ transform: (part, out) => { out.enqueue(part); s.seen += part.length; } }));
      return new Response(body, res);
    },
    // The 100 ms wait: Node's fetch can clear a finished test's timer after the next test's fake clock starts, and Node's mock clock
    // (v26.13.1) then drops whatever timer holds that place in the new clock's queue; 100 ms let 24 runs side by side end their
    // connections first (the re-read of dl-limit-next's round 2, 2026-11-17).
    close: async () => {
      server.closeAllConnections();
      server.close();
      await turns(() => false, 100);
    },
  };
  return s;
}

test("a dead connection ends after QUIET_MS of nothing, with the words annai shows for a download that failed: a request that never answers, and one that sends its headers and 1 KB and then nothing; the catalog's and a plugin's file (dl-limit-next: they waited until annai was restarted)", async (t) => {
  /** @type {'never' | 'headers'} */
  let how = 'never';
  const s = await siteOn((_path, res) => {
    if (how === 'never') return;
    res.writeHead(200);
    res.write(' '.repeat(1024));
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = await entryOf(1);
  for (const [shape, what, path, words] of /** @type {const} */ ([
    ['never', 'catalog', '/catalog/plugins.json', "annai's list of plugins couldn't be loaded. Check the connection and try again."],
    ['headers', 'catalog', '/catalog/plugins.json', "annai's list of plugins couldn't be loaded. Check the connection and try again."],
    ['never', 'file', '/plugins-official/many/f0.js', "The plugin couldn't be downloaded. Check the connection and try again."],
    ['headers', 'file', '/plugins-official/many/f0.js', "The plugin couldn't be downloaded. Check the connection and try again."],
  ])) {
    how = shape;
    s.asked.length = 0;
    s.seen = 0;
    const w = watch(/** @type {Promise<unknown>} */ (what === 'catalog' ? officialPlugins({ fetch: s.fetch, base: s.base }) : download(entry, { fetch: s.fetch, base: s.base })));
    // Asked; with headers, its first 1 KB read too, so the limit runs from the last thing that came.
    await turns(() => s.asked.includes(path) && (shape === 'never' || s.seen >= 1024));
    assert.ok(s.asked.includes(path) && (shape === 'never' || s.seen >= 1024), `${what} ${shape}: the request was made`);
    t.mock.timers.tick(QUIET_MS - 1);
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', `${what} ${shape}: still waiting just short of the limit`);
    t.mock.timers.tick(1);
    await turns(() => w.state !== 'pending');
    assert.equal(w.state, 'failed', `${what} ${shape}: ended at the limit`);
    assert.equal(messageOf(w.error), words, `${what} ${shape}`);
  }
});

test("a file whose parts come less than QUIET_MS apart is never cut, however long it takes in all: the limit is on silence, not on the whole request (on a real link PDF pages took 55 s whole at 400 kbps and 209 s at 100 kbps)", async (t) => {
  const parts = ['export const parts = [', "'one', 'two',", " 'three'];"];
  const entry = /** @type {any} */ ({ id: 'slow', name: 'Slow', version: '0.1.0', files: { 'big.js': await sha256Hex(bytes(parts.join(''))) } });
  /** @type {import('node:http').ServerResponse | undefined} */
  let reply;
  const s = await siteOn((_path, res) => {
    res.writeHead(200);
    res.flushHeaders();
    reply = res;
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(download(entry, { fetch: s.fetch, base: s.base }));
  await turns(() => reply !== undefined);
  let sent = 0;
  for (const part of parts) {
    t.mock.timers.tick(QUIET_MS - 1);
    /** @type {import('node:http').ServerResponse} */ (reply).write(part);
    sent += Buffer.byteLength(part);
    await turns(() => s.seen >= sent);
    assert.equal(w.state, 'pending', `after ${sent} bytes`);
  }
  /** @type {import('node:http').ServerResponse} */ (reply).end();
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', 'three times QUIET_MS - 1 in all, never QUIET_MS with nothing');
  assert.equal(new TextDecoder().decode(w.value?.get('big.js')), parts.join(''));
});

test("an install whose words' request goes dead still installs and starts, in English, once the limit ends that request: the words never hold the install line", async (t) => {
  setWords('ja', {});
  t.after(() => setWords('en', null));
  const ID = 'tide-tables';
  const k = await hostKit();
  const s = await site(
    { [ID]: { 'annai-plugin.json': JSON.stringify({ id: ID, name: 'Tide tables', version: '1.0.0', api: 2, entry: 'index.js', description: 'Tide tables for the coast.' }), 'index.js': 'export function activate() {}' } },
    { ja: { [ID]: { manifest: { description: '海岸の潮汐表。' }, messages: {} } } },
  );
  const words = `/catalog/l10n/ja/${ID}.json`;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const get = (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (url !== words) return s.fetch(url);
    s.asked.push(url);
    return dead(init, 'never');
  };
  const w = watch(installOfficial(k.host, s.entries[0], { fetch: get }));
  await turns(() => s.asked.includes(words));
  assert.ok(s.asked.includes(words), 'its words were asked for');
  t.mock.timers.tick(QUIET_MS);
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', String(w.error?.message ?? 'still waiting'));
  assert.ok(k.host.active.has(ID), 'it started');
  assert.equal(k.host.shownOf(ID).description, 'Tide tables for the coast.', 'in English: its Japanese can come with the next check');
});

test("an answer that comes QUIET_MS - 1 after its request, and each part of its body QUIET_MS - 1 after the one before, is never cut: what comes starts the silence again", async (t) => {
  const entry = /** @type {any} */ ({ id: 'late', name: 'Late', version: '0.1.0', files: { 'late.js': await sha256Hex(bytes('late')) } });
  /** @type {import('node:http').ServerResponse | undefined} */
  let reply;
  const s = await siteOn((_path, res) => {
    reply = res;
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(download(entry, { fetch: s.fetch, base: s.base }));
  await turns(() => reply !== undefined);
  t.mock.timers.tick(QUIET_MS - 1);
  /** @type {import('node:http').ServerResponse} */ (reply).writeHead(200).flushHeaders();
  await turns(() => s.answered === 1);
  assert.equal(s.answered, 1, 'its answer came');
  // Two writes, a tick between them and another before the end: the first part of the body must start the silence again as the answer did.
  t.mock.timers.tick(QUIET_MS - 1);
  /** @type {import('node:http').ServerResponse} */ (reply).write('la');
  await turns(() => s.seen >= 2);
  assert.equal(s.seen, 2, 'the first part of its body came');
  t.mock.timers.tick(QUIET_MS - 1);
  /** @type {import('node:http').ServerResponse} */ (reply).end('te');
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', String(w.error?.message ?? 'still waiting'));
  assert.equal(new TextDecoder().decode(w.value?.get('late.js')), 'late');
});

test("an install whose language index goes dead still installs and starts, in English, once the limit ends that request: the words never hold the install line", async (t) => {
  setWords('ja', {});
  t.after(() => setWords('en', null));
  const ID = 'tide-tables';
  const k = await hostKit();
  const s = await site(
    { [ID]: { 'annai-plugin.json': JSON.stringify({ id: ID, name: 'Tide tables', version: '1.0.0', api: 2, entry: 'index.js', description: 'Tide tables for the coast.' }), 'index.js': 'export function activate() {}' } },
    { ja: { [ID]: { manifest: { description: '海岸の潮汐表。' }, messages: {} } } },
  );
  const index = '/catalog/l10n/ja.json';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const get = (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (url !== index) return s.fetch(url);
    s.asked.push(url);
    return dead(init, 'never');
  };
  const w = watch(installOfficial(k.host, s.entries[0], { fetch: get }));
  await turns(() => s.asked.includes(index));
  assert.ok(s.asked.includes(index), 'the language index was asked for');
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => w.state !== 'pending', 50);
  assert.equal(w.state, 'pending', 'still waiting just short of the limit');
  t.mock.timers.tick(1);
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', String(w.error?.message ?? 'still waiting'));
  assert.ok(k.host.active.has(ID), 'it started');
  assert.equal(k.host.shownOf(ID).description, 'Tide tables for the coast.', 'in English: its Japanese can come with the next check');
});

test("a file whose answer waits behind another file that keeps coming is not a dead connection: on one connection an answer queues behind bytes already sent for other requests, so the silence counted is the site's (PDF pages at 400 kbps: small files waited up to 33 s while the connection was busy the whole time)", async (t) => {
  const big = ['aaaa', 'bbbb', 'cccc'];
  const entry = /** @type {any} */ ({ id: 'two', name: 'Two', version: '1.0.0', files: { 'big.bin': await sha256Hex(bytes(big.join(''))), 'small.js': await sha256Hex(bytes('ok')) } });
  /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */
  let bigBody;
  /** @type {((res: Response) => void) | undefined} */
  let answerSmall;
  let smallAborted = false;
  const get = (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => {
    if (url.endsWith('big.bin')) return Promise.resolve(new Response(new ReadableStream({ start: (c) => { bigBody = c; } })));
    return new Promise((resolve, fail) => {
      answerSmall = resolve;
      init?.signal?.addEventListener('abort', () => { smallAborted = true; fail(init.signal?.reason); }, { once: true });
    });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(download(entry, { fetch: get }));
  await turns(() => Boolean(bigBody && answerSmall));
  for (const part of big) {
    t.mock.timers.tick(QUIET_MS - 1);
    /** @type {ReadableStreamDefaultController<Uint8Array>} */ (bigBody).enqueue(bytes(part));
    await turns(() => false, 20);
  }
  /** @type {ReadableStreamDefaultController<Uint8Array>} */ (bigBody).close();
  /** @type {(res: Response) => void} */ (answerSmall)(new Response('ok'));
  await turns(() => w.state !== 'pending');
  assert.equal(smallAborted, false, 'the queued request was ended though the site kept sending');
  assert.equal(w.state, 'done', messageOf(w.error));
});

test("the silence is the site's across calls too: a catalog answer held while a file of another call streams is not ended, and ends only once the site has been quiet for QUIET_MS (a silence counted per call would have ended it, with the site busy the whole time)", async (t) => {
  const parts = ['aaaa', 'bbbb', 'cccc'];
  const entry = /** @type {any} */ ({ id: 'busy', name: 'Busy', version: '0.1.0', files: { 'big.js': await sha256Hex(bytes(parts.join(''))) } });
  /** @type {import('node:http').ServerResponse | undefined} */
  let catalog;
  /** @type {import('node:http').ServerResponse | undefined} */
  let file;
  const s = await siteOn((path, res) => {
    if (path === '/catalog/plugins.json') {
      catalog = res;
      return;
    }
    res.writeHead(200);
    res.flushHeaders();
    file = res;
  });
  t.after(s.close);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The catalog's request is asked first and its answer held; then the file's call starts, a call of its own.
  const listing = watch(officialPlugins({ fetch: s.fetch, base: s.base, words: false }));
  await turns(() => catalog !== undefined);
  const files = watch(download(entry, { fetch: s.fetch, base: s.base }));
  await turns(() => file !== undefined);
  let sent = 0;
  for (const part of parts) {
    t.mock.timers.tick(QUIET_MS - 1);
    /** @type {import('node:http').ServerResponse} */ (file).write(part);
    sent += Buffer.byteLength(part);
    await turns(() => s.seen >= sent);
    await turns(() => listing.state !== 'pending', 50);
    assert.equal(listing.state, 'pending', `the held catalog answer, after ${sent} bytes of the file`);
  }
  /** @type {import('node:http').ServerResponse} */ (file).end();
  await turns(() => files.state !== 'pending');
  assert.equal(files.state, 'done', 'the file: three times QUIET_MS - 1 in all, never QUIET_MS with nothing');
  // The site's silence started with the last part: the catalog's request, held on, ends QUIET_MS after it and not before.
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => listing.state !== 'pending', 50);
  assert.equal(listing.state, 'pending', 'the held catalog answer, just short of the limit');
  t.mock.timers.tick(1);
  await turns(() => listing.state !== 'pending');
  assert.equal(listing.state, 'failed', 'ended at QUIET_MS of the site being quiet');
  assert.equal(messageOf(listing.error), "annai's list of plugins couldn't be loaded. Check the connection and try again.");
});
