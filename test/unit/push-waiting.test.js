import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pushKit, RELAY, at, iso, LA } from './push-kit.js';
import { BIXBY, MONTEREY, RIVER_INN, CAMBRIA } from './live-kit.js';
import { FILE, GRACE_MS } from '../../src/core/push/mirror.js';
import { createTrip, listTrips, removeTrip, setTripStatus, SYS_DEVICE } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { setWords } from '../../src/core/l10n.js';
import { exportArchive, peekArchive, importArchive, PRESETS } from '../../src/core/archive.js';

// The user, 2026-11-06, "Talking moves it" and "Call it off (Recommended)": a copy of a trip that isn't in play stays only while that
// trip's plan still says the same thing, and which trip is open plays no part. Road and Side both happen today, on the real Live, mirror,
// relay and workspace: Side's copies went to the relay while it was in play, then the user talked in Road.

const ROAD = { tea: { title: 'Tea at the inn', fixed: true, start: { at: iso('16:00'), tz: LA } } };
const CAFE_A = { name: 'Cafe A', ...RIVER_INN };
const CAFE_B = { name: 'Cafe B', ...CAMBRIA };
/** A fixed stop with a place: its copy is a "leave soon". */
const PLACED = { id: 'cake', title: 'Cake', fixed: true, start: { at: iso('17:00'), tz: LA }, place: CAFE_A };
/** A fixed stop with no place: its copy is a "coming up". */
const PLAIN = { id: 'cake', title: 'Cake', fixed: true, start: { at: iso('17:00'), tz: LA } };
const UA1 = { id: 'ua1', kind: 'flight', status: 'confirmed', source: '/files/x.pdf', title: 'UA 1', fields: { terminal: 'T2' } };
const FLIGHT = { id: 'fly', title: 'Flight', fixed: true, kind: 'flight', start: { at: iso('17:00'), tz: LA }, booking: '/bookings/ua1.json', place: { name: 'SFO', lat: 37.62, lng: -122.38 } };

/** @typedef {Awaited<ReturnType<typeof pushKit>>} Kit */

/** A line of the user's in a trip at t, as Live hears it through the rows. @param {Kit} k @param {string} scope @param {number} t */
async function talk(k, scope, t) {
  await k.to(t);
  await record(k.store, scope, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'hello']], now: t });
  k.agent.opened(scope);
  await k.flush();
  assert.equal(k.live.play, scope);
}

