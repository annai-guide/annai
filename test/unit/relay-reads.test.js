import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushKit, breakReads, RELAY, at, iso, LA } from './push-kit.js';
import { RIVER_INN } from './live-kit.js';
import { FILE } from '../../src/core/push/mirror.js';
import { createTrip, SYS_DEVICE } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { ManualClock } from '../../src/core/live/clock.js';

// RULES.md: an absence counts as evidence only when the source was asked and answered. A read answers, or nothing changes: there is no
// plan part read. A read that fails stops the sync with nothing decided and leaves Live on the trip and plan it has, and both try again by
// themselves. No read failure sends short words or calls a good copy off, and a real edit is still called off once reads work. The memory
// store's reads never fail: breakReads makes them.

const ROAD = { tea: { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } } };
const PLACED = { id: 'cake', title: 'Cake', fixed: true, start: { at: iso('17:00'), tz: LA }, place: { name: 'Cafe A', ...RIVER_INN } };
const PLAIN = { id: 'plain', title: 'Plain', fixed: true, start: { at: iso('18:00'), tz: LA } };
const UA1 = { id: 'ua1', kind: 'flight', status: 'confirmed', source: '/files/x.pdf', title: 'UA 1', fields: { terminal: 'T2' } };
const FLIGHT = { id: 'fly', title: 'Flight', fixed: true, start: { at: iso('19:00'), tz: LA }, booking: '/bookings/ua1.json', place: { name: 'SFO', lat: 37.62, lng: -122.38 } };

/** @typedef {Awaited<ReturnType<typeof pushKit>>} Kit */

/** A line said in a trip. Whether it moves play yet depends on the trip's records being read. */
async function say(/** @type {Kit} */ k, /** @type {string} */ scope, /** @type {number} */ t) {
  await k.to(t);
  await record(k.store, scope, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: t });
  k.agent.opened(scope);
  await k.flush();
}
async function talk(/** @type {Kit} */ k, /** @type {string} */ scope, /** @type {number} */ t) {
  await say(k, scope, t);
  assert.equal(k.live.play, scope);
}
const copies = async (/** @type {Kit} */ k, /** @type {string} */ scope) => Object.keys(/** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items).filter((key) => key.startsWith(`${scope}|`)).map((key) => key.split('|')[1]).sort();
const calls = (/** @type {Kit} */ k) => ({ off: k.net.calls.filter((c) => c.method === 'DELETE').length, sent: k.net.calls.filter((c) => c.method === 'POST').length });
const THREE = ['plan:cake:leave', 'plan:fly:leave', 'plan:plain:coming-up'];
/** The plan's watches Live holds for a scope: none but the trip in play's. @param {Kit} k @param {string} scope */
const planIn = async (k, scope) => (await k.live.listWatches(scope)).split('\n').slice(1).map((l) => l.split('\t')[0]).filter((id) => id.startsWith('plan:')).sort();
/** A read that fails is warned of, and each of these tests makes some. @param {() => Promise<void>} fn */
const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
};

/** Road and Side both happen, Side's three copies are at the relay, and Road is in play. @param {{ side?: Record<string, any>, live?: boolean }} [o] */
async function overlap({ side: tripOpts = {}, live = false } = {}) {
  const k = await pushKit({ plan: ROAD, live });
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

/** A read fails during a look's sync, once or for as long as the look lasts: nothing is called off or sent, and every copy still pushes. */
async function look(/** @type {(side: string) => (op: string, scope: string, path?: any) => boolean} */ match, /** @type {number} */ times) {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    let left = times;
    const fail = match(side);
    const b = breakReads(k, (op, scope, path) => fail(op, scope, path) && left-- > 0);
    k.agent.opened(side); // a look: it starts a sync
    await k.flush();
    b.heal();
    assert.ok(b.log.length >= 1, 'the read failed');
    assert.deepEqual(calls(k), was, 'a look and a failed read call nothing off and send nothing');
    assert.deepEqual(await copies(k, side), THREE);
    await k.flush(120_000);
    assert.deepEqual(calls(k), was, 'two healthy minutes on, still nothing');
    assert.deepEqual(await pushedFor(k, side, at('19:01')), THREE.slice().sort(), 'all three reach the phone');
  } finally {
    await k.stop();
  }
}

// Review 7's table: what fails in a look's sync.
/** @type {[string, (side: string) => (op: string, scope: string, path?: any) => boolean][]} */
const LOOKS = [
  ['a plan file', (side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json'],
  ['a booking, whose words its stop takes', (side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json'],
  ['every plan read, with the lists answering', (side) => (op, scope, path) => op === 'getFile' && scope === side && String(path).startsWith('/plan/')],
  ['every plan read and the list of /bookings/', (side) => (op, scope, path) => scope === side && ((op === 'getFile' && String(path).startsWith('/plan/')) || (op === 'listFiles' && path === '/bookings/'))],
  ['the bookings\' reads and /trip.json', (side) => (op, scope, path) => op === 'getFile' && scope === side && (String(path).startsWith('/bookings/') || path === '/trip.json')],
];
for (const [what, match] of LOOKS) {
  test(`${what} failing once in a look's sync: 0 DELETE, and all three still push`, () => quiet(() => look(match, 1)));
  test(`${what} failing all through a look: 0 DELETE, and all three still push`, () => quiet(() => look(match, Infinity)));
}
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

test('a sync that needs a plan it can\'t read stops: it rejects, nothing is decided, and it is tried again by itself', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    const before = await k.ws.readText(SYS_DEVICE, FILE);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && String(path).startsWith('/plan/'));
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    assert.deepEqual(calls(k), was);
    assert.equal(await k.ws.readText(SYS_DEVICE, FILE), before, 'not a byte of the push file changed');
    const tries = b.log.length;
    await k.flush(70_000);
    assert.ok(b.log.length > tries, 'tried again, with nobody asking');
    b.heal();
    await k.flush(40_000);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, side), THREE);
  } finally {
    await k.stop();
  }
}));

