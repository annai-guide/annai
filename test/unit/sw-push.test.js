import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

/** The service worker in a context of its own, with a fake registration, clients and caches. */
async function swKit({ windows = 0 } = {}) {
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
  const clients = Array.from({ length: windows }, () => ({ url: 'https://annai.guide/#/now', focus: async () => { focused++; }, postMessage: (/** @type {any} */ m) => posted.push(m) }));
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
  vm.runInNewContext(source, { self, caches, Request, Response, URL, console });
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