/** What /push.json keeps of a trip's copies, by key. @param {Kit} k @param {string} scope @returns {Promise<Record<string, any>>} */
const copies = async (k, scope) => Object.fromEntries(Object.entries((/** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE))).items).filter(([, i]) => /** @type {any} */ (i).scope === scope));
/** Calls to the relay so far, called off and sent. @param {Kit} k */
const calls = (k) => ({ off: k.net.calls.filter((c) => c.method === 'DELETE').length, sent: k.net.calls.filter((c) => c.method === 'POST').length });
/** The events of a trip's copies, sorted. @param {Kit} k @param {string} scope */
const events = async (k, scope) => Object.keys(await copies(k, scope)).map((key) => key.split('|')[1].split(':').slice(1).join(':')).sort();

/**
 * Side's plan is at the relay, then the user talks in Road. look: Side is left open after it.
 * @param {{ plan: Record<string, any>, bookings?: Record<string, any>, road?: Record<string, any>, live?: boolean, look?: boolean }} o
 */
async function overlap({ plan, bookings = {}, road = ROAD, live = false, look = false }) {
  const k = await pushKit({ plan: road, live });
  try {
    const side = await createTrip(k.ws, { title: 'Side', start: '2026-11-27', end: '2026-11-28' });
    for (const [p, b] of Object.entries(bookings)) await k.ws.write(side, p, b, { author: 'user' });
    for (const [p, item] of Object.entries(plan)) await k.ws.write(side, p, item, { author: 'user' });
    await k.mirror.turnOn(RELAY);
    await talk(k, side, at('08:31'));
    await talk(k, k.trip, at('09:00'));
    assert.ok(Object.keys(await copies(k, side)).length, 'side has copies');
    if (look) {
      k.agent.opened(side);
      await k.flush();
    }
    return { k, side };
  } catch (e) {
    await k.stop();
    throw e;
  }
}

/** What the phone pushes for a trip, up to t. @param {Kit} k @param {string} scope @param {number} t */
async function pushed(k, scope, t) {
  k.sensors.visible(false);
  await k.settle();
  await k.deliver(t);
  return k.pushed().filter((p) => p.scope === scope).map((p) => p.body);
}

// F1: the key carries only the time, so nothing else was seen.
for (const look of [false, true]) {
  const where = look ? 'left open' : 'not open';
  /** @type {[string, Record<string, any>, any, Record<string, any>?][]} */
  const edits = [
    ['renamed: a "coming up"', { '/plan/cake.json': PLAIN }, { ...PLAIN, title: 'Pie' }],
    ['renamed: a "leave soon"', { '/plan/cake.json': PLACED }, { ...PLACED, title: 'Pie' }],
    ['moved to another place', { '/plan/cake.json': PLACED }, { ...PLACED, place: CAFE_B }],
    ['moved to a place of the same name', { '/plan/cake.json': PLACED }, { ...PLACED, place: { ...CAFE_B, name: CAFE_A.name } }],
  ];
  for (const [what, plan, edited] of edits) {
    test(`a stop ${what}, in a waiting trip ${where}: its copy is called off, nothing is sent, and the old words never come`, async () => {
      const { k, side } = await overlap({ plan, look });
      try {
        const was = calls(k);
        await k.ws.write(side, '/plan/cake.json', edited, { author: 'user' });
        await k.flush();
        assert.equal(k.live.play, k.trip, 'still not in play');
        assert.deepEqual(await copies(k, side), {});
        assert.deepEqual(calls(k), { off: was.off + 1, sent: was.sent }, 'the one copy, and nothing sent for it');
        assert.deepEqual(await pushed(k, side, at('17:01')), []);
      } finally { await k.stop(); }
    });
  }

  test(`a booking's terminal changed, in a waiting trip ${where}: the flight's copy is called off`, async () => {
    const { k, side } = await overlap({ plan: { '/plan/fly.json': FLIGHT }, bookings: { '/bookings/ua1.json': UA1 }, look });
    try {
      await k.ws.write(side, '/bookings/ua1.json', { ...UA1, fields: { terminal: 'T3' } }, { author: 'user' });
      await k.flush();
      assert.deepEqual(await copies(k, side), {});
      assert.deepEqual(await pushed(k, side, at('17:01')), []);
    } finally { await k.stop(); }
  });
}

// F2: which trip is open at sync time decided it, so an edit no sync saw escaped.
for (const how of ['deleted', 'renamed']) {
  test(`a stop ${how} offline in a waiting trip, then the user leaves it, then the connection returns: its copy is called off`, async () => {
    const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN }, look: true });
    try {
      k.net.online = false;
      if (how === 'deleted') await k.ws.delete(side, '/plan/cake.json', { author: 'user' });
      else await k.ws.write(side, '/plan/cake.json', { ...PLAIN, title: 'Pie' }, { author: 'user' });
      await k.flush();
      k.agent.opened(k.trip);
      await k.flush();
      k.net.online = true;
      await k.mirror.sync();
      await k.flush();
      assert.deepEqual(await copies(k, side), {});
    } finally { await k.stop(); }
  });
}

test('a stop deleted within the half second before the sync, as the user leaves the trip: its copy is called off', async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN }, look: true });
  try {
    await k.ws.delete(side, '/plan/cake.json', { author: 'user' });
    k.agent.opened(k.trip);
    await k.flush();
    assert.deepEqual(await copies(k, side), {});
  } finally { await k.stop(); }
});

test('a stop just sent, renamed offline in the trip in play, then a line in the other trip, then the connection returns: its copy is called off, though no sync saw the edit', async () => {
  const fresh = { ...PLAIN, id: 'fresh', title: 'Fresh', start: { at: iso('19:00'), tz: LA } };
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    await talk(k, side, at('10:00'));
    await k.ws.write(side, '/plan/fresh.json', fresh, { author: 'user' });
    await k.flush();
    assert.deepEqual(await events(k, side), ['cake:coming-up', 'fresh:coming-up']);
    k.net.online = false;
    await k.ws.write(side, '/plan/fresh.json', { ...fresh, title: 'Pie' }, { author: 'user' });
    await k.flush();
    await talk(k, k.trip, at('10:30'));
    k.net.online = true;
    await k.mirror.sync();
    await k.flush();
    assert.deepEqual(await events(k, side), ['cake:coming-up']);
  } finally { await k.stop(); }
});

