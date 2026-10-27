import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayOf, momentAt, entryLine, routeWords, dayBounds, PLAY_SPEEDS } from '../../src/core/after/replay.js';
import { readJourney } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { liveKit, at, iso, LA, BIXBY, HEARST, NEPENTHE } from './live-kit.js';
import { MORNING } from './after-kit.js';

/** The morning's journey, with an arrival, a card and words, and a day after with one message. */
async function morning() {
  const k = await liveKit({ live: false, plan: { hearst: { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } } } });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng } }, p.at);
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in 1932.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h', text: 'Can we stop at Nepenthe?' } }, at('09:36'));
  await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: 'Good morning!' } }, at('08:00', '2026-11-28'));
  return readJourney({ store: k.store, ws: k.ws, trip: k.trip });
}

test('the whole trip, or a day of it: the drawn route, its entries and stamps, and the route in words (spec §13, §16.5)', async () => {
  const j = await morning();
  const all = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(j));
  assert.equal(all.segments.length, 2); // the phone locked from Nepenthe to Hearst Castle
  assert.equal(all.from, MORNING[0].at);
  assert.equal(all.to, at('08:00', '2026-11-28'));
  assert.ok(all.lengths.every((n) => n >= 0) && all.lengths[0] > 100);
  assert.match(all.words, /^\d+(\.\d)? mi on the road, from Bixby Creek Bridge to Hearst Castle, with 2 stops and 1 stamp\.$/);
  const friday = /** @type {any} */ (replayOf(j, '2026-11-27'));
  assert.equal(friday.entries.some((/** @type {any} */ e) => e.text === 'Good morning!'), false);
  const saturday = /** @type {any} */ (replayOf(j, '2026-11-28'));
  assert.deepEqual([saturday.segments, saturday.entries.length, saturday.km], [[], 1, 0]);
  assert.equal(saturday.words, 'No road was recorded, with 0 stops and 0 stamps.');
  assert.equal(replayOf(j, '2026-12-01'), null);
  assert.deepEqual(dayBounds('2026-11-27', LA), { from: Date.parse('2026-11-27T08:00:00Z'), to: Date.parse('2026-11-28T08:00:00Z') });
  assert.deepEqual(PLAY_SPEEDS.map(([v]) => v), [60, 600, 3600]);
});

test('what was so at a moment: where, the last entry reached, the stamps so far, how much of the route is behind', async () => {
  const r = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(await morning(), '2026-11-27'));
  const before = momentAt(r, at('08:00'));
  assert.deepEqual([before.index, before.where, before.stamps, before.done.every((d) => d === 0)], [-1, 'Not started yet', 0, true]);
  const bridge = momentAt(r, at('09:40'));
  assert.equal(bridge.where, 'At Bixby Creek Bridge');
  assert.equal(bridge.stamps, 1);
  assert.equal(/** @type {any} */ (r.entries[bridge.index]).kind, 'said'); // the words at 09:36 were the last thing reached
  const onTheWay = momentAt(r, at('12:00'));
  assert.equal(onTheWay.where, 'Driving from Bixby Creek Bridge');
  assert.ok(onTheWay.done[0] > 0 && Math.abs(onTheWay.done[0] - r.lengths[0]) < 1, 'the first piece is all behind, held during the jump');
  const [x, y] = /** @type {[number, number]} */ (onTheWay.xy);
  const [nx, ny] = r.map.xy(NEPENTHE);
  assert.ok(Math.abs(x - nx) < 1 && Math.abs(y - ny) < 1, 'held where the jump began');
  assert.equal(momentAt(r, at('17:00')).where, 'At Hearst Castle');
});

test('each timeline entry in a few words', async () => {
  const r = /** @type {import('../../src/core/after/replay.js').Replay} */ (replayOf(await morning(), '2026-11-27'));
  const lines = r.entries.map((e) => entryLine(e, LA));
  assert.match(lines[0].text, /^Drove \d+(\.\d)? mi · 30 min$/);
  assert.match(lines[1].when, /^09:29–09:5\d$/);
  assert.equal(lines[1].text, 'Bixby Creek Bridge · 20 min · stamp');
  assert.deepEqual(lines[2], { when: '09:35', text: 'Shiori: Bixby Creek Bridge' });
  assert.deepEqual(lines[3], { when: '09:36', text: 'You said: Can we stop at Nepenthe?' });
  assert.match(lines[4].text, /^Drove \d+(\.\d)? mi · 6 hr, \d+ min \(partly unseen: the phone was locked\)$/);
  assert.equal(entryLine({ kind: 'photo', at: at('10:00'), path: '/files/2026-11-27-1000.webp', hash: 'h', type: 'image/webp', size: 1, width: null, height: null, place: null }, LA).text, 'Photo 2026-11-27-1000.webp');
  assert.equal(entryLine({ kind: 'stay', at: at('10:00'), to: at('10:30'), lat: 1, lng: 1, name: null, stamp: null }, LA).text, 'A stop · 30 min');
  assert.equal(routeWords({ entries: [], km: 0, stamps: [] }), 'No road was recorded, with 0 stops and 0 stamps.');
  // An arrival the road shows no stay for (7a Task 5): when it came, not a stay of no time.
  const stamp = { name: 'Cambria Pines Lodge', lat: 1, lng: 1, at: at('18:32'), plan: true };
  assert.deepEqual(entryLine({ kind: 'stay', at: at('18:32'), to: at('18:32'), lat: 1, lng: 1, name: 'Cambria Pines Lodge', stamp }, LA), { when: '18:32', text: 'Cambria Pines Lodge · arrived · stamp' });
});
