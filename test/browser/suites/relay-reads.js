import { createIdbStore, eraseDatabase } from '../../../src/core/store-idb.js';
import { liveKit, at, iso, LA, RIVER_INN } from '../../unit/live-kit.js';
import { PushMirror, FILE } from '../../../src/core/push/mirror.js';
import { createTrip, SYS_DEVICE } from '../../../src/core/scopes.js';
import { record } from '../../../src/core/agent/log.js';
import { toBase64Url } from '../../../src/core/bytes.js';

// A read that fails in a sync, on the real IndexedDB: a transaction aborted in flight rejects the read. It must not take a copy at the relay
// off, nor the push file's state. The unit tests make a read fail on the memory store; this is the real thing. The store tries an aborted
// transaction once more, so a read that fails is one aborted twice.

const RELAY = 'https://push.annai.guide';
let n = 0;
const fresh = async () => {
  const name = `relay-reads-${Date.now()}-${n++}`;
  await eraseDatabase(name);
  return createIdbStore(name);
};
const ROAD = { tea: { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } } };
const PLACED = { id: 'cake', title: 'Cake', fixed: true, start: { at: iso('17:00'), tz: LA }, place: { name: 'Cafe A', ...RIVER_INN } };
const PLAIN = { id: 'plain', title: 'Plain', fixed: true, start: { at: iso('18:00'), tz: LA } };

