import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJourney, takenAt } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { record } from '../../src/core/agent/log.js';
import { liveKit, at, iso, off, LA, BIXBY, NEPENTHE, HEARST, RIVER_INN } from './live-kit.js';
import { MORNING } from './after-kit.js';

const PLAN = {
  bixby: { title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } },
  hearst: { title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } },
  dinner: { title: 'Dinner in Cambria', fixed: false, start: { at: iso('19:30'), tz: LA } },
};

/** A trip with the morning's road, arrivals, a card, words typed and spoken, and photos. */
async function aTrip() {
  const k = await liveKit({ live: false, plan: PLAN });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } }, p.at);
  await logEvent(k.store, k.trip, { type: 'location', data: { lat: 'broken' } }, at('09:01'));
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'w-1', type: 'arrived' } }, at('09:33'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in **1932**.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: 'not a card' } }, at('09:35'));
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', `Look! ${'x'.repeat(2500)}`]], now: at('09:36') });
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h1' } }, at('09:40'));
  await logEvent(k.store, k.trip, { type: 'heard.text', data: { of: 'h1', text: 'Is that the bridge?' } }, at('09:40'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h2', dismissed: true, text: 'chatter in the back' } }, at('09:41'));
  await logEvent(k.store, k.trip, { type: 'heard', data: { id: 'h3' } }, at('09:42')); // its words never came
  await k.ws.write(k.trip, '/files/2026-11-27-0945.webp', new Uint8Array([1, 2, 3]), { author: 'user', type: 'image/webp', meta: { taken: '2026-11-27T09:45:00', width: 4000, height: 3000, place: { lat: BIXBY.lat, lng: BIXBY.lng } } });
  await k.ws.write(k.trip, '/files/notes.pdf', new Uint8Array([4]), { author: 'user', type: 'application/pdf' });
  return k;
}

test("a trip's journey: the road as stays and moves, named; stamps; cards; words typed and spoken; photos; in time order (spec §13)", async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip, namer: (p) => (Math.abs(p.lat - HEARST.lat) < 0.01 ? { name: 'not this one', m: 10 } : null) });
  assert.equal(j.tz, LA);
  assert.equal(j.title, 'Big Sur');
  assert.equal(j.points.length, MORNING.length);
  const kinds = j.entries.map((e) => e.kind);
  assert.deepEqual(kinds, ['move', 'stay', 'card', 'said', 'said', 'photo', 'move', 'stay']);
  const [, bixby, card, typed, spoken, photo, , castle] = /** @type {any[]} */ (j.entries);
  assert.equal(bixby.name, 'Bixby Creek Bridge'); // named by its arrival
  assert.equal(bixby.stamp?.name, 'Bixby Creek Bridge');
  assert.equal(castle.name, 'Hearst Castle'); // a plan place within 300 m comes before the namer
  assert.equal(castle.stamp, null); // no arrival fired there
  assert.deepEqual(card.card, { title: 'Bixby Creek Bridge', text: 'Built in **1932**.' });
  assert.match(typed.text, /^Look! x{2500}$/); // a long message's words are read from where they are stored
  assert.deepEqual([spoken.text, spoken.spoken], ['Is that the bridge?', true]);
  assert.deepEqual([photo.path, photo.at, photo.width, photo.type], ['/files/2026-11-27-0945.webp', at('09:45'), 4000, 'image/webp']);
  assert.deepEqual(j.stamps.map((s) => s.name), ['Bixby Creek Bridge']);
  assert.deepEqual(j.days, ['2026-11-27']);
  assert.equal(j.from, MORNING[0].at);
  assert.equal(j.to, at('18:15'));
  assert.deepEqual(j.plan.map((p) => [p.title, p.visited, p.place?.name ?? null]), [
    ['Bixby Bridge photo stop', true, 'Bixby Creek Bridge'], ['Hearst Castle tour', false, 'Hearst Castle'], ['Dinner in Cambria', false, null]]);
});

test('a stay with no arrival and no plan place is named by the namer; a trip with nothing in its log is an empty journey', async () => {
  const k = await liveKit({ live: false });
  for (const [p, t] of /** @type {const} */ ([[RIVER_INN, '10:00'], [off(RIVER_INN, 20, 0), '10:30'], [NEPENTHE, '10:45']])) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng } }, at(t));
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip, namer: (p) => (Math.abs(p.lat - RIVER_INN.lat) < 0.001 ? { name: 'Big Sur River Inn', m: 30 } : null) });
  assert.equal(/** @type {any} */ (j.entries.find((e) => e.kind === 'stay'))?.name, 'Big Sur River Inn');
  const empty = await liveKit({ live: false });
  const none = await readJourney({ store: empty.store, ws: empty.ws, trip: empty.trip });
  assert.deepEqual([none.points, none.entries, none.stamps, none.from, none.to, none.days], [[], [], [], null, null, []]);
});

test("when a photo was taken: with its offset, or the wall clock where it was taken read in the trip's zone", () => {
  assert.equal(takenAt('2026-11-27T09:45:00-08:00', 'UTC'), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('2026-11-27T09:45:00', LA), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('2026-11-27T09:45', LA), Date.parse('2026-11-27T17:45:00Z'));
  assert.equal(takenAt('yesterday', LA), null);
  assert.equal(takenAt(undefined, LA), null);
});

test('an arrival the road shows no stay for is still in the timeline; live mode turned off ends the last stay there (spec §13)', async () => {
  const k = await liveKit({ live: false });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA] }, { author: 'user' });
  const evening = [{ ...HEARST, at: at('18:15') }, { ...off(HEARST, 3000, -3000), at: at('18:20') }, { ...off(HEARST, 6000, -6000), at: at('18:25') }];
  for (const p of evening) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng } }, p.at);
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name: 'Cambria Pines Lodge', ...off(HEARST, 6000, -6000) } } }, at('18:27'));
  const open = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const arrived = /** @type {any} */ (open.entries.find((e) => e.kind === 'stay'));
  assert.deepEqual([arrived?.name, arrived?.at, arrived?.to, arrived?.stamp?.name], ['Cambria Pines Lodge', at('18:27'), at('18:27'), 'Cambria Pines Lodge']);
  await logEvent(k.store, k.trip, { type: 'state', data: { live: 'off' } }, at('19:30'));
  const closed = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const stays = closed.entries.filter((e) => e.kind === 'stay');
  assert.equal(stays.length, 1);
  assert.deepEqual([/** @type {any} */ (stays[0]).name, stays[0].at, /** @type {any} */ (stays[0]).to], ['Cambria Pines Lodge', at('18:25'), at('19:30')]);
});
