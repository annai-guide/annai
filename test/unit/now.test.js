import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRows } from '../../src/core/plan.js';
import { upcoming, routeStrip, sunPlace } from '../../src/core/now.js';
import { todayOf, nowOf, takeover, driveBack, drivingTrip, askIn } from '../../src/ui/today.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readAppSettings } from '../../src/core/settings.js';
import { dayIn, deviceZone } from '../../src/core/time.js';
import { at, iso, LA, BIXBY, NEPENTHE, RIVER_INN } from './live-kit.js';

const ROWS = planRows([
  { path: '/plan/bixby.json', item: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, end: { at: iso('10:05'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
  { path: '/plan/coffee.json', item: { id: 'coffee', title: 'Coffee', fixed: false, start: { at: iso('11:00'), tz: LA } } },
  { path: '/plan/nepenthe.json', item: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } },
  { path: '/plan/day.json', item: { id: 'day', title: 'Park day', kind: 'all-day', fixed: false, start: { at: iso('00:00', '2026-11-28'), tz: LA } } },
  { path: '/plan/skate.json', item: { id: 'skate', title: 'Ice skating', fixed: false } },
], [], { fallbackTz: LA });
/** @param {import('../../src/core/plan.js').PlanRow[]} rows */
const ids = (rows) => rows.map((r) => r.item.id);

test('what is next: items not over yet, soonest first; one without an end lasts half an hour; all-day and untimed items are not "next"', () => {
  assert.deepEqual(ids(upcoming(ROWS, at('09:00'))), ['bixby', 'coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('10:05'))), ['bixby', 'coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('10:06'))), ['coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('11:30'))), ['coffee', 'nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('11:31'))), ['nepenthe']);
  assert.deepEqual(ids(upcoming(ROWS, at('09:00'), 1)), ['bixby']);
  assert.deepEqual(upcoming([], at('09:00')), []);
});

test('the route strip: the next stops with places, how far each is in a straight line, and about how long (spec §16.2, §11.3)', () => {
  const s = routeStrip(ROWS, RIVER_INN, at('09:00'), 'moving-fast');
  assert.deepEqual(s.map((x) => x.name), ['Bixby Creek Bridge', 'Nepenthe']);
  assert.equal(Math.round(/** @type {number} */ (s[1].km) * 10), 70);
  assert.equal(s[1].minutes, 12);
  assert.deepEqual(s[1].place, NEPENTHE);
  assert.deepEqual(routeStrip(ROWS, null, at('09:00'), 'unknown').map((x) => [x.km, x.minutes]), [[null, null], [null, null]]);
});

test('the sun is worked out where the user is, else at the next stop with a place, else nowhere', () => {
  assert.deepEqual(sunPlace(RIVER_INN, ROWS, at('09:00')), RIVER_INN);
  assert.deepEqual(sunPlace(null, ROWS, at('11:00')), NEPENTHE);
  assert.equal(sunPlace(null, ROWS, at('23:00')), null);
});

test("an end with no offset and no zone of its own is read on the start's zone, as the Plan and the reminders read it (the second review)", () => {
  // Starts 09:45 in Big Sur; its end "10:30", written bare: 10:30 there, so at 10:20 it isn't over (read as UTC, it ended at 02:30).
  const rows = planRows([{ path: '/plan/x.json', item: { id: 'x', title: 'Walk', fixed: false, start: { at: iso('09:45'), tz: LA }, end: { at: iso('10:30').slice(0, 16) } } }], [], { fallbackTz: LA });
  assert.deepEqual(ids(upcoming(rows, at('10:20'))), ['x']);
  assert.deepEqual(ids(upcoming(rows, at('10:31'))), []);
});

test("today is live mode's: a simulation's clock and zone while one runs, so the Itinerary's today follows it", () => {
  const sim = { clock: { now: () => Date.parse('2030-11-27T07:30:00Z') }, timeZone: () => LA };
  assert.equal(nowOf(sim), Date.parse('2030-11-27T07:30:00Z'));
  assert.equal(todayOf(sim), '2030-11-26'); // still the evening before, where the simulation is
  assert.equal(todayOf({ ...sim, timeZone: () => 'Asia/Tokyo' }), '2030-11-27');
});

test('today without live mode is the phone\'s own', () => {
  assert.equal(todayOf(undefined), dayIn(Date.now(), deviceZone()));
});

