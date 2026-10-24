import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// An update downloads only the files that changed (the user, 2026-10-23: "The service worker keeps each file's hash and copies
// unchanged files from the old version"). These run the real sw.js against a phone's caches and a site, version after version.

const SOURCE = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const SHELL_BLOCK = /const SHELL = \[([\s\S]*?)\];/;
const SHELL = [...(SHELL_BLOCK.exec(SOURCE)?.[1] ?? '').matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
const RECORD = '/shell-record.json';
const hashOf = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const ORIGIN = 'https://annai.guide';
const pathOf = (/** @type {string | Request} */ r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
/** The pages: fetched by every install, as their headers carry the site's policy (CSP, Permissions-Policy) of the version that has them. */
const PAGES = ['/', '/index.html', '/src/ui/grounding.html'];
assert.ok(PAGES.every((p) => SHELL.includes(p)));
/** What an update that can copy fetches: the manifest, the pages, and these files, in SHELL order. @param {string[]} changed */
const only = (changed, shell = SHELL) => ['/shell.json', ...shell.filter((p) => PAGES.includes(p) || changed.includes(p))];

/** A phone and the site it updates from. The site holds version A of every shell file; `ship` publishes a version's manifest. */
function phone() {
  /** The phone's caches, in the order they were made: name → path → body. @type {Map<string, Map<string, string>>} */
  const stores = new Map();
  /** The site: path → body. @type {Map<string, string>} */
  const site = new Map(SHELL.map((p) => [p, `the ${p} of version A`]));
  /** Each path the phone asked the site for, in order. @type {string[]} */
  const fetched = [];
  /** @type {string[]} */
  const notReload = [];
  let down = false;
  const serve = (/** @type {Request} */ req) => {
    if (down) throw new TypeError('Failed to fetch');
    const path = pathOf(req);
    fetched.push(path);
    if (req.cache !== 'reload') notReload.push(path);
    const body = site.get(path);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
  };
  const open = (/** @type {string} */ name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = /** @type {Map<string, string>} */ (stores.get(name));
    return {
      addAll: async (/** @type {Request[]} */ reqs) => {
        // All or nothing, as the Cache API's addAll is.
        /** @type {[string, string][]} */
        const got = [];
        for (const r of reqs) {
          const res = serve(r);
          if (!res.ok) throw new TypeError(`${r.url} ${res.status}`);
          got.push([pathOf(r), await res.text()]);
        }
        for (const [p, body] of got) store.set(p, body);
      },
      match: async (/** @type {string | Request} */ r) => {
        const body = store.get(pathOf(r));
        return body === undefined ? undefined : new Response(body);
      },
      put: async (/** @type {string | Request} */ r, /** @type {Response} */ res) => { store.set(pathOf(r), await res.text()); },
      delete: async (/** @type {string | Request} */ r) => store.delete(pathOf(r)),
    };
  };
  const caches = { open: async (/** @type {string} */ n) => open(n), keys: async () => [...stores.keys()], delete: async (/** @type {string} */ n) => stores.delete(n) };
  class SwRequest extends Request {
    constructor(/** @type {string | Request} */ u, /** @type {RequestInit} */ init) { super(typeof u === 'string' ? new URL(u, `${ORIGIN}/sw.js`) : u, init); }
  }

  /** The site publishes a version: its manifest names the build and the hash of each of its shell files as the site holds them. */
  const ship = (/** @type {string} */ build, shell = SHELL) => {
    site.set('/shell.json', JSON.stringify({ build, files: Object.fromEntries(shell.map((p) => [p, hashOf(/** @type {string} */ (site.get(p)))])) }));
  };

  /**
   * The phone installs a version of sw.js: its build and its SHELL. Resolves with the paths that install fetched.
   * @param {string} build @param {string[]} [shell]
   */
  const install = async (build, shell = SHELL) => {
    const source = SOURCE.replace(/^const BUILD = '[^']*';$/m, `const BUILD = '${build}';`)
      .replace(SHELL_BLOCK, `const SHELL = ${JSON.stringify(shell)};`);
    /** @type {Record<string, (e: any) => void>} */
    const handlers = {};
    const self = { location: new URL(`${ORIGIN}/sw.js`), navigator: { languages: [] }, addEventListener: (/** @type {string} */ t, /** @type {any} */ f) => { handlers[t] = f; } };
    vm.runInNewContext(source, {
      self, caches, Request: SwRequest, Response, URL, console, TextDecoder, crypto,
      fetch: async (/** @type {Request} */ r) => serve(r),
      setTimeout: (/** @type {() => void} */ f, /** @type {number} */ ms) => setTimeout(f, ms).unref(),
    });
    const from = fetched.length;
    /** @type {Promise<unknown> | undefined} */
    let done;
    handlers.install({ waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
    await done;
    return fetched.slice(from);
  };

  /** What a version's cache holds, and its record. @param {string} build */
  const cacheOf = (build) => {
    const store = stores.get(`annai-shell-0.1.0-${build}`);
    const raw = store?.get(RECORD);
    return { store, record: raw === undefined ? undefined : JSON.parse(raw) };
  };
  return { stores, site, fetched, notReload, ship, install, cacheOf, offline: () => { down = true; }, online: () => { down = false; } };
}

/** The record a cache should carry: the hash of each shell file it holds. @param {Map<string, string>} store @param {string[]} [shell] */
const recordOf = (store, shell = SHELL) => ({ files: Object.fromEntries(shell.map((p) => [p, hashOf(/** @type {string} */ (store.get(p)))])) });

test('a first install fetches the whole shell, past the HTTP cache, and records the hash of each file it holds', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  const got = await p.install('aaaaaaaaaaaa');
  assert.deepEqual(got, SHELL, 'every file, and no manifest: there is nothing to copy from');
  const { store, record } = p.cacheOf('aaaaaaaaaaaa');
  assert.ok(store);
  for (const path of SHELL) assert.equal(store.get(path), `the ${path} of version A`);
  assert.deepEqual(record, recordOf(store));
  assert.deepEqual(p.notReload, []);
});

test('an update fetches only the file that changed, the pages and the manifest, and copies the rest from the version before', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  p.site.set('/src/core/sun.js', 'the sun, version B');
  p.ship('bbbbbbbbbbbb');
  assert.deepEqual(await p.install('bbbbbbbbbbbb'), only(['/src/core/sun.js']));
  const { store, record } = p.cacheOf('bbbbbbbbbbbb');
  assert.ok(store);
  for (const path of SHELL) assert.equal(store.get(path), p.site.get(path), `${path} is the site's`);
  assert.deepEqual(record, recordOf(store));
  assert.deepEqual(p.notReload, [], 'the manifest too is fetched past the HTTP cache');
});

test('a file missing from the old cache is fetched', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  p.cacheOf('aaaaaaaaaaaa').store?.delete('/src/ui/shell.js');
  p.ship('bbbbbbbbbbbb');
  assert.deepEqual(await p.install('bbbbbbbbbbbb'), only(['/src/ui/shell.js']));
  assert.equal(p.cacheOf('bbbbbbbbbbbb').store?.get('/src/ui/shell.js'), 'the /src/ui/shell.js of version A');
});

test('a cache whose record is missing or unreadable is copied from not at all', async () => {
  for (const bad of [null, 'not json', '[]', '{"files":7}', '{"files":null}', '{"other":{}}']) {
    const p = phone();
    p.ship('aaaaaaaaaaaa');
    await p.install('aaaaaaaaaaaa');
    const old = /** @type {Map<string, string>} */ (p.cacheOf('aaaaaaaaaaaa').store);
    if (bad === null) old.delete(RECORD); // a version from before records
    else old.set(RECORD, bad);
    p.ship('bbbbbbbbbbbb');
    assert.deepEqual(await p.install('bbbbbbbbbbbb'), SHELL, `record ${bad}`);
  }
});

test('a hash in the record that is not the manifest\'s, or none, is fetched', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  const old = /** @type {Map<string, string>} */ (p.cacheOf('aaaaaaaaaaaa').store);
  const record = JSON.parse(/** @type {string} */ (old.get(RECORD)));
  record.files['/src/core/sun.js'] = '000000000000';
  record.files['/src/core/time.js'] = 7;
  delete record.files['/src/core/tsv.js'];
  old.set(RECORD, JSON.stringify(record));
  p.ship('bbbbbbbbbbbb');
  assert.deepEqual(await p.install('bbbbbbbbbbbb'), only(['/src/core/sun.js', '/src/core/time.js', '/src/core/tsv.js']));
});

