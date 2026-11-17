import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWatches, planWords, PLAN } from '../../src/core/live/plan-watches.js';
import { MONTEREY, BIXBY, RIVER_INN, NEPENTHE, HEARST, CAMBRIA, off, at, iso, LA, liveKit } from './live-kit.js';

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
  assert.deepEqual(on, { text: 'Plan: "Call Grandma" (can\'t be moved) starts at 18:00, in 15 min', at: at('17:45'), fallback: 'In 15 min: Call Grandma at 18:00.', say: { event: 'coming-up', what: /** @type {any} */ (find('plan:call:coming-up').say).what, left: 15 } });
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
    assert.equal(/** @type {any} */ (f?.say).left, left, hhmm);
    assert.match(String(f?.text), new RegExp(`starts at 18:00, in ${left} min$`), hhmm); // Shiori's text said it already
  }
  // Half a minute before the start still says one minute, as Shiori's text and the phone's notification do.
  assert.equal(PLAN.check(call, moment({ now: at('17:59:40') }), {})?.fallback, 'In 1 min: Call Grandma at 18:00.');
  // The watch's own words, for the notification made for its due time (the phone counts the minutes left itself): 15; and an entry written before.
  const say = /** @type {any} */ (find('plan:call:coming-up').say);
  assert.equal(planWords(say), 'In 15 min: Call Grandma at 18:00.');
  assert.equal(planWords({ event: 'coming-up', what: say.what, left: 8 }), 'In 8 min: Call Grandma at 18:00.');
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

test("the leave reminder on a catch-up's first look says \"soon\": the place it counts from is where the traveller was before the phone locked, so a count would be false (it said \"about 8 min\" at 11:40)", () => {
  const leave = find('plan:nepenthe:leave').when;
  const soon = 'Leave soon: Lunch at Nepenthe at 12:00.';
  // The first look: the fix is the one from before annai went away (River Inn, 12 min by car, so the time to leave was 11:48), no new fix yet.
  const first = PLAN.check(leave, moment({ now: at('11:40'), past: true, fix: here(RIVER_INN, at('11:20')).fix }), {});
  assert.equal(first?.fallback, soon);
  assert.equal(planWords(/** @type {any} */ (first?.say)), soon);
  assert.equal(/** @type {any} */ (first?.say).left, undefined);
  assert.match(String(first?.text), /about 12 min by car$/); // Shiori's own text keeps the real distance, from the place it names
  // The same moment from a current fix keeps its count.
  assert.equal(PLAN.check(leave, here(RIVER_INN, at('11:40')), {})?.fallback, 'Leave in about 8 min: Lunch at Nepenthe at 12:00. About 12 min by car.');
});

test("a reopened annai says \"soon\" for the leave reminder wherever the traveller is by its first fix, on the live engine (it said \"about 8 min\" from the place before the lock)", async () => {
  const soon = 'Leave soon: Lunch at Nepenthe at 12:00.';
  // On the live engine: on screen at the River Inn until 11:20, the phone locks, annai is back at 11:40 and the traveller is 12 km north of Nepenthe,
  // or at the place they were; in both shapes the leave reminder says "soon", beside whatever else fires. At Nepenthe itself it is left out (the next test).
  for (const [where, p] of /** @type {[string, { lat: number, lng: number }][]} */ ([['12 km north', off(NEPENTHE, 0, 12_000)], ['the old place', RIVER_INN]])) {
    const k = await liveKit({ plan: { nepenthe: ITEMS[0].item } });
    await k.stay(RIVER_INN, at('11:00'), at('11:20'));
    k.sensors.visible(false);
    await k.settle();
    await k.to(at('11:40'));
    k.sensors.visible(true);
    await k.settle();
    await k.fix(at('11:40:05'), p);
    const said = k.agent.wakes.flatMap((w) => (w.fallbacks ?? []).filter((/** @type {any} */ f) => f.plan?.event === 'leave').map((/** @type {any} */ f) => [f.text, planWords(f.plan)]));
    assert.deepEqual(said, [[soon, soon]], where);
    k.live.dispose();
  }
});

test("a catch-up that fires an item's arrival leaves out its leave reminder: the traveller got there while annai was off screen (it said \"Leave soon: Lunch at Nepenthe at 12:00.\" beside \"Nepenthe: Lunch at Nepenthe.\")", async () => {
  // On screen at the River Inn until 11:20; the phone locks, the traveller drives to Nepenthe, and annai is back on screen there at 11:40.
  const k = await liveKit({ plan: { nepenthe: ITEMS[0].item } });
  await k.stay(RIVER_INN, at('11:00'), at('11:20'));
  k.sensors.visible(false);
  await k.settle();
  await k.to(at('11:40'));
  k.sensors.visible(true);
  await k.settle();
  await k.fix(at('11:40:05'), NEPENTHE);
  const wakes = k.agent.wakes.filter((w) => w.kind === 'catch-up');
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].fallbacks.map((/** @type {any} */ f) => [f.plan?.event, f.text]), [['arrived', 'Nepenthe: Lunch at Nepenthe. Window table if they have one.']]);
  assert.match(String(wakes[0].text), /you arrived at Nepenthe for "Lunch at Nepenthe"/);
  assert.doesNotMatch(String(wakes[0].text), /time to leave/);
  // It fired, and the log keeps it, so it doesn't come again: only the catch-up's words leave it out.
  assert.ok((await k.events(['trigger.fired'])).some((e) => e.data.watch === 'plan:nepenthe:leave'));
  await k.to(at('11:55'));
  assert.equal(k.agent.wakes.filter((w) => w.kind === 'catch-up').length, 1);
  assert.ok(!k.agent.wakes.some((w) => (w.fallbacks ?? []).some((/** @type {any} */ f) => f.plan?.event === 'leave')));
  k.live.dispose();
});

// A trip flown to, with made-up names: a flight out of SFO on the Friday, landing at 17:30 on the other coast, after the 16:00
// check-in of a stay 3300 km from Monterey; a tour near the stay that evening; and a tour as far away on a plan with no flight.
const NY = 'America/New_York';
const FAR = { lat: 40.3, lng: -83.6 }; // made up: about 3300 km from Monterey, a 58-hour drive by the rough estimate
const AIRPORT = off(FAR, 0, -15_000);
const ny = (/** @type {string} */ hhmm, day = '2026-11-27') => Date.parse(`${day}T${hhmm}:00-05:00`);
const FLOWN = [
  { path: '/plan/out.json', item: { title: 'Flight out', kind: 'flight', fixed: true, start: { at: '2026-11-27T09:00:00-08:00', tz: LA }, end: { at: '2026-11-27T17:30:00-05:00', tz: NY }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } } },
  { path: '/plan/inn.json', item: { title: 'Check in: Harbor Inn', fixed: true, start: { at: '2026-11-27T16:00:00-05:00', tz: NY }, place: { name: 'Harbor Inn', ...FAR }, booking: '/trip/bookings/inn.json' } },
  { path: '/plan/tour.json', item: { title: 'Lighthouse tour', fixed: true, start: { at: '2026-11-27T19:00:00-05:00', tz: NY }, place: { name: 'Old Lighthouse', ...off(FAR, 4000, 0) } } },
];
const INN = new Map([['/bookings/inn.json', { id: 'inn', kind: 'lodging', status: 'confirmed', source: '/files/inn.pdf', title: 'Harbor Inn' }]]);
const flown = planWatches(/** @type {any} */ (FLOWN), INN, { fallbackTz: LA });
const flownW = (/** @type {string} */ id) => /** @type {any} */ (flown.find((w) => w.id === id)).when;
const MONDAY = at('20:44', '2026-11-23');

test("a stay's check-in gets no leave or running-late reminder: it is the earliest time to arrive, not a time to be there (it said \"Leave in about 15 min\" four days ahead)", () => {
  assert.deepEqual(flown.filter((w) => w.id.startsWith('plan:inn:')).map((w) => w.id), ['plan:inn:arrived']);
  // A stay by the item's own kind, with no booking linked, is one too.
  const own = planWatches([{ path: '/plan/lodge.json', item: { title: 'Lodge', kind: 'lodging', fixed: true, start: { at: iso('19:00'), tz: LA }, place: { name: 'Lodge', ...CAMBRIA } } }], new Map(), { fallbackTz: LA });
  assert.deepEqual(own.filter((w) => w.id !== 'plan:linger').map((w) => w.id), ['plan:lodge:arrived']);
  // A stay with no place still says it is coming up: that is true wherever the traveller is.
  const bare = planWatches([{ path: '/plan/lodge.json', item: { title: 'Lodge', kind: 'lodging', fixed: true, start: { at: iso('19:00'), tz: LA } } }], new Map(), { fallbackTz: LA });
  assert.deepEqual(bare.map((w) => w.id), ['plan:lodge:coming-up']);
});