test('one trip\'s failed read stops the sync for every trip, and a reminder set meanwhile reaches the relay by itself once it reads', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && String(path).startsWith('/plan/'));
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    const was = calls(k);
    await k.flush(60_000);
    assert.deepEqual(calls(k), was, 'nothing goes while a plan it needs can\'t be read');
    b.heal();
    await k.flush(40_000); // no outside trigger
    assert.equal(calls(k).sent, was.sent + 1, `${w.id} went to the relay`);
    assert.equal(calls(k).off, was.off);
    k.sensors.visible(false);
    await k.settle();
    await k.deliver(at('15:01'));
    assert.equal(k.pushed().filter((p) => p.body === 'Call Mum.').length, 1);
  } finally {
    await k.stop();
  }
}));

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

// Review 8's table: what fails as play moves to Side. Live stays on Road and Road's plan, whole, and the next try moves it, by itself.
/** @type {[string, (side: string) => (op: string, scope: string, path?: any) => boolean][]} */
const MOVES = [
  ['the list of /plan/', (side) => (op, scope, path) => op === 'listFiles' && scope === side && path === '/plan/'],
  ['the list of /bookings/', (side) => (op, scope, path) => op === 'listFiles' && scope === side && path === '/bookings/'],
  ['a plan file', (side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json'],
  ['a booking', (side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json'],
  ['/trip.json', (side) => (op, scope, path) => op === 'getFile' && scope === side && path === '/trip.json'],
  ['a file\'s content', () => (op) => op === 'getBlob'],
  ['the scope record', (side) => (op, scope) => op === 'getScope' && scope === side],
  ['the log of what fired', (side) => (op, scope) => op === 'listEvents' && scope === side],
];
for (const [what, match] of MOVES) {
  test(`${what} failing as play moves: Live stays on the plan it has, 0 DELETE, and the plan comes back by itself`, () => quiet(async () => {
    const { k, side } = await overlap();
    try {
      const was = calls(k);
      const b = breakReads(k, match(side));
      await talk(k, side, at('09:30'));
      await k.flush(60_000);
      assert.ok(b.log.length >= 1, 'the read failed');
      assert.deepEqual(await planIn(k, side), [], 'no part of Side\'s plan');
      assert.ok((await planIn(k, k.trip)).includes('plan:tea:coming-up'), 'Road\'s, whole');
      assert.deepEqual(calls(k), was);
      b.heal();
      await k.flush(70_000); // no outside trigger
      const plan = await planIn(k, side);
      assert.ok(THREE.every((w) => plan.includes(w)), `Side's plan is in play: ${plan}`);
      assert.deepEqual(calls(k), was, 'nothing called off, nothing sent');
      assert.deepEqual(await pushedFor(k, side, at('19:01')), THREE.slice().sort());
    } finally {
      await k.stop();
    }
  }));
}

test('a plan file at the move, then the list of /plan/ at the next try: still 0 DELETE, and the plan comes back by itself', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    let b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json');
    await talk(k, side, at('09:30'));
    b.heal();
    b = breakReads(k, (op, scope) => op === 'listFiles' && scope === side);
    await k.flush(70_000);
    b.heal();
    await k.flush(70_000);
    const plan = await planIn(k, side);
    assert.ok(THREE.every((w) => plan.includes(w)), `${plan}`);
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, side), THREE);
  } finally {
    await k.stop();
  }
}));

test('a stop in the plan that is in play, edited with its reload failing: the plan stays whole, and is read again by itself', () => quiet(async () => {
  const k = await pushKit({ plan: { plain: PLAIN, cake: PLACED }, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const before = await copies(k, k.trip);
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === k.trip && path === '/plan/cake.json');
    await k.ws.write(k.trip, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' });
    await k.flush(5000);
    assert.ok(b.log.length >= 1);
    assert.deepEqual(await copies(k, k.trip), before, 'no stop left the plan');
    assert.deepEqual(calls(k), was);
    b.heal();
    await k.flush(70_000);
    assert.deepEqual(calls(k), { off: was.off + 1, sent: was.sent + 1 }, 'the edit is seen, and only the edit');
    assert.ok(k.pushed().every((p) => p.body !== 'In 15 min: Plain at 18:00.'), 'the old words never left the relay');
    k.sensors.visible(false);
    await k.settle();
    await k.deliver(at('18:01'));
    assert.deepEqual(k.pushed().filter((p) => String(p.key).includes('plain')).map((p) => p.what), ['Renamed at 18:00']);
  } finally {
    await k.stop();
  }
}));

test('an open trip that is not happening, with a failed plan read, stops the sync and keeps its copies', () => quiet(async () => {
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
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === future && path === '/plan/cake.json');
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    b.heal();
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await copies(k, future), before);
  } finally {
    await k.stop();
  }
}));

