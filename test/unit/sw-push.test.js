import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

/**
 * annai's database as the service worker reads it, holding these files of sys:device, or none at all.
 * @param {Record<string, string> | null} files
 */
function fakeIndexedDB(files) {
  const later = (/** @type {() => void} */ f) => setTimeout(f, 0);
  return {
    open: () => {
      /** @type {any} */
      const r = {};
      later(() => {
        if (!files) {
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
                  if (store === 'files') q.result = key[0] === 'sys:device' && key[1] in files ? { hash: key[1], type: 'application/json' } : undefined;
                  else q.result = key in files ? { data: new TextEncoder().encode(files[key]).buffer } : undefined;
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

/** The service worker in a context of its own, with a fake registration, clients and caches. */
async function swKit({ windows = 0, focusFails = false, device = /** @type {Record<string, string> | null} */ (null) } = {}) {
  const source = await readFile(new URL('sw.js', root), 'utf8');
  /** @type {Record<string, (e: any) => void>} */
  const handlers = {};
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const subscribed = [];
  /** @type {string[]} */
  const opened = [];
  /** @type {Map<string, string>} */
  const inbox = new Map();
  /** @type {any[]} */
  const posted = [];
  let focused = 0;
  const clients = Array.from({ length: windows }, () => ({
    url: 'https://annai.guide/#/now',
    focus: async () => {
      if (focusFails) throw new DOMException('Not allowed to focus a window.', 'InvalidAccessError');
      focused++;
    },
    postMessage: (/** @type {any} */ m) => posted.push(m),
  }));
  const self = {
    location: new URL('https://annai.guide/sw.js'),
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => { handlers[type] = fn; },
    registration: {
      showNotification: async (/** @type {string} */ title, /** @type {any} */ o) => { shown.push({ title, ...o }); },
      pushManager: { subscribe: async (/** @type {any} */ o) => { subscribed.push(o); return {}; } },
    },
    clients: { matchAll: async () => clients, openWindow: async (/** @type {string} */ u) => { opened.push(u); return null; } },
  };
  const caches = {
    open: async (/** @type {string} */ name) => ({
      put: async (/** @type {string} */ key, /** @type {Response} */ res) => { inbox.set(`${name} ${key}`, await res.text()); },
    }),
  };
  vm.runInNewContext(source, { self, caches, Request, Response, URL, console, indexedDB: fakeIndexedDB(device), TextDecoder, DOMException });
  /** @param {string} type @param {any} ev */
  const fire = async (type, ev) => {
    /** @type {Promise<unknown> | undefined} */
    let done;
    handlers[type]({ ...ev, waitUntil: (/** @type {Promise<unknown>} */ p) => { done = p; } });
    await done;
  };
  const news = () => [...inbox].filter(([k]) => k.startsWith('annai-push /push-news/')).map(([, v]) => JSON.parse(v));
  return { fire, shown, subscribed, opened, news, posted, focused: () => focused };
}

const REMINDER = { v: 1, key: 'trip-1|w-1', title: 'Big Sur', body: 'Tea time.', at: 1764266400000, scope: 'trip-1', watch: 'w-1' };

test("a push shows its reminder as a notification, and annai hears of it (spec §3: push → notification)", async () => {
  const k = await swKit({ windows: 1 });
  await k.fire('push', { data: { json: () => REMINDER } });
  assert.equal(k.shown.length, 1);
  const [n] = k.shown;
  assert.equal(n.title, 'Big Sur');
  assert.equal(n.body, 'Tea time.');
  assert.equal(n.tag, 'trip-1|w-1');
  assert.deepEqual({ ...n.data }, { key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', at: 1764266400000 });
  assert.equal(n.icon, '/assets/icons/icon-192.png');
  const [news] = k.news();
  assert.equal(news.kind, 'shown');
  assert.equal(news.key, 'trip-1|w-1');
  assert.ok(Number.isFinite(news.t));
  assert.deepEqual(k.posted.map((m) => ({ ...m })), [{ type: 'annai.push', kind: 'shown' }]);
});

test('a push it cannot read still shows a notification: Safari takes the subscription away after a few that show none', async () => {
  for (const data of [null, { json: () => { throw new SyntaxError('not JSON'); } }, { json: () => ({ v: 1 }) }, { json: () => 'text' }]) {
    const k = await swKit();
    await k.fire('push', { data });
    assert.equal(k.shown.length, 1);
    assert.equal(k.shown[0].title, 'annai');
    assert.equal(k.shown[0].body, 'annai has a reminder for you. Open annai to see it.');
  }
});

test("tapping it opens annai, after writing the tap down, so a launch that ignores the URL still catches up (spec §11.6)", async () => {
  const none = await swKit();
  let closed = 0;
  const notification = { title: 'Big Sur', body: 'Tea time.', data: { key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', at: 1 }, close: () => { closed++; } };
  await none.fire('notificationclick', { notification });
  assert.equal(closed, 1);
  assert.deepEqual(none.opened, ['/']);
  const [news] = none.news();
  assert.deepEqual({ kind: news.kind, key: news.key, scope: news.scope, watch: news.watch, title: news.title, body: news.body }, { kind: 'opened', key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', title: 'Big Sur', body: 'Tea time.' });
  const open = await swKit({ windows: 1 });
  await open.fire('notificationclick', { notification: { ...notification, close: () => {} } });
  assert.deepEqual(open.opened, [], 'an open annai is brought forward instead');
  assert.equal(open.focused(), 1);
  assert.deepEqual(open.posted.map((m) => m.kind), ['opened']);
});

test('a renewed subscription: subscribed again with the old key, and annai sends everything again at its next start', async () => {
  const k = await swKit();
  const key = new Uint8Array([4, 1, 2]);
  await k.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } }, newSubscription: null });
  assert.equal(k.subscribed.length, 1);
  assert.equal(k.subscribed[0].userVisibleOnly, true);
  assert.equal(k.subscribed[0].applicationServerKey, key);
  assert.equal(k.news()[0].kind, 'changed');
  const given = await swKit();
  await given.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: key } }, newSubscription: {} });
  assert.equal(given.subscribed.length, 0, 'the browser made the new one itself');
  assert.equal(given.news()[0].kind, 'changed');
});

test("an open annai that can't be brought forward (focus refused): annai is opened instead, so the tap always leads somewhere", async () => {
  const k = await swKit({ windows: 1, focusFails: true });
  await k.fire('notificationclick', { notification: { title: 'Big Sur', body: 'Tea time.', data: { key: 'trip-1|w-1', scope: 'trip-1', watch: 'w-1', at: 1 }, close: () => {} } });
  assert.deepEqual(k.opened, ['/']);
});

// The emulator pass (m6 #11): a "coming up" push held by the phone came 4 minutes late, still saying "In 15 min".
test('a "coming up" reminder says the minutes left when it shows, counted from the start it carries', async () => {
  const k = await swKit();
  const start = Date.now() + 11 * 60_000 + 20_000;
  const coming = { ...REMINDER, key: 'trip-1|plan:call:coming-up|1', watch: 'plan:call:coming-up', body: 'In 15 min: Call home at 05:35.', start };
  await k.fire('push', { data: { json: () => coming } });
  assert.equal(k.shown[0].body, 'In 11 min: Call home at 05:35.');
  await k.fire('push', { data: { json: () => ({ ...coming, start: Date.now() + 20_000 }) } });
  assert.equal(k.shown[1].body, 'Now: Call home at 05:35.');
  await k.fire('push', { data: { json: () => ({ ...coming, start: Date.now() - 9 * 60_000 }) } });
  assert.equal(k.shown[2].body, 'Started 9 min ago: Call home at 05:35.');
  // Without a start, or with other words, the words stay as they came.
  await k.fire('push', { data: { json: () => ({ ...coming, start: undefined }) } });
  assert.equal(k.shown[3].body, 'In 15 min: Call home at 05:35.');
  await k.fire('push', { data: { json: () => ({ ...REMINDER, start }) } });
  assert.equal(k.shown[4].body, 'Tea time.');
});

// The emulator pass: a reminder annai had already given in its catch-up, held back by the phone, popped up 6 minutes later.
test('a reminder annai already gave, or called off, comes quietly, and annai hears it is stale: it is no longer waiting at the relay', async () => {
  const state = (/** @type {string[]} */ keys) => ({ '/push.json': JSON.stringify({ on: true, items: Object.fromEntries(keys.map((k) => [k, { id: 'x', due: 1, sendAt: 2 }])) }) });
  const stale = await swKit({ windows: 1, device: state(['trip-1|w-2']) });
  await stale.fire('push', { data: { json: () => REMINDER } });
  assert.equal(stale.shown.length, 1, 'shown, as every push must be (Safari takes the subscription away otherwise)');
  assert.equal(stale.shown[0].silent, true, 'without a sound, so it never pops up');
  assert.deepEqual(stale.news().map((n) => [n.kind, n.key, n.stale]), [['shown', 'trip-1|w-1', true]]);
  // One still waiting shows as it came; so does one when annai keeps nothing yet, or its database can't be read.
  for (const device of [state(['trip-1|w-1']), {}, null]) {
    const k = await swKit({ device });
    await k.fire('push', { data: { json: () => REMINDER } });
    assert.equal(k.shown[0].silent, undefined, JSON.stringify(device));
    assert.equal(k.news()[0]?.stale, undefined);
  }
  // annai's own test and "notifications are on" are never stale.
  const test = await swKit({ device: state([]) });
  await test.fire('push', { data: { json: () => ({ ...REMINDER, key: 'hello|abc', test: true }) } });
  assert.equal(test.shown[0].silent, undefined);
});