test('no leave or running-late reminder on screen for a place farther than a day\'s drive: four days ahead from home, it said "Leave in about 15 min ... about 5521 min by car"', () => {
  // On a plan with no flight: the tour alone, 3300 km from where the traveller is on the Monday evening.
  const alone = planWatches([FLOWN[2]], new Map(), { fallbackTz: LA });
  const leave = /** @type {any} */ (alone.find((w) => w.id === 'plan:tour:leave')).when;
  const late = /** @type {any} */ (alone.find((w) => w.id === 'plan:tour:late')).when;
  // The screen says nothing from a position a flight away, whenever it looks; the relay's copy counts as with no position (half an hour before).
  for (const t of [MONDAY, at('09:00', '2026-11-24'), ny('18:30'), ny('18:40')]) assert.equal(PLAN.check(leave, here(MONTEREY, t), {}), null, new Date(t).toISOString());
  assert.equal(PLAN.next?.(leave, here(MONTEREY, MONDAY), {}), ny('18:30'));
  assert.equal(PLAN.next?.(leave, moment({ now: MONDAY }), {}), ny('18:30'));
  assert.equal(PLAN.check(late, here(MONTEREY, ny('18:30')), {}), null);
  assert.equal(PLAN.next?.(late, here(MONTEREY, ny('18:30')), {}), null);
  // A day's drive is the Plan's line between a leg and a flight (LEG_MAX_KM, 1000 km): just inside it the drive is counted, beyond it not.
  const within = planWatches([{ path: '/plan/x.json', item: { title: 'Tour', fixed: true, start: { at: iso('12:00', '2026-11-28'), tz: LA }, place: { name: 'Far', ...off(MONTEREY, 0, -999_000) } } }], new Map(), { fallbackTz: LA });
  const beyond = planWatches([{ path: '/plan/x.json', item: { title: 'Tour', fixed: true, start: { at: iso('12:00', '2026-11-28'), tz: LA }, place: { name: 'Far', ...off(MONTEREY, 0, -1_001_000) } } }], new Map(), { fallbackTz: LA });
  const leaveOf = (/** @type {any[]} */ ws) => ws.find((w) => w.id === 'plan:x:leave').when;
  const lateOf = (/** @type {any[]} */ ws) => ws.find((w) => w.id === 'plan:x:late').when;
  const counted = PLAN.next?.(leaveOf(within), here(MONTEREY, at('08:00')), {});
  assert.equal(typeof counted, 'number'); // a drive counted from here (not null, which Number() reads as 0)...
  assert.ok(/** @type {number} */ (counted) < at('11:00', '2026-11-28')); // ...due long before the half hour
  assert.equal(PLAN.next?.(leaveOf(beyond), here(MONTEREY, at('08:00')), {}), at('11:30', '2026-11-28')); // not counted: half an hour before
  assert.equal(PLAN.check(leaveOf(beyond), here(MONTEREY, at('11:30', '2026-11-28')), {}), null);
  assert.equal(PLAN.check(lateOf(beyond), here(MONTEREY, at('11:50', '2026-11-28')), {}), null);
});

test("what comes after a flight waits for it to arrive: no leave or running late from the plane, then from where the traveller is", () => {
  // The user's shape: home on the Monday evening, the tour after the flight; nothing for it until the flight has landed at 17:30.
  const tourLeave = flownW('plan:tour:leave');
  const tourLate = flownW('plan:tour:late');
  // The relay holds its copy from home (the review's F1), counted from the plan's stop before, the stay 4 km from the tour (7 min, and the
  // 15 of the lead: 18:38); the position at home, a flight away, counts as none.
  assert.equal(PLAN.next?.(tourLeave, here(MONTEREY, MONDAY), {}), ny('18:38'));
  assert.equal(PLAN.check(tourLeave, here(MONTEREY, MONDAY), {}), null);
  // A diner 3 km from the tour at 18:00, between the stay and the tour, is the tour's stop before instead (6 min and the 15: 18:39). Without
  // the plan's stop before, as with no stay or diner, it is half an hour before (18:30).
  const dined = planWatches(/** @type {any} */ ([...FLOWN.slice(0, 2), { path: '/plan/diner.json', item: { title: 'Diner', fixed: true, start: { at: '2026-11-27T18:00:00-05:00', tz: NY }, place: { name: 'Corner Diner', lat: 40.327, lng: -83.55 } } }, FLOWN[2]]), INN, { fallbackTz: LA });
  assert.equal(PLAN.next?.(/** @type {any} */ (dined.find((w) => w.id === 'plan:tour:leave')).when, here(MONTEREY, MONDAY), {}), ny('18:39'));
  // Never before the flight has landed: a tour at 17:50 is due at the landing (17:30), not half an hour before it (17:20).
  const soon = planWatches(/** @type {any} */ ([FLOWN[0], { path: '/plan/soon.json', item: { title: 'Soon tour', fixed: true, start: { at: '2026-11-27T17:50:00-05:00', tz: NY }, place: { name: 'Dock', ...off(FAR, 1000, 0) } } }]), new Map(), { fallbackTz: LA });
  assert.equal(PLAN.next?.(/** @type {any} */ (soon.find((w) => w.id === 'plan:soon:leave')).when, here(MONTEREY, MONDAY), {}), ny('17:30'));
  // On the plane, 300 km out at 17:00: neither "leave" nor "running late", though a drive from there would be late.
  const plane = off(FAR, 0, -300_000);
  assert.equal(PLAN.check(tourLeave, here(plane, ny('17:00')), {}), null);
  assert.equal(PLAN.check(tourLate, here(plane, ny('17:00')), {}), null);
  assert.equal(PLAN.next?.(tourLate, here(plane, ny('17:00')), {}), ny('17:30'));
  // Landed, at the airport 15.5 km away (about 27 min by car): due at 18:18, as any leave reminder.
  assert.equal(PLAN.next?.(tourLeave, here(AIRPORT, ny('17:35')), {}), ny('18:18'));
  assert.equal(PLAN.check(tourLeave, here(AIRPORT, ny('18:18')), {})?.fallback, 'Leave in about 15 min: Lighthouse tour at 19:00, Old Lighthouse. About 27 min by car.');

});

test("what comes after a train within a day's drive waits for it to arrive, and isn't counted from the station it left (the second opinion's gap: the test was masked)", () => {
  // From Monterey at 07:00, arriving 09:00 at a station 400 km south; a pier tour at 13:00, 1 km from it.
  const STATION = off(MONTEREY, 0, -400_000);
  const ridden0 = () => ({ path: '/plan/train.json', item: { title: 'Coast train', fixed: true, start: { at: iso('07:00'), tz: LA }, end: { at: iso('09:00'), tz: LA }, place: { name: 'Monterey station', ...MONTEREY }, booking: '/trip/bookings/train.json' } });
  const TRAIN_BOOKING = { id: 'train', kind: 'rail', status: 'confirmed', source: '/files/t.pdf', title: 'Coast train' };
  const ridden = planWatches(/** @type {any} */ ([
    ridden0(),
    { path: '/plan/pier.json', item: { title: 'Pier tour', fixed: true, start: { at: iso('13:00'), tz: LA }, place: { name: 'South pier', ...off(STATION, 1000, 0) } } },
  ]), new Map([['/bookings/train.json', TRAIN_BOOKING]]), { fallbackTz: LA });
  const pier = /** @type {any} */ (ridden.find((w) => w.id === 'plan:pier:leave')).when;
  // On the train: a drive of 390 km would be due long ago; the train isn't.
  assert.equal(PLAN.check(pier, here(off(MONTEREY, 0, -10_000), at('07:05')), {}), null);
  // Running late waits for the train too: a pier at 11:30 (its window opens at 08:30, before the train arrives at 09:00), and a position
  // 250 km from it at 08:30, on the train: a drive from there (277 min) would be 97 min late, but they are carried. Removing the wait for the
  // arrival (`after`) from the late check fails this. Once the train has arrived, from the same distance, it is late.
  const early = planWatches(/** @type {any} */ ([ridden0(), { path: '/plan/early.json', item: { title: 'Early pier tour', fixed: true, start: { at: iso('11:30'), tz: LA }, place: { name: 'North pier', ...off(STATION, 1000, 0) } } }]), new Map([['/bookings/train.json', TRAIN_BOOKING]]), { fallbackTz: LA });
  const earlyLate = /** @type {any} */ (early.find((w) => w.id === 'plan:early:late')).when;
  const onTrain = off(STATION, 0, 250_000);
  assert.equal(PLAN.check(earlyLate, here(onTrain, at('08:30')), {}), null);
  assert.equal(PLAN.check(earlyLate, here(onTrain, at('08:59')), {}), null);
  assert.match(String(PLAN.check(earlyLate, here(onTrain, at('09:00')), {})?.text), /about 127 min late$/);
  // Arrived at 09:00, 1 km away on foot (18 min): the time to leave is 12:27.
  assert.equal(PLAN.next?.(pier, here(STATION, at('09:00')), {}), at('12:27'));
  assert.equal(PLAN.check(pier, here(STATION, at('12:27')), {})?.fallback, 'Leave in about 15 min: Pier tour at 13:00, South pier. About 18 min on foot.');
  // With no position (live mode off, or the copy at the push relay): not counted from the station the train left (that would be due at
  // 09:00, the arrival), but half an hour before. Removing the reset of the stop before fails this.
  assert.equal(PLAN.next?.(pier, moment({ now: at('06:00') }), {}), at('12:30'));
  assert.equal(PLAN.check(pier, moment({ now: at('07:05') }), {}), null);
  assert.equal(PLAN.check(pier, moment({ now: at('09:00') }), {}), null);
  assert.equal(PLAN.check(pier, moment({ now: at('12:29') }), {}), null);
  assert.equal(PLAN.check(pier, moment({ now: at('12:30') }), {})?.fallback, 'Leave soon: Pier tour at 13:00, South pier.');
});

