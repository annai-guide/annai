import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWatches, PLAN } from '../../src/core/live/plan-watches.js';
import { MONTEREY, BIXBY, RIVER_INN, NEPENTHE, off, at, LA } from './live-kit.js';

/** @param {Partial<import('../../src/core/live/triggers.js').Moment>} o @returns {import('../../src/core/live/triggers.js').Moment} */
const moment = (o = {}) => ({ now: at('08:00'), fix: null, newFix: false, past: false, live: true, activity: 'still', change: null, odometer: 0, stop: null, gap: null, fired: () => false, ...o });
/** The user at p at now, with a new fix. @param {{ lat: number, lng: number }} p @param {number} now @param {Partial<import('../../src/core/live/triggers.js').Moment>} [o] */
const here = (p, now, o = {}) => moment({ now, fix: { lat: p.lat, lng: p.lng, accuracy: 10, at: now, speed: null, heading: null, source: 'gps' }, newFix: true, ...o });
const ITEMS = [
  { path: '/plan/nepenthe.json', item: { id: 'nepenthe', title: 'Lunch at Nepenthe', fixed: true, start: { at: '2026-11-27T12:00:00-08:00', tz: LA }, end: { at: '2026-11-27T13:15:00-08:00', tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE }, notes: 'Window table if they have one.' } },
  { path: '/plan/bixby.json', item: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T09:45:00-08:00', tz: LA }, end: { at: '2026-11-27T10:05:00-08:00', tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
  { path: '/plan/flight.json', item: { id: 'flight', title: 'UA 123 home', kind: 'flight', fixed: true, start: { at: '2026-11-29T14:05:00-08:00', tz: LA }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 }, booking: '/trip/bookings/flight.json' } },
  { path: '/plan/call.json', item: { id: 'call', title: 'Call Grandma', fixed: true, start: { at: '2026-11-27T18:00:00-08:00', tz: LA } } },
  { path: '/plan/park.json', item: { id: 'park', title: 'Day at the park', kind: 'all-day', fixed: false, start: { at: '2026-11-28T00:00:00-08:00', tz: LA }, place: { name: 'Park', lat: 36.5, lng: -121.9 } } },
  { path: '/plan/skate.json', item: { id: 'skate', title: 'Ice skating', fixed: false } },
  { path: '/plan/odd.json', item: 'not an object' },
];
const BOOKINGS = new Map([['/bookings/flight.json', { id: 'flight', kind: 'flight', status: 'confirmed', source: '/files/f.pdf', title: 'UA 123', fields: { terminal: 'T3' } }]]);
const WATCHES = planWatches(/** @type {any} */ (ITEMS), BOOKINGS, { fallbackTz: LA });
/** @param {string} id */
const find = (id) => /** @type {import('../../src/core/live/watches.js').Watch} */ (WATCHES.find((w) => w.id === id));

test("each timed item gets the plan's own watches; all-day and untimed items get none (spec §11.3)", () => {
  assert.deepEqual(WATCHES.map((w) => w.id), [
    'plan:bixby:off-plan', 'plan:bixby:arrived',
    'plan:nepenthe:leave', 'plan:nepenthe:late', 'plan:nepenthe:arrived',
    'plan:call:coming-up',
    'plan:flight:leave', 'plan:flight:late', 'plan:flight:arrived',
    'plan:linger',
  ]);
  assert.ok(WATCHES.every((w) => w.owner === 'system' && w.when.type === 'plan'));
  assert.deepEqual(WATCHES.map((w) => w.repeat), [false, false, false, false, false, false, false, false, false, true]);
  // Fallbacks filled in from the plan data, as "Flight UA123 departs 14:05, SFO T3".
  assert.equal(find('plan:flight:leave').fallback, 'Leave soon: Flight UA 123 departs 14:05, SFO T3.');
  assert.equal(find('plan:nepenthe:leave').fallback, 'Leave soon: Lunch at Nepenthe at 12:00.');
  assert.equal(find('plan:nepenthe:arrived').fallback, 'Nepenthe: Lunch at Nepenthe. Window table if they have one.');
  assert.equal(find('plan:call:coming-up').fallback, 'In 15 min: Call Grandma at 18:00.');
  assert.equal(find('plan:flight:arrived').when.radius, 2000); // an airport is big
  assert.equal(find('plan:nepenthe:arrived').when.radius, 300);
  assert.deepEqual(find('plan:nepenthe:leave').when.from, { name: 'Bixby Creek Bridge', ...BIXBY }); // the stop before it
  assert.deepEqual(find('plan:linger').when.places.map((/** @type {any} */ p) => p.name), ['Bixby Creek Bridge', 'Nepenthe', 'SFO']);
  assert.equal(PLAN.describe(find('plan:nepenthe:leave').when), '15 min before leaving for "Lunch at Nepenthe" at 12:00');
  assert.deepEqual(planWatches([], new Map(), { fallbackTz: LA }), []);
});

