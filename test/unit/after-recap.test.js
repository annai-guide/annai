import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recapText, recapPhotos, writeRecap, recapError, RECAP_SYSTEM, RECAP_CHARS } from '../../src/core/after/recap.js';
import { AllFailedError } from '../../src/core/llm/fallback.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { readJourney } from '../../src/core/after/journey.js';
import { logEvent } from '../../src/core/events.js';
import { agentKit, fakeCodec } from './agent-kit.js';
import { at, iso, LA, BIXBY, HEARST } from './live-kit.js';
import { MORNING } from './after-kit.js';
import { saveModel } from '../../src/core/llm/config.js';

const RECAP = '# Big Sur, Thanksgiving\n\n## Friday, November 27\n\nBixby Bridge in the morning sun.';

/** A trip on a memory annai with the morning's road, a stamp, words, a card, a note and photos; a scripted utility model writes the recap. */
async function aTrip(/** @type {any[]} */ utility = [{ text: RECAP }], /** @type {any} */ o = {}) {
  const k = await agentKit([[{ text: '' }]], { utility, ...o });
  await k.ws.patch(k.trip, '/trip.json', { timezones: [LA], start: '2026-11-27', end: '2026-11-28', party: [{ name: 'Alex', driver: true }, { name: 'Sam', age: 12, interests: ['tide pools'] }] }, { author: 'user' });
  await k.ws.write(k.trip, '/plan/bixby.json', { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: iso('09:45'), tz: LA }, place: { name: 'Bixby Creek Bridge', ...BIXBY } }, { author: 'user' });
  await k.ws.write(k.trip, '/plan/hearst.json', { id: 'hearst', title: 'Hearst Castle tour', fixed: true, start: { at: iso('16:30'), tz: LA }, place: { name: 'Hearst Castle', ...HEARST } }, { author: 'user' });
  for (const p of MORNING) await logEvent(k.store, k.trip, { type: 'location', data: { lat: p.lat, lng: p.lng, accuracy: 8 } }, p.at);
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { watch: 'plan:bixby:arrived', type: 'plan', event: 'arrived', place: { name: 'Bixby Creek Bridge', ...BIXBY } } }, at('09:32'));
  await logEvent(k.store, k.trip, { type: 'out.show', data: { card: { title: 'Bixby Creek Bridge', text: 'Built in 1932.' } } }, at('09:35'));
  await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: 'Sam wants to see the sea lions.' } }, at('09:36'));
  await k.ws.write(k.trip, '/notes/day1.md', '# Day 1\nThe fog lifted at ten.\n', { author: 'shiori' });
  for (let i = 0; i < 8; i++) {
    await k.ws.write(k.trip, `/files/2026-11-27-10${i}0.jpg`, new TextEncoder().encode('3000x2000'), { author: 'user', type: 'image/jpeg', meta: { taken: `2026-11-27T10:${i}0:00`, width: 3000, height: 2000 } });
  }
  return k;
}

test('the recap is written from the journey in words and lists, never the raw track (spec §13, §4.7, choice 4)', async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const text = recapText(j, { profile: '# Profile\n- What to call me: Alex', memory: '# Trip memory\n- Sam is vegetarian', notes: [{ path: '/trip/notes/day1.md', text: 'The fog lifted at ten.' }] });
  assert.match(text, /^# Big Sur\n/);
  assert.match(text, /Times are local, in America\/Los_Angeles\./);
  assert.match(text, /Travel party: Alex, driver; Sam, age 12, likes tide pools\./);
  assert.match(text, /2026-11-27\t09:2\d\t09:5\d\tstayed\tBixby Creek Bridge\t\tyes/);
  assert.match(text, /\tdrove \(partly unseen: the phone was locked or annai closed\)\t/);
  assert.match(text, /stayed\tHearst Castle/);
  assert.match(text, /2026-11-27 09:35\tShiori \(card\)\tBixby Creek Bridge: Built in 1932\./);
  assert.match(text, /2026-11-27 09:36\ttraveler\tSam wants to see the sea lions\./);
  assert.match(text, /Hearst Castle tour\tHearst Castle\tfixed\tno/);
  assert.match(text, /\/trip\/files\/2026-11-27-1000\.jpg/);
  assert.match(text, /The fog lifted at ten\./);
  assert.match(text, /Sam is vegetarian/);
  assert.match(text, /What to call me: Alex/);
  // No location point goes as it is: at most a few positions, for unnamed stays (choice 4).
  assert.ok((text.match(/-121\.\d{3,}/g) ?? []).length <= 2, text);
});

test('a long trip fits the cap: the words are thinned evenly, the road and the stamps stay', async () => {
  const k = await aTrip();
  for (let i = 0; i < 3000; i++) await logEvent(k.store, k.trip, { type: 'msg.user', data: { text: `Message ${i}: ${'blah '.repeat(60)}` } }, at('11:00') + i * 1000);
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  const text = recapText(j);
  assert.ok(text.length <= RECAP_CHARS, String(text.length));
  assert.match(text, /stayed\tBixby Creek Bridge/);
  assert.match(text, /Shiori \(card\)\tBixby Creek Bridge/); // the first line stays…
  assert.match(text, /Message 2999: /); // …and the last
  assert.match(text, /lines left out to fit/);
  assert.ok(!text.includes('blah '.repeat(61)), 'each line is cut to 300 characters');
});