/** Road in play, and Side with a flight and no copy yet. @param {Record<string, any>} [o] */
async function noCopy(o = {}) {
  const k = await pushKit({ plan: ROAD, live: false });
  const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28', ...o });
  await k.mirror.turnOn(RELAY);
  await k.flush();
  await talk(k, k.trip, at('09:00'));
  await k.ws.write(side, '/bookings/ua1.json', UA1, { author: 'user' });
  return { k, side };
}

test('a booking read failing as play moves sends no short words: no copy goes, then the whole one, by itself', () => quiet(async () => {
  const { k, side } = await noCopy();
  try {
    await k.ws.write(side, '/plan/fly.json', FLIGHT, { author: 'user' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json');
    await talk(k, side, at('09:30'));
    await k.flush(40_000);
    assert.deepEqual(calls(k), was, 'nothing goes from a plan not read whole');
    assert.deepEqual(await copies(k, side), []);
    b.heal();
    await k.flush(40_000);
    assert.deepEqual(calls(k), { off: was.off, sent: was.sent + 1 });
    k.sensors.visible(false);
    await k.settle();
    await k.deliver(at('19:01'));
    assert.deepEqual(k.pushed().filter((p) => p.scope === side).map((p) => p.body), ['Leave soon: Flight UA 1 departs 19:00, SFO T2.']);
  } finally {
    await k.stop();
  }
}));

test('the same for an open trip that isn\'t happening: no short words go', () => quiet(async () => {
  const { k, side } = await noCopy({ start: '2026-11-28', end: '2026-12-21' }); // starts while Big Sur runs: not followed as the next trip
  try {
    await k.ws.write(side, '/plan/fly.json', { ...FLIGHT, start: { at: iso('19:00', '2026-11-28'), tz: LA } }, { author: 'user' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json');
    k.agent.opened(side);
    await k.flush(40_000);
    assert.deepEqual(calls(k), was);
    b.heal();
    await k.flush(40_000);
    assert.deepEqual(calls(k), { off: was.off, sent: was.sent + 1 }, 'one copy, once, from the whole plan');
  } finally {
    await k.stop();
  }
}));

test('a stop with no copy yet, Live off and on screen, one failed read as play moves: back in the plan and at the relay with no outside trigger', () => quiet(async () => {
  const { k, side } = await noCopy();
  try {
    await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/plain.json');
    await talk(k, side, at('09:30'));
    b.heal();
    await k.flush(70_000);
    assert.ok((await planIn(k, side)).includes('plan:plain:coming-up'));
    assert.equal(calls(k).sent, was.sent + 1);
  } finally {
    await k.stop();
  }
}));

test('with notifications off, Live off and on screen, the clock alone reads the plan again', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
    await k.ws.write(side, '/plan/plain.json', PLAIN, { author: 'user' });
    await talk(k, k.trip, at('09:00'));
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/plain.json');
    await talk(k, side, at('09:30'));
    b.heal();
    await k.to(k.clock.now() + 70_000);
    await k.settle();
    assert.ok((await planIn(k, side)).includes('plan:plain:coming-up'));
  } finally {
    await k.stop();
  }
}));

for (const live of [false, true]) {
  const mode = live ? 'Live on' : 'Live off';
  test(`${mode}: an edit in a waiting trip whose own sync hits a failed read is called off with no outside trigger`, () => quiet(async () => {
    const { k, side } = await overlap({ live });
    try {
      const was = calls(k);
      const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json');
      await k.ws.write(side, '/plan/cake.json', { ...PLACED, title: 'Tart', place: { name: 'Cafe B', lat: 35.5641, lng: -121.0807 } }, { author: 'user' });
      await k.flush(5000);
      assert.deepEqual(calls(k), was, 'not called off while it can\'t be read');
      b.heal();
      await k.flush(40_000);
      assert.equal(calls(k).off, was.off + 1);
      assert.deepEqual(await copies(k, side), THREE.filter((x) => x !== 'plan:cake:leave'));
      assert.deepEqual((await pushedFor(k, side, at('19:01'))).includes('plan:cake:leave'), false, 'the old words never arrive');
    } finally {
      await k.stop();
    }
  }));

  test(`${mode}, on screen: a read failing as watches come due, whichever read it is, both still fire, once each`, () => quiet(async () => {
    for (const op of ['listFiles', 'getFile', 'getScope', 'listEvents', 'listScopes']) {
      const k = await pushKit({ plan: { plain: PLAIN }, live });
      try {
        const other = await createTrip(k.ws, { title: 'Other', start: '2026-12-20', end: '2026-12-21' });
        await k.mirror.turnOn(RELAY);
        await k.live.setWatch(other, { when: { type: 'time', at: iso('09:10') }, fallback: 'First.' });
        await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('09:20') }, fallback: 'Second.' });
        await k.flush();
        // A read is owed from before they come due, and fails all through them.
        const b = breakReads(k, (name) => name === op);
        await k.ws.write(k.trip, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' });
        await k.flush(1000);
        await k.to(at('09:40'));
        await k.flush(1000);
        b.heal();
        assert.deepEqual(k.agent.wakes.flatMap((w) => w.fallbacks ?? []).concat(k.agent.reminders).map((r) => r.text).sort(), ['First.', 'Second.'], op);
      } finally {
        await k.stop();
      }
    }
  }));
}

