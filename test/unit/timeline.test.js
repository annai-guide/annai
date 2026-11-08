import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf, timelineRows, dayOfTrip, FOLD_OVER, RECENT_DAYS } from '../../src/core/timeline.js';
import { dayIn, nextDay } from '../../src/core/time.js';

const noon = Date.parse('2026-11-27T12:00:00-08:00'), LA = 'America/Los_Angeles';

test('phaseOf by dates in the zone', () => {
  assert.equal(phaseOf({}, noon, LA), 'undated');
  assert.equal(phaseOf(null, noon, LA), 'undated');
  assert.equal(phaseOf({ end: '2026-11-27' }, noon, LA), 'undated');
  assert.equal(phaseOf({ start: '2026-11-28' }, noon, LA), 'future');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-25', end: '2026-11-26' }, noon, LA), 'past');
  assert.equal(phaseOf({ start: '2026-11-27' }, noon, LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26' }, noon, LA), 'past');
});

test('the last evening of a trip is still the trip, by the zone given', () => {
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), LA), 'happening');
  assert.equal(phaseOf({ start: '2026-11-26', end: '2026-11-27' }, Date.parse('2026-11-28T07:00:00Z'), 'Asia/Tokyo'), 'past');
});

test('nextDay is the next midnight, through a day with no midnight', () => {
  assert.equal(nextDay(noon, LA), Date.parse('2026-11-28T00:00:00-08:00'));
  const t = nextDay(Date.parse('2026-03-07T12:00:00-05:00'), 'America/Havana');
  assert.ok(t > Date.parse('2026-03-07T12:00:00-05:00'));
  assert.equal(dayIn(t, 'America/Havana'), '2026-03-08');
});

test('nextDay crosses a month and a year, and from the last second of a day is the next second', () => {
  assert.equal(nextDay(Date.parse('2026-12-31T23:59:59Z'), 'UTC'), Date.parse('2027-01-01T00:00:00Z'));
});

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = noon;
const noonOn = (/** @type {string} */ d) => Date.parse(`${d}T12:00:00-08:00`);
/** A chat's record. @param {string} id @param {{ talked?: number | null, created?: number }} [o] */
const chat = (id, o = {}) => /** @type {any} */ ({ id, kind: 'trip', title: id, status: 'active', created: o.created ?? now - 2 * HOUR, updated: now, format: 1, talked: o.talked ?? null });
/** A dated trip's record. @param {string} id @param {string} start @param {string} [end] */
const trip = (id, start, end) => /** @type {any} */ ({ ...chat(id), start, ...(end ? { end } : {}) });
const rows = (/** @type {any[]} */ l) => timelineRows(l, now, LA);
const ids = (/** @type {any[]} */ entries) => entries.flatMap((e) => (e.row ? [e.row.id] : e.fold ? e.fold.rows.map((/** @type {any} */ r) => r.id) : []));

test('where each sits', () => {
  const r = rows([
    chat('talked', { talked: now - 3 * HOUR, created: now - 10 * DAY }),
    chat('never', { created: now - 5 * HOUR }),
    trip('past', '2026-11-01', '2026-11-05'),
    trip('pastday', '2026-11-10'),
    trip('now', '2026-11-26', '2026-11-28'),
    trip('later', '2026-12-10', '2026-12-12'),
  ]);
  const at = Object.fromEntries([...r.above.filter((e) => e.row).map((e) => e.row), ...r.happening, ...r.below].map((x) => [x.id, x]));
  assert.equal(at.talked.at, now - 3 * HOUR);
  assert.equal(at.never.at, now - 5 * HOUR);
  assert.equal(at.past.at, noonOn('2026-11-05'), 'a past trip at its end');
  assert.equal(at.pastday.at, noonOn('2026-11-10'), 'else its start');
  assert.equal(at.now.phase, 'happening');
  assert.equal(at.later.at, noonOn('2026-12-10'));
  assert.deepEqual(r.happening.map((x) => x.id), ['now']);
  assert.deepEqual(r.below.map((x) => x.id), ['later']);
  assert.deepEqual(ids(r.above), ['past', 'pastday', 'never', 'talked']);
});

test('old to new; only dated trips sit below now', () => {
  const r = rows([chat('a', { talked: now - HOUR }), trip('f', '2027-01-01', '2027-01-05')]);
  assert.deepEqual(r.below.map((x) => x.id), ['f']);
  assert.ok(r.above.some((e) => e.row?.id === 'a'));
  // A chat stamped after now (a clock that ran ahead) still sits above.
  const ahead = rows([chat('b', { talked: now + DAY }), trip('g', '2026-11-30')]);
  assert.deepEqual(ahead.below.map((x) => x.id), ['g']);
  assert.deepEqual(ids(ahead.above), ['b']);
});