test("a stop's pin moved in the trip in play leaves its copy at the relay, and a line in the other trip then keeps it", async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLACED } });
  try {
    await talk(k, side, at('10:00'));
    const was = calls(k);
    await k.ws.write(side, '/plan/cake.json', { ...PLACED, place: { ...CAFE_A, lat: CAFE_A.lat + 0.001 } }, { author: 'user' });
    await k.flush();
    assert.deepEqual(calls(k), was, 'its words and time hold');
    await talk(k, k.trip, at('10:30'));
    assert.deepEqual(await events(k, side), ['cake:leave']);
    assert.deepEqual(calls(k), was);
  } finally { await k.stop(); }
});

test('a copy stands still: no fix, hour, look, language, zone or new day calls off or sends a good copy, for either kind', async () => {
  const DAY2 = '2026-11-28';
  const { k, side } = await overlap({
    road: {},
    live: true,
    plan: {
      '/plan/cake.json': { ...PLACED, start: { at: iso('17:00', DAY2), tz: LA } },
      '/plan/plain.json': { ...PLAIN, id: 'plain', title: 'Plain', start: { at: iso('18:00', DAY2), tz: LA } },
    },
  });
  try {
    const before = await copies(k, side);
    assert.deepEqual(await events(k, side), ['cake:leave', 'plain:coming-up']);
    const was = calls(k);
    /** @param {string} step */
    const same = async (step) => {
      await k.mirror.sync();
      await k.flush(40_000);
      assert.equal(k.live.play, k.trip, step);
      assert.deepEqual(await copies(k, side), before, step);
      assert.deepEqual(calls(k), was, step);
    };
    await k.fix(at('09:01'), BIXBY);
    await same('a fix elsewhere');
    k.agent.opened(side);
    await same('a look');
    for (let i = 1; i <= 6; i++) await k.fix(at('09:30') + i * 30 * 60_000, MONTEREY, { speed: 20 });
    await same('three hours of fixes, on the move');
    await k.fix(at('13:00'), CAFE_A, { speed: 0 });
    await same("standing inside the leave's radius");
    setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
    await same('the screens in Japanese');
    k.live.timeZone = () => 'Asia/Tokyo';
    await same('the phone in another zone');
    await k.to(at('00:30', DAY2));
    await same('the day turning');
    // Words wait until the trip is back in play: then it goes once, in the screens' language.
    k.live.timeZone = () => LA;
    await talk(k, side, at('01:00', DAY2));
    assert.deepEqual(await events(k, side), ['cake:leave', 'plain:coming-up']);
    assert.notDeepEqual(await copies(k, side), before);
    assert.deepEqual(calls(k), { off: was.off + 2, sent: was.sent + 2 });
  } finally {
    setWords('en', null);
    await k.stop();
  }
});
after(() => setWords('en', null));

test('a look, there and back, changes no copy of either trip', async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLACED, '/plan/plain.json': { ...PLAIN, id: 'plain', title: 'Plain', start: { at: iso('18:00'), tz: LA } } } });
  try {
    const before = [await copies(k, side), await copies(k, k.trip)];
    const was = calls(k);
    k.agent.opened(side);
    await k.flush();
    k.agent.opened(k.trip);
    await k.flush();
    k.agent.opened(side);
    await k.flush();
    assert.deepEqual([await copies(k, side), await copies(k, k.trip)], before);
    assert.deepEqual(calls(k), was);
  } finally { await k.stop(); }
});

test("a line in one trip keeps the other's copies and sends its own; really moving play back doubles nothing and calls nothing off", async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    assert.deepEqual(await events(k, k.trip), ['tea:coming-up'], "the road's own went out with its line");
    assert.deepEqual(await events(k, side), ['cake:coming-up'], "and side's stayed");
    const before = [await copies(k, side), await copies(k, k.trip)];
    const was = calls(k);
    await talk(k, side, at('10:00'));
    await talk(k, k.trip, at('11:00'));
    assert.deepEqual([await copies(k, side), await copies(k, k.trip)], before);
    assert.deepEqual(calls(k), was);
    assert.equal((await k.waiting()).length, 2);
  } finally { await k.stop(); }
});