test('six photos at most go with it, spread over the trip', async () => {
  const k = await aTrip();
  const j = await readJourney({ store: k.store, ws: k.ws, trip: k.trip });
  assert.deepEqual(recapPhotos(j).map((p) => p.path), ['/files/2026-11-27-1000.jpg', '/files/2026-11-27-1010.jpg', '/files/2026-11-27-1030.jpg', '/files/2026-11-27-1040.jpg', '/files/2026-11-27-1060.jpg', '/files/2026-11-27-1070.jpg']);
});

test('the utility model writes /trip/recap.md, with request copies of the photos; the log names what was sent (spec §13, §4.8, §4.9)', async () => {
  const k = await aTrip();
  const r = await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip, codec: fakeCodec() });
  assert.equal(r.photos, 6);
  assert.equal(await k.ws.readText(k.trip, '/recap.md'), `${RECAP}\n`);
  assert.equal((await k.ws.read(k.trip, '/recap.md'))?.entry.author, 'shiori');
  const asked = k.requests.at(-1);
  assert.equal(asked.system, RECAP_SYSTEM);
  const parts = asked.messages[0].parts;
  assert.equal(parts.filter((/** @type {any} */ p) => p.type === 'image').length, 6);
  assert.match(parts[1].text, /^Photo \/trip\/files\/2026-11-27-1000\.jpg, 2026-11-27 10:00:$/);
  const [entry] = await k.events(['recap']);
  assert.deepEqual([entry.data.path, entry.data.photos], ['/recap.md', 6]);
  assert.equal(entry.refs.length, 6); // the copies, named (§4.9)
  const [turn] = (await k.events(['model.turn'])).filter((e) => e.data.tag === 'recap');
  assert.ok(turn, 'the call is in the trace');
});

test('no photos go to a model that takes none; a model that answers nothing, or none at all, is a plain error and nothing is written', async () => {
  const k = await aTrip([{ text: RECAP }], { models: [{ input: ['text'] }] });
  await saveModel(k.ws, { id: 'm-u', provider: 'pv-u', ability: 'chat', template: null, user: { providerId: 'model-u', prices: { input: 1, output: 1 }, input: ['text'] }, created: 0 });
  await writeRecap({ store: k.store, ws: k.ws, llm: k.llm, trip: k.trip, codec: fakeCodec() });
  assert.equal(k.requests.at(-1).messages[0].parts.length, 1);

  const empty = await aTrip([{ text: '   ' }]);
  await assert.rejects(writeRecap({ store: empty.store, ws: empty.ws, llm: empty.llm, trip: empty.trip }), /The model sent back an empty recap\. Try again, or put another model first in the utility role \(Settings → Models\)\./);
  assert.equal(await empty.ws.read(empty.trip, '/recap.md'), undefined);
  assert.deepEqual(await empty.events(['recap']), []);

  const none = await agentKit([]);
  await assert.rejects(writeRecap({ store: none.store, ws: none.ws, llm: none.llm, trip: none.trip }), /No model is set up to write the recap\. Add one in Settings → Models\./);
});

test('an arrival whose stay the road doesn\'t show is "arrived" in the recap, not a stay of no time', async () => {
  const k = await aTrip();
  await logEvent(k.store, k.trip, { type: 'location', data: { lat: 35.5641, lng: -121.0807 } }, at('18:40'));
  await logEvent(k.store, k.trip, { type: 'trigger.fired', data: { type: 'plan', event: 'arrived', place: { name: 'Cambria Pines Lodge', lat: 35.5641, lng: -121.0807 } } }, at('18:42'));
  const text = recapText(await readJourney({ store: k.store, ws: k.ws, trip: k.trip }));
  assert.match(text, /2026-11-27\t18:42\t18:42\tarrived\tCambria Pines Lodge\t\tyes/);
});

test("why a recap wasn't written, in plain words with what to do next", () => {
  assert.equal(recapError(new AllFailedError([{ model: 'm', name: 'Haiku', outcome: 'auth', ms: 1, error: 'invalid x-api-key' }])), 'No model could write it: Haiku: invalid x-api-key. Check Settings → Models, then try again.');
  assert.equal(recapError(new AllFailedError([])), 'No model is set for the utility or main role. Add one in Settings → Models.');
  assert.equal(recapError(new ProviderError('rate', 'slow down')), 'The provider says too many requests for now. Try again in a while.');
  assert.equal(recapError(new Error('The model sent back an empty recap.')), 'The model sent back an empty recap.');
});

test('what the Recap screen says goes to the model is true of photos too: one kept as taken can hold where it was taken (review 6)', async () => {
  const { RECAP_SENDS } = /** @type {any} */ (await import('../../src/core/after/recap.js'));
  assert.ok(Array.isArray(RECAP_SENDS) && RECAP_SENDS.length >= 5);
  assert.match(RECAP_SENDS.join('\n'), /rounded to about 100 m\. Never the GPS track itself\./);
  assert.match(RECAP_SENDS.join('\n'), /Up to 6 photos, if the model takes photos\. A photo kept as taken \(Settings → Photos → Keep originals\) can still hold where it was taken\./);
});