test("a flight's leave reminder aims to be at the airport 2 h before it departs; running late only when they'd be there under 1 h before (it said to leave so as to arrive at 14:05 for a 14:05 flight)", () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const home = off(SFO, 0, 25_000); // 25 km: 35 km of road, 36 min at 50 km/h for the first 30 and 3.75 at 80 km/h for the rest: 40 min by car
  const day = '2026-11-29';
  const leave = find('plan:flight:leave').when;
  const late = find('plan:flight:late').when;
  // 14:05 − 2 h − 40 min − the 15-minute lead: due at 11:10, to leave at 11:25 and be there by 12:05.
  assert.equal(PLAN.next?.(leave, here(home, at('08:00', day)), {}), at('11:10', day));
  assert.equal(PLAN.check(leave, here(home, at('11:09', day)), {}), null);
  const f = PLAN.check(leave, here(home, at('11:10', day)), {});
  assert.equal(f?.fallback, 'Leave in about 15 min: Flight UA 123 departs 14:05, SFO T3. About 40 min by car.');
  assert.equal(f?.text, 'Plan: time to leave soon for "UA 123 home" (can\'t be moved, 14:05): 25.0 km away in a straight line, about 40 min by car, to be there by 12:05');
  assert.equal(PLAN.describe(leave), '15 min before leaving for "UA 123 home" at 14:05, to be there by 12:05');
  // Past the time to be there, the leave reminder has nothing left to say.
  assert.equal(PLAN.check(leave, here(home, at('12:05', day)), {}), null);
  // Running late (the user's pick, "Under 1 hour before"): only when the traveller would reach the airport less than an hour before the
  // departure, about when check-in and bag drop close: after 13:05, and the usual 5 min of grace. Missing the 2-hour mark alone isn't it.
  assert.equal(PLAN.check(late, here(home, at('11:20', day)), {}), null); // it said "Running late" here: there at 12:00 is on time
  assert.equal(PLAN.check(late, here(home, at('12:10', day)), {}), null); // 5 min past the mark: there at 12:50, 75 min early
  assert.equal(PLAN.next?.(late, here(home, at('08:00', day)), {}), at('12:30:01', day));
  assert.equal(PLAN.check(late, here(home, at('12:30', day)), {}), null); // there at 13:10: the 5 min of grace
  const l = PLAN.check(late, here(home, at('12:31', day)), {});
  assert.equal(l?.fallback, 'Running late: Flight UA 123 departs 14:05, SFO T3. About 40 min away.');
  assert.equal(l?.text, 'Plan: running late for "UA 123 home" (can\'t be moved, 14:05): 25.0 km away, about 40 min by car, so about 6 min late to be there by 13:05');
  assert.equal(PLAN.describe(late), 'when running late for "UA 123 home" at 14:05, to be there by 13:05');
  assert.ok(PLAN.check(late, here(home, at('13:30', day)), {})); // still far and under an hour before: the flight is at risk
  assert.equal(PLAN.check(late, here(home, at('14:06', day)), {}), null); // it has departed
  assert.equal(PLAN.check(late, here(off(SFO, 0, 10_000), at('12:50', day)), {}), null); // 10 km (14 km of road, 17 min): there at 13:07
  // The window of running late opens 3 h before the 1-hour mark (10:05), not before the 2-hour one (09:05): from 250 km out, a 277-min
  // drive, the estimate is far past the mark all morning.
  const out = off(SFO, 0, 250_000);
  assert.equal(PLAN.next?.(late, here(out, at('08:00', day)), {}), at('10:05', day));
  assert.equal(PLAN.check(late, here(out, at('09:30', day)), {}), null);
  assert.ok(PLAN.check(late, here(out, at('10:05', day)), {}));
  // Anything else keeps its own time: lunch at 12:00 from 7 km is due at 11:33, as before.
  assert.equal(PLAN.next?.(find('plan:nepenthe:leave').when, here(RIVER_INN, at('10:30')), {}), at('11:33'));
});

test("a connection gets no leave and no running late: a flight whose time to be there comes before the flight before it lands (it said \"Running late ... 505 min away\" as the first plane landed)", () => {
  const HUB = { lat: 47.45, lng: -122.31 };
  const fly = (/** @type {string} */ name, /** @type {string} */ from, /** @type {string} */ to, /** @type {{ lat: number, lng: number }} */ place, /** @type {any} */ o = {}) => ({ path: `/plan/${name}.json`, item: { title: `Flight ${name}`, kind: 'flight', fixed: true, start: { at: iso(from), tz: LA }, end: { at: iso(to), tz: LA }, place: { name, ...place }, ...o } });
  const ids = (/** @type {any[]} */ items) => planWatches(items, new Map(), { fallbackTz: LA }).filter((w) => w.id !== 'plan:linger').map((w) => w.id);
  // The first plane lands at 10:00; the second leaves at 11:30, so its time to be there (09:30) comes first: the traveller is carried there.
  assert.deepEqual(ids([fly('a', '08:00', '10:00', MONTEREY), fly('b', '11:30', '14:00', HUB)]), ['plan:a:leave', 'plan:a:late', 'plan:a:arrived', 'plan:b:arrived']);
  // With a 3-hour layover (be there by 11:30, after the landing) it keeps both: the leave is half an hour before the time to be there
  // (11:00). That a reminder is never due before the landing is the landing floor's, pinned in the test above (a tour at 17:50).
  const long = planWatches(/** @type {any} */ ([fly('a', '08:00', '10:00', MONTEREY), fly('b', '13:30', '16:00', HUB)]), new Map(), { fallbackTz: LA });
  assert.deepEqual(long.filter((w) => w.id.startsWith('plan:b:')).map((w) => w.id), ['plan:b:leave', 'plan:b:late', 'plan:b:arrived']);
  assert.equal(PLAN.next?.(/** @type {any} */ (long.find((w) => w.id === 'plan:b:leave')).when, moment({ now: at('07:00') }), {}), at('11:00'));
  // A time to be there exactly at the landing is no connection (12:00 less 2 h, 10:00): the boundary is "before", not "at".
  const exact = planWatches(/** @type {any} */ ([fly('a', '08:00', '10:00', MONTEREY), fly('b', '12:00', '15:00', HUB)]), new Map(), { fallbackTz: LA });
  assert.deepEqual(exact.filter((w) => w.id.startsWith('plan:b:')).map((w) => w.id), ['plan:b:leave', 'plan:b:late', 'plan:b:arrived']);
  // A train meeting a plane the same way (a train has no margin: its time to be there is its start).
  const train = { path: '/plan/t.json', item: { title: 'Airport train', kind: 'rail', fixed: true, start: { at: iso('09:40'), tz: LA }, end: { at: iso('10:30'), tz: LA }, place: { name: 'Station', ...HUB } } };
  assert.deepEqual(ids([fly('a', '08:00', '10:00', MONTEREY), train]), ['plan:a:leave', 'plan:a:late', 'plan:a:arrived', 'plan:t:arrived']);
});

