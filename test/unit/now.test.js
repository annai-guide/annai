import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRows } from '../../src/core/plan.js';
import { upcoming, routeStrip, sunPlace } from '../../src/core/now.js';
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