test('a read that fails as annai comes back on screen, with news to hear, leaves the clock going and no catch-up stuck', () => quiet(async () => {
  /** @type {any[]} */
  const news = [];
  const k = await pushKit({ plan: ROAD, live: false, news: async () => news.splice(0) });
  try {
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('10:00') }, fallback: 'Tea time.' });
    k.sensors.visible(false);
    await k.settle();
    await k.to(at('09:50'));
    news.push({ kind: 'shown', key: `${k.trip}|x`, scope: k.trip, watch: 'x', t: at('09:49') });
    const b = breakReads(k, (op, key) => op === 'getScope' && key === k.trip);
    k.sensors.visible(true);
    await k.settle();
    b.heal();
    await k.to(at('10:01'));
    await k.settle();
    assert.deepEqual(k.agent.wakes.flatMap((w) => w.fallbacks ?? []).map((r) => r.text), ['Tea time.']);
  } finally {
    await k.stop();
  }
}));

test('a relay retry that meets a failed read isn\'t the end of the chain: the reminder reaches the relay', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    k.net.down.add(new URL(RELAY).host);
    await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    await k.flush(2000);
    assert.equal((await k.mirror.status()).problem?.needsYou, false);
    k.net.down.clear();
    const was = calls(k);
    let left = 1;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === SYS_DEVICE && path === FILE && left-- > 0);
    await k.flush(5 * 60_000);
    b.heal();
    assert.equal(b.log.length, 1, 'the retry met it');
    assert.equal(calls(k).sent, was.sent + 1);
    assert.equal((await k.mirror.status()).problem, null);
  } finally {
    await k.stop();
  }
}));

test('a sync start() or the online event asked for leaves a retry behind too', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    await k.flush();
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    await k.flush();
    const was = calls(k);
    await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...ROAD.tea, title: 'Renamed' }, { author: 'user' });
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === SYS_DEVICE && path === FILE);
    await k.flush(1000);
    await k.mirror.sync().catch(() => {}); // as main.js's online listener: nobody tries again but the mirror
    b.heal();
    await k.flush(40_000);
    assert.equal(calls(k).off, was.off + 1, `${w.id}'s neighbour's edit is seen`);
  } finally {
    await k.stop();
  }
}));

test('a scope record that can\'t be read stops the sync: no copy is retitled "Reminder" over it', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    await talk(k, side, at('09:30'));
    const was = calls(k);
    let left = Infinity;
    const b = breakReads(k, (op, key) => op === 'getScope' && key === side && left-- > 0);
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    assert.deepEqual(calls(k), was);
    left = 0;
    b.heal();
    await k.flush(40_000);
    assert.deepEqual(calls(k), was);
    await pushedFor(k, side, at('19:01'));
    assert.deepEqual([...new Set(k.pushed().filter((p) => p.scope === side).map((p) => p.title))], ['Side']);
  } finally {
    await k.stop();
  }
}));

test('a title that can\'t be read leaves no copy saying what its plan says now: a stopped sync decides nothing', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    await talk(k, side, at('09:30'));
    await k.flush();
    const says = async () => /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items;
    const key = Object.keys(await says()).find((x) => x.includes('plan:cake:leave')) ?? '';
    const was = (await says())[key].says;
    const other = await createTrip(k.ws, { title: 'Later', start: '2026-12-20', end: '2026-12-21' });
    await k.ws.write(other, '/plan/plain.json', { ...PLAIN, start: { at: iso('18:00', '2026-12-20'), tz: LA } }, { author: 'user' });
    const b = breakReads(k, (op, id) => op === 'getScope' && id === other);
    await k.ws.write(side, '/plan/cake.json', { ...PLACED, title: 'Tart' }, { author: 'user' });
    k.agent.opened(other);
    await k.flush(1000);
    assert.ok(b.log.length >= 1);
    assert.equal((await says())[key].says, was, 'the copy still says what it said');
    b.heal();
  } finally {
    await k.stop();
  }
}));

test('a watch file whose read fails is not a broken watch: its copy stays, and it still pushes', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && path === `/watches/${w.id}.json`);
    const second = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('16:30') }, fallback: 'Second.' });
    await k.flush(5000);
    assert.equal(calls(k).off, was.off, 'not called off');
    b.heal();
    await k.flush(70_000);
    assert.equal(calls(k).off, was.off);
    assert.ok((await copies(k, k.trip)).includes(second.id));
    k.sensors.visible(false);
    await k.settle();
    await k.deliver(at('15:01'));
    assert.equal(k.pushed().filter((p) => p.body === 'Call Mum.').length, 1);
  } finally {
    await k.stop();
  }
}));

