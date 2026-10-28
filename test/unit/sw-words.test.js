import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

/**
 * annai's database as the service worker reads it: these files of sys:settings (path to JSON text), or no database at all.
 * @param {Record<string, string> | null} settings @param {boolean} [hang]
 */
function fakeIndexedDB(settings, hang = false) {
  const later = (/** @type {() => void} */ f) => setTimeout(f, 0);
  return {
    open: () => {
      /** @type {any} */
      const r = {};
      if (hang) return r; // an open queued behind a blocked upgrade or delete never answers
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
async function swKit({ langs = ['ja', 'zh-Hans'], shipped = langs, phone = /** @type {string[]} */ ([]), settings = /** @type {Record<string, string> | null} */ (null), network = /** @type {Record<string, string>} */ ({ ja: '{"a":"b"}', 'zh-Hans': '{"a":"c"}' }), cacheNames = ['annai-shell-0.1.0-old'], failAll = false, host = 'annai.guide', hang = false } = {}) {
  // Whatever languages sw.js lists today (strings.mjs writes the lines), the test's own.
  const line = (/** @type {string} */ name) => new RegExp(`^const ${name} = \\[[^\\]\\n]*\\];$`, 'm');
  const text = await readFile(new URL('sw.js', root), 'utf8');
  assert.match(text, line('LANGS'), 'sw.js has its LANGS line');
  assert.match(text, line('SHIPPED_LANGS'), 'and its SHIPPED_LANGS line');
  const source = text.replace(line('LANGS'), `const LANGS = ${JSON.stringify(langs)};`).replace(line('SHIPPED_LANGS'), `const SHIPPED_LANGS = ${JSON.stringify(shipped)};`);
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  /** @type {Map<string, Map<string, string>>} */
  const stores = new Map(cacheNames.map((n) => [n, new Map()]));
  /** The headers each stored response had, by "cache path". @type {Map<string, Record<string, string>>} */
  const heads = new Map();
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
      match: async (/** @type {Request | string} */ req) => {
        const text = /** @type {Map<string, string>} */ (stores.get(name)).get(new URL(typeof req === 'string' ? req : req.url, 'https://annai.guide').pathname);
        return text === undefined ? undefined : new Response(text, { headers: heads.get(`${name} ${new URL(typeof req === 'string' ? req : req.url, 'https://annai.guide').pathname}`) });
      },
      delete: async (/** @type {Request | string} */ req) => /** @type {Map<string, string>} */ (stores.get(name)).delete(new URL(typeof req === 'string' ? req : req.url, 'https://annai.guide').pathname),
      put: async (/** @type {string} */ key, /** @type {Response} */ res) => {
        const path = new URL(key, 'https://annai.guide').pathname;
        heads.set(`${name} ${path}`, Object.fromEntries(res.headers));
        /** @type {Map<string, string>} */ (stores.get(name)).set(path, await res.text());
      },
    };
  };
  const caches = {
    open: async (/** @type {string} */ n) => cache(n), keys: async () => [...stores.keys()],
    match: async (/** @type {Request | string} */ req, /** @type {{ cacheName: string }} */ { cacheName }) => (stores.has(cacheName) ? cache(cacheName).match(req) : undefined),
  };
  const self = {
    location: new URL(`https://${host}/sw.js`),
    navigator: { languages: phone },
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; },
  };
  let down = false;
  const fetchStub = async (/** @type {Request} */ req) => {
    if (down) throw new TypeError('Failed to fetch');
    const m = /^\/l10n\/(.+)\.json$/.exec(new URL(req.url).pathname);
    fetched.push(new URL(req.url).pathname);
    if (m && m[1] in network && network[m[1]].startsWith('<')) return new Response(network[m[1]], { headers: { 'Content-Type': 'text/html' } }); // a captive portal's page
    return m && m[1] in network ? new Response(network[m[1]], { headers: { 'Content-Type': 'application/json' } }) : new Response('not found', { status: 404 });
  };
  // In a service worker, relative URLs resolve against its own location.
  class SwRequest extends Request {
    constructor(/** @type {string | Request} */ u, /** @type {RequestInit} */ init) { super(typeof u === 'string' ? new URL(u, self.location.href) : u, init); }
  }
  vm.runInNewContext(source, { self, caches, Request: SwRequest, Response, URL, console, indexedDB: fakeIndexedDB(settings, hang), TextDecoder, DOMException, crypto, fetch: fetchStub, setTimeout: (/** @type {() => void} */ f) => setTimeout(f, hang ? 5 : 60_000).unref() });
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
  /** A page asking for a file, as the worker answers it: the text, or null when it has nothing. @param {string} path */
  const get = async (path) => {
    /** @type {Promise<Response> | undefined} */
    let answer;
    /** @type {Promise<unknown>[]} */
    const after = [];
    handlers.fetch({ request: new SwRequest(path, {}), respondWith: (/** @type {Promise<Response>} */ p) => { answer = p; }, waitUntil: (/** @type {Promise<unknown>} */ p) => { after.push(p); } });
    const text = await answer?.then((r) => (r.ok ? r.text() : null), () => null);
    await Promise.all(after); // what the worker goes on doing once it has answered
    return text;
  };
  return { fire, ask, get, offline: () => { down = true; }, online: () => { down = false; }, stores, heads, added, fetched, install: async () => { await fire('install'); return [...added[added.length - 1]].filter((p) => p.startsWith('/l10n/')); } };
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

test('with Traditional Chinese shipped, a Taiwan or Hong Kong phone caches its catalog, and a mainland one Simplified (l10n-zh-Hant)', async () => {
  const langs = ['ja', 'zh-Hans', 'zh-Hant'];
  const network = { ja: '{"a":"b"}', 'zh-Hans': '{"a":"c"}', 'zh-Hant': '{"a":"d"}' };
  assert.deepEqual(await (await swKit({ langs, network, phone: ['zh-TW'] })).install(), ['/l10n/zh-Hant.json']);
  assert.deepEqual(await (await swKit({ langs, network, phone: ['zh-HK', 'en-GB'] })).install(), ['/l10n/zh-Hant.json']);
  assert.deepEqual(await (await swKit({ langs, network, phone: ['zh-CN'] })).install(), ['/l10n/zh-Hans.json']);
  assert.deepEqual(await (await swKit({ langs, network, shipped: ['ja', 'zh-Hans'], phone: ['zh-TW', 'ja-JP'] })).install(), ['/l10n/ja.json'], 'unfinished, it is not the phone\'s');
});

test('a phone that lists English before a language annai has gets English, as the page does: no catalog (L6 review 1)', async () => {
  assert.deepEqual(await (await swKit({ phone: ['en-US', 'ja-JP'] })).install(), []);
  assert.deepEqual(await (await swKit({ phone: ['en-GB', 'zh-CN'] })).install(), []);
  assert.deepEqual(await (await swKit({ phone: ['fr-FR', 'en-US', 'ja-JP'] })).install(), [], 'French annai lacks: the next, English, decides');
  assert.deepEqual(await (await swKit({ phone: ['fr-FR', 'ja-JP', 'en-US'] })).install(), ['/l10n/ja.json']);
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

test('a language already on the device is kept offline: asked again with no connection, the worker answers from its own cache', async () => {
  const build = /const BUILD = '([^']*)';/.exec(await readFile(new URL('sw.js', root), 'utf8'))?.[1];
  const now = `annai-shell-0.1.0-${build}`;
  const k = await swKit({ cacheNames: [now, 'annai-shell-0.1.0-waiting'] });
  k.stores.get(now)?.set('/l10n/ja.json', '{"a":"b"}');
  k.offline();
  assert.deepEqual(await k.ask('ja'), [{ ok: true }], 'chosen online once, then English, then 日本語 again offline');
  assert.equal(k.stores.get('annai-shell-0.1.0-waiting')?.get('/l10n/ja.json'), '{"a":"b"}', 'and a version that waits has it too');
  assert.deepEqual(await k.ask('zh-Hans'), [{ ok: false }], 'one not on the device still needs the connection');
  const missing = await swKit({ cacheNames: [now], network: {} });
  missing.stores.get(now)?.set('/l10n/ja.json', '{"a":"b"}');
  assert.deepEqual(await missing.ask('ja'), [{ ok: true }], 'a 404 too');
});

/** The running version's cache name, as sw.js makes it. */
const running = async () => `annai-shell-0.1.0-${/const BUILD = '([^']*)';/.exec(await readFile(new URL('sw.js', root), 'utf8'))?.[1]}`;

test('offline, the device\'s words go only where a catalog is missing: a waiting version\'s newer one stays', async () => {
  const now = await running();
  const k = await swKit({ cacheNames: [now, 'annai-shell-0.1.0-waiting'] });
  k.stores.get(now)?.set('/l10n/ja.json', '{"a":"old"}');
  k.stores.get('annai-shell-0.1.0-waiting')?.set('/l10n/ja.json', '{"a":"new"}');
  k.offline();
  assert.deepEqual(await k.ask('ja'), [{ ok: true }]);
  assert.equal(k.stores.get('annai-shell-0.1.0-waiting')?.get('/l10n/ja.json'), '{"a":"new"}');
});

test('a captive portal\'s page (200, HTML) is no catalog: the device\'s words answer, and nothing is kept from it', async () => {
  const now = await running();
  const portal = { ja: '<html>Sign in to the hotel Wi-Fi</html>', 'zh-Hans': '<html>Sign in</html>' };
  const k = await swKit({ cacheNames: [now], network: portal });
  k.stores.get(now)?.set('/l10n/ja.json', '{"a":"b"}');
  assert.deepEqual(await k.ask('ja'), [{ ok: true }], 'chosen again behind the portal');
  assert.deepEqual(await k.ask('zh-Hans'), [{ ok: false }], 'not on the device: no');
  assert.equal(k.stores.get(now)?.get('/l10n/ja.json'), '{"a":"b"}');
  for (const host of ['annai.guide', 'localhost']) {
    const r = await swKit({ host, cacheNames: [now], network: portal });
    r.stores.get(now)?.set('/l10n/ja.json', '{"a":"b"}');
    assert.equal(await r.get('/l10n/ja.json'), '{"a":"b"}', `the kept words are served (${host})`);
    await r.get('/l10n/zh-Hans.json');
    assert.equal(r.stores.get(now)?.get('/l10n/zh-Hans.json'), undefined, `and the portal's page is not kept as words (${host})`);
  }
});

test('words copied from the device are marked, and the first start online fetches them fresh once, in the background', async () => {
  const now = await running();
  const k = await swKit({ cacheNames: [now, 'annai-shell-0.1.0-waiting'] });
  k.stores.get(now)?.set('/l10n/ja.json', '{"a":"old"}');
  k.offline();
  assert.deepEqual(await k.ask('ja'), [{ ok: true }]);
  assert.equal(k.heads.get('annai-shell-0.1.0-waiting /l10n/ja.json')?.['x-annai-words'], 'device', 'the waiting version knows its words are an older one\'s');
  // That version running: its cache holds the marked copy.
  const next = await swKit({ cacheNames: [now], network: { ja: '{"a":"new"}' } });
  await next.stores.get(now)?.set('/l10n/ja.json', '{"a":"old"}');
  next.heads.set(`${now} /l10n/ja.json`, { 'x-annai-words': 'device' });
  assert.equal(await next.get('/l10n/ja.json'), '{"a":"old"}', 'the start is not held up');
  assert.equal(next.stores.get(now)?.get('/l10n/ja.json'), '{"a":"new"}', 'and its own words replace them');
  assert.equal(next.heads.get(`${now} /l10n/ja.json`)?.['x-annai-words'], undefined, 'unmarked');
  assert.equal(await next.get('/l10n/ja.json'), '{"a":"new"}');
  assert.deepEqual(next.fetched, ['/l10n/ja.json'], 'once: a normal start fetches nothing');
  const portal = await swKit({ cacheNames: [now], network: { ja: '<html>Sign in</html>' } });
  portal.stores.get(now)?.set('/l10n/ja.json', '{"a":"old"}');
  portal.heads.set(`${now} /l10n/ja.json`, { 'x-annai-words': 'device' });
  await portal.get('/l10n/ja.json');
  assert.equal(portal.heads.get(`${now} /l10n/ja.json`)?.['x-annai-words'], 'device', 'a portal\'s page replaces nothing, so the next start tries again');
});

test('a catalog that comes from the network is kept, so the next start offline has it (restore, Try again, a read that raced cache-words)', async () => {
  for (const host of ['annai.guide', 'localhost']) {
    const k = await swKit({ host, cacheNames: [] });
    assert.equal(await k.get('/l10n/ja.json'), '{"a":"b"}', `online (${host})`);
    k.offline();
    assert.equal(await k.get('/l10n/ja.json'), '{"a":"b"}', `and then offline (${host})`);
  }
});

test('only a catalog annai lists, and fetched whole, is kept from the network', async () => {
  const k = await swKit({ cacheNames: [], network: { ja: '{"a":"b"}', ko: '{"a":"k"}' } });
  await k.get('/l10n/ko.json');
  await k.get('/l10n/ja.json?x=1');
  await k.get('/l10n/nope.json');
  await k.get('/src/app/main.js');
  k.offline();
  assert.equal(await k.get('/l10n/ko.json'), null, 'a language not in LANGS');
  assert.equal(await k.get('/l10n/nope.json'), null, 'a missing catalog is no catalog');
});

test('an IndexedDB that never answers does not hold up an install: the phone\'s languages decide', async () => {
  const k = await swKit({ hang: true, phone: ['zh-CN'] });
  assert.deepEqual(await k.install(), ['/l10n/zh-Hans.json']);
  assert.deepEqual(await (await swKit({ hang: true, phone: ['en-GB'] })).install(), []);
});

test('an install whose settings read times out keeps every language an older version holds, fetched fresh, so a chosen one survives activate', async () => {
  const k = await swKit({ hang: true, phone: ['en-US'] });
  k.stores.get('annai-shell-0.1.0-old')?.set('/l10n/ja.json', 'old words');
  assert.deepEqual(await k.install(), ['/l10n/ja.json'], 'the user chose 日本語 once: the new version has it too');
  const both = await swKit({ hang: true, phone: ['zh-CN'], cacheNames: ['annai-shell-0.1.0-old', 'annai-inbox'] });
  both.stores.get('annai-shell-0.1.0-old')?.set('/l10n/ja.json', 'old words');
  both.stores.get('annai-shell-0.1.0-old')?.set('/l10n/ko.json', 'not a language annai lists');
  assert.deepEqual(await both.install(), ['/l10n/zh-Hans.json', '/l10n/ja.json'], "the phone's, then the older version's; only what annai lists");
  const read = await swKit({ settings: app({ ui: 'en' }), phone: ['en-US'] });
  read.stores.get('annai-shell-0.1.0-old')?.set('/l10n/ja.json', 'old words');
  assert.deepEqual(await read.install(), [], 'a read that answers decides alone: English now');
});

test('a phone is matched only against the shipped languages: a draft is never downloaded for it, but a user who chose it has it', async () => {
  const draft = { shipped: ['zh-Hans'] };
  assert.deepEqual(await (await swKit({ ...draft, phone: ['ja-JP'] })).install(), [], 'a Japanese phone, Japanese still a draft');
  assert.deepEqual(await (await swKit({ ...draft, phone: ['ja-JP', 'zh-CN'] })).install(), ['/l10n/zh-Hans.json']);
  assert.deepEqual(await (await swKit({ ...draft, phone: ['ja-JP'], settings: app({ ui: 'ja' }) })).install(), ['/l10n/ja.json'], 'chosen: kept');
  assert.deepEqual(await (await swKit({ ...draft, phone: [] })).ask('ja'), [{ ok: true }], 'and asked for: kept');
});
