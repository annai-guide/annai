import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

/**
 * annai's database as the service worker reads it: these files of sys:settings (path to JSON text), or no database at all.
 * @param {Record<string, string> | null} settings
 */
function fakeIndexedDB(settings) {
  const later = (/** @type {() => void} */ f) => setTimeout(f, 0);
  return {
    open: () => {
      /** @type {any} */
      const r = {};
      later(() => {
        if (!settings) {
          r.transaction = { abort: () => {} };
          r.onupgradeneeded?.();
          r.error = new DOMException('no database', 'AbortError');
          r.onerror?.();
          return;
        }
        r.result = {
          close: () => {},
          transaction: () => {
            /** @type {any} */
            const t = {};
            let open = 0;
            const done = () => { if (--open === 0) later(() => t.oncomplete?.()); };
            t.objectStore = (/** @type {string} */ store) => ({
              get: (/** @type {any} */ key) => {
                /** @type {any} */
                const q = {};
                open++;
                later(() => {
                  if (store === 'files') q.result = key[0] === 'sys:settings' && key[1] in settings ? { hash: key[1], type: 'application/json' } : undefined;
                  else q.result = key in settings ? { data: new TextEncoder().encode(settings[key]).buffer } : undefined;
                  q.onsuccess?.();
                  done();
                });
                return q;
              },
            });
            return t;
          },
        };
        r.onsuccess?.();
      });
      return r;
    },
  };
}

/**
 * The service worker in a context of its own, listing these languages, with the phone's languages, the app settings and a network.
 * network: the catalogs by tag (a missing one is a 404); caches start with these names (a waiting version's too).
 */
