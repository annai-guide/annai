import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, breakReads, RELAY, at, iso, LA } from './push-kit.js';
import { RIVER_INN } from './live-kit.js';
import { FILE } from '../../src/core/push/mirror.js';
import { createTrip, SYS_DEVICE } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';

// RULES.md: an absence counts as evidence only when the source was asked and answered. A read of a plan file, a booking or /trip.json
// that failed says nothing of the stop: its waiting copy is held for that sync. A look, a read that fails once and a sync that is
// healthy again call off nothing, and a real edit is still called off at the next healthy sync. The memory store's reads never fail:
// breakReads makes them.

const ROAD = { tea: { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } } };
const PLACED = { id: 'cake', title: 'Cake', fixed: true, start: { at: iso('17:00'), tz: LA }, place: { name: 'Cafe A', ...RIVER_INN } };
const PLAIN = { id: 'plain', title: 'Plain', fixed: true, start: { at: iso('18:00'), tz: LA } };
const UA1 = { id: 'ua1', kind: 'flight', status: 'confirmed', source: '/files/x.pdf', title: 'UA 1', fields: { terminal: 'T2' } };
const FLIGHT = { id: 'fly', title: 'Flight', fixed: true, start: { at: iso('19:00'), tz: LA }, booking: '/bookings/ua1.json', place: { name: 'SFO', lat: 37.62, lng: -122.38 } };

/** @typedef {Awaited<ReturnType<typeof pushKit>>} Kit */

async function talk(/** @type {Kit} */ k, /** @type {string} */ scope, /** @type {number} */ t) {
  await k.to(t);
  await record(k.store, scope, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: t });
  k.agent.opened(scope);
  await k.flush();
  assert.equal(k.live.play, scope);
}
const copies = async (/** @type {Kit} */ k, /** @type {string} */ scope) => Object.keys(/** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items).filter((key) => key.startsWith(`${scope}|`)).map((key) => key.split('|')[1]).sort();
const calls = (/** @type {Kit} */ k) => ({ off: k.net.calls.filter((c) => c.method === 'DELETE').length, sent: k.net.calls.filter((c) => c.method === 'POST').length });
const THREE = ['plan:cake:leave', 'plan:fly:leave', 'plan:plain:coming-up'];

/** Road and Side both happen, Side's three copies are at the relay, and Road is in play. @param {{ side?: Record<string, any> }} [o] */
async function overlap({ side: tripOpts = {} } = {}) {
  const k = await pushKit({ plan: ROAD, live: false });
  const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28', ...tripOpts });
  await k.ws.write(side, '/bookings/ua1.json', UA1, { author: 'user' });
  await k.ws.write(side, '/plan/cake.json', PLACED, { author: 'user' });
  await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
  await k.ws.write(side, '/plan/fly.json', FLIGHT, { author: 'user' });
  await k.mirror.turnOn(RELAY);
  await talk(k, side, at('08:31'));
  await talk(k, k.trip, at('09:00'));
  assert.deepEqual(await copies(k, side), THREE);
  return { k, side };
}
/** The words that reach the phone from Side's copies, with annai off screen. */
async function pushedFor(/** @type {Kit} */ k, /** @type {string} */ scope, /** @type {number} */ t) {
  k.sensors.visible(false);
  await k.settle();
  for (let x = k.clock.now() + 600_000; x < t; x += 600_000) await k.deliver(x);
  await k.deliver(t);
  return k.pushed().filter((p) => p.scope === scope).map((p) => p.key.split('|')[1]).sort();
}

/** One read fails, once, during a look's sync: no copy is called off, the sync doesn't reject, and every copy still pushes. */
async function oneRead(/** @type {(side: string) => (op: string, scope: string, path?: string) => boolean} */ match, /** @type {{ side?: Record<string, any> }} */ o) {
  const { k, side } = await overlap(o);
  try {
    const was = calls(k);
    let left = 1;
    const fail = match(side);
    const b = breakReads(k, (op, scope, path) => fail(op, scope, path) && left-- > 0);
    k.agent.opened(side); // a look: it starts a sync
    await k.flush();
    b.heal();
    assert.equal(b.log.length, 1, `the read failed: ${b.log}`);
    assert.deepEqual(calls(k), was, 'a look and a failed read call nothing off and send nothing');
    assert.deepEqual(await copies(k, side), THREE);
    await k.flush(120_000);
    assert.deepEqual(calls(k), was, 'two healthy minutes on, still nothing');
    assert.deepEqual(await pushedFor(k, side, at('19:01')), THREE.slice().sort(), 'all three reach the phone');
  } finally {
    await k.stop();
  }
}

test('a plan file whose read fails once keeps its copy: 0 DELETE, and it still pushes', () => oneRead((side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json', {}));
test('a booking whose read fails once keeps the flight\'s copy: its words come from the booking', () => oneRead((side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json', {}));
test('a failed read of /trip.json keeps the copies of items that take their time from its zone', async () => {
  // Plain's own zone is none that exists: it takes the trip's, Tokyo. Without /trip.json it would take the phone's, and say another time.
  const side = { timezones: ['Asia/Tokyo'] };
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    const id = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28', ...side });
    await k.ws.write(id, '/plan/plain.json', { id: 'plain', title: 'Plain', fixed: true, start: { at: iso('18:00'), tz: 'Mars/Phobos' } }, { author: 'user' });
    await k.mirror.turnOn(RELAY);
    await talk(k, id, at('08:31'));
    await talk(k, k.trip, at('09:00'));
    assert.deepEqual(await copies(k, id), ['plan:plain:coming-up']);
    const was = calls(k);
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === id && path === '/trip.json' && left-- > 0);
    k.agent.opened(id);
    await k.flush();
    b.heal();
    assert.equal(b.log.length, 1);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, id), ['plan:plain:coming-up']);
  } finally {
    await k.stop();
  }
});

test('every plan read failing for one sync, the lists answering, calls off nothing and the sync does not reject', async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && String(path).startsWith('/plan/'));
    await k.mirror.sync();
    b.heal();
    assert.ok(b.log.length >= 3);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, side), THREE);
  } finally {
    await k.stop();
  }
});