test('leave: 15 min before the estimated departure, from where the user is, else from the stop before; not once there, nor after the start', () => {
  const leave = find('plan:nepenthe:leave').when;
  // From the Big Sur River Inn, 7.0 km: about 12 min by car, so 12:00 − 27 min.
  assert.equal(PLAN.next?.(leave, here(RIVER_INN, at('10:30')), {}), at('11:33'));
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('11:32')), {}), null);
  const f = PLAN.check(leave, here(RIVER_INN, at('11:33')), {});
  assert.equal(f?.text, 'Plan: time to leave soon for "Lunch at Nepenthe" (fixed, 12:00): 7.0 km away in a straight line, about 12 min by car');
  assert.equal(f?.at, at('11:33'));
  assert.equal(f?.fallback, 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 12 min by car.');
  // Without a position: from Bixby, the plan's stop before (21.2 km, 36 min).
  assert.equal(PLAN.next?.(leave, moment({ now: at('10:00') }), {}), at('11:09'));
  assert.equal(PLAN.check(leave, here(off(NEPENTHE, 100, 0), at('11:50')), {}), null); // already there
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('12:00')), {}), null); // it has started: running late says so
  const call = find('plan:call:coming-up').when;
  assert.equal(PLAN.next?.(call, moment(), {}), at('17:45'));
  assert.equal(PLAN.check(call, moment({ now: at('17:44') }), {}), null);
  assert.deepEqual(PLAN.check(call, moment({ now: at('17:45') }), {}), { text: 'Plan: "Call Grandma" (fixed) starts at 18:00, in 15 min', at: at('17:45') });
});

test('arrived: stopped 2 min there, or 5 min inside; driving past is not arriving; inferred on coming back on screen', () => {
  const arrived = find('plan:nepenthe:arrived').when;
  const mem = {};
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:48'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:49'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.deepEqual(PLAN.check(arrived, here(NEPENTHE, at('11:50'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), {
    text: 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00)', place: { name: 'Nepenthe', ...NEPENTHE },
  });
  // Walking about inside for 5 minutes (the stop keeps moving).
  const walk = {};
  for (const [t, dx] of /** @type {[string, number][]} */ ([['11:00', 0], ['11:02', 120], ['11:04', -120]])) {
    assert.equal(PLAN.check(arrived, here(off(NEPENTHE, dx, 0), at(t), { stop: { ...off(NEPENTHE, dx, 0), since: at(t) } }), walk), null);
  }
  assert.ok(PLAN.check(arrived, here(NEPENTHE, at('11:05'), { stop: { ...NEPENTHE, since: at('11:05') } }), walk));
  // Driving past at 50 km/h: inside for half a minute.
  const past = {};
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, -250, 0), at('11:00')), past), null);
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, 250, 0), at('11:00:36')), past), null);
  assert.equal(PLAN.check(arrived, here(off(NEPENTHE, 1000, 0), at('11:01')), past), null);
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('08:00'), { stop: { ...NEPENTHE, since: at('07:50') } }), {}), null); // before its window
  const back = PLAN.check(arrived, here(NEPENTHE, at('12:10'), { gap: { since: at('11:40'), from: null } }), {});
  assert.equal(back?.text, 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (fixed, 12:00), inferred on coming back on screen');
});