test('a reload of every conversation that fails part way keeps every watch: none are left out of what the relay should hold', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const w = await k.live.setWatch(side, { when: { type: 'time', at: iso('15:00') }, fallback: 'Side watch.' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope) => op === 'listEvents' && scope === 'me');
    await k.live.tripsChanged();
    await k.flush(5000);
    b.heal();
    await k.flush(70_000);
    assert.deepEqual(calls(k), was);
    assert.ok((await copies(k, side)).includes(w.id));
  } finally {
    await k.stop();
  }
}));

test('a watch changed on disk, with its reload failing, is read again by itself: the file wins, once reads work', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    await k.mirror.turnOn(RELAY);
    const w = await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
    await k.flush();
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'listFiles' && scope === k.trip && path === '/watches/');
    await k.ws.write(k.trip, `/watches/${w.id}.json`, { ...w, fallback: 'Call Dad.' }, { author: 'user' });
    await k.flush(5000);
    assert.deepEqual(calls(k), was);
    b.heal();
    await k.flush(70_000);
    assert.deepEqual(calls(k), { off: was.off + 1, sent: was.sent + 1 });
  } finally {
    await k.stop();
  }
}));

test('a line said while the trips can\'t be read still moves play, by itself', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    const b = breakReads(k, (op) => op === 'listScopes');
    await say(k, side, at('09:30'));
    assert.notEqual(k.live.play, side, 'the rows are the old ones');
    b.heal();
    await k.flush(70_000);
    assert.equal(k.live.play, side);
    const plan = await planIn(k, side);
    assert.ok(THREE.every((x) => plan.includes(x)));
    assert.deepEqual(calls(k), was);
  } finally {
    await k.stop();
  }
}));

for (const [what, fails] of /** @type {[string, (t: string) => (op: string, key: string, path?: any) => boolean][]} */ ([
  ['the trips\' records', () => (op) => op === 'listScopes'],
  ['the plan', (t) => (op, key) => op === 'listFiles' && key === t],
  ['a watch', (t) => (op, key, path) => op === 'getFile' && key === t && String(path).startsWith('/watches/')],
  ['the log', () => (op) => op === 'listEvents'],
])) {
  test(`${what} failing as annai starts: Live starts all the same, says so to a sync, and comes back whole by itself`, () => quiet(async () => {
    const k = await pushKit({ plan: { plain: PLAIN }, live: false });
    try {
      await k.live.setWatch(k.trip, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' });
      await k.settle();
      const b = breakReads(k, fails(k.trip));
      const l = await k.restart();
      await assert.rejects(l.reminders(), { name: 'AbortError' });
      b.heal();
      await k.to(k.clock.now() + 70_000);
      await k.settle();
      const list = (await l.reminders()) ?? [];
      assert.deepEqual(list.map((r) => r.text).sort(), ['Call Mum.', 'In 15 min: Plain at 18:00.']);
    } finally {
      await k.stop();
    }
  }));
}

test('the trip in play removed, with the next one failing to read: nothing more goes into it, and the plan in play comes back by itself', () => quiet(async () => {
  const { k, side } = await overlap({ live: true });
  try {
    await talk(k, side, at('09:30'));
    await k.fix(at('09:31'), RIVER_INN);
    const points = (await k.events(['location'], side)).length;
    const b = breakReads(k, (op, scope) => op === 'listFiles' && scope === k.trip);
    k.agent.opened(k.trip);
    await k.live.forget(side);
    await k.fix(at('09:40'), { lat: 37.62, lng: -122.38 });
    assert.equal((await k.events(['location'], side)).length, points);
    assert.deepEqual(await planIn(k, side), []);
    b.heal();
    await k.flush(70_000);
    assert.ok((await planIn(k, k.trip)).includes('plan:tea:coming-up'));
  } finally {
    await k.stop();
  }
}));

test('Live off: the trip in play removed, the next plan failing to read: the clock alone brings it back', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
    await talk(k, side, at('09:00'));
    k.agent.opened(k.trip);
    await k.settle();
    const b = breakReads(k, (op, scope) => op === 'listFiles' && scope === k.trip);
    await k.live.forget(side);
    b.heal();
    await k.to(k.clock.now() + 70_000);
    await k.settle();
    assert.ok((await planIn(k, k.trip)).includes('plan:tea:coming-up'));
  } finally {
    await k.stop();
  }
}));

test('play moving starts a new road, once its plan is read: the stop and the last point go with the move, not with a move that failed', () => quiet(async () => {
  const { k, side } = await overlap({ live: true });
  try {
    await k.fix(at('09:01'), RIVER_INN);
    const b = breakReads(k, (op, scope) => op === 'listFiles' && scope === side);
    await say(k, side, at('09:05'));
    assert.ok(k.live.stop, 'still the road it was on');
    b.heal();
    await k.flush(70_000);
    assert.equal(k.live.stop, null);
    await k.fix(k.clock.now() + 1000, RIVER_INN);
    assert.equal((await k.events(['location'], side)).length, 1, 'its first point, where the user stands');
  } finally {
    await k.stop();
  }
}));

test('a look at no trip keeps what the plan in play remembers: looking changes nothing', () => quiet(async () => {
  const k = await pushKit({ plan: ROAD, live: false, start: at('08:30', '2026-11-20') });
  try {
    await k.settle();
    const before = k.live.held;
    assert.ok(before.length > 0);
    k.agent.opened(null);
    await k.settle();
    assert.deepEqual(k.live.held, before);
  } finally {
    await k.stop();
  }
}));