test('a card is dated, so an old undated trip with files is a line', () => {
  const r = rows([chat('old', { created: now - 200 * DAY }), trip('t', '2026-11-01', '2026-11-03')]);
  const all = [...r.above.flatMap((e) => (e.row ? [e.row] : [])), ...r.happening, ...r.below];
  assert.deepEqual(all.map((x) => [x.id, x.card]), [['old', false], ['t', true]]);
});

test('overlapping trips are just rows, in order', () => {
  const r = rows([trip('b', '2026-11-26', '2026-11-30'), trip('a', '2026-11-20', '2026-11-28'), trip('c', '2026-11-27')]);
  assert.deepEqual(r.happening.map((x) => x.id), ['a', 'b', 'c']);
  const later = rows([trip('y', '2026-12-05', '2026-12-20'), trip('x', '2026-12-01', '2026-12-10')]);
  assert.deepEqual(later.below.map((x) => x.id), ['x', 'y']);
});

test('the last 30 days have day headings, before that month headings', () => {
  const r = rows([chat('today', { talked: now - HOUR }), chat('yesterday', { talked: now - DAY }), chat('old', { talked: noonOn('2026-09-15') })]);
  const heads = r.above.filter((e) => e.heading).map((e) => [e.heading.kind, e.heading.key]);
  assert.deepEqual(heads, [['month', '2026-09'], ['day', '2026-11-26'], ['day', '2026-11-27']]);
  assert.deepEqual(r.above.map((e) => e.heading?.key ?? e.row?.id), ['2026-09', 'old', '2026-11-26', 'yesterday', '2026-11-27', 'today']);
});

test('a month before the last 30 days with over three chats folds; three stay; cards never fold', () => {
  const oct = (/** @type {number} */ d) => noonOn(`2026-10-${String(d).padStart(2, '0')}`);
  const r = rows([
    chat('o1', { talked: oct(2) }), chat('o2', { talked: oct(3) }), chat('o3', { talked: oct(5) }), chat('o4', { talked: oct(7) }),
    trip('card', '2026-10-04', '2026-10-06'),
    chat('s1', { talked: noonOn('2026-09-02') }), chat('s2', { talked: noonOn('2026-09-03') }), chat('s3', { talked: noonOn('2026-09-04') }),
  ]);
  const fold = r.above.find((e) => e.fold);
  assert.equal(fold?.fold.month, '2026-10');
  assert.deepEqual(fold?.fold.rows.map((/** @type {any} */ x) => x.id), ['o1', 'o2', 'o3', 'o4']);
  assert.ok(r.above.some((e) => e.row?.id === 'card'), 'the card outside it');
  assert.ok(r.above.some((e) => e.heading?.key === '2026-10'), 'a month with a card keeps its heading');
  assert.deepEqual(r.above.filter((e) => e.row && e.row.id.startsWith('s')).map((e) => e.row.id), ['s1', 's2', 's3'], 'three stay');
  assert.equal(r.above.filter((e) => e.fold).length, 1);
  // Only chats: the fold names the month, with no heading of its own.
  const only = rows([chat('a', { talked: oct(2) }), chat('b', { talked: oct(3) }), chat('c', { talked: oct(4) }), chat('d', { talked: oct(5) })]);
  assert.deepEqual(only.above.map((e) => (e.fold ? 'fold' : e.heading ? 'heading' : 'row')), ['fold']);
  assert.ok(FOLD_OVER === 3 && RECENT_DAYS === 30);
});

test('dayOfTrip', () => {
  assert.deepEqual(dayOfTrip({ start: '2026-11-25', end: '2026-12-02' }, noonOn('2026-11-27'), LA), { day: 3, of: 8 });
  assert.equal(dayOfTrip({ start: '2026-11-25' }, noonOn('2026-11-27'), LA), null);
  assert.equal(dayOfTrip({ start: '2026-11-28', end: '2026-12-02' }, noonOn('2026-11-27'), LA), null, 'not yet');
  assert.deepEqual(dayOfTrip({ start: '2026-10-30', end: '2026-11-02' }, noonOn('2026-11-01'), LA), { day: 3, of: 4 }, 'across a clock change and a month');
});