test('what nobody changed stays: another stop, a note, an end time, a stop added before it, the trip\'s name', async () => {
  const later = { ...PLAIN, id: 'later', title: 'Later', start: { at: iso('19:00'), tz: LA } };
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLACED, '/plan/later.json': later } });
  try {
    const before = await copies(k, side);
    const was = calls(k);
    await k.ws.write(side, '/plan/cake.json', { ...PLACED, notes: 'Bring the box.', end: { at: iso('18:00'), tz: LA } }, { author: 'user' });
    await k.flush();
    await k.ws.write(side, '/plan/before.json', { id: 'before', title: 'Before', fixed: true, start: { at: iso('15:00'), tz: LA }, place: CAFE_B }, { author: 'user' });
    await k.flush();
    await k.ws.patch(side, '/trip.json', { title: 'Side trip' }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await copies(k, side), before);
    assert.deepEqual(calls(k), was);
    await k.ws.write(side, '/plan/later.json', { ...later, title: 'Much later' }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await events(k, side), ['cake:leave'], 'one stop changed: its copy alone goes');
  } finally { await k.stop(); }
});

test('a new stop in a waiting trip sends nothing, and an open trip that is only coming up still sends its edit at once', async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN }, look: true });
  try {
    const was = calls(k);
    await k.ws.write(side, '/plan/new.json', { ...PLAIN, id: 'new', title: 'New', start: { at: iso('19:00'), tz: LA } }, { author: 'user' });
    await k.flush();
    assert.deepEqual(calls(k), was);
    assert.deepEqual(await events(k, side), ['cake:coming-up']);
    // It starts while the trip in play still runs, so it isn't followed as the next trip is (live.js #nextTrips).
    const next = await createTrip(k.ws, { title: 'Next', start: '2026-11-28', end: '2026-12-02' });
    k.agent.opened(next);
    await k.flush();
    await k.ws.write(next, '/plan/fly.json', { ...PLAIN, id: 'fly', title: 'Fly', start: { at: iso('09:00', '2026-11-28'), tz: LA } }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await events(k, next), ['fly:coming-up']);
    assert.deepEqual(calls(k), { off: was.off, sent: was.sent + 1 });
    k.agent.opened(k.trip);
    await k.flush();
    assert.deepEqual(await events(k, next), ['fly:coming-up'], 'left, it waits as any trip does');
    await k.ws.write(next, '/plan/fly.json', { ...PLAIN, id: 'fly', title: 'Flight', start: { at: iso('09:00', '2026-11-28'), tz: LA } }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await copies(k, next), {}, 'and goes as any trip\'s does');
  } finally { await k.stop(); }
});

test("a removed trip's copies go, and an archived trip's", async () => {
  for (const how of ['removed', 'archived']) {
    const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
    try {
      if (how === 'removed') {
        await removeTrip(k.store, side);
        await k.live.forget(side);
      } else {
        await setTripStatus(k.store, side, 'archived');
        await k.live.tripsChanged();
      }
      await k.flush();
      assert.deepEqual(await copies(k, side), {}, how);
    } finally { await k.stop(); }
  }
});

test('writing /push.json starts no sync: after an edit, two idle minutes reach the relay no more', async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    await k.ws.write(side, '/plan/cake.json', { ...PLAIN, title: 'Pie' }, { author: 'user' });
    await k.flush();
    const was = k.net.calls.length;
    await k.flush(120_000);
    assert.equal(k.net.calls.length, was);
  } finally { await k.stop(); }
});

test('a sync reads the plan only of the trips with copies at the relay', async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    const none = await createTrip(k.ws, { title: 'Nothing there', start: '2026-11-27', end: '2026-11-28' });
    await k.flush();
    /** @type {string[]} */
    const read = [];
    const list = k.ws.list.bind(k.ws);
    k.ws.list = (/** @type {string} */ scope, /** @type {string} */ path) => {
      if (path === '/plan/') read.push(scope);
      return list(scope, path);
    };
    await k.mirror.sync();
    assert.deepEqual(read, [side]);
    assert.ok((await listTrips(k.store)).active.some((t) => t.id === none));
  } finally { await k.stop(); }
});