/** A simulation's trip, with a stop and a watch of its own, outside its run. @param {{ start?: number }} [o] */
async function stillTrip(o = {}) {
  const k = await pushKit({ plan: ROAD, live: false, ...o });
  const sim = await k.chat('Simulation', { start: '2026-11-27', end: '2026-11-27' });
  await k.ws.patch(sim, '/trip.json', { simulation: true }, { author: 'user' });
  await k.ws.write(sim, '/plan/plain.json', PLAIN, { author: 'user' });
  await k.ws.write(sim, '/watches/w-sim.json', { id: 'w-sim', owner: 'shiori', when: { type: 'time', at: iso('15:00') }, fallback: 'Sim.', created: iso('08:00') }, { author: 'user' });
  await k.settle();
  return { k, sim };
}
/** Whether a simulation's trip's own /trip.json fails, once. @param {Kit} k @param {string} sim */
const tripJsonOnce = (k, sim) => {
  let left = 1;
  return breakReads(k, (op, scope, path) => op === 'getFile' && scope === sim && path === '/trip.json' && left-- > 0);
};

test('a simulation\'s trip stays still when the read that says so fails: its plan doesn\'t come into play', () => quiet(async () => {
  const { k, sim } = await stillTrip({ start: at('08:30', '2026-11-20') });
  try {
    const b = tripJsonOnce(k, sim);
    k.agent.opened(sim);
    await k.settle();
    assert.equal(b.log.length, 1);
    b.heal();
    assert.deepEqual(await planIn(k, sim), []);
  } finally {
    await k.stop();
  }
}));

test('a simulation\'s trip stays still when the read that says so fails: its watches aren\'t loaded', () => quiet(async () => {
  const { k, sim } = await stillTrip();
  try {
    const b = tripJsonOnce(k, sim);
    await k.ws.write(sim, '/watches/w-sim.json', { id: 'w-sim', owner: 'shiori', when: { type: 'time', at: iso('15:30') }, fallback: 'Sim.', created: iso('08:00') }, { author: 'user' });
    await k.settle();
    assert.equal(b.log.length, 1);
    b.heal();
    assert.equal(await k.live.listWatches(sim), 'No watches.');
  } finally {
    await k.stop();
  }
}));

test('a simulation brings its trip\'s plan and watches into play, and its end takes them out whatever a read says: the real plan comes back by itself', () => quiet(async () => {
  const { k, sim } = await stillTrip();
  try {
    const giveBack = await k.live.simulate({ clock: new ManualClock(at('11:00')), timeZone: () => LA, trip: sim });
    k.agent.opened(sim);
    await k.settle();
    assert.ok((await planIn(k, sim)).includes('plan:plain:coming-up'));
    assert.ok((await k.live.listWatches(sim)).includes('w-sim'));
    const b = breakReads(k, (op, scope) => op === 'listFiles');
    await giveBack();
    assert.deepEqual(await planIn(k, sim), [], 'it reminds of nothing on the real clock, read or no read');
    assert.deepEqual(await planIn(k, k.trip), []);
    b.heal();
    await k.to(k.clock.now() + 70_000);
    await k.settle();
    assert.ok((await planIn(k, k.trip)).includes('plan:tea:coming-up'));
    assert.equal(await k.live.listWatches(sim), 'No watches.');
  } finally {
    await k.stop();
  }
}));

test('a fired stop doesn\'t fire twice across a failed load: its firing isn\'t forgotten, and it is read again whole', () => quiet(async () => {
  const STOP = { title: 'Stop', fixed: true, start: { at: iso('10:00'), tz: LA } };
  const LATER = { title: 'Later', fixed: true, start: { at: iso('12:00'), tz: LA } };
  const k = await pushKit({ plan: { stop: STOP, later: LATER }, live: true });
  try {
    await k.mirror.turnOn(RELAY);
    await k.to(at('09:45'));
    await k.flush(1000);
    const first = k.agent.wakes.length;
    assert.equal((await k.events(['trigger.fired'])).length, 1);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === k.trip && path === '/plan/stop.json');
    await k.ws.write(k.trip, '/plan/later.json', { id: 'later', ...LATER, title: 'Later 2' }, { author: 'user' });
    await k.flush(70_000);
    b.heal();
    await k.flush(190_000);
    assert.equal(k.agent.wakes.length, first, 'said once');
    assert.equal((await k.events(['trigger.fired'])).length, 1);
    assert.deepEqual((await k.live.reminders())?.filter((r) => r.watch.includes('stop')), []);
  } finally {
    await k.stop();
  }
}));