test("a flexible flight or train doesn't hold back a fixed item's reminders: only a fixed one carries the traveller (the second opinion's N2)", () => {
  const maybe = /** @type {any} */ ({ path: '/plan/maybe.json', item: { title: 'Maybe the early flight', kind: 'flight', fixed: false, start: { at: iso('09:00'), tz: LA }, end: { at: iso('17:30'), tz: LA }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } } });
  const items = [maybe, ITEMS[0]];
  const lunch = planWatches(/** @type {any} */ (items), new Map(), { fallbackTz: LA }).find((w) => w.id === 'plan:nepenthe:leave')?.when;
  assert.equal(PLAN.next?.(lunch, here(RIVER_INN, at('10:30')), {}), at('11:33'));
  assert.ok(PLAN.check(lunch, here(RIVER_INN, at('11:33')), {}));
  // The same flight fixed: the lunch waits for it to land at 17:30, which is after the lunch.
  const fixed = planWatches(/** @type {any} */ ([{ ...maybe, item: { ...maybe.item, fixed: true } }, ITEMS[0]]), new Map(), { fallbackTz: LA }).find((w) => w.id === 'plan:nepenthe:leave')?.when;
  assert.equal(PLAN.next?.(fixed, here(RIVER_INN, at('10:30')), {}), null);
});