test('with two older caches, the newest is copied from', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  // B changes two files and waits (installed, never activated, so A's cache stays).
  p.site.set('/src/core/sun.js', 'the sun, version B');
  p.site.set('/src/core/time.js', 'time, version B');
  p.ship('bbbbbbbbbbbb');
  await p.install('bbbbbbbbbbbb');
  // C keeps B's sun, and takes time back to A's.
  p.site.set('/src/core/time.js', 'the /src/core/time.js of version A');
  p.ship('cccccccccccc');
  assert.deepEqual(await p.install('cccccccccccc'), only(['/src/core/time.js']), "B's sun is copied; A's time is not looked for");
  assert.equal(p.cacheOf('cccccccccccc').store?.get('/src/core/sun.js'), 'the sun, version B');
});

test('an update while offline fails, and the version running keeps its cache as it was', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  const before = new Map(p.cacheOf('aaaaaaaaaaaa').store);
  p.site.set('/src/core/sun.js', 'the sun, version B');
  p.ship('bbbbbbbbbbbb');
  p.offline();
  await assert.rejects(p.install('bbbbbbbbbbbb'), /Failed to fetch/);
  assert.deepEqual(p.cacheOf('aaaaaaaaaaaa').store, before);
  assert.equal(p.cacheOf('bbbbbbbbbbbb').record, undefined, 'a cache cut off has no record, so nothing is ever copied from it');
  // A shell file the site no longer has fails the install too, as it always has.
  p.online();
  p.site.delete('/src/core/sun.js');
  await assert.rejects(p.install('bbbbbbbbbbbb'), /404/);
  // Back online, the next try copies from A, not from B's half.
  p.site.set('/src/core/sun.js', 'the sun, version B');
  assert.deepEqual(await p.install('bbbbbbbbbbbb'), only(['/src/core/sun.js']));
});