test('a lasting failure in one trip does not stop the relay for the others: the trip in play still sends', async () => {
  const { k, side } = await overlap();
  try {
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && String(path).startsWith('/plan/'));
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    const was = calls(k);
    await k.flush();
    b.heal();
    assert.ok(calls(k).sent > was.sent, `${w.id} went to the relay`);
    assert.equal(calls(k).off, was.off);
  } finally {
    await k.stop();
  }
});

test('after a failed read, the next healthy sync still calls off a stop that really changed', async () => {
  const { k, side } = await overlap();
  try {
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json' && left-- > 0);
    k.agent.opened(side);
    await k.flush();
    b.heal();
    const was = calls(k);
    assert.equal(was.off, 0);
    await k.ws.write(side, '/plan/cake.json', { ...PLACED, place: { name: 'Cafe B', lat: 35.5641, lng: -121.0807 } }, { author: 'user' });
    await k.flush();
    assert.equal(calls(k).off, was.off + 1, 'the moved stop\'s copy goes');
    assert.deepEqual(await copies(k, side), THREE.filter((x) => x !== 'plan:cake:leave'));
  } finally {
    await k.stop();
  }
});

test('a plan file that is not JSON is an answer: it is no stop, and its copy is called off', async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    await k.ws.write(side, '/plan/cake.json', 'not json', { author: 'user', type: 'text/plain' });
    await k.flush();
    assert.equal(calls(k).off, was.off + 1);
    assert.deepEqual(await copies(k, side), THREE.filter((x) => x !== 'plan:cake:leave'));
  } finally {
    await k.stop();
  }
});

// The trip in play: the same read, as play moves to Side. Its plan is read short for as long as the read fails, and read again once a minute.
const watchIds = async (/** @type {Kit} */ k) => (await k.live.reminders())?.filter((r) => r.scope !== k.trip).map((r) => r.watch).sort();

test('one failed plan read as play moves to Side: no copy is called off, and a minute on the plan is read again whole', async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json' && left-- > 0);
    await talk(k, side, at('09:30'));
    b.heal();
    assert.equal(b.log.length, 1);
    assert.deepEqual(calls(k), was, 'nothing called off, nothing sent');
    assert.deepEqual(await copies(k, side), THREE);
    await k.to(k.clock.now() + 70_000);
    await k.mirror.sync();
    await k.flush();
    assert.deepEqual(await watchIds(k), THREE, 'Cake is in the plan in play again, to be said on screen as well');
    assert.deepEqual(calls(k), was);
  } finally {
    await k.stop();
  }
});

test('a plan in play that keeps failing is held, not rejected, and is not read more than once a minute', async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json');
    await talk(k, side, at('09:30'));
    await k.mirror.sync().catch(() => assert.fail('the sync rejected'));
    const first = b.log.length;
    for (let i = 0; i < 5; i++) {
      await k.to(k.clock.now() + 10_000);
      await k.mirror.sync();
    }
    assert.ok(b.log.length - first <= 2, `read again ${b.log.length - first} times in 50 s`);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, side), THREE);
    b.heal();
    await k.to(k.clock.now() + 70_000);
    await k.mirror.sync();
    assert.deepEqual(await watchIds(k), THREE);
  } finally {
    await k.stop();
  }
});

test('an open trip that is not happening, with a failed plan read, keeps its copies for that sync', async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    const future = await createTrip(k.ws, { title: 'Later', start: '2026-12-20', end: '2026-12-21' });
    await k.ws.write(future, '/plan/cake.json', { ...PLACED, start: { at: iso('17:00', '2026-12-20'), tz: LA } }, { author: 'user' });
    await k.mirror.turnOn(RELAY);
    k.agent.opened(future);
    await k.flush();
    const before = await copies(k, future);
    assert.deepEqual(before, ['plan:cake:leave']);
    const was = calls(k);
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === future && path === '/plan/cake.json' && left-- > 0);
    await k.mirror.sync();
    b.heal();
    assert.equal(b.log.length, 1);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, future), before);
  } finally {
    await k.stop();
  }
});

test('what a plan says of a reminder is pinned: a change to saysOf calls off every waiting copy at the first sync of that release', async () => {
  const k = await pushKit({ plan: { cake: PLACED }, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const cake = (await k.live.reminders())?.find((r) => r.watch === 'plan:cake:leave');
    assert.equal(cake?.says, '[{"title":"Cake","at":1795827600000,"tz":"America/Los_Angeles","place":"Cafe A"},{"name":"Cafe A","lat":36.27,"lng":-121.807}]');
    const item = Object.entries(/** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items).find(([key]) => key.includes('plan:cake:leave'));
    assert.equal(item?.[1].says, '2c1c0cd1e205d668');
  } finally {
    await k.stop();
  }
});