test('running late: when the estimated arrival is more than 5 min past the start; not once arrived, nor inside; not hours early', () => {
  const late = find('plan:nepenthe:late').when;
  assert.equal(PLAN.check(late, here(RIVER_INN, at('11:50')), {}), null); // 12 min: 12:02
  const f = PLAN.check(late, here(BIXBY, at('11:40')), {});
  assert.equal(f?.text, 'Plan: running late for "Lunch at Nepenthe" (fixed, 12:00): 21.2 km away, about 36 min by car, so about 16 min late');
  assert.equal(f?.fallback, 'Running late: Lunch at Nepenthe at 12:00. About 36 min away.');
  assert.equal(PLAN.check(late, here(BIXBY, at('11:40'), { fired: (id) => id === 'plan:nepenthe:arrived' }), {}), null);
  assert.equal(PLAN.check(late, here(off(NEPENTHE, 50, 0), at('12:20')), {}), null);
  assert.equal(PLAN.check(late, here(BIXBY, at('08:30')), {}), null); // more than 3 h before
  assert.equal(PLAN.next?.(late, here(BIXBY, at('08:30')), {}), at('11:29:01'));
  assert.ok(PLAN.check(late, here(BIXBY, at('11:29:01')), {}));
  assert.equal(PLAN.check(late, moment({ now: at('11:40') }), {}), null); // no position: can't tell
});

test('off plan: far from a flexible item 10 min into its time; or stopped 20 min somewhere not on the plan, once a spot', () => {
  const offPlan = find('plan:bixby:off-plan').when;
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:54')), {}), null);
  assert.equal(PLAN.check(offPlan, here(off(BIXBY, 0, -2000), at('09:56')), {}), null);
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:56')), {})?.text,
    'Off plan: "Bixby Bridge photo stop" (flexible) is planned for 09:45–10:05 at Bixby Creek Bridge, and the user is 14.1 km away. The replanning skill says what to do');
  assert.equal(PLAN.check(offPlan, here(RIVER_INN, at('09:56'), { fired: (id) => id === 'plan:bixby:arrived' }), {}), null);
  const linger = find('plan:linger').when;
  const mem = /** @type {Record<string, any>} */ ({});
  assert.equal(PLAN.check(linger, here(MONTEREY, at('08:30')), mem), null); // where live mode first found the user
  assert.equal(PLAN.check(linger, here(MONTEREY, at('08:55'), { stop: { ...MONTEREY, since: at('08:30') } }), mem), null);
  const s = { ...RIVER_INN, since: at('10:08') };
  assert.equal(PLAN.next?.(linger, here(RIVER_INN, at('10:10'), { stop: s }), mem), at('10:28'));
  assert.equal(PLAN.check(linger, here(RIVER_INN, at('10:27'), { stop: s }), mem), null);
  const f = PLAN.check(linger, here(RIVER_INN, at('10:28'), { stop: s }), mem);
  assert.equal(f?.text, "Off plan: the user has been stopped for 20 min at a place that isn't on the plan (36.2700, -121.8070); next on the plan: \"Lunch at Nepenthe\" at 12:00. The replanning skill says what to do");
  assert.equal(f?.fallback, 'Next on the plan: Lunch at Nepenthe at 12:00.');
  assert.equal(f?.at, at('10:28'));
  mem.lastPlace = f?.place; // the engine keeps where it last fired
  assert.equal(PLAN.check(linger, here(RIVER_INN, at('11:00'), { stop: s }), mem), null);
  assert.equal(PLAN.check(linger, here(NEPENTHE, at('12:30'), { stop: { ...NEPENTHE, since: at('11:50') } }), { home: MONTEREY }), null); // a plan place
  assert.equal(PLAN.check(linger, moment({ now: at('11:00'), past: true, fix: here(RIVER_INN, at('10:00')).fix, stop: s }), { home: MONTEREY }), null); // a catch-up's first look
});