async function swKit({ langs = ['ja', 'zh-Hans'], phone = /** @type {string[]} */ ([]), settings = /** @type {Record<string, string> | null} */ (null), network = /** @type {Record<string, string>} */ ({ ja: '{"a":"b"}', 'zh-Hans': '{"a":"c"}' }), cacheNames = ['annai-shell-0.1.0-old'], failAll = false } = {}) {
  const source = (await readFile(new URL('sw.js', root), 'utf8')).replace('const LANGS = [];', `const LANGS = ${JSON.stringify(langs)};`);
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  /** @type {Map<string, Map<string, string>>} */
  const stores = new Map(cacheNames.map((n) => [n, new Map()]));
  /** @type {string[][]} */
  const added = [];
  /** @type {string[]} */
  const fetched = [];
  const cache = (/** @type {string} */ name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return {
      addAll: async (/** @type {Request[]} */ reqs) => {
        added.push([...reqs].map((r) => new URL(r.url).pathname));
        for (const r of reqs) if (r.cache !== 'reload') throw new Error('not past the HTTP cache');
        if (failAll) throw new TypeError('Failed to fetch');
        const bad = reqs.find((r) => /^\/l10n\/(.+)\.json$/.test(new URL(r.url).pathname) && !(/** @type {string} */ (/^\/l10n\/(.+)\.json$/.exec(new URL(r.url).pathname)?.[1]) in network));
        if (bad) throw new TypeError(`${bad.url} 404`);
        for (const r of reqs) /** @type {Map<string, string>} */ (stores.get(name)).set(new URL(r.url).pathname, 'x');
      },
      put: async (/** @type {string} */ key, /** @type {Response} */ res) => { /** @type {Map<string, string>} */ (stores.get(name)).set(new URL(key, 'https://annai.guide').pathname, await res.text()); },
    };
  };
  const caches = { open: async (/** @type {string} */ n) => cache(n), keys: async () => [...stores.keys()] };
  const self = {
    location: new URL('https://annai.guide/sw.js'),
    navigator: { languages: phone },
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; },
  };
  const fetchStub = async (/** @type {Request} */ req) => {
    const m = /^\/l10n\/(.+)\.json$/.exec(new URL(req.url).pathname);
    fetched.push(new URL(req.url).pathname);
    return m && m[1] in network ? new Response(network[m[1]], { headers: { 'Content-Type': 'application/json' } }) : new Response('not found', { status: 404 });
  };
  // In a service worker, relative URLs resolve against its own location.
  class SwRequest extends Request {
    constructor(/** @type {string | Request} */ u, /** @type {RequestInit} */ init) { super(typeof u === 'string' ? new URL(u, self.location.href) : u, init); }
  }
  vm.runInNewContext(source, { self, caches, Request: SwRequest, Response, URL, console, indexedDB: fakeIndexedDB(settings), TextDecoder, DOMException, fetch: fetchStub });
  /** @type {(type: string, ev?: any) => Promise<unknown>} */
  const fire = async (type, ev = {}) => {
    /** @type {Promise<unknown> | undefined} */
    let done;
    handlers[type]({ ...ev, waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
    return done;
  };
  /** Asks the worker to keep a language, as the page does; the answer comes on the port. @param {unknown} tag */
  const ask = async (tag) => {
    /** @type {any[]} */
    const said = [];
    await fire('message', { data: { type: 'cache-words', tag }, ports: [{ postMessage: (/** @type {any} */ m) => said.push({ ...m }) }] });
    return said;
  };
  return { fire, ask, stores, added, fetched, install: async () => { await fire('install'); return [...added[added.length - 1]].filter((p) => p.startsWith('/l10n/')); } };
}

const app = (/** @type {Record<string, unknown>} */ languages) => ({ '/app.json': JSON.stringify({ languages }) });

test('install caches the catalog of the language chosen in the app settings, with the shell', async () => {
  const k = await swKit({ settings: app({ ui: 'zh-Hans' }), phone: ['ja-JP'] });
  assert.deepEqual(await k.install(), ['/l10n/zh-Hans.json']);
  assert.ok(k.added[0].length > 100 && k.added[0].includes('/index.html'), 'in the same call as the shell');
  assert.equal(k.added.length, 1);
});

test('without a choice, install takes the first of the worker\'s own languages that annai has, by language and script', async () => {
  assert.deepEqual(await (await swKit({ phone: ['zh-TW', 'ja-JP'] })).install(), ['/l10n/ja.json'], 'zh-TW is Traditional: not Simplified');
  assert.deepEqual(await (await swKit({ phone: ['zh-CN', 'ja-JP'] })).install(), ['/l10n/zh-Hans.json']);
  assert.deepEqual(await (await swKit({ phone: ['en-GB'] })).install(), []);
  assert.deepEqual(await (await swKit({ phone: [] })).install(), []);
  assert.deepEqual(await (await swKit({ phone: ['ja-JP'], settings: null })).install(), ['/l10n/ja.json'], 'no database yet (a first install)');
  assert.deepEqual(await (await swKit({ phone: ['ja-JP'], settings: app({ spoken: ['en'] }) })).install(), ['/l10n/ja.json'], 'settings without a choice');
});

test('a choice of English caches no catalog, and one annai no longer has is the phone\'s', async () => {
  assert.deepEqual(await (await swKit({ phone: ['ja-JP'], settings: app({ ui: 'en' }) })).install(), []);
  assert.deepEqual(await (await swKit({ phone: ['ja-JP'], settings: app({ ui: 'ko' }) })).install(), ['/l10n/ja.json']);
  assert.deepEqual(await (await swKit({ phone: ['ja-JP'], settings: app({ ui: 7 }) })).install(), ['/l10n/ja.json']);
  assert.deepEqual(await (await swKit({ langs: [], phone: ['ja-JP'], settings: app({ ui: 'ja' }) })).install(), [], 'no language listed');
});

test('a new version whose words cannot be fetched is not installed: the shell and the words are one call', async () => {
  const k = await swKit({ settings: app({ ui: 'ja' }), network: {} });
  await assert.rejects(k.fire('install'), /404/);
  assert.equal(k.stores.get('annai-shell-0.1.0-old')?.size, 0, 'and nothing of it is kept in the old cache');
  const shell = await swKit({ settings: app({ ui: 'ja' }), failAll: true });
  await assert.rejects(shell.fire('install'), /Failed to fetch/);
});

test('the worker keeps one catalog when asked, in every shell cache, and answers when it is stored', async () => {
  const k = await swKit({ cacheNames: ['annai-shell-0.1.0-now', 'annai-shell-0.1.0-waiting', 'annai-inbox'] });
  assert.deepEqual(await k.ask('ja'), [{ ok: true }]);
  assert.equal(k.stores.get('annai-shell-0.1.0-now')?.get('/l10n/ja.json'), '{"a":"b"}');
  assert.equal(k.stores.get('annai-shell-0.1.0-waiting')?.get('/l10n/ja.json'), '{"a":"b"}', 'a version that waits has it too');
  assert.equal(k.stores.get('annai-inbox')?.size, 0, 'nothing else');
  assert.deepEqual(k.fetched, ['/l10n/ja.json'], 'fetched once');
});

test('asked for words it cannot keep, it says no', async () => {
  const k = await swKit({ network: { ja: '[1]', 'zh-Hans': 'not json' } });
  assert.deepEqual(await k.ask('ja'), [{ ok: false }], 'a catalog that is not an object');
  assert.deepEqual(await k.ask('zh-Hans'), [{ ok: false }], 'one that does not parse');
  assert.deepEqual(await k.ask('ko'), [{ ok: false }], 'a language annai has not listed');
  assert.deepEqual(await k.ask(undefined), [{ ok: false }]);
  assert.deepEqual(await (await swKit({ network: {} })).ask('ja'), [{ ok: false }], 'not there (offline or missing)');
  assert.ok([...(await swKit()).stores.values()].every((s) => s.size === 0));
});