test("a manifest that can't be had, or is another build's, copies nothing, and the update goes on", async () => {
  for (const manifest of [undefined, '<html>Sign in to the hotel Wi-Fi</html>', '{"build":"cccccccccccc","files":{}}', '{"build":"bbbbbbbbbbbb","files":7}']) {
    const p = phone();
    p.ship('aaaaaaaaaaaa');
    await p.install('aaaaaaaaaaaa');
    p.site.set('/src/core/sun.js', 'the sun, version B');
    if (manifest === undefined) p.site.delete('/shell.json');
    else p.site.set('/shell.json', manifest);
    assert.deepEqual(await p.install('bbbbbbbbbbbb'), ['/shell.json', ...SHELL], `manifest ${manifest}`);
    const { store, record } = p.cacheOf('bbbbbbbbbbbb');
    assert.ok(store);
    assert.deepEqual(record, recordOf(store));
  }
});

test('a file added to SHELL is fetched; one taken out is neither fetched nor kept', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  const next = [...SHELL.filter((path) => path !== '/src/core/sun.js'), '/src/core/moon.js'];
  p.site.set('/src/core/moon.js', 'the moon');
  p.ship('bbbbbbbbbbbb', next);
  assert.deepEqual(await p.install('bbbbbbbbbbbb', next), only(['/src/core/moon.js'], next));
  const { store, record } = p.cacheOf('bbbbbbbbbbbb');
  assert.ok(store);
  assert.equal(store.has('/src/core/sun.js'), false);
  assert.equal(store.get('/src/core/moon.js'), 'the moon');
  assert.deepEqual(record, recordOf(store, next));
});

test('a record says what the cache holds, not what the manifest said: a file that changed mid-release is fetched again', async () => {
  const p = phone();
  // A's sw.js was fetched, then the site moved on before A's install fetched the sun.
  p.site.set('/src/core/sun.js', 'the sun, half released');
  await p.install('aaaaaaaaaaaa');
  p.site.set('/src/core/sun.js', 'the /src/core/sun.js of version A');
  p.ship('bbbbbbbbbbbb');
  assert.deepEqual(await p.install('bbbbbbbbbbbb'), only(['/src/core/sun.js']));
  assert.equal(p.cacheOf('bbbbbbbbbbbb').store?.get('/src/core/sun.js'), 'the /src/core/sun.js of version A');
});

test('a new sw.js with the same build (a change to the worker alone) fetches only the manifest and the pages, and keeps the record', async () => {
  const p = phone();
  p.ship('aaaaaaaaaaaa');
  await p.install('aaaaaaaaaaaa');
  const before = new Map(p.cacheOf('aaaaaaaaaaaa').store);
  assert.deepEqual(await p.install('aaaaaaaaaaaa'), only([]));
  assert.deepEqual(p.cacheOf('aaaaaaaaaaaa').store, before);
});