test('no false "off plan" while a read fails: the place the user is stopped at stays on the plan', () => quiet(async () => {
  const OTHER = { lat: 36.6036, lng: -121.8916 };
  const inn = { title: 'Inn', fixed: false, start: { at: iso('10:00'), tz: LA }, place: { name: 'Inn', ...RIVER_INN } };
  const other = { title: 'Other', fixed: false, start: { at: iso('14:00'), tz: LA }, place: { name: 'Other', ...OTHER } };
  const k = await pushKit({ plan: { inn, other }, live: true });
  try {
    await k.fix(at('09:00'), { lat: 36.0, lng: -121.0 }, { speed: 0 });
    await k.drive({ lat: 36.0, lng: -121.0 }, RIVER_INN, at('09:01'), at('09:40'), 30);
    await k.stay(RIVER_INN, at('09:40'), at('10:05'), 30);
    const first = k.agent.wakes.length;
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === k.trip && path === '/plan/inn.json');
    await k.ws.write(k.trip, '/plan/other.json', { id: 'other', ...other, title: 'Other 2' }, { author: 'user' });
    await k.settle();
    await k.stay(RIVER_INN, at('10:05:30'), at('10:06:30'), 30);
    b.heal();
    await k.stay(RIVER_INN, at('10:07'), at('10:08'), 30);
    assert.deepEqual(k.agent.wakes.slice(first).filter((w) => String(w.text).includes('Off plan')), []);
  } finally {
    await k.stop();
  }
}));

test('a file gone between the list and its read is an answer: its copy goes', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const was = calls(k);
    const real = k.ws.list.bind(k.ws);
    let once = true;
    k.ws.list = async (/** @type {string} */ s, /** @type {string} */ p) => {
      const out = await real(s, p);
      if (s === side && p === '/plan/' && once) {
        once = false;
        await k.store.tx(['files'], 'readwrite', (t) => t.deleteFile(side, '/plan/cake.json'));
      }
      return out;
    };
    await k.mirror.sync();
    await k.flush();
    assert.equal(calls(k).off, was.off + 1);
    assert.deepEqual(await copies(k, side), THREE.filter((x) => x !== 'plan:cake:leave'));
  } finally {
    await k.stop();
  }
}));

test('a copy from before says takes no digest from a read that failed: it takes the whole plan\'s, once that reads', () => quiet(async () => {
  const { k, side } = await overlap();
  try {
    const st = /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE));
    const whole = Object.fromEntries(Object.entries(st.items).map(([key, i]) => [key, /** @type {any} */ (i).says]));
    for (const i of Object.values(st.items)) delete /** @type {any} */ (i).says;
    await k.ws.write(SYS_DEVICE, FILE, st, { author: 'system' });
    const was = calls(k);
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/bookings/ua1.json');
    await assert.rejects(k.mirror.sync(), { name: 'AbortError' });
    b.heal();
    await k.flush(40_000);
    assert.deepEqual(calls(k), was);
    const items = /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE)).items;
    assert.deepEqual(Object.fromEntries(Object.entries(items).map(([key, i]) => [key, /** @type {any} */ (i).says])), whole);
  } finally {
    await k.stop();
  }
}));

test('with nothing owed, the plan in play isn\'t read again: not by a sync, a look or the clock, and not after a failed read has healed', () => quiet(async () => {
  const { k, side } = await overlap({ live: true });
  try {
    const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === k.trip && path === '/plan/tea.json');
    await k.ws.write(k.trip, '/plan/tea.json', { id: 'tea', ...ROAD.tea, notes: 'x' }, { author: 'user' });
    await k.flush(5000);
    b.heal();
    await k.flush(70_000);
    let reads = 0;
    const real = k.ws.list.bind(k.ws);
    k.ws.list = (/** @type {string} */ s, /** @type {string} */ p) => {
      if (s === k.trip && p === '/plan/') reads++;
      return real(s, p);
    };
    await k.mirror.sync();
    k.agent.opened(side);
    await k.flush(120_000);
    assert.equal(reads, 0);
  } finally {
    await k.stop();
  }
}));

// Known limitation (docs/limitations.md): nothing runs while annai is closed.
async function editThenClose() {
  const o = await overlap();
  const { k, side } = o;
  const was = calls(k);
  const b = breakReads(k, (op, scope, path) => op === 'getFile' && scope === side && path === '/plan/cake.json');
  await k.ws.write(side, '/plan/cake.json', { ...PLACED, title: 'Tart' }, { author: 'user' });
  await k.flush(1000);
  b.heal();
  k.mirror.dispose(); // annai closes before the retry
  k.sensors.visible(false);
  await k.settle();
  return { ...o, was };
}

test('limitation: an edit in a waiting trip, its sync stopped by a failed read, annai closed before the retry: the old words can arrive', () => quiet(async () => {
  const { k, side, was } = await editThenClose();
  try {
    assert.deepEqual(calls(k), was);
    for (let t = k.clock.now() + 600_000; t < at('17:00'); t += 600_000) await k.deliver(t);
    await k.deliver(at('17:00'));
    assert.deepEqual(k.pushed().filter((p) => p.scope === side && p.key.includes('cake')).map((p) => p.body), ['Leave soon: Cake at 17:00, Cafe A.']);
  } finally {
    await k.stop();
  }
}));

test('limitation, its end: annai opening before the copy\'s time calls it off', () => quiet(async () => {
  const { k, side, was } = await editThenClose();
  try {
    await k.to(at('10:00'));
    await k.mirror.sync(); // what opening starts
    assert.equal(calls(k).off, was.off + 1);
    assert.deepEqual(await copies(k, side), THREE.filter((x) => x !== 'plan:cake:leave'));
  } finally {
    await k.stop();
  }
}));