const go = { activity: 'moving-fast', was: 'walking', screens: [], on: true, hash: '#/trips', typing: false, trip: 'trip-a', same: false };
test('moving fast begins: Driving takes over from home, the conversation, the Itinerary and Now', () => {
  for (const hash of ['', '#/trips', '#/talk', '#/plan', '#/trip/trip-a/plan', '#/now']) assert.equal(takeover({ ...go, hash }), '#/drive', hash);
});
test('it stays put elsewhere, while typing, with GPS off, and with nothing open', () => {
  for (const o of [{ hash: '#/settings' }, { hash: '#/trip/trip-a' }, { hash: '#/drive' }, { typing: true }, { on: false }, { trip: null }]) assert.equal(takeover({ ...go, ...o }), null);
});
test('once: a drive already going takes nobody over', () => {
  assert.equal(takeover({ ...go, was: 'moving-fast' }), null);
});
test('moving fast starting again after a light is the same drive: Driving, or a plugin\'s screen for moving fast, does not take over again', () => {
  assert.equal(takeover({ ...go, same: true }), null);
  const screens = [{ pluginId: 'p', item: { id: 's', homeFor: 'moving-fast' } }];
  assert.equal(takeover({ ...go, screens }), '#/ext/p/s');
  assert.equal(takeover({ ...go, screens, same: true }), null);
  const walking = [{ pluginId: 'p', item: { id: 's', homeFor: 'walking' } }];
  assert.equal(takeover({ ...go, activity: 'walking', was: 'still', screens: walking, same: true }), '#/ext/p/s', 'the rule is about driving');
});
test("a plugin's screen for the activity takes over, with no trip open too", () => {
  const screens = [{ pluginId: 'p', item: { id: 's', homeFor: 'walking' } }];
  assert.equal(takeover({ ...go, activity: 'walking', was: 'still', screens, trip: null }), '#/ext/p/s');
});
test('← on Driving: Now by name, anywhere else as Back, and Now when nothing says where it was entered from', () => {
  assert.deepEqual(driveBack(undefined), { href: '#/now', label: 'Now' });
  assert.deepEqual(driveBack('#/now'), { href: '#/now', label: 'Now' });
  assert.deepEqual(driveBack('#/trip/trip-a/plan'), { href: '#/trip/trip-a/plan', label: 'Back' });
});

test('Driving shows the trip in play, else the open one, else nothing', () => {
  assert.equal(drivingTrip({ live: { play: 'trip-a' }, agent: { trip: 'trip-chat' } }), 'trip-a');
  assert.equal(drivingTrip({ live: { play: null }, agent: { trip: 'trip-chat' } }), 'trip-chat');
  assert.equal(drivingTrip({ agent: { trip: 'trip-chat' } }), 'trip-chat');
  assert.equal(drivingTrip({ live: { play: null }, agent: { trip: null } }), null);
  assert.equal(drivingTrip({}), null);
});

/** Driving's ctx, with an agent that records. @param {string | null} target @param {{ koeState?: string, sessionOpen?: boolean }} [o] */
async function asking(target, { koeState = 'off', sessionOpen = false } = {}) {
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  /** @type {any[]} */
  const did = [];
  const agent = {
    target, koeState, sessionOpen,
    async open(/** @type {string} */ id) { did.push(['open', id, (await readAppSettings(ws)).activeTrip]); agent.target = id; },
    send(/** @type {string} */ text, /** @type {any} */ o) { did.push(['send', text, o, agent.target]); },
  };
  return { ctx: { ws, agent }, did };
}

test("a quick ask from a quick chat opens the trip first, saved as the open one, then asks there", async () => {
  const { ctx, did } = await asking('trip-chat');
  await askIn(ctx, 'trip-a', 'Fuel?');
  assert.deepEqual(did, [['open', 'trip-a', 'trip-a'], ['send', 'Fuel?', { chose: true }, 'trip-a']]);
});

test('a quick ask in the trip already open just asks', async () => {
  const { ctx, did } = await asking('trip-a');
  await askIn(ctx, 'trip-a', 'Fuel?');
  assert.deepEqual(did, [['send', 'Fuel?', { chose: true }, 'trip-a']]);
});

test('a quick ask over an open live session goes to the open conversation: opening would close the session', async () => {
  const { ctx, did } = await asking('trip-chat', { koeState: 'live', sessionOpen: true });
  await askIn(ctx, 'trip-a', 'Fuel?');
  assert.deepEqual(did, [['send', 'Fuel?', { chose: true }, 'trip-chat']]);
});

test("Koe being live isn't a session: with none open, the quick ask opens the trip first", async () => {
  const { ctx, did } = await asking('trip-chat', { koeState: 'live', sessionOpen: false });
  await askIn(ctx, 'trip-a', 'Fuel?');
  assert.deepEqual(did, [['open', 'trip-a', 'trip-a'], ['send', 'Fuel?', { chose: true }, 'trip-a']]);
});

test("a trip that doesn't open leaves nothing asked: the failure reaches the caller, which says so", async () => {
  const { ctx, did } = await asking('trip-chat');
  ctx.agent.open = async () => { throw new Error('no'); };
  await assert.rejects(askIn(ctx, 'trip-a', 'Fuel?'), /no/);
  assert.deepEqual(did, []);
});
