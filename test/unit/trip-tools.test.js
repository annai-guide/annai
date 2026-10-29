import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { useClock } from './clock.js';
import { tripTools } from '../../src/core/agent/trip-tools.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { createTrip, listTrips, removeTrip, setTripStatus, ME, SYS_WAITING } from '../../src/core/scopes.js';
import { readAppSettings } from '../../src/core/settings.js';
import { readNames } from '../../src/core/names.js';
import { waitingFiles } from '../../src/core/waiting.js';
import { utf8 } from '../../src/core/bytes.js';
import { storedTexts } from '../../src/core/agent/log.js';

const say = (/** @type {string} */ text, /** @type {Record<string, any>} */ more = {}) => ({ ...more, toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const call = (/** @type {string} */ name, /** @type {any} */ input) => ({ toolCalls: [{ name, input }] });
const waitingFlight = { path: '/waiting/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
const PDF = utf8('%PDF-1.4\n% ANNAI AIR AN 123\n');
const START = { title: 'Anchorage · Nov 20–27', start: '2026-11-20', end: '2026-11-27', recap: 'A long weekend in Testville with Sam', files: ['/waiting/files/flight.pdf'] };

/**
 * Shiori as Halves with her trip tools, no trip open, a flight PDF waiting with its short name. @param {any[]} script @param {Record<string, any>} [o]
 */
async function kit(script, o = {}) {
  const k = await agentKit([script], { halves: true, open: false, ...o });
  k.agent.addLoopTools(tripTools(k.agent));
  const pdf = await k.ws.write(SYS_WAITING, '/files/flight.pdf', PDF, { author: 'user', type: 'application/pdf' });
  await k.ws.write(SYS_WAITING, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  await k.agent.open(o.trip === false ? null : o.trip ?? null);
  return { ...k, pdfHash: pdf.hash };
}
/** @param {any} k @param {string} scope @param {string[]} [types] */
const eventsIn = (k, scope, types) => k.store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, types ? { types } : {}));
/** A trip by its title. @param {any} k @param {string} title */
const tripNamed = async (k, title) => (await listTrips(k.store)).active.find((s) => s.title === title);
/** A tool of hers, run as her turn would, in the conversation open now. @param {any} k @param {string} name @param {any} input @param {string} [handover] */
const run = (k, name, input, handover) => k.agent.kokoro.loopTools().find((/** @type {any} */ t) => t.name === name).run(input, {
  id: 'c', scope: k.agent.scope, trip: k.agent.trip, signal: new AbortController().signal, model: null, wake: 'w', author: 'shiori', ...(handover ? { handover } : {}),
});

test("start_trip with no trip open: a trip of Shiori's, with the waiting files in its Files, its conversation starting with the hand-over and her recap; it opens once she is done", async (t) => {
  useClock(t);
  const k = await kit([call('start_trip', START), say('I started Anchorage · Nov 20–27.'), say('Your flight is on Nov 20.')]);
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  const trip = await tripNamed(k, 'Anchorage · Nov 20–27');
  assert.ok(trip);
  const tj = await k.ws.readJSON(trip.id, '/trip.json');
  assert.deepEqual([tj.title, tj.start, tj.end], ['Anchorage · Nov 20–27', '2026-11-20', '2026-11-27']);
  assert.equal((await k.ws.read(trip.id, '/trip.json')).entry.author, 'shiori');
  assert.deepEqual((await k.ws.list(trip.id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  assert.deepEqual(await readNames(k.ws, trip.id), { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' });
  assert.deepEqual(await waitingFiles(k.ws), []);
  const there = await eventsIn(k, trip.id, ['msg.user', 'wake']);
  const copy = there.find((/** @type {any} */ e) => e.type === 'msg.user');
  assert.deepEqual([copy.data.handed[0].path, copy.data.from, copy.data.handover], ['/trip/files/flight.pdf', ME, 'h-1']);
  const recap = there.filter((/** @type {any} */ e) => e.type === 'wake').flatMap((/** @type {any} */ e) => e.data.reasons).find((/** @type {any} */ r) => r.recap);
  assert.deepEqual([recap.kind, recap.recap, recap.handover, recap.files], ['file', 'A long weekend in Testville with Sam', 'h-1', ['/files/flight.pdf']]);
  const [moved] = await eventsIn(k, ME, ['handover.moved']);
  assert.deepEqual(moved.data, { handover: 'h-1', to: trip.id, started: true, count: 1 });
  // It opened, and its own turn took the hand-over up there.
  assert.equal(k.agent.trip, trip.id);
  assert.equal((await readAppSettings(k.ws)).activeTrip, trip.id);
  assert.deepEqual((await eventsIn(k, trip.id, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Your flight is on Nov 20.']);
  // The no-trip conversation keeps its own lines.
  assert.deepEqual((await eventsIn(k, ME, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['I started Anchorage · Nov 20–27.']);
});

test('start_trip while a trip is open: the new trip keeps its files waiting to be read, and the open trip stays open', async (t) => {
  useClock(t);
  const k = await agentKit([[call('start_trip', { title: 'Kyoto · Apr', files: ['/trip/files/temple.pdf'] }), say('That one is for Kyoto: I started a trip for it.')]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.write(k.trip, '/files/temple.pdf', utf8('%PDF temple'), { author: 'user', type: 'application/pdf' });
  k.agent.send('', { handed: [{ path: '/trip/files/temple.pdf', type: 'application/pdf', name: 'temple.pdf', new: true }], handover: 'h-1' });
  await k.agent.idle();
  assert.equal(k.agent.trip, k.trip);
  const kyoto = await tripNamed(k, 'Kyoto · Apr');
  const owed = await Transcript.load(k.store, kyoto.id);
  assert.equal(owed.unanswered, true);
  assert.equal(owed.handover, 'h-1');
  const [wake] = (await eventsIn(k, kyoto.id, ['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'file'));
  assert.deepEqual(wake.data.reasons[0].files, ['/files/temple.pdf']);
  assert.equal(await k.ws.read(k.trip, '/files/temple.pdf'), undefined);
  const result = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'start_trip');
  assert.match(result.data.content ?? '', /doesn't open/);
});

test('start_trip needs only a title; a date that is not one is refused in words', async (t) => {
  useClock(t);
  const k = await kit([call('start_trip', { title: 'Somewhere', start: '20 Nov' }), call('start_trip', { title: 'Just a name' }), say('Started.')]);
  k.agent.send('Start a trip for us');
  await k.agent.idle();
  const [bad, good] = (await eventsIn(k, ME, ['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'start_trip');
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.content, /YYYY-MM-DD/);
  assert.equal(await tripNamed(k, 'Somewhere'), undefined);
  assert.equal(good.data.ok, true);
  const trip = await tripNamed(k, 'Just a name');
  const tj = await k.ws.readJSON(trip.id, '/trip.json');
  assert.equal('start' in tj || 'end' in tj, false);
  // No hand-over: only what she did, written into it.
  assert.deepEqual((await eventsIn(k, trip.id, ['msg.user'])).length, 0);
  assert.equal((await eventsIn(k, trip.id, ['wake'])).length > 0, true);
});

test("list_trips: only the other active trips' ids, titles, dates and places", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  const kyoto = await createTrip(k.ws, { title: 'Kyoto', start: '2027-04-01', end: '2027-04-08', places: ['Kyoto', 'Nara'] });
  await k.ws.write(kyoto, '/notes/temples.md', 'temple notes', { author: 'user' });
  const old = await createTrip(k.ws, { title: 'Old trip' });
  await setTripStatus(k.store, old, 'archived');
  const result = await run(k, 'list_trips', {});
  assert.equal(result, 'id\ttitle\tstart\tend\tplaces\n' + `${kyoto}\tKyoto\t2027-04-01\t2027-04-08\tKyoto, Nara`);
  assert.doesNotMatch(result, /Big Sur|temple notes|Old trip/);
});

test('open_trip with no trip open: the files go to that trip, its conversation gets the hand-over and the recap, and it opens', async (t) => {
  useClock(t);
  const k = await kit([sleep, say('Filed in Anchorage.')]);
  const anchorage = await createTrip(k.ws, { title: 'Anchorage', start: '2026-11-20' });
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  assert.match(await run(k, 'open_trip', { trip: anchorage, recap: 'Thanksgiving', files: ['/waiting/files/flight.pdf'] }, 'h-1'), /opens when you are done/);
  await k.agent.idle();
  assert.equal(k.agent.trip, anchorage);
  assert.deepEqual((await k.ws.list(anchorage, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  const copy = (await eventsIn(k, anchorage, ['msg.user']))[0];
  assert.deepEqual([copy.data.handed[0].path, copy.data.handover], ['/trip/files/flight.pdf', 'h-1']);
  const [moved] = await eventsIn(k, ME, ['handover.moved']);
  assert.deepEqual(moved.data, { handover: 'h-1', to: anchorage, started: false, count: 1 });
  // With a trip open, open_trip is refused: move_file is the way.
  await assert.rejects(run(k, 'open_trip', { trip: anchorage }, 'h-1'), /move_file/);
});

test("move_file: from the open trip into another trip's Files with its short name; that trip waits to read it; this one says where it went", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  await k.ws.write(k.trip, '/files/temple.pdf', utf8('%PDF temple'), { author: 'user', type: 'application/pdf' });
  await k.ws.write(k.trip, '/names.json', { '/files/temple.pdf': 'Temple tickets' }, { author: 'shiori' });
  assert.match(await run(k, 'move_file', { path: '/trip/files/temple.pdf', trip: kyoto }, 'h-1'), /Kyoto/);
  assert.equal(await k.ws.read(k.trip, '/files/temple.pdf'), undefined);
  assert.deepEqual(await readNames(k.ws, kyoto), { '/files/temple.pdf': 'Temple tickets' });
  const owed = await Transcript.load(k.store, kyoto);
  assert.equal(owed.unanswered, true);
  const [wake] = await eventsIn(k, kyoto, ['wake']);
  assert.deepEqual([wake.data.reasons[0].kind, wake.data.reasons[0].files, wake.data.reasons[0].handover], ['file', ['/files/temple.pdf'], 'h-1']);
  const [moved] = await k.events(['handover.moved']);
  assert.deepEqual(moved.data, { handover: 'h-1', to: kyoto, started: false, count: 1 });
  // Refused: to the open trip; a path outside /trip/files/ and /waiting/files/; an archived trip.
  await k.ws.write(k.trip, '/files/b.pdf', utf8('b'), { author: 'user', type: 'application/pdf' });
  await assert.rejects(run(k, 'move_file', { path: '/trip/files/b.pdf', trip: k.trip }), /open trip/);
  await assert.rejects(run(k, 'move_file', { path: '/trip/notes/a.md', trip: kyoto }), /only files in/);
  await setTripStatus(k.store, kyoto, 'archived');
  await assert.rejects(run(k, 'move_file', { path: '/trip/files/b.pdf', trip: kyoto }), /archived/);
  assert.ok(await k.ws.read(k.trip, '/files/b.pdf'));
});

test('a trip she started opens later with its hand-over owed: the turn that takes it up carries the hand-over (the page closed before the open)', async (t) => {
  useClock(t);
  const k = await agentKit([[
    call('start_trip', { title: 'Kyoto · Apr', files: ['/trip/files/temple.pdf'] }), say('Started Kyoto for it.'),
    { toolCalls: [{ name: 'write', input: { path: '/trip/notes/temple.md', content: 'Temple, Apr 3' } }, { name: 'speak', input: { text: 'Filed.' } }, { name: 'sleep', input: {} }] },
  ]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.write(k.trip, '/files/temple.pdf', utf8('%PDF temple'), { author: 'user', type: 'application/pdf' });
  k.agent.send('', { handed: [{ path: '/trip/files/temple.pdf', type: 'application/pdf', name: 'temple.pdf', new: true }], handover: 'h-1' });
  await k.agent.idle();
  const kyoto = await tripNamed(k, 'Kyoto · Apr');
  // annai starts again: a fresh Shiori opens the trip.
  k.agent.hush?.('away');
  const fresh = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  await fresh.open(kyoto.id);
  await fresh.idle();
  const wrote = (await eventsIn(k, kyoto.id, ['file.write'])).find((/** @type {any} */ e) => e.data.path === '/notes/temple.md');
  assert.equal(wrote?.data.handover, 'h-1');
});

test("the user opening another conversation before she is done keeps that one open: openWhenDone doesn't pull them away", async (t) => {
  useClock(t);
  const k = await kit([call('start_trip', START), say('Started.', { delayMs: 80 }), sleep]);
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  const end = Date.now() + 3000;
  while (!(await tripNamed(k, START.title)) && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.agent.trip, k.trip);
});

test('a PDF handed over with no trip open, filed into a trip she started, then the trip removed: no blob of that PDF is left', async (t) => {
  useClock(t);
  const k = await kit([
    call('read', { path: '/waiting/files/flight.pdf' }), call('start_trip', START), say('Started.'),
    { toolCalls: [{ name: 'write', input: { path: '/trip/notes/flight.md', content: 'AS 123, Nov 20' } }, { name: 'speak', input: { text: 'Filed.' } }, { name: 'sleep', input: {} }] },
  ], { utility: [{ text: 'ANNAI AIR AN 123, Nov 20 2026' }], utilityModel: { input: ['text', 'image', 'pdf'] } });
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  const trip = await tripNamed(k, START.title);
  assert.ok(await k.ws.read(trip.id, '/notes/flight.md'));
  assert.equal(await k.store.tx(['blobs'], 'readonly', (/** @type {any} */ x) => x.hasBlob(k.pdfHash)), true);
  await k.agent.open(null);
  await k.agent.idle();
  await removeTrip(k.store, trip.id);
  assert.equal(await k.store.tx(['blobs'], 'readonly', (/** @type {any} */ x) => x.hasBlob(k.pdfHash)), false);
});

// The fix pass: every file is found before anything is made or moved.

test('start_trip naming a file that is not there makes no trip and moves nothing; the retry makes one trip', async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  await assert.rejects(run(k, 'start_trip', { title: 'Anchorage', files: ['/waiting/files/flight.pdf', '/waiting/files/fligth.pdf'] }, 'h-1'), /Nothing was done[\s\S]*fligth\.pdf/);
  assert.equal((await listTrips(k.store)).active.some((s) => s.title === 'Anchorage'), false);
  assert.deepEqual((await waitingFiles(k.ws)).map((f) => f.path), ['/files/flight.pdf']);
  await run(k, 'start_trip', { title: 'Anchorage', files: ['/waiting/files/flight.pdf', '/waiting/files/flight.pdf'] }, 'h-1');
  const made = (await listTrips(k.store)).active.filter((s) => s.title === 'Anchorage');
  assert.equal(made.length, 1);
  assert.deepEqual((await k.ws.list(made[0].id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
});

test("start_trip forgives a path's case, as the files tools do", async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  await run(k, 'start_trip', { title: 'Anchorage', files: ['/waiting/Files/Flight.PDF'] }, 'h-1');
  const trip = await tripNamed(k, 'Anchorage');
  assert.deepEqual((await k.ws.list(trip.id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  // The trip's copy of the user's line shows the file where it is now.
  const copy = (await eventsIn(k, trip.id, ['msg.user']))[0];
  assert.deepEqual(copy.data.handed.map((/** @type {any} */ f) => f.path), ['/trip/files/flight.pdf']);
});

test('open_trip with one good file and one missing moves neither', async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  await assert.rejects(run(k, 'open_trip', { trip: kyoto, files: ['/waiting/files/flight.pdf', '/waiting/files/nope.pdf'] }, 'h-1'), /Nothing was done/);
  assert.deepEqual((await waitingFiles(k.ws)).map((f) => f.path), ['/files/flight.pdf']);
  assert.deepEqual(await k.ws.list(kyoto, '/files/'), []);
});

test("start_trip with no files, a hand-over owed and no trip open, takes the hand-over's waiting files; the copy of a long message keeps its words", async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  const words = `Our trip. ${'We land late and want a quiet hotel near the water. '.repeat(50)}`;
  k.agent.send(words, { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  await run(k, 'start_trip', { title: 'Anchorage' }, 'h-1');
  const trip = await tripNamed(k, 'Anchorage');
  assert.deepEqual((await k.ws.list(trip.id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  assert.deepEqual(await waitingFiles(k.ws), []);
  const copy = (await eventsIn(k, trip.id, ['msg.user']))[0];
  assert.equal(String(copy.data.text ?? (await storedTexts(k.store, copy)).text), words.trim());
  assert.deepEqual(copy.data.handed.map((/** @type {any} */ f) => f.path), ['/trip/files/flight.pdf']);
});

test('start_trip with no hand-over and no files writes no copy of a message: only her line', async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('Start a trip for Kyoto, please');
  await k.agent.idle();
  await run(k, 'start_trip', { title: 'Kyoto' });
  const trip = await tripNamed(k, 'Kyoto');
  assert.deepEqual(await eventsIn(k, trip.id, ['msg.user']), []);
  assert.deepEqual((await waitingFiles(k.ws)).map((f) => f.path), ['/files/flight.pdf']);
});