// The release: copies already waiting carry nothing to compare with.
test('a copy sent before this release: the first sync neither calls it off nor sends it, and from then on a change calls it off', async () => {
  const later = { ...PLAIN, id: 'later', title: 'Later', start: { at: iso('19:00'), tz: LA } };
  const gone = { ...PLAIN, id: 'gone', title: 'Gone', start: { at: iso('20:00'), tz: LA } };
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLACED, '/plan/later.json': later, '/plan/gone.json': gone } });
  try {
    const st = /** @type {any} */ (await k.ws.readJSON(SYS_DEVICE, FILE));
    for (const item of Object.values(st.items)) delete /** @type {any} */ (item).says;
    await k.ws.write(SYS_DEVICE, FILE, st, { author: 'system' });
    await k.ws.delete(side, '/plan/gone.json', { author: 'user' }); // gone while the old copy of annai ran
    await k.flush();
    const was = calls(k);
    await k.mirror.sync();
    await k.flush();
    assert.deepEqual(await events(k, side), ['cake:leave', 'later:coming-up'], 'all but the stop already gone stay');
    assert.deepEqual(calls(k), was);
    await k.ws.write(side, '/plan/later.json', { ...later, title: 'Much later' }, { author: 'user' });
    await k.ws.write(side, '/plan/cake.json', { ...PLACED, place: CAFE_B }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await copies(k, side), {});
  } finally { await k.stop(); }
});

// A restore that changes a trip that isn't open, and isn't in play, by each road a restore has.
test("a backup restored over a trip that isn't open and isn't in play: the replaced trip's copies go, and the restored trip waits to be talked in", async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    const { blob } = await exportArchive(k.store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
    const opened = await peekArchive(new Uint8Array(await blob.arrayBuffer()));
    await k.ws.write(side, '/plan/cake.json', { ...PLAIN, start: { at: iso('20:00'), tz: LA } }, { author: 'user' });
    await k.flush();
    const r = await importArchive(k.store, opened, { trips: { [side]: 'replace', [k.trip]: 'skip' }, now: k.clock.now() });
    assert.deepEqual(r.archived, [side]);
    await k.live.tripsChanged();
    await k.flush();
    assert.equal(k.live.play, k.trip);
    assert.deepEqual(await copies(k, side), {});
    assert.deepEqual(await copies(k, r.trips[0]), {});
  } finally { await k.stop(); }
});

test("a stop's earlier version restored in a trip that isn't open and isn't in play: its copy is called off", async () => {
  const { k, side } = await overlap({ plan: { '/plan/cake.json': PLAIN } });
  try {
    const first = /** @type {any} */ (await k.store.tx(['files'], 'readonly', (t) => t.getFile(side, '/plan/cake.json'))).hash;
    await k.ws.delete(side, '/plan/cake.json', { author: 'user' });
    await k.ws.write(side, '/plan/cake.json', { ...PLAIN, title: 'Pie' }, { author: 'user' });
    await k.flush();
    assert.deepEqual(await copies(k, side), {});
    await talk(k, side, at('09:30'));
    assert.deepEqual(await events(k, side), ['cake:coming-up'], 'its new words went with the line');
    await talk(k, k.trip, at('09:45'));
    await k.ws.restore(side, '/plan/cake.json', first, { author: 'user' });
    await k.flush();
    assert.deepEqual(await copies(k, side), {});
  } finally { await k.stop(); }
});

test("an undated trip open while another is in play: a sync within 5 s of its reminder's send time keeps the copy, which annai won't say itself (the deferred gap, closed at stage 4)", async () => {
  const k = await pushKit({ plan: ROAD });
  try {
    const open = await createTrip(k.ws, { title: 'Undated, with a plan' });
    await k.ws.write(open, '/plan/cake.json', PLAIN, { author: 'user' });
    await k.mirror.turnOn(RELAY);
    k.agent.opened(open);
    await k.flush();
    assert.equal(k.live.play, k.trip, 'looking moves nothing');
    const mine = ((await k.live.reminders()) ?? []).find((r) => r.scope === open && r.watch === 'plan:cake:coming-up');
    assert.equal(mine?.here, false);
    assert.equal(Object.keys(await copies(k, open)).length, 1, 'at the relay');
    await k.to(/** @type {number} */ (mine?.due) + GRACE_MS - 3000);
    await k.mirror.settled();
    const before = calls(k).off;
    await k.mirror.sync();
    await k.mirror.settled();
    assert.equal(calls(k).off, before, 'not called off');
    assert.equal(Object.keys(await copies(k, open)).length, 1, 'still waiting there, to be sent');
  } finally { await k.stop(); }
});