test('turning notifications on with no /push.json yet still works: a missing file is an answer', async () => {
  const k = await pushKit({ plan: ROAD, live: false });
  try {
    assert.equal(await k.ws.readText(SYS_DEVICE, FILE), undefined);
    assert.equal((await k.mirror.status()).on, false);
    await k.mirror.turnOn(RELAY);
    assert.equal((await k.mirror.status()).on, true);
    assert.equal(k.pushed().length, 1, 'the hello');
  } finally {
    await k.stop();
  }
});

// Every read a healthy run makes, failed in turn: the first any test has of "any read, of any store call". Once it heals, the relay ends as
// the healthy run did: the same copies, saying the same, after the same requests. Nothing else may have been called off, or gone short.
/** @param {Kit} k @param {string[]} [trips] */
const relayState = async (k, trips = []) => {
  const st = /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE));
  const name = (/** @type {string} */ key) => trips.reduce((x, id, i) => x.replaceAll(id, `t${i}`), key).replace(/w-[a-z0-9]+/, 'watch');
  const items = Object.entries(st.items).map(([key, i]) => [name(key), /** @type {any} */ (i).hash, /** @type {any} */ (i).says ?? null, Boolean(/** @type {any} */ (i).sending)]);
  return { items: items.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), calls: calls(k) };
};

/**
 * @param {string} name @param {() => Promise<{ k: Kit, side: string }>} make @param {(o: { k: Kit, side: string }) => Promise<unknown>} act
 * @param {(o: { k: Kit, side: string }) => Promise<unknown>} [also] more that must end as the healthy run's did, where the relay can't show it
 */
function everyRead(name, make, act, also) {
  test(`every read failed in turn, ${name}: the relay ends as the healthy run did`, () => quiet(async () => {
    const run = async (/** @type {(seen: number) => boolean} */ fails) => {
      const o = await make();
      try {
        let seen = 0;
        const b = breakReads(o.k, () => fails(seen++));
        await act(o);
        await o.k.flush(5000);
        b.heal();
        await o.k.flush(70_000);
        return { state: [await relayState(o.k, [o.k.trip, o.side]), await also?.(o)], reads: seen, log: b.log };
      } finally {
        await o.k.stop();
      }
    };
    const healthy = await run(() => false);
    assert.ok(healthy.reads > 5, `${healthy.reads} reads`);
    for (const width of [1, 8, Infinity]) { // Infinity: the store goes at that read, and stays gone until it heals
      for (let i = 0; i < healthy.reads; i += 1) {
        const r = await run((seen) => seen >= i && seen < i + width);
        assert.deepEqual(r.state, healthy.state, `read ${i}, ${width} wide: ${r.log[0]}`);
      }
    }
  }));
}

const inSide = async () => {
  const o = await overlap();
  await talk(o.k, o.side, at('09:10'));
  return o;
};
const liveOn = () => overlap({ live: true });
everyRead('in a look\'s sync', overlap, async ({ k, side }) => { k.agent.opened(side); });
everyRead('with Live on, as play moves', liveOn, ({ k, side }) => say(k, side, at('09:30')));
everyRead('with Live on, as a stop is edited in a waiting trip', liveOn, ({ k, side }) => k.ws.write(side, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' }));
everyRead('as play moves', overlap, ({ k, side }) => say(k, side, at('09:30')));
everyRead('in a plain sync, with Side in play', inSide, ({ k }) => k.mirror.sync().catch(() => {}));
everyRead('as a stop is edited in a waiting trip', overlap, ({ k, side }) => k.ws.write(side, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' }));
everyRead('as a stop is edited in the trip in play', inSide, ({ k, side }) => k.ws.write(side, '/plan/plain.json', { ...PLAIN, title: 'Renamed' }, { author: 'user' }));
everyRead('as a booking is edited in the trip in play', inSide, ({ k, side }) => k.ws.write(side, '/bookings/ua1.json', { ...UA1, fields: { terminal: 'T3' } }, { author: 'user' }));
everyRead('as a reminder is set', overlap, ({ k, side }) => k.live.setWatch(side, { when: { type: 'time', at: iso('15:00') }, fallback: 'Call Mum.' }));
// start() reads too: a repeating watch that fired at 09:20 must not fire again at 09:25 because a read of its firings failed.
everyRead('as annai starts again, with a 20-minute watch fired at 09:20', async () => {
  const o = await overlap({ live: true });
  o.k.agent.opened(null); // the watch is Me's
  await o.k.flush();
  await o.k.live.setWatch('me', { when: { type: 'every', minutes: 20 }, fallback: 'Stretch.' });
  await o.k.to(at('09:21'));
  await o.k.flush();
  return o;
}, async ({ k }) => { await k.to(at('09:25')); await k.reopen({ mirrorMayFail: true }); },
// A repeating watch has no copy at the relay: what shows a false firing is the log of firings.
async ({ k }) => (await k.events(['trigger.fired'], 'me')).map((e) => new Date(e.ts).toISOString().slice(11, 16)));
everyRead('as a stop with no copy comes into play', async () => {
  const o = await noCopy();
  await o.k.ws.write(o.side, '/plan/fly.json', FLIGHT, { author: 'user' });
  await o.k.flush();
  return o;
}, ({ k, side }) => say(k, side, at('09:30')));

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