async function fakeSub() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { endpoint: 'https://push.example/abc', p256dh: new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), auth: crypto.getRandomValues(new Uint8Array(16)) };
}
/** A stand-in relay that counts what it is asked. */
function fakeRelay() {
  /** @type {{ method: string, url: string }[]} */
  const calls = [];
  const vapid = new Uint8Array(65);
  vapid[0] = 4;
  return {
    calls,
    fetch: async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      if (url.endsWith('/v1/vapid')) return new Response(JSON.stringify({ key: toBase64Url(vapid) }), { status: 200 });
      if (method === 'POST') return new Response(JSON.stringify({ id: 'x', sendAt: 1, sent: false }), { status: 201 });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('{}', { status: 200 });
    },
  };
}
async function kit() {
  const k = await liveKit({ store: await fresh(), plan: ROAD, live: false });
  const relay = fakeRelay();
  const sub = await fakeSub();
  /** @type {any} */
  let has = null;
  const source = { supported: () => /** @type {const} */ ('yes'), permission: () => 'granted', ask: async () => 'granted', get: async () => has, subscribe: async () => { has = sub; return sub; }, unsubscribe: async () => { has = null; } };
  const mirror = new PushMirror({ store: k.store, ws: k.ws, live: k.live, source, fetch: relay.fetch, clock: k.clock });
  await mirror.start();
  const flush = async (ms = 1000) => {
    const end = k.clock.now() + ms;
    for (let t = k.clock.now(); t < end; t = k.clock.now()) {
      await k.to(Math.min(t + 5000, end));
      await mirror.settled();
      await k.settle();
    }
    await k.to(k.clock.now() + 600);
    await mirror.settled();
    await k.settle();
    await mirror.settled();
  };
  const talk = async (/** @type {string} */ scope, /** @type {number} */ t) => {
    await k.to(t);
    await record(k.store, scope, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: t });
    k.agent.opened(scope);
    await flush();
  };
  const deletes = () => relay.calls.filter((c) => c.method === 'DELETE').length;
  const copies = async (/** @type {string} */ scope) => Object.keys(/** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items).filter((key) => key.startsWith(`${scope}|`)).map((key) => key.split('|')[1]).sort();
  const stop = () => { mirror.dispose(); k.live.dispose(); k.store.close?.(); };
  return { k, mirror, flush, talk, deletes, copies, stop };
}
/** Side's copies are at the relay, and Road is in play. */
async function overlap() {
  const o = await kit();
  const side = await createTrip(o.k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
  await o.k.ws.write(side, '/plan/cake.json', PLACED, { author: 'user' });
  await o.k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
  await o.mirror.turnOn(RELAY);
  await o.talk(side, at('08:31'));
  await o.talk(o.k.trip, at('09:00'));
  return { ...o, side };
}
/** Aborts the next reads of a file, in flight, on the real engine: the read is placed, then its transaction goes. @param {number} count @param {(key: any) => boolean} match */
function abortReads(count, match) {
  const get = IDBObjectStore.prototype.get;
  let left = count;
  /** @type {any[]} */
  const seen = [];
  IDBObjectStore.prototype.get = function (key) {
    const r = get.call(this, key);
    if (left > 0 && this.name === 'files' && match(key)) {
      left--;
      seen.push(key);
      this.transaction.abort();
    }
    return r;
  };
  return { seen, heal: () => { IDBObjectStore.prototype.get = get; } };
}

/** @param {any} test @param {any} assert */
export default function (test, assert) {
  test('a look with nothing failing changes no copy (control)', async () => {
    const { k, side, flush, deletes, copies, stop } = await overlap();
    try {
      const before = await copies(side);
      assert.deepEqual(before, ['plan:cake:leave', 'plan:plain:coming-up']);
      const off = deletes();
      k.agent.opened(side);
      await flush();
      assert.equal(deletes(), off);
      assert.deepEqual(await copies(side), before);
    } finally {
      stop();
    }
  });

  test('a plan read aborted in a look\'s sync calls off nothing, and a real edit is still called off afterwards', async () => {
    const { k, side, flush, deletes, copies, stop } = await overlap();
    try {
      const before = await copies(side);
      const off = deletes();
      const b = abortReads(2, (key) => key[0] === side && key[1] === '/plan/cake.json');
      k.agent.opened(side);
      await flush();
      b.heal();
      assert.equal(b.seen.length, 2, 'the read and its retry were aborted');
      assert.equal(deletes(), off);
      assert.deepEqual(await copies(side), before);
      await flush(120_000);
      assert.equal(deletes(), off, 'two healthy minutes on, still there');
      await k.ws.write(side, '/plan/cake.json', { ...PLACED, place: { name: 'Cafe B', lat: 35.56, lng: -121.08 } }, { author: 'user' });
      await flush();
      assert.equal(deletes(), off + 1, 'the moved stop\'s copy is called off');
    } finally {
      stop();
    }
  });

  test('the push file read aborted in a sync leaves notifications on and the file as it was', async () => {
    const { k, side, mirror, flush, deletes, stop } = await overlap();
    try {
      await flush();
      const before = await k.ws.readText(SYS_DEVICE, FILE);
      assert.equal(JSON.parse(String(before)).on, true);
      const off = deletes();
      const b = abortReads(2, (key) => key[0] === SYS_DEVICE && key[1] === FILE);
      let failed = '';
      await mirror.sync().catch((/** @type {any} */ e) => { failed = e?.name; });
      b.heal();
      assert.equal(b.seen.length, 2);
      assert.equal(failed, 'AbortError', 'the sync stops');
      assert.equal(await k.ws.readText(SYS_DEVICE, FILE), before);
      assert.equal((await mirror.status()).on, true);
      assert.equal(deletes(), off);
    } finally {
      stop();
    }
  });

  test('a plan read aborted as play moves to the trip keeps its copies', async () => {
    const { k, side, flush, talk, deletes, copies, stop } = await overlap();
    try {
      const before = await copies(side);
      const off = deletes();
      const b = abortReads(2, (key) => key[0] === side && key[1] === '/plan/cake.json');
      await talk(side, at('09:30'));
      b.heal();
      assert.equal(b.seen.length, 2);
      assert.equal(k.live.play, side);
      assert.equal(deletes(), off);
      assert.deepEqual(await copies(side), before);
      await flush(120_000);
      assert.equal(deletes(), off);
    } finally {
      stop();
    }
  });
}
