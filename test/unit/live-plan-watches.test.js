import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWatches, planWords, PLAN } from '../../src/core/live/plan-watches.js';
import { MONTEREY, BIXBY, RIVER_INN, NEPENTHE, HEARST, off, at, iso, LA, liveKit } from './live-kit.js';

/** @param {Partial<import('../../src/core/live/triggers.js').Moment>} o @returns {import('../../src/core/live/triggers.js').Moment} */
const moment = (o = {}) => ({ now: at('08:00'), fix: null, newFix: false, past: false, live: true, activity: 'still', change: null, odometer: 0, stop: null, gap: null, fastEnded: null, fired: () => false, ...o });
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
  assert.equal(f?.text, 'Plan: time to leave soon for "Lunch at Nepenthe" (can\'t be moved, 12:00): 7.0 km away in a straight line, about 12 min by car');
  assert.equal(f?.at, at('11:33'));
  assert.equal(f?.fallback, 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 12 min by car.');
  // Without a position: from Bixby, the plan's stop before (21.2 km, 36 min).
  assert.equal(PLAN.next?.(leave, moment({ now: at('10:00') }), {}), at('11:09'));
  assert.equal(PLAN.check(leave, here(off(NEPENTHE, 100, 0), at('11:50')), {}), null); // already there
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('12:00')), {}), null); // it has started: running late says so
  const call = find('plan:call:coming-up').when;
  assert.equal(PLAN.next?.(call, moment(), {}), at('17:45'));
  assert.equal(PLAN.check(call, moment({ now: at('17:44') }), {}), null);
  const on = PLAN.check(call, moment({ now: at('17:45') }), {});
  assert.deepEqual(on, { text: 'Plan: "Call Grandma" (can\'t be moved) starts at 18:00, in 15 min', at: at('17:45'), fallback: 'In 15 min: Call Grandma at 18:00.', say: { event: 'coming-up', what: /** @type {any} */ (find('plan:call:coming-up').say).what, minutes: 15 } });
});