test("several flight items on one booking: a leg is named by its own item, not by the whole booking (it said \"Flight AB 123: SFO ⇄ ANC via SEA departs 17:55\" for every leg)", () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const SEA = { lat: 47.45, lng: -122.31 };
  const ANC = { lat: 61.17, lng: -150.0 };
  const leg = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ day, /** @type {string} */ from, /** @type {string} */ to, /** @type {string} */ airport, /** @type {{ lat: number, lng: number }} */ place) =>
    ({ path: `/plan/${name}.json`, item: { title, kind: 'flight', fixed: true, start: { at: iso(from, day), tz: LA }, end: { at: iso(to, day), tz: LA }, place: { name: airport, ...place }, booking: '/trip/bookings/four.json' } });
  const four = new Map([['/bookings/four.json', { id: 'four', kind: 'flight', status: 'confirmed', source: '/files/f.pdf', title: 'AB 123: SFO ⇄ ANC via SEA', fields: { terminal: 'T3' } }]]);
  const l1 = leg('l1', 'Out to Seattle', '2026-11-20', '09:05', '11:30', 'SFO', SFO);
  const ws = planWatches(/** @type {any} */ ([
    l1,
    leg('l2', 'On to Anchorage', '2026-11-20', '14:00', '17:00', 'SEA', SEA),
    leg('l3', 'Back to Seattle', '2026-11-26', '09:05', '12:30', 'ANC', ANC),
    leg('l4', 'Last leg home', '2026-11-26', '17:55', '21:00', 'SEA', SEA),
  ]), four, { fallbackTz: LA });
  assert.equal(ws.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Out to Seattle at 09:05, SFO.');
  assert.equal(ws.find((w) => w.id === 'plan:l4:late')?.fallback, 'Running late: Last leg home at 17:55, SEA.');
  assert.equal(planWords(/** @type {any} */ (ws.find((w) => w.id === 'plan:l4:leave')?.say)), 'Leave soon: Last leg home at 17:55, SEA.');
  assert.equal(ws.find((w) => w.id === 'plan:l2:leave')?.fallback, 'Leave soon: On to Anchorage at 14:00, SEA.');
  // A leg alone on its booking is still the flight by its booking's name, with its terminal.
  const one = planWatches(/** @type {any} */ ([l1]), four, { fallbackTz: LA });
  assert.equal(one.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Flight AB 123: SFO ⇄ ANC via SEA departs 09:05, SFO T3.');
  // An out and back on one booking, two legs, is several too (the threshold is two): each leg is named by its own item.
  const pair = planWatches(/** @type {any} */ ([l1, leg('l3', 'Back to Seattle', '2026-11-26', '09:05', '12:30', 'ANC', ANC)]), four, { fallbackTz: LA });
  assert.equal(pair.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Out to Seattle at 09:05, SFO.');
  assert.equal(pair.find((w) => w.id === 'plan:l3:leave')?.fallback, 'Leave soon: Back to Seattle at 09:05, ANC.');
  // Only flight legs count as several: a transfer on a package booking (kind "other", a flight and a car) doesn't, so the flight keeps its name and its terminal.
  const withCar = new Map([['/bookings/four.json', { ...four.get('/bookings/four.json'), kind: 'other', title: 'AB 123 and a car' }]]);
  const transfer = { path: '/plan/car.json', item: { title: 'Car to the hotel', kind: 'car', fixed: true, start: { at: iso('12:00', '2026-11-20'), tz: LA }, place: { name: 'Arrivals', ...SEA }, booking: '/trip/bookings/four.json' } };
  const hop = planWatches(/** @type {any} */ ([l1, transfer]), withCar, { fallbackTz: LA });
  assert.equal(hop.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Flight AB 123 and a car departs 09:05, SFO T3.');
  // On a booking of kind "flight" the car is no leg by its own kind, so the flight is alone on it and named by it, with its terminal; with no kind
  // the car takes the booking's and is a second leg, so each is named by its own title (D1 of the second re-review; what else follows from it is in
  // docs/limitations.md, "An item with no kind, or a kind annai doesn't know, linked to a flight or train booking, takes the booking's rules").
  const onFlight = planWatches(/** @type {any} */ ([l1, transfer]), four, { fallbackTz: LA });
  assert.equal(onFlight.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Flight AB 123: SFO ⇄ ANC via SEA departs 09:05, SFO T3.');
  const { kind: _, ...unkinded } = transfer.item;
  const noKind = planWatches(/** @type {any} */ ([l1, { ...transfer, item: unkinded }]), four, { fallbackTz: LA });
  assert.equal(noKind.find((w) => w.id === 'plan:l1:leave')?.fallback, 'Leave soon: Out to Seattle at 09:05, SFO.');
  // The legs still count as flights: the airport's wide circle, and the 2 h margin.
  assert.equal(/** @type {any} */ (ws.find((w) => w.id === 'plan:l1:arrived')).when.radius, 2000);
  assert.equal(/** @type {any} */ (ws.find((w) => w.id === 'plan:l1:leave')).when.by, Date.parse('2026-11-20T09:05:00-08:00') - 120 * 60_000);
});

test('a flight whose name already begins with "Flight" is not given the word again: "Flight Flight to Seattle departs" (slice 2 F2 of fix round 2)', () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const flight = (/** @type {string} */ title, /** @type {any} */ o = {}) => ({ path: '/plan/f.json', item: { title, kind: 'flight', fixed: true, start: { at: iso('09:05'), tz: LA }, end: { at: iso('11:30'), tz: LA }, place: { name: 'SFO', ...SFO }, ...o } });
  const ofBooking = (/** @type {string} */ title) => new Map([['/bookings/b.json', { id: 'b', kind: 'flight', status: 'confirmed', source: '/files/f.pdf', title, fields: { terminal: 'T3' } }]]);
  /** What Shiori reads and what the user's words make of the same data, for the leave and the late. @param {any[]} items @param {Map<string, any>} bookings */
  const said = (items, bookings) => {
    const ws = planWatches(/** @type {any} */ (items), bookings, { fallbackTz: LA });
    return ['plan:f:leave', 'plan:f:late'].map((id) => { const w = /** @type {any} */ (ws.find((x) => x.id === id)); return [w.fallback, planWords(w.say)]; });
  };
  // No booking: the item's title is the name, and it begins with the word, so it is shown as an item's title, as it is.
  assert.deepEqual(said([flight('Flight to Seattle')], new Map()), [
    ['Leave soon: Flight to Seattle at 09:05, SFO.', 'Leave soon: Flight to Seattle at 09:05, SFO.'],
    ['Running late: Flight to Seattle at 09:05, SFO.', 'Running late: Flight to Seattle at 09:05, SFO.'],
  ]);
  // A booking's title that begins with it is the same, with the terminal; its item's own title is not the name then.
  assert.equal(said([flight('Out to Seattle', { booking: '/trip/bookings/b.json' })], ofBooking('Flight AB 123'))[0][0], 'Leave soon: Flight AB 123 at 09:05, SFO T3.');
  // Any other name keeps "Flight <name> departs", with a booking or without one.
  assert.equal(said([flight('Out to Seattle')], new Map())[0][0], 'Leave soon: Flight Out to Seattle departs 09:05, SFO.');
  assert.equal(said([flight('Out to Seattle', { booking: '/trip/bookings/b.json' })], ofBooking('AB 123'))[0][0], 'Leave soon: Flight AB 123 departs 09:05, SFO T3.');
  // The plural is the word too, with a booking or without one; "Flightseeing" is not: the word is a word.
  assert.equal(said([flight('Flights SFO to SEA')], new Map())[0][0], 'Leave soon: Flights SFO to SEA at 09:05, SFO.');
  assert.equal(said([flight('Out to Seattle', { booking: '/trip/bookings/b.json' })], ofBooking('Flights SFO to SEA'))[0][0], 'Leave soon: Flights SFO to SEA at 09:05, SFO T3.');
  assert.equal(said([flight('Flightseeing')], new Map())[0][0], 'Leave soon: Flight Flightseeing departs 09:05, SFO.');
  // The local words of the shipped languages (フライト, 航班, 班機) are the word as well, as the user's own title: the data holds the title, not a flight's name.
  for (const name of ['フライト 羽田→新千歳', 'フライトJL 123', '航班 CA981', '班機 CI 5']) {
    const [w] = planWatches(/** @type {any} */ ([flight(name)]), new Map(), { fallbackTz: LA }).filter((x) => x.id === 'plan:f:leave');
    assert.deepEqual([w.say.what.title, w.say.what.flight], [name, undefined], name);
    assert.equal(w.fallback, `Leave soon: ${name} at 09:05, SFO.`, name);
  }
});

/** A flight in, a stop on the way, and a flight on: the plan check's shape (made-up places; the airport 2475 km from the stop, so a flight away). */
const HOTEL_Y = off(MONTEREY, 0, -2_475_000);
/** @param {any} between the item sorted between the two flights, 16:00 */
const hopWith = (between) => planWatches(/** @type {any} */ ([
  { path: '/plan/in.json', item: { title: 'Flight in', kind: 'flight', fixed: true, start: { at: iso('06:00'), tz: LA }, end: { at: iso('13:05'), tz: LA }, place: { name: 'Home airport', ...off(MONTEREY, 0, 2_000_000) } } },
  { path: '/plan/between.json', item: { fixed: true, start: { at: iso('16:00'), tz: LA }, place: { name: 'Harbor', ...HOTEL_Y }, ...between } },
  { path: '/plan/on.json', item: { title: 'Flight on', kind: 'flight', fixed: true, start: { at: iso('17:55'), tz: LA }, end: { at: iso('21:00'), tz: LA }, place: { name: 'Airport X', ...MONTEREY } } },
]), new Map(), { fallbackTz: LA });

test("a stop before farther than a day's drive from the item is none: a check-in, a car pick-up or an unlinked hotel between two flights doesn't make the flight on due from 2475 km away (the plan check's shape)", () => {
  for (const between of [{ title: 'Check in: Harbor Inn', kind: 'lodging' }, { title: 'Car pick-up' }, { title: 'Hotel Harbor', kind: 'hotel' }]) {
    const ws = hopWith(between);
    const leave = /** @type {any} */ (ws.find((w) => w.id === 'plan:on:leave')).when;
    assert.equal(leave.from?.name, 'Harbor', between.title); // it is the plan's stop before: it sorted between the flights...
    // ...and no place to count a drive from: half an hour before the time to be there (15:55), with no fix, or at the stop, a flight away.
    assert.equal(PLAN.next?.(leave, moment({ now: at('12:00') }), {}), at('15:25'), between.title);
    assert.equal(PLAN.next?.(leave, here(HOTEL_Y, at('12:00')), {}), at('15:25'), between.title);
    assert.equal(PLAN.check(leave, moment({ now: at('15:25') }), {})?.fallback, 'Leave soon: Flight on at 17:55, Airport X.', between.title);
  }
  // A stay has no leave or running late of its own, and is still a place on the plan.
  const ws = hopWith({ title: 'Check in: Harbor Inn', kind: 'lodging' });
  assert.deepEqual(ws.filter((w) => w.id.startsWith('plan:between:')).map((w) => w.id), ['plan:between:arrived']);
  assert.deepEqual(/** @type {any} */ (ws.find((w) => w.id === 'plan:linger')).when.places.map((/** @type {any} */ p) => p.name), ['Home airport', 'Harbor', 'Airport X']);
});

test("a stay is the stop before what comes after it, within a day's drive: the flight home counts from the stay's place (it said \"Leave soon\" 1 h 44 min late with no position), and so does the dinner after a check-in", () => {
  const AIRPORT_H = { lat: 37.6213, lng: -122.379 };
  const STAY_H = off(AIRPORT_H, 0, 100_000); // 100 km from the airport: 140 km of road, 119 min by car
  const home = { path: '/plan/home.json', item: { title: 'Flight home', kind: 'flight', fixed: true, start: { at: iso('14:05', '2026-11-30'), tz: LA }, place: { name: 'SFO', ...AIRPORT_H } } };
  const flightIn = { path: '/plan/in.json', item: { title: 'Flight in', kind: 'flight', fixed: true, start: { at: iso('06:00'), tz: LA }, end: { at: iso('13:05'), tz: LA }, place: { name: 'Home airport', ...off(MONTEREY, 0, 2_000_000) } } };
  const homeLeave = (/** @type {any[]} */ items) => /** @type {any} */ (planWatches(/** @type {any} */ (items), new Map(), { fallbackTz: LA }).find((w) => w.id === 'plan:home:leave')).when;
  // S4: one stay item, from the check-in to the check-out; S4b: the check-in and the check-out as items of their own. No position: 12:05
  // (14:05 less 2 h) less 119 min and the 15 of the lead, 09:51 on the day; it was 11:35, half an hour before, which is 1 h 44 min late.
  const stay = { path: '/plan/stay.json', item: { title: 'Stay at Harbor Inn', kind: 'lodging', fixed: true, start: { at: iso('16:00'), tz: LA }, end: { at: iso('11:00', '2026-11-30'), tz: LA }, place: { name: 'Harbor Inn', ...STAY_H } } };
  const checkIn = { path: '/plan/checkin.json', item: { title: 'Check in: Harbor Inn', kind: 'lodging', fixed: true, start: { at: iso('16:00'), tz: LA }, place: { name: 'Harbor Inn', ...STAY_H } } };
  const checkOut = { path: '/plan/checkout.json', item: { title: 'Check out: Harbor Inn', kind: 'lodging', fixed: true, start: { at: iso('11:00', '2026-11-30'), tz: LA }, place: { name: 'Harbor Inn', ...STAY_H } } };
  for (const [name, items] of /** @type {[string, any[]][]} */ ([['one stay item', [flightIn, stay, home]], ['a check-in and a check-out', [flightIn, checkIn, checkOut, home]]])) {
    const leave = homeLeave(items);
    assert.equal(leave.from?.name, 'Harbor Inn', name);
    assert.equal(PLAN.next?.(leave, moment({ now: at('08:00', '2026-11-30') }), {}), at('09:51', '2026-11-30'), name);
    assert.equal(PLAN.check(leave, moment({ now: at('09:50', '2026-11-30') }), {}), null, name);
    assert.equal(PLAN.check(leave, moment({ now: at('09:51', '2026-11-30') }), {})?.fallback, 'Leave in about 15 min: Flight home at 14:05, SFO. About 119 min by car.', name);
  }
  // A road trip: a tour in town A, the check-in of a stay 7 km from the dinner, the dinner at 19:00: its copy with no position is counted from the stay (18:33).
  const trip = planWatches(/** @type {any} */ ([
    { path: '/plan/tour.json', item: { title: 'Monterey tour', fixed: true, start: { at: iso('10:00'), tz: LA }, end: { at: iso('11:30'), tz: LA }, place: { name: 'Monterey', ...MONTEREY } } },
    { path: '/plan/inn.json', item: { title: 'Check in: Big Sur River Inn', kind: 'lodging', fixed: true, start: { at: iso('16:00'), tz: LA }, place: { name: 'Big Sur River Inn', ...RIVER_INN } } },
    { path: '/plan/dinner.json', item: { title: 'Dinner at Nepenthe', fixed: true, start: { at: iso('19:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } },
  ]), new Map(), { fallbackTz: LA });
  assert.equal(PLAN.next?.(/** @type {any} */ (trip.find((w) => w.id === 'plan:dinner:leave')).when, moment({ now: at('08:00') }), {}), at('18:33'));
});

/**
 * The traveller's stay at the destination, 3300 km from home, and what comes after the flight there, with no position near (the phone
 * closed since landing, or GPS off): a tour the morning after, 40 km from the stay (56 min by car); or, with nothing between, the flight
 * home three days on from an airport 100 km from it (119 min). Made-up places. @param {any[]} flights the flights there, with the
 * check-in sorted among them @param {'tour' | 'home'} next
 */
const stayedAfter = (flights, next) => planWatches(/** @type {any} */ ([
  ...flights,
  { path: '/plan/inn.json', item: { title: 'Check in: Harbor Inn', fixed: true, start: { at: '2026-11-27T16:00:00-05:00', tz: NY }, place: { name: 'Harbor Inn', ...FAR }, booking: '/trip/bookings/inn.json' } },
  next === 'tour'
    ? { path: '/plan/tour.json', item: { title: 'Lighthouse tour', fixed: true, start: { at: '2026-11-28T09:00:00-05:00', tz: NY }, place: { name: 'Old Lighthouse', ...off(FAR, 0, 40_000) } } }
    : { path: '/plan/home.json', item: { title: 'Flight home', kind: 'flight', fixed: true, start: { at: '2026-11-30T14:05:00-05:00', tz: NY }, place: { name: 'Home airport', ...off(FAR, 0, -100_000) } } },
]), INN, { fallbackTz: LA });

test("a stay whose check-in sorts before the flight that takes the traveller there is still the stop before what comes after it (the design check's A1: the tour's reminder came 41 min late, the flight home's 1 h 44 min)", () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const HUB = off(FAR, 0, 2_475_000); // a flight away from the stay
  const shapes = /** @type {[string, any[]][]} */ ([
    // One flight that leaves after the check-in's time there: 14:00 in California is 17:00 at the stay, landing 22:58.
    ['a flight in that leaves after the check-in time', [
      { path: '/plan/out.json', item: { title: 'Flight out', kind: 'flight', fixed: true, start: { at: '2026-11-27T14:00:00-08:00', tz: LA }, end: { at: '2026-11-27T22:58:00-05:00', tz: NY }, place: { name: 'SFO', ...SFO } } },
    ]],
    // Two flights with the check-in between: in to a hub 2475 km from the stay, landing 13:05, and on at 17:55, landing 21:00.
    ['two flights with the check-in between', [
      { path: '/plan/in.json', item: { title: 'Flight in', kind: 'flight', fixed: true, start: { at: '2026-11-27T06:00:00-08:00', tz: LA }, end: { at: '2026-11-27T13:05:00-05:00', tz: NY }, place: { name: 'SFO', ...SFO } } },
      { path: '/plan/on.json', item: { title: 'Flight on', kind: 'flight', fixed: true, start: { at: '2026-11-27T17:55:00-05:00', tz: NY }, end: { at: '2026-11-27T21:00:00-05:00', tz: NY }, place: { name: 'Hub', ...HUB } } },
    ]],
  ]);
  for (const [name, flights] of shapes) {
    const leaveOf = (/** @type {'tour' | 'home'} */ id) => /** @type {any} */ (stayedAfter(flights, id).find((w) => w.id === `plan:${id}:leave`)).when;
    // The morning after: 09:00 less 56 min and the 15 of the lead, 07:49; it came at 08:30, the half hour before. From home, a flight away, the same.
    assert.equal(leaveOf('tour').from?.name, 'Harbor Inn', name);
    assert.equal(PLAN.next?.(leaveOf('tour'), moment({ now: ny('23:30') }), {}), ny('07:49', '2026-11-28'), name);
    assert.equal(PLAN.next?.(leaveOf('tour'), here(MONTEREY, MONDAY), {}), ny('07:49', '2026-11-28'), name);
    assert.equal(PLAN.check(leaveOf('tour'), moment({ now: ny('07:49', '2026-11-28') }), {})?.fallback, 'Leave in about 15 min: Lighthouse tour at 09:00, Old Lighthouse. About 56 min by car.', name);
    // The flight home, with no check-out or other stop before it: 12:05 less 119 min and the 15, 09:51; it came at 11:35.
    assert.equal(leaveOf('home').from?.name, 'Harbor Inn', name);
    assert.equal(PLAN.next?.(leaveOf('home'), moment({ now: ny('08:00', '2026-11-30') }), {}), ny('09:51', '2026-11-30'), name);
    // Waiting for the landing stays as it was: nothing before 22:58, or 21:00.
    assert.ok(/** @type {number} */ (PLAN.next?.(leaveOf('tour'), moment({ now: ny('12:00') }), {})) > ny('21:00'), name);
  }
  // A stop before within a day's drive of where the flight leaves is behind it, and wiped as before: a hotel by the airport the night
  // before the flight out, then the tour at the destination with no stay on the plan: half an hour before it.
  const behind = planWatches(/** @type {any} */ ([
    { path: '/plan/night.json', item: { title: 'Airport hotel', kind: 'lodging', fixed: true, start: { at: '2026-11-26T20:00:00-08:00', tz: LA }, place: { name: 'Airport hotel', ...off(SFO, 2000, 0) } } },
    shapes[0][1][0],
    { path: '/plan/tour.json', item: { title: 'Lighthouse tour', fixed: true, start: { at: '2026-11-28T09:00:00-05:00', tz: NY }, place: { name: 'Old Lighthouse', ...off(FAR, 0, 40_000) } } },
  ]), new Map(), { fallbackTz: LA });
  const tour = /** @type {any} */ (behind.find((w) => w.id === 'plan:tour:leave')).when;
  assert.equal(tour.from, null);
  assert.equal(PLAN.next?.(tour, moment({ now: ny('23:30') }), {}), ny('08:30', '2026-11-28'));
});

test("a train's running late ends when it departs: on board at 07:10, 33 km down the line, it said \"Running late: Coast train at 07:00, Home station. About 49 min away.\" (the design check's A2)", () => {
  const ws = planWatches([{ path: '/plan/train.json', item: { title: 'Coast train', kind: 'rail', fixed: true, start: { at: iso('07:00'), tz: LA }, end: { at: iso('09:00'), tz: LA }, place: { name: 'Home station', ...MONTEREY } } }], new Map(), { fallbackTz: LA });
  const late = /** @type {any} */ (ws.find((w) => w.id === 'plan:train:late')).when;
  const aboard = off(MONTEREY, 0, -33_000);
  // Before it departs, 33 km from the station (49 min by car): late, as before.
  assert.equal(PLAN.check(late, here(aboard, at('06:59')), {})?.fallback, 'Running late: Coast train at 07:00, Home station. About 49 min away.');
  // Once it has departed, they are on it or have missed it: nothing, where it said running late for an hour.
  for (const t of ['07:00:01', '07:10', '07:59']) assert.equal(PLAN.check(late, here(aboard, at(t)), {}), null, t);
  // Anything else keeps its hour: lunch at 12:00, 21 km away at 12:30, is still late.
  assert.match(String(PLAN.check(find('plan:nepenthe:late').when, here(BIXBY, at('12:30')), {})?.text), /so about 66 min late$/);
  assert.equal(PLAN.check(find('plan:nepenthe:late').when, here(BIXBY, at('13:00:01')), {}), null);
});

test("an item's own kind word decides, read through one table, and only an unknown word or none takes its booking's: a car or a check-out on a flight's booking is no flight (it was one, and the flight home's reminder came 1 h 44 min late)", () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const STAY_H = off(SFO, 0, 100_000); // 100 km from the airport: 119 min by car
  const ON_FLIGHT = new Map([['/bookings/ua.json', { id: 'ua', kind: 'flight', status: 'confirmed', source: '/files/ua.pdf', title: 'UA 123', fields: { terminal: 'T3' } }]]);
  const home = { path: '/plan/home.json', item: { title: 'Flight home', kind: 'flight', fixed: true, start: { at: iso('14:05', '2026-11-30'), tz: LA }, place: { name: 'SFO', ...SFO }, booking: '/trip/bookings/ua.json' } };
  const out = (/** @type {any} */ o) => ({ path: '/plan/out.json', item: { title: 'Check out: Harbor Inn', fixed: true, start: { at: iso('11:00', '2026-11-30'), tz: LA }, place: { name: 'Harbor Inn', ...STAY_H }, booking: '/trip/bookings/ua.json', ...o } });
  const homeOf = (/** @type {any} */ o) => /** @type {any} */ (planWatches(/** @type {any} */ ([out(o), home]), ON_FLIGHT, { fallbackTz: LA }).find((w) => w.id === 'plan:home:leave'));
  // A check-out written as a stay, on the flight's booking: a stay, so the stop before the flight home, 09:51 with no position; and the
  // flight is alone on its booking again, named by it with its terminal. Every word for a stay, in any case or spacing, reads alike.
  for (const kind of ['lodging', 'hotel', 'stay', ' Hotel ', 'LODGING']) {
    const w = homeOf({ kind });
    assert.equal(w.when.from?.name, 'Harbor Inn', kind);
    assert.equal(PLAN.next?.(w.when, moment({ now: at('08:00', '2026-11-30') }), {}), at('09:51', '2026-11-30'), kind);
    assert.equal(w.fallback, 'Leave soon: Flight UA 123 departs 14:05, SFO T3.', kind);
  }
  // With no kind, or a word the table doesn't know, it takes its booking's, as before: a flight leg, so no stop before (11:35), and
  // the flight is one of two legs, named by its own title.
  for (const o of [{}, { kind: 'checkout' }]) {
    const w = homeOf(o);
    assert.equal(w.when.from, null, JSON.stringify(o));
    assert.equal(PLAN.next?.(w.when, moment({ now: at('08:00', '2026-11-30') }), {}), at('11:35', '2026-11-30'), JSON.stringify(o));
    assert.equal(w.fallback, 'Leave soon: Flight home at 14:05, SFO.', JSON.stringify(o));
  }
  // A car pick-up at 17:00 on the booking of a flight that lands at 16:30: by its own word a car, so it gets its own leave and running
  // late (as a connection it had neither), and the dinner after it, 100 km from the car desk, counts from there (16:46; it was 18:30).
  const DESK = off(SFO, 0, -1_000);
  const arrive = { path: '/plan/in.json', item: { title: 'Flight in', kind: 'flight', fixed: true, start: { at: iso('12:00'), tz: LA }, end: { at: iso('16:30'), tz: LA }, place: { name: 'Home airport', ...off(SFO, 0, 1_500_000) }, booking: '/trip/bookings/ua.json' } };
  const car = { path: '/plan/car.json', item: { title: 'Car pick-up', kind: 'car', fixed: true, start: { at: iso('17:00'), tz: LA }, place: { name: 'Car hire desk', ...DESK }, booking: '/trip/bookings/ua.json' } };
  const dinner = { path: '/plan/dinner.json', item: { title: 'Dinner', fixed: true, start: { at: iso('19:00'), tz: LA }, place: { name: 'Harbor', ...off(DESK, 0, 100_000) } } };
  const landed = planWatches(/** @type {any} */ ([arrive, car, dinner]), ON_FLIGHT, { fallbackTz: LA });
  assert.deepEqual(landed.filter((w) => w.id.startsWith('plan:car:')).map((w) => w.id), ['plan:car:leave', 'plan:car:late', 'plan:car:arrived']);
  assert.equal(/** @type {any} */ (landed.find((w) => w.id === 'plan:car:arrived')).when.radius, 300);
  assert.equal(/** @type {any} */ (landed.find((w) => w.id === 'plan:car:leave')).fallback, 'Leave soon: Car pick-up at 17:00, Car hire desk.');
  assert.equal(PLAN.next?.(/** @type {any} */ (landed.find((w) => w.id === 'plan:dinner:leave')).when, moment({ now: at('12:00') }), {}), at('16:46'));
  assert.equal(/** @type {any} */ (landed.find((w) => w.id === 'plan:in:leave')).fallback, 'Leave soon: Flight UA 123 departs 12:00, Home airport T3.');
  // A flight written with a word the table doesn't know ("transport") on its flight's booking keeps the 2-hour margin, from its booking.
  const transport = planWatches(/** @type {any} */ ([{ ...home, item: { ...home.item, kind: 'transport' } }]), ON_FLIGHT, { fallbackTz: LA });
  assert.equal(/** @type {any} */ (transport.find((w) => w.id === 'plan:home:leave')).when.by, at('12:05', '2026-11-30'));
  // Linked to no booking, the everyday words are known too: a "plane" has the margin and the airport's circle; a "Train" is a carrier;
  // a "hotel" gets no leave or running late (the plan check's: an item "hotel" on a stay's booking keeps a stay's rules, as below).
  const alone = (/** @type {string} */ kind) => planWatches(/** @type {any} */ ([{ path: '/plan/x.json', item: { title: 'X', kind, fixed: true, start: { at: iso('14:05'), tz: LA }, end: { at: iso('16:00'), tz: LA }, place: { name: 'P', ...SFO } } }]), new Map(), { fallbackTz: LA });
  assert.equal(/** @type {any} */ (alone('plane').find((w) => w.id === 'plan:x:leave')).when.by, at('12:05'));
  assert.equal(/** @type {any} */ (alone('plane').find((w) => w.id === 'plan:x:arrived')).when.radius, 2000);
  assert.deepEqual(alone('hotel').filter((w) => w.id !== 'plan:linger').map((w) => w.id), ['plan:x:arrived']);
  const STAY_B = new Map([['/bookings/inn.json', { id: 'inn', kind: 'lodging', status: 'confirmed', source: '/files/inn.pdf', title: 'Inn' }]]);
  const hotelOnStay = planWatches(/** @type {any} */ ([{ path: '/plan/x.json', item: { title: 'Check in', kind: 'hotel', fixed: true, start: { at: iso('16:00'), tz: LA }, place: { name: 'Inn', ...STAY_H }, booking: '/trip/bookings/inn.json' } }]), STAY_B, { fallbackTz: LA });
  assert.deepEqual(hotelOnStay.filter((w) => w.id !== 'plan:linger').map((w) => w.id), ['plan:x:arrived']);
});

test("ferries, buses and coaches carry the traveller as flights and trains do: what comes after waits for the ride to arrive and doesn't count from where it began (on a coach annai said \"Leave soon: Harbor tour at 11:30\" with the distance still to go)", () => {
  // A coach from Monterey at 07:00, arriving 10:00 at a town 300 km south; a harbor tour at 11:30, 1 km from where it arrives.
  const TOWN = off(MONTEREY, 0, -300_000);
  for (const kind of ['coach', 'bus', 'ferry', 'Coach']) {
    const ws = planWatches(/** @type {any} */ ([
      { path: '/plan/ride.json', item: { title: 'Coast coach', kind, fixed: true, start: { at: iso('07:00'), tz: LA }, end: { at: iso('10:00'), tz: LA }, place: { name: 'Monterey depot', ...MONTEREY } } },
      { path: '/plan/tour.json', item: { title: 'Harbor tour', fixed: true, start: { at: iso('11:30'), tz: LA }, place: { name: 'Harbor', ...off(TOWN, 1000, 0) } } },
    ]), new Map(), { fallbackTz: LA });
    const tour = /** @type {any} */ (ws.find((w) => w.id === 'plan:tour:leave')).when;
    // On the coach, 100 km on at 08:30: a 200 km drive (237 min) would be due already; the ride is waited for.
    assert.equal(PLAN.check(tour, here(off(MONTEREY, 0, -100_000), at('08:30')), {}), null, kind);
    assert.equal(PLAN.next?.(tour, here(off(MONTEREY, 0, -100_000), at('08:30')), {}), at('10:00'), kind);
    // With no position: not from the depot it left (that would be due at once, 08:30's drive), but half an hour before.
    assert.equal(tour.from, null, kind);
    assert.equal(PLAN.next?.(tour, moment({ now: at('06:00') }), {}), at('11:00'), kind);
    // Its own running late ends when it departs, as a train's.
    const late = /** @type {any} */ (ws.find((w) => w.id === 'plan:ride:late')).when;
    assert.ok(PLAN.check(late, here(off(MONTEREY, 0, 33_000), at('06:59')), {}), kind);
    assert.equal(PLAN.check(late, here(off(MONTEREY, 0, -33_000), at('07:10')), {}), null, kind);
    // A ride is no flight: no 2-hour margin, the 300 m circle.
    assert.equal(/** @type {any} */ (ws.find((w) => w.id === 'plan:ride:leave')).when.by, at('07:00'), kind);
    assert.equal(/** @type {any} */ (ws.find((w) => w.id === 'plan:ride:arrived')).when.radius, 300, kind);
  }
});

test("a flight item with no end takes its booking's: what comes after waits for the landing, not the departure (in the air it said \"Leave soon\" and \"Running late ... About 329 min away\")", () => {
  const SFO = { lat: 37.6213, lng: -122.379 };
  const UA = { id: 'ua', kind: 'flight', status: 'confirmed', source: '/files/ua.pdf', title: 'UA 9', start: { at: '2026-11-27T09:00:00-08:00', tz: LA }, end: { at: '2026-11-27T17:30:00-05:00', tz: NY } };
  const out = (/** @type {any} */ o = {}) => ({ path: '/plan/out.json', item: { title: 'Flight out', kind: 'flight', fixed: true, start: { at: '2026-11-27T09:00:00-08:00', tz: LA }, place: { name: 'SFO', ...SFO }, booking: '/trip/bookings/ua.json', ...o } });
  const tourOf = (/** @type {any[]} */ items, /** @type {any} */ booking = UA) => {
    const ws = planWatches(/** @type {any} */ ([...items, FLOWN[2]]), new Map([['/bookings/ua.json', booking]]), { fallbackTz: LA });
    return { leave: /** @type {any} */ (ws.find((w) => w.id === 'plan:tour:leave')).when, late: /** @type {any} */ (ws.find((w) => w.id === 'plan:tour:late')).when };
  };
  // On the plane at 17:00, 300 km from the tour at 19:00 (329 min by car): with the booking's end the tour waits for the landing at 17:30.
  const plane = off(FAR, 0, -300_000);
  const taken = tourOf([out()]);
  assert.equal(taken.leave.after, ny('17:30'));
  assert.equal(PLAN.check(taken.leave, here(plane, ny('17:00')), {}), null);
  assert.equal(PLAN.check(taken.late, here(plane, ny('17:00')), {}), null);
  assert.equal(PLAN.next?.(taken.leave, here(plane, ny('17:00')), {}), ny('17:30'));
  // Its own end wins over the booking's.
  assert.equal(tourOf([out({ end: { at: '2026-11-27T18:00:00-05:00', tz: NY } })]).leave.after, ny('18:00'));
  // Not the booking's end when it isn't this leg's: with its departure as the wait, as before. A booking two carrier items link (an out
  // and back; its end is the return's), and one whose end comes more than a day after the departure (a trip out and back with only the
  // way out on the plan: taken, it would hold back the trip's reminders until the return).
  const back = { path: '/plan/back.json', item: { title: 'Flight back', kind: 'flight', fixed: true, start: { at: '2026-11-30T08:00:00-05:00', tz: NY }, end: { at: '2026-11-30T11:00:00-08:00', tz: LA }, place: { name: 'Home airport', ...AIRPORT }, booking: '/trip/bookings/ua.json' } };
  const roundTrip = { ...UA, end: { at: '2026-11-30T11:00:00-08:00', tz: LA } };
  assert.equal(tourOf([out(), back], roundTrip).leave.after, ny('12:00')); // 09:00 in California
  assert.equal(tourOf([out()], roundTrip).leave.after, ny('12:00'));
  // A booking with no end, or one before the departure, gives none.
  const { end: _, ...noEnd } = UA;
  assert.equal(tourOf([out()], noEnd).leave.after, ny('12:00'));
  assert.equal(tourOf([out()], { ...UA, end: { at: '2026-11-27T08:00:00-08:00', tz: LA } }).leave.after, ny('12:00'));
  // A train on its booking alike.
  const rail = { ...UA, kind: 'rail' };
  assert.equal(tourOf([out({ kind: 'rail' })], rail).leave.after, ny('17:30'));
  // A flight that only takes the booking's end, the wait is as if Shiori had written it: the flight's own arrival counts until it.
  const flight = planWatches(/** @type {any} */ ([out()]), new Map([['/bookings/ua.json', UA]]), { fallbackTz: LA });
  assert.equal(/** @type {any} */ (flight.find((w) => w.id === 'plan:out:arrived')).when.end, ny('17:30'));
});

test("a stay's check-in counts arriving until its booking's check-out: reached at 21:55 for 16:00 after a late landing, it gets its \"arrived\" cue with its notes (it got none past 19:00)", () => {
  const STAYED = { id: 'inn', kind: 'lodging', status: 'confirmed', source: '/files/inn.pdf', title: 'Harbor Inn', start: { at: '2026-11-27T16:00:00-05:00', tz: NY }, end: { at: '2026-11-29T11:00:00-05:00', tz: NY } };
  const checkIn = { path: '/plan/inn.json', item: { title: 'Check in: Harbor Inn', kind: 'lodging', fixed: true, start: { at: '2026-11-27T16:00:00-05:00', tz: NY }, place: { name: 'Harbor Inn', ...FAR }, booking: '/trip/bookings/inn.json', notes: 'The key is in the lockbox.' } };
  const arrivedOf = (/** @type {any} */ item, /** @type {any} */ booking = STAYED) => /** @type {any} */ (planWatches(/** @type {any} */ ([item]), new Map([['/bookings/inn.json', booking]]), { fallbackTz: LA }).find((w) => w.id === 'plan:inn:arrived'));
  const stopped = (/** @type {number} */ t) => here(FAR, t, { stop: { ...FAR, since: t - 3 * 60_000 } });
  const w = arrivedOf(checkIn);
  const f = PLAN.check(w.when, stopped(ny('21:55')), {});
  assert.equal(f?.text, 'Plan: you arrived at Harbor Inn for "Check in: Harbor Inn" (can\'t be moved, 16:00)');
  assert.equal(w.fallback, 'Harbor Inn: Check in: Harbor Inn. The key is in the lockbox.');
  // The next morning too, and not past the check-out.
  assert.ok(PLAN.check(w.when, stopped(ny('09:00', '2026-11-28')), {}));
  assert.equal(PLAN.check(w.when, stopped(ny('11:01', '2026-11-29')), {}), null);
  // With no check-out on the booking, or no booking, or an item that isn't a stay: 3 hours after the start, as before.
  const { end: _, ...open } = STAYED;
  assert.equal(PLAN.check(arrivedOf(checkIn, open).when, stopped(ny('21:55')), {}), null);
  assert.equal(PLAN.check(arrivedOf({ ...checkIn, item: { ...checkIn.item, booking: undefined } }).when, stopped(ny('21:55')), {}), null);
  assert.equal(PLAN.check(arrivedOf({ ...checkIn, item: { ...checkIn.item, kind: 'meal' } }, { ...STAYED, kind: 'restaurant' }).when, stopped(ny('21:55')), {}), null);
  // A stay item with its own end keeps it.
  const own = arrivedOf({ ...checkIn, item: { ...checkIn.item, end: { at: '2026-11-28T10:00:00-05:00', tz: NY } } });
  assert.equal(own.when.end, ny('10:00', '2026-11-28'));
});

test("a flight item with no coordinates gets its leave reminder half an hour before the time to be at the airport, as a flight with no position does (it got only \"In 15 min\" as it departed)", () => {
  const day = '2026-11-29';
  const bare = { path: '/plan/f.json', item: { title: 'UA 123 home', kind: 'flight', fixed: true, start: { at: iso('14:05', day), tz: LA }, booking: '/trip/bookings/flight.json' } };
  const ws = planWatches(/** @type {any} */ ([bare]), BOOKINGS, { fallbackTz: LA });
  assert.deepEqual(ws.map((w) => w.id), ['plan:f:leave', 'plan:f:coming-up']);
  const leave = /** @type {any} */ (ws[0]).when;
  // 14:05 less the 2 hours is 12:05; half an hour before it, 11:35, wherever the traveller is: there is no airport to count a drive to.
  assert.equal(PLAN.next?.(leave, moment({ now: at('08:00', day) }), {}), at('11:35', day));
  assert.equal(PLAN.next?.(leave, here(off(MONTEREY, 0, 25_000), at('08:00', day)), {}), at('11:35', day));
  assert.equal(PLAN.check(leave, moment({ now: at('11:34', day) }), {}), null);
  const f = PLAN.check(leave, here(MONTEREY, at('11:35', day)), {});
  assert.equal(f?.fallback, 'Leave soon: Flight UA 123 departs 14:05.');
  assert.equal(planWords(/** @type {any} */ (f?.say)), 'Leave soon: Flight UA 123 departs 14:05.');
  assert.equal(f?.text, 'Plan: time to leave soon for "UA 123 home" (can\'t be moved, 14:05)');
  assert.equal(PLAN.check(leave, moment({ now: at('12:05', day) }), {}), null); // past the time to be there
  assert.equal(PLAN.describe(leave), '15 min before leaving for "UA 123 home" at 14:05, to be there by 12:05');
  // "Coming up" stays, 15 min before it departs.
  assert.equal(PLAN.next?.(/** @type {any} */ (ws[1]).when, moment(), {}), at('13:50', day));
  // A connection with no coordinates is carried there, as one with them: nothing to leave for.
  const first = { path: '/plan/a.json', item: { title: 'Flight a', kind: 'flight', fixed: true, start: { at: iso('08:00', day), tz: LA }, end: { at: iso('13:00', day), tz: LA }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 } } };
  assert.deepEqual(planWatches(/** @type {any} */ ([first, bare]), BOOKINGS, { fallbackTz: LA }).filter((w) => w.id.startsWith('plan:f:')).map((w) => w.id), ['plan:f:coming-up']);
  // Any other fixed item with no place, a train's too, keeps "coming up" alone; a flexible flight with no place gets nothing, as before.
  const train = { path: '/plan/t.json', item: { title: 'Coast train', kind: 'rail', fixed: true, start: { at: iso('07:00', day), tz: LA } } };
  assert.deepEqual(planWatches(/** @type {any} */ ([train]), new Map(), { fallbackTz: LA }).map((w) => w.id), ['plan:t:coming-up']);
  assert.deepEqual(planWatches(/** @type {any} */ ([{ ...bare, item: { ...bare.item, fixed: false } }]), BOOKINGS, { fallbackTz: LA }).map((w) => w.id), []);
});

test("the push relay holds a flight with no coordinates' leave reminder too, half an hour before the time to be at the airport, on the live engine", async () => {
  const day = '2026-11-28';
  const k = await liveKit({ live: false, plan: { f: { title: 'Flight home', kind: 'flight', fixed: true, start: { at: iso('14:05', day), tz: LA } } } });
  const list = await k.live.reminders();
  assert.deepEqual(list?.filter((r) => r.watch.startsWith('plan:f:')).map((r) => [r.watch, r.due, r.text]), [
    ['plan:f:leave', at('11:35', day), 'Leave soon: Flight home at 14:05.'],
    ['plan:f:coming-up', at('13:50', day), 'In 15 min: Flight home at 14:05.'],
  ]);
  k.live.dispose();
});
