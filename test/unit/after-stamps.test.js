import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampsOf, stampLabel, isArrival, stampCount } from '../../src/core/after/stamps.js';
import { meters } from '../../src/core/live/geo.js';
import { liveKit, at, iso, LA, MONTEREY, RIVER_INN, NEPENTHE, MCWAY } from './live-kit.js';

const fired = (/** @type {string} */ hhmm, /** @type {any} */ data, day = '2026-11-27') => ({ ts: at(hhmm, day), data });
const place = (/** @type {string | undefined} */ name, /** @type {{ lat: number, lng: number }} */ p) => ({ ...(name ? { name } : {}), lat: p.lat, lng: p.lng });

test('each arrival at a named place earns a stamp, one a place a day, oldest first (spec §13)', () => {
  const log = [
    fired('11:00', { type: 'plan', event: 'linger', place: place('Big Sur River Inn', RIVER_INN) }),
    fired('09:40', { type: 'plan', event: 'arrived', watch: 'plan:nepenthe:arrived', place: place('Nepenthe', NEPENTHE) }),
    fired('09:41', { type: 'arrived', place: place('Nepenthe', NEPENTHE) }), // the same visit, by Shiori's watch
    fired('10:30', { type: 'arrived', place: place(undefined, MCWAY) }), // nowhere named: no stamp
    fired('11:30', { type: 'plan', event: 'leave', place: place('Hearst Castle', MCWAY) }), // not an arrival
    fired('08:00', { type: 'plan', event: 'arrived', place: place('Nepenthe', NEPENTHE) }, '2026-11-28'), // the next day: another
    { ts: at('12:00'), data: { type: 'arrived', place: { name: 'Broken', lat: 'x', lng: 1 } } },
    { ts: at('12:01') }, { ts: at('12:02'), data: null },
  ];
  assert.deepEqual(stampsOf(log, LA).map((s) => [s.name, s.plan, new Date(s.at).toISOString()]), [
    ['Nepenthe', true, '2026-11-27T17:40:00.000Z'],
    ['Big Sur River Inn', false, '2026-11-27T19:00:00.000Z'],
    ['Nepenthe', true, '2026-11-28T16:00:00.000Z'],
  ]);
  assert.equal(isArrival({ type: 'plan', event: 'late' }), false);
  assert.equal(isArrival(undefined), false);
});

test("a stamp's words: the first word, two when the first is short, two characters of a Japanese name", () => {
  assert.equal(stampLabel('Bixby Creek Bridge'), 'Bixby');
  assert.equal(stampLabel('Big Sur River Inn'), 'Big Sur');
  assert.equal(stampLabel('San Simeon pier'), 'San Simeon');
  assert.equal(stampLabel('伏見稲荷大社'), '伏見');
  assert.equal(stampLabel('Cambria Pines Lodge'), 'Cambria');
  assert.equal(stampLabel('Llanfairpwllgwyngyll'), 'Llanfairpwll');
  assert.equal(stampLabel('Kiyomizu-dera'), 'Kiyomizu'); // a hyphen parts words too
  assert.equal(stampLabel('  '), '');
});

test('live mode names an arrival as it fires: a plan place within 300 m, else a place the offline pack names (spec §13)', async () => {
  const k = await liveKit({ plan: { nepenthe: { title: 'Dinner at Nepenthe', fixed: false, start: { at: iso('16:00'), tz: LA }, place: { name: 'Nepenthe', ...NEPENTHE } } } });
  k.live.namers.push((p) => (meters(p, RIVER_INN) <= 500 ? { name: 'Big Sur River Inn', m: meters(p, RIVER_INN) } : null));
  await k.live.setWatch(k.trip, { when: { type: 'arrived', minutes: 5 }, repeat: true, fallback: 'Here.' });
  await k.drive(MONTEREY, RIVER_INN, at('09:00'), at('09:40'));
  await k.stay(RIVER_INN, at('09:40'), at('09:50'));
  await k.drive(RIVER_INN, NEPENTHE, at('09:50'), at('10:00'));
  await k.stay(NEPENTHE, at('10:00'), at('10:10'));
  await k.drive(NEPENTHE, MCWAY, at('10:10'), at('10:25'));
  await k.stay(MCWAY, at('10:25'), at('10:35'));
  const names = (await k.events(['trigger.fired'])).filter((e) => e.data.type === 'arrived').map((e) => e.data.place.name ?? null);
  assert.deepEqual(names, ['Big Sur River Inn', 'Nepenthe', null]);
});

test("stamps in words, and a trip's stamps read from its log for its card (spec §13: never stored)", async () => {
  assert.equal(stampCount(1), '1 stamp');
  assert.equal(stampCount(5), '5 stamps');
  const k = await liveKit({ live: false });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  const { logEvent } = await import('../../src/core/events.js');
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: place('Nepenthe', NEPENTHE) } }, at('12:00'));
  const { tripStamps } = await import('../../src/ui/stamps.js');
  assert.deepEqual((await tripStamps({ store: k.store, ws: k.ws }, k.trip)).map((s) => s.name), ['Nepenthe']);
});