test('arrived: stopped 2 min there, or 5 min inside; driving past is not arriving; inferred on coming back on screen', () => {
  const arrived = find('plan:nepenthe:arrived').when;
  const mem = {};
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:48'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.equal(PLAN.check(arrived, here(NEPENTHE, at('11:49'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), null);
  assert.deepEqual(PLAN.check(arrived, here(NEPENTHE, at('11:50'), { stop: { ...NEPENTHE, since: at('11:48') } }), mem), {
    text: 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (can\'t be moved, 12:00)', place: { name: 'Nepenthe', ...NEPENTHE },
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
  assert.equal(back?.text, 'Plan: you arrived at Nepenthe for "Lunch at Nepenthe" (can\'t be moved, 12:00), inferred on coming back on screen');
});

test('running late: when the estimated arrival is more than 5 min past the start; not once arrived, nor inside; not hours early', () => {
  const late = find('plan:nepenthe:late').when;
  assert.equal(PLAN.check(late, here(RIVER_INN, at('11:50')), {}), null); // 12 min: 12:02
  const f = PLAN.check(late, here(BIXBY, at('11:40')), {});
  assert.equal(f?.text, 'Plan: running late for "Lunch at Nepenthe" (can\'t be moved, 12:00): 21.2 km away, about 36 min by car, so about 16 min late');
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
    'Off plan: "Bixby Bridge photo stop" is planned for 09:45–10:05 at Bixby Creek Bridge, and the user is 14.1 km away. The replanning skill says what to do');
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

test("a wake says when an item's time is its booking's time Shiori isn't sure of, beside \"can't be moved\" (the 固定 re-review's L2)", () => {
  const items = [{ path: '/plan/out.json', item: { id: 'out', title: 'Check out', fixed: true, booking: '/trip/bookings/inn.json', start: { at: '2026-11-28T11:00:00-08:00', tz: LA } } }];
  const inn = { id: 'inn', kind: 'lodging', status: 'unverified', source: '/files/i.pdf', title: 'Harbor Test Inn', unsure: ['end'], start: { at: '2026-11-27T15:00:00-08:00', tz: LA }, end: { at: '2026-11-28T11:00:00-08:00', tz: LA } };
  const wake = (/** @type {any} */ b) => {
    const [w] = planWatches(items, new Map([['/bookings/inn.json', b]]), { fallbackTz: LA });
    assert.equal(w.id, 'plan:out:coming-up');
    return PLAN.check(w.when, moment({ now: Date.parse('2026-11-28T10:50:00-08:00') }), {})?.text;
  };
  assert.equal(wake(inn), 'Plan: "Check out" (can\'t be moved; not sure the time was read right) starts at 11:00, in 10 min');
  assert.equal(wake({ ...inn, unsure: ['start'] }), 'Plan: "Check out" (can\'t be moved) starts at 11:00, in 10 min');
});

test("a wake shows an item's start: an unsure end of its booking doesn't make a sure start unsure (the review of booking-check, F1)", () => {
  const items = [{ path: '/plan/stay.json', item: { id: 'stay', title: 'Stay', fixed: true, booking: '/trip/bookings/inn.json', start: { at: '2026-11-27T15:00:00-08:00', tz: LA }, end: { at: '2026-11-28T11:00:00-08:00', tz: LA } } }];
  const inn = { id: 'inn', kind: 'lodging', status: 'unverified', source: '/files/i.pdf', title: 'Harbor Test Inn', unsure: ['end'], start: { at: '2026-11-27T15:00:00-08:00', tz: LA }, end: { at: '2026-11-28T11:00:00-08:00', tz: LA } };
  const wake = (/** @type {any} */ b) => {
    const [w] = planWatches(items, new Map([['/bookings/inn.json', b]]), { fallbackTz: LA });
    assert.equal(w.id, 'plan:stay:coming-up');
    assert.ok(planWatches(items, new Map([['/bookings/inn.json', b]]), { fallbackTz: LA }).every((x) => x.when.unsure === (b.unsure[0] === 'start')), 'every wake of the item carries the same answer');
    return PLAN.check(w.when, moment({ now: Date.parse('2026-11-27T14:50:00-08:00') }), {})?.text;
  };
  assert.equal(wake(inn), 'Plan: "Stay" (can\'t be moved) starts at 15:00, in 10 min');
  assert.equal(wake({ ...inn, unsure: ['start'] }), 'Plan: "Stay" (can\'t be moved; not sure the time was read right) starts at 15:00, in 10 min');
});

test("the off-plan wake shows a flexible item's end too, so an unsure end of its booking marks that wake alone (the second opinion on booking-check's fix round)", () => {
  const items = [{ path: '/plan/dinner.json', item: { id: 'dinner', title: 'Dinner', fixed: false, booking: '/trip/bookings/table.json', start: { at: '2026-11-27T19:00:00-08:00', tz: LA }, end: { at: '2026-11-27T21:00:00-08:00', tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } }];
  const table = { id: 'table', kind: 'restaurant', status: 'unverified', source: '/files/t.pdf', title: 'Nepenthe', unsure: ['end'], start: { at: '2026-11-27T19:00:00-08:00', tz: LA }, end: { at: '2026-11-27T21:00:00-08:00', tz: LA } };
  const wakes = (/** @type {any} */ b) => {
    const ws = planWatches(items, new Map([['/bookings/table.json', b]]), { fallbackTz: LA });
    assert.deepEqual(ws.map((w) => w.id), ['plan:dinner:off-plan', 'plan:dinner:arrived', 'plan:linger']);
    const offPlan = PLAN.check(ws[0].when, here(RIVER_INN, at('19:15')), {})?.text;
    const arrived = PLAN.check(ws[1].when, here(NEPENTHE, at('19:05'), { stop: { ...NEPENTHE, since: at('19:00') } }), {})?.text;
    return [offPlan, arrived];
  };
  assert.deepEqual(wakes(table), [
    'Off plan: "Dinner" (not sure the time was read right) is planned for 19:00–21:00 at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do',
    'Plan: you arrived at Nepenthe for "Dinner" (19:00)', // the arrived wake shows the start alone, which is sure
  ]);
  assert.deepEqual(wakes({ ...table, unsure: [] }), [
    'Off plan: "Dinner" is planned for 19:00–21:00 at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do',
    'Plan: you arrived at Nepenthe for "Dinner" (19:00)',
  ]);
  assert.match(String(wakes({ ...table, unsure: ['start'] })[1]), /\(not sure the time was read right, 19:00\)$/);
});

/** The off-plan wake's words for a flexible item, with the user at the Big Sur River Inn. @param {any} item @param {number} now @param {Map<string, any>} [bookings] */
const offPlanSaid = (item, now, bookings = new Map()) => {
  const w = planWatches([{ path: '/plan/x.json', item: { fixed: false, ...item } }], bookings, { fallbackTz: LA }).find((x) => x.when.event === 'off-plan');
  return PLAN.check(/** @type {any} */ (w).when, here(RIVER_INN, now), {})?.text ?? null;
};

test("the off-plan wake says no end for an item with none (it said an hour after the start: the scope audit's off-plan range)", () => {
  const bixby = { title: 'Bixby Bridge photo stop', start: { at: '2026-11-27T09:45:00-08:00', tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
  const said = 'Off plan: "Bixby Bridge photo stop" is planned for 09:45 at Bixby Creek Bridge, and the user is 14.1 km away. The replanning skill says what to do';
  assert.equal(offPlanSaid(bixby, at('10:40')), said); // it said "09:45–10:45"
  assert.equal(offPlanSaid(bixby, at('10:46')), null); // the hour after the start stays as when it may wake her
  assert.equal(offPlanSaid({ ...bixby, end: { at: '2026-11-27T09:00:00-08:00', tz: LA } }, at('09:56')), said); // an end that isn't after the start is none
});

test("the off-plan wake names both days of an item that ends on a later day, on the item's own clock (it said \"19:00–11:00\": the scope audit's off-plan range)", () => {
  const night = { title: 'Night at Nepenthe', start: { at: '2026-11-27T19:00:00-08:00', tz: LA }, end: { at: '2026-11-28T11:00:00-08:00', tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
  const said = 'Off plan: "Night at Nepenthe" is planned from Fri 2026-11-27 19:00 (GMT-8) to Sat 2026-11-28 11:00 (GMT-8) at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do';
  assert.equal(offPlanSaid(night, at('19:15')), said);
  // After midnight, "23:30" alone would read as today's.
  assert.equal(offPlanSaid({ ...night, start: { at: '2026-11-27T23:30:00-08:00', tz: LA } }, at('00:15', '2026-11-28')),
    'Off plan: "Night at Nepenthe" is planned from Fri 2026-11-27 23:30 (GMT-8) to Sat 2026-11-28 11:00 (GMT-8) at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do');
  // Over a clock change, each time with its own offset.
  assert.equal(offPlanSaid({ ...night, start: { at: '2026-10-31T19:00:00-07:00', tz: LA }, end: { at: '2026-11-01T11:00:00-08:00', tz: LA } }, Date.parse('2026-10-31T19:15:00-07:00')),
    'Off plan: "Night at Nepenthe" is planned from Sat 2026-10-31 19:00 (GMT-7) to Sun 2026-11-01 11:00 (GMT-8) at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do');
});

test("the off-plan wake's doubt follows the times it says: an unsure end it doesn't say doesn't mark a sure start", () => {
  const table = { id: 'table', kind: 'restaurant', status: 'unverified', source: '/files/t.pdf', title: 'Nepenthe', unsure: ['end'], start: { at: '2026-11-27T19:00:00-08:00', tz: LA }, end: { at: '2026-11-27T07:00:00-08:00', tz: LA } };
  const dinner = { title: 'Dinner', booking: '/trip/bookings/table.json', start: table.start, end: table.end, place: { name: 'Nepenthe', ...NEPENTHE } };
  assert.equal(offPlanSaid(dinner, at('19:15'), new Map([['/bookings/table.json', table]])),
    'Off plan: "Dinner" is planned for 19:00 at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do');
  assert.equal(offPlanSaid(dinner, at('19:15'), new Map([['/bookings/table.json', { ...table, unsure: ['start'] }]])),
    'Off plan: "Dinner" (not sure the time was read right) is planned for 19:00 at Nepenthe, and the user is 7.0 km away. The replanning skill says what to do');
});

test("the off-plan wake asks in an item's first hour: far 30 min into a long flexible item wakes her, 90 min in doesn't", () => {
  const long = { title: 'Afternoon at Bixby Creek', start: { at: '2026-11-27T13:00:00-08:00', tz: LA }, end: { at: '2026-11-27T17:00:00-08:00', tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } };
  assert.equal(offPlanSaid(long, at('13:30')),
    'Off plan: "Afternoon at Bixby Creek" is planned for 13:00–17:00 at Bixby Creek Bridge, and the user is 14.1 km away. The replanning skill says what to do');
  assert.equal(offPlanSaid(long, at('14:30')), null); // past its first hour: a stop off the plan is linger's
  const w = planWatches([{ path: '/plan/long.json', item: { fixed: false, ...long } }], new Map(), { fallbackTz: LA })[0];
  assert.equal(PLAN.describe(w.when), 'when far from "Afternoon at Bixby Creek" in the first 60 min of its time');
});

/** A flexible stay from 15:00 to 11:00 the next day at the Big Sur River Inn, and dinner at Nepenthe from 19:00. */
const STAY = { title: 'Stay at Big Sur River Inn', fixed: false, start: { at: '2026-11-27T15:00:00-08:00', tz: LA }, end: { at: '2026-11-28T11:00:00-08:00', tz: LA }, place: { name: 'Big Sur River Inn', ...RIVER_INN } };
const DINNER = { title: 'Dinner at Nepenthe', fixed: true, start: { at: '2026-11-27T19:00:00-08:00', tz: LA }, end: { at: '2026-11-27T20:30:00-08:00', tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } };
/**
 * What wakes her when annai is opened at dinner: live mode's first fixes are at Nepenthe from 19:30, 7.0 km from the inn, which the
 * traveller hasn't reached yet. @param {Record<string, any>} plan @returns {Promise<string[]>}
 */
async function openedAtDinner(plan) {
  const k = await liveKit({ plan, start: at('19:25') });
  await k.stay(NEPENTHE, at('19:30'), at('19:40'), 60);
  k.live.dispose();
  return k.agent.wakes.map((x) => String(x.text));
}

test("a stay that runs overnight doesn't wake her \"off plan\" at the dinner the plan has (it did: the stay was planned too)", async () => {
  const texts = await openedAtDinner({ stay: STAY, dinner: DINNER });
  assert.deepEqual(texts.filter((x) => x.includes('Off plan')), []);
  assert.ok(texts.some((x) => x.startsWith('Plan: you arrived at Nepenthe for "Dinner at Nepenthe"')), texts.join('\n'));
});

test("a stay that runs overnight doesn't wake her \"off plan\" at a dinner the plan doesn't have, 4 h after the stay's start", async () => {
  assert.deepEqual((await openedAtDinner({ stay: STAY })).filter((x) => x.includes('Off plan')), []);
});

/** The linger watch of a plan with Bixby's photo stop today and the Hearst Castle tour on the day after (fixed, 16:30). */
const lingerOf = () => planWatches([
  { path: '/plan/bixby.json', item: { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2026-11-27T09:45:00-08:00', tz: LA }, end: { at: '2026-11-27T10:05:00-08:00', tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } } },
  { path: '/plan/castle.json', item: { id: 'castle', title: 'Hearst Castle tour', fixed: true, start: { at: '2026-11-28T16:30:00-08:00', tz: LA }, place: { name: 'Hearst Castle', ...HEARST } } },
], new Map(), { fallbackTz: LA }).find((x) => x.id === 'plan:linger');

test("the linger wake names the day of the next item when it isn't the moment's day, in Shiori's words and in the data the user's are made from (it said \"at 16:30\" for tomorrow's)", () => {
  const linger = /** @type {any} */ (lingerOf()).when;
  const stopped = (/** @type {string} */ hhmm, /** @type {string} */ since) => PLAN.check(linger, here(RIVER_INN, at(hhmm), { stop: { ...RIVER_INN, since: at(since) } }), { home: MONTEREY });
  // 13:20 on the 27th: the day's timed items are over, and the next is tomorrow's, at a clock time later than now.
  const f = stopped('13:20', '13:00');
  assert.equal(f?.text, "Off plan: the user has been stopped for 20 min at a place that isn't on the plan (36.2700, -121.8070); next on the plan: \"Hearst Castle tour\" at Sat 2026-11-28 16:30 (GMT-8). The replanning skill says what to do");
  assert.equal(f?.fallback, 'Next on the plan: Hearst Castle tour at Sat 2026-11-28 16:30 (GMT-8).');
  assert.deepEqual(/** @type {any} */ (f?.say).next, { title: 'Hearst Castle tour', at: at('16:30', '2026-11-28'), tz: LA, later: true });
  assert.equal(planWords(/** @type {any} */ (f?.say)), 'Next on the itinerary: Hearst Castle tour at Sat, Nov 28, 16:30.'); // the user's own line says it too
  // The same item on the moment's own day names no day, as before: the time alone is true.
  const same = PLAN.check(linger, here(RIVER_INN, at('13:20', '2026-11-28'), { stop: { ...RIVER_INN, since: at('13:00', '2026-11-28') } }), { home: MONTEREY });
  assert.equal(same?.fallback, 'Next on the plan: Hearst Castle tour at 16:30.');
  assert.deepEqual(/** @type {any} */ (same?.say).next, { title: 'Hearst Castle tour', at: at('16:30', '2026-11-28'), tz: LA });
  assert.equal(planWords(/** @type {any} */ (same?.say)), 'Next on the itinerary: Hearst Castle tour at 16:30.');
  // An entry written before the day was carried reads as it did.
  assert.equal(planWords({ event: 'linger', next: { title: 'Hearst Castle tour', at: at('16:30', '2026-11-28'), tz: LA } }), 'Next on the itinerary: Hearst Castle tour at 16:30.');
});

/** The reminder's words for a moment: its fallback (Shiori's), and the user's, made from its data; they say the same, in English. @param {import('../../src/core/live/watches.js').Watch} watch @param {number} now */
const wordsAt = (watch, now, o = {}) => {
  const f = PLAN.check(watch.when, here(RIVER_INN, now, o), {});
  return f ? [f.fallback, planWords(/** @type {any} */ (f.say))] : null;
};

test("the leave reminder says the minutes left to leave when it fires: on time 15, 7 min late 8, past its time \"soon\" (it said \"about 15\" however late it fired)", () => {
  const leave = find('plan:nepenthe:leave').when;
  const soon = 'Leave soon: Lunch at Nepenthe at 12:00.';
  // From the River Inn (12 min by car) it is due at 11:33, and the time to leave is 11:48.
  const lunch = (/** @type {number} */ n) => `Leave in about ${n} min: Lunch at Nepenthe at 12:00. About 12 min by car.`;
  for (const [hhmm, left] of /** @type {[string, number][]} */ ([['11:33', 15], ['11:35', 13], ['11:36', 12], ['11:40', 8], ['11:47', 1]])) {
    const f = PLAN.check(leave, here(RIVER_INN, at(hhmm)), {});
    assert.equal(f?.fallback, lunch(left), hhmm);
    assert.equal(planWords(/** @type {any} */ (f?.say)), lunch(left), hhmm);
    assert.equal(/** @type {any} */ (f?.say).left, left, hhmm);
    assert.match(String(f?.text), /about 12 min by car$/); // Shiori's own text says the real distances, and no lead
  }
  // At the time to leave and past it: "soon", with no lead and no travel time beside "Running late".
  for (const hhmm of ['11:48', '11:50', '11:59']) {
    assert.deepEqual(wordsAt(find('plan:nepenthe:leave'), at(hhmm)), [soon, soon], hhmm);
  }
  // Opened at 11:50, 44 km (about 75 min) from the lunch, with no model to reach: the review's input.
  const far = PLAN.check(leave, here(off(NEPENTHE, 0, 44_000), at('11:50')), {});
  assert.equal(far?.fallback, soon);
  assert.equal(planWords(/** @type {any} */ (far?.say)), soon);
  // No position and no stop before: no travel time to count from, so no lead is said.
  const none = planWatches([{ path: '/plan/lunch.json', item: { title: 'Lunch', fixed: true, start: { at: iso('12:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } }], new Map(), { fallbackTz: LA }).find((x) => x.id === 'plan:lunch:leave');
  assert.equal(PLAN.check(/** @type {any} */ (none).when, moment({ now: at('11:40') }), {})?.fallback, 'Leave soon: Lunch at 12:00, Nepenthe.');
  // An entry written before the minutes left were carried reads as it did: "about 15" with a travel time, else "soon".
  const what = /** @type {any} */ (find('plan:nepenthe:leave').say).what;
  assert.equal(planWords({ event: 'leave', what, minutes: 12, mode: 'drive' }), lunch(15));
  assert.equal(planWords({ event: 'leave', what, minutes: 12, mode: 'walk' }), 'Leave in about 15 min: Lunch at Nepenthe at 12:00. About 12 min on foot.');
  assert.equal(planWords({ event: 'leave', what }), soon);
});

test("the coming-up reminder says the minutes left when it fires: 15 on time, 8 when annai was opened at 17:52 (it said \"In 15 min\" for 18:00)", () => {
  const call = find('plan:call:coming-up').when;
  for (const [hhmm, left] of /** @type {[string, number][]} */ ([['17:45', 15], ['17:48', 12], ['17:52', 8], ['17:59', 1]])) {
    const f = PLAN.check(call, moment({ now: at(hhmm) }), {});
    assert.equal(f?.fallback, `In ${left} min: Call Grandma at 18:00.`, hhmm);
    assert.equal(planWords(/** @type {any} */ (f?.say)), f?.fallback, hhmm);
    assert.equal(/** @type {any} */ (f?.say).minutes, left, hhmm);
    assert.match(String(f?.text), new RegExp(`starts at 18:00, in ${left} min$`), hhmm); // Shiori's text said it already
  }
  // Half a minute before the start still says one minute, as Shiori's text and the phone's notification do.
  assert.equal(PLAN.check(call, moment({ now: at('17:59:40') }), {})?.fallback, 'In 1 min: Call Grandma at 18:00.');
  // The watch's own words, for the notification made for its due time (the phone counts the minutes left itself): 15; and an entry written before.
  const say = /** @type {any} */ (find('plan:call:coming-up').say);
  assert.equal(planWords(say), 'In 15 min: Call Grandma at 18:00.');
  assert.equal(planWords({ event: 'coming-up', what: say.what, minutes: 8 }), 'In 8 min: Call Grandma at 18:00.');
});

test("a reopened annai says the minutes left of the plan's reminders, on the live engine, in Shiori's fallback and the user's words (it said \"In 15 min\" at 17:52)", async () => {
  const CALL = { title: 'Call Grandma', fixed: true, start: { at: iso('18:00'), tz: LA } };
  for (const [hhmm, left] of /** @type {[string, number][]} */ ([['17:45', 15], ['17:52', 8]])) {
    const k = await liveKit({ live: false, plan: { call: CALL }, start: at(hhmm) });
    await k.to(at(hhmm));
    const words = k.agent.wakes.flatMap((w) => (w.fallbacks ?? []).map((/** @type {any} */ f) => [f.text, planWords(f.plan)]));
    assert.deepEqual(words, [[`In ${left} min: Call Grandma at 18:00.`, `In ${left} min: Call Grandma at 18:00.`]], hhmm);
    k.live.dispose();
  }
});
