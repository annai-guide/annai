import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, rescript, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { tripTools } from '../../src/core/agent/trip-tools.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Transcript, SAID } from '../../src/core/agent/transcript.js';
import { createTrip, listTrips, removeTrip, setTripStatus, ME, SYS_WAITING } from '../../src/core/scopes.js';
import { readAppSettings } from '../../src/core/settings.js';
import { readNames } from '../../src/core/names.js';
import { waitingFiles } from '../../src/core/waiting.js';
import { utf8 } from '../../src/core/bytes.js';
import { storedTexts, record } from '../../src/core/agent/log.js';
import { importCalendar } from '../../src/core/imports.js';
import { undoHandover, handOverText } from '../../src/core/handover.js';
import { dateRange } from '../../src/core/intl.js';

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
/** annai's own cards, collected as they are written. @param {any} k @returns {any[]} */
const cards = (k) => {
  /** @type {any[]} */
  const asks = [];
  k.agent.on('event', (/** @type {any} */ e) => { if (e.type === 'out.ask' && e.data.own) asks.push(e); });
  return asks;
};

test("start_trip with no trip open: a trip of Shiori's, with the waiting files in its Files, its conversation starting with the hand-over and her recap; it opens once she is done", async (t) => {
  useClock(t);
  const k = await kit([call('start_trip', START), say('I started Anchorage · Nov 20–27.'), say('Your flight is on Nov 20.')]);
  /** @type {any[]} */
  const went = [];
  k.agent.on('went', (/** @type {any} */ x) => went.push(x));
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  const trip = await tripNamed(k, 'Anchorage · Nov 20–27');
  assert.ok(trip);
  assert.deepEqual(went, [{ trip: trip.id }], "not the user's own choice: a screen on home stays where it is");
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
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' }); // a trip, not a chat: it may start another
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
  assert.match(result, new RegExp(`^id\ttitle\tstart\tend\tplaces\tlast talked\n${kyoto}\tKyoto\t2027-04-01\t2027-04-08\tKyoto, Nara\t[^\t\n]+$`));
  assert.doesNotMatch(result, /Big Sur|temple notes|Old trip/);
});

test("open_trip with no trip open: annai's card asks first; at Open the files go to that trip, its conversation gets the hand-over and the recap, and it opens", async (t) => {
  useClock(t);
  const k = await kit([sleep, say('Filed in Anchorage.')]);
  const asks = cards(k);
  const anchorage = await createTrip(k.ws, { title: 'Anchorage', start: '2026-11-20' });
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await k.agent.idle();
  const opening = run(k, 'open_trip', { trip: anchorage, recap: 'Thanksgiving', files: ['/waiting/files/flight.pdf'] }, 'h-1');
  await until(() => asks.length === 1);
  assert.deepEqual((await waitingFiles(k.ws)).map((f) => f.path), ['/files/flight.pdf'], 'nothing moved before the answer');
  k.agent.answer(asks[0].data.tap, 'Open');
  assert.match(await opening, /^They chose Open: that conversation is open now/);
  await k.agent.idle();
  assert.equal(k.agent.trip, anchorage);
  assert.deepEqual((await k.ws.list(anchorage, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  const copy = (await eventsIn(k, anchorage, ['msg.user']))[0];
  assert.deepEqual([copy.data.handed[0].path, copy.data.handover], ['/trip/files/flight.pdf', 'h-1']);
  const [moved] = await eventsIn(k, ME, ['handover.moved']);
  assert.deepEqual(moved.data, { handover: 'h-1', to: anchorage, started: false, count: 1 });
  // In a dated trip open_trip is refused: they open the other from Trips.
  await assert.rejects(run(k, 'open_trip', { trip: anchorage }, 'h-1'), /A dated trip is open/);
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
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' }); // a trip, not a chat: it may start another
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

const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:dinner@test.invalid\r\nDTSTART:20261120T180000Z\r\nDTEND:20261120T190000Z\r\nSUMMARY:Dinner in Testville\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:tour@test.invalid\r\nDTSTART:20261121T090000Z\r\nDTEND:20261121T110000Z\r\nSUMMARY:Walking tour\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

test("move_file takes a calendar file's plan items with it, but one the user changed; Undo brings them back", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
  await k.ws.write(k.trip, '/files/dinner.ics', utf8(ICS), { author: 'user', type: 'text/calendar' });
  const planned = await importCalendar(k.ws, k.trip, '/files/dinner.ics', { defaultTz: 'UTC' });
  assert.equal(planned.length, 2);
  const [kept, moving] = planned.sort();
  await k.ws.patch(k.trip, kept, { notes: 'Bring an umbrella' }, { author: 'user' });
  assert.match(await run(k, 'move_file', { path: '/trip/files/dinner.ics', trip: kyoto }, 'h-1'), /1 event/);
  const there = await k.ws.list(kyoto, '/plan/');
  assert.deepEqual(there.map((/** @type {any} */ f) => [f.path, f.source]), [[moving, '/files/dinner.ics']]);
  assert.ok(await k.ws.read(k.trip, kept));
  assert.equal(await k.ws.read(k.trip, moving), undefined);
  // That trip is told its events are on its plan already.
  const [wake] = await eventsIn(k, kyoto, ['wake']);
  assert.match(wake.data.reasons[0].text, /1 of its events/);
  await undoHandover(k.ws, k.trip, 'h-1');
  assert.deepEqual(await k.ws.list(kyoto, '/plan/'), []);
  assert.equal((await k.ws.list(k.trip, '/plan/')).find((/** @type {any} */ f) => f.path === moving)?.source, '/files/dinner.ics');
  assert.ok(await k.ws.read(k.trip, '/files/dinner.ics'));
});

test("a calendar file's move cut off at any point leaves it with its events: both where they were, or both in the trip it went to", async (t) => {
  useClock(t);
  for (let cutAt = 0; cutAt < 4; cutAt++) {
    const k = await agentKit([[sleep]], { halves: true });
    k.agent.addLoopTools(tripTools(k.agent));
    const kyoto = await createTrip(k.ws, { title: 'Kyoto' });
    await k.ws.write(k.trip, '/files/dinner.ics', utf8(ICS), { author: 'user', type: 'text/calendar' });
    assert.equal((await importCalendar(k.ws, k.trip, '/files/dinner.ics', { defaultTz: 'UTC' })).length, 2);
    // The page closes after `left` writes of the move; every later one is lost.
    let left = cutAt;
    const tx = k.store.tx;
    k.store.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => (mode === 'readwrite' && left-- <= 0 ? Promise.reject(new Error('the page closed')) : tx(stores, mode, fn));
    await run(k, 'move_file', { path: '/trip/files/dinner.ics', trip: kyoto }, 'h-1').catch(() => {});
    k.store.tx = tx;
    const here = Boolean(await k.ws.read(k.trip, '/files/dinner.ics'));
    const plans = [(await k.ws.list(k.trip, '/plan/')).length, (await k.ws.list(kyoto, '/plan/')).length];
    assert.deepEqual([here, ...plans], here ? [true, 2, 0] : [false, 0, 2], `cut after ${cutAt}`);
  }
});

test("a waiting calendar file filed into a trip she started is not said to be on its plan: nothing put it there", async () => {
  const text = handOverText([{ path: '/trip/files/dinner.ics', type: 'text/calendar', name: 'dinner.ics', new: true }]);
  assert.doesNotMatch(text, /on the plan already/);
  assert.match(handOverText([{ path: '/trip/files/dinner.ics', type: 'text/calendar', name: 'dinner.ics', new: true, planned: 2 }]), /"\/trip\/files\/dinner\.ics": annai put its 2 events on the plan already/);
});

test('start_trip with no files takes the waiting files of every hand-over its turn took: the flight, then "and the hotel" while she worked', async (t) => {
  useClock(t);
  const k = await kit([{ delayMs: 40, toolCalls: [{ name: 'list_trips', input: {} }] }, call('start_trip', { title: 'Anchorage' }), say('Started Anchorage.'), sleep]);
  await k.ws.write(SYS_WAITING, '/files/hotel.png', utf8('a hotel'), { author: 'user', type: 'image/png' });
  k.agent.send('', { handed: [waitingFlight], handover: 'h-1' });
  await new Promise((r) => setTimeout(r, 10));
  k.agent.send('and the hotel', { handed: [{ path: '/waiting/files/hotel.png', type: 'image/png', name: 'hotel.png', new: true }], handover: 'h-2' });
  await k.agent.idle();
  const trip = await tripNamed(k, 'Anchorage');
  assert.deepEqual((await k.ws.list(trip.id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf', '/files/hotel.png']);
  assert.deepEqual(await waitingFiles(k.ws), []);
  // Each of the user's lines is copied into the trip, with its own files.
  const copies = await eventsIn(k, trip.id, ['msg.user']);
  assert.deepEqual(copies.map((/** @type {any} */ e) => [e.data.handover, e.data.handed.map((/** @type {any} */ f) => f.path)]), [['h-1', ['/trip/files/flight.pdf']], ['h-2', ['/trip/files/hotel.png']]]);
});

test("a waiting calendar file filed by start_trip has its events planned in the trip, and she is told; Undo takes them back", async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  await k.ws.write(SYS_WAITING, '/files/dinner.ics', utf8(ICS), { author: 'user', type: 'text/calendar' });
  k.agent.send('', { handed: [{ path: '/waiting/files/dinner.ics', type: 'text/calendar', name: 'dinner.ics', new: true }], handover: 'h-1' });
  await k.agent.idle();
  await run(k, 'start_trip', { title: 'Testville', timezones: ['America/Anchorage'], files: ['/waiting/files/dinner.ics'] }, 'h-1');
  const trip = await tripNamed(k, 'Testville');
  const plan = await k.ws.list(trip.id, '/plan/');
  assert.equal(plan.length, 2);
  assert.ok(plan.every((/** @type {any} */ f) => f.source === '/files/dinner.ics'));
  const copy = (await eventsIn(k, trip.id, ['msg.user']))[0];
  assert.equal(copy.data.handed[0].planned, 2);
  await undoHandover(k.ws, trip.id, 'h-1');
  assert.deepEqual(await k.ws.list(trip.id, '/plan/'), []);
});

test('start_trip is refused in an undated conversation, and says to patch /trip/trip.json', async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.agent.opening;
  const before = (await listTrips(k.store)).active.length;
  await assert.rejects(run(k, 'start_trip', { title: 'Testville' }), /patch \/trip\/trip\.json/);
  assert.equal((await listTrips(k.store)).active.length, before);
});

test('in a dated trip start_trip works as today', async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' });
  await k.agent.opening;
  await run(k, 'start_trip', { title: 'Testville' });
  assert.ok(await tripNamed(k, 'Testville'));
});

// Timeline stage 6, Moving into a trip, as annai's card (the user's pick of 2026-11-11, "She asks, I tap or say yes"): open_trip works from a
// conversation with no dates, and is refused in a dated trip; it asks with annai's own card, and only the user's Open moves anything.

/** Shiori in a chat (no dates), with her trip tools, and Kyoto, a dated trip of the user's. @param {Record<string, any>} [o] agentKit's */
async function chatKit(o = {}) {
  const k = await agentKit([[sleep]], { halves: true, ...o });
  k.agent.addLoopTools(tripTools(k.agent));
  const kyoto = await createTrip(k.ws, { title: 'Kyoto', start: '2027-04-01', end: '2027-04-08' });
  await k.agent.opening;
  return { ...k, kyoto, asks: cards(k) };
}
/** A file the user handed in the chat. @param {any} k @param {string} name */
const handIn = async (k, name) => {
  await k.ws.write(k.trip, `/files/${name}`, utf8(`%PDF ${name}`), { author: 'user', type: 'application/pdf' });
  return { path: `/trip/files/${name}`, type: 'application/pdf', name, new: true };
};
/** open_trip run as her turn would, its card answered with a tap. @param {any} k @param {any} input @param {string} [handover] @param {string} [option] */
const openBy = async (k, input, handover, option = 'Open') => {
  const n = k.asks.length;
  const out = run(k, 'open_trip', input, handover);
  await until(() => k.asks.length === n + 1);
  k.agent.answer(k.asks[n].data.tap, option);
  return out;
};

test('open_trip is refused in a dated trip, saying they open that trip from Trips, and for the conversation it is in; neither asks or writes anything', async (t) => {
  useClock(t);
  const k = await chatKit();
  k.agent.send("Let's carry on here");
  await k.agent.idle();
  const before = (await eventsIn(k, k.trip)).length;
  await assert.rejects(run(k, 'open_trip', { trip: k.trip }), /this conversation/);
  assert.equal((await eventsIn(k, k.trip)).length, before);
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' });
  await assert.rejects(run(k, 'open_trip', { trip: k.kyoto }), (e) => /** @type {any} */ (e).message === "A dated trip is open, so open_trip doesn't work here: the user can open that trip from Trips and carry on there. (Only to put one of this trip's files into it: move_file.)");
  assert.equal(k.asks.length, 0, 'no card');
  assert.equal(k.agent.trip, k.trip);
  assert.deepEqual(await eventsIn(k, k.kyoto, ['msg.user', 'wake']), []);
});

test("open_trip in a chat with no files named takes the hand-over's fresh files at Open; with files named, only those", async (t) => {
  useClock(t);
  const k = await chatKit();
  const [hotel, tickets] = [await handIn(k, 'hotel.pdf'), await handIn(k, 'tickets.pdf')];
  k.agent.send('Our Kyoto stay', { handed: [hotel, tickets], handover: 'h-1' });
  await k.agent.idle();
  await openBy(k, { trip: k.kyoto }, 'h-1');
  await k.agent.idle(); // their lines go in as Kyoto opens
  assert.deepEqual((await k.ws.list(k.kyoto, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf', '/files/tickets.pdf']);
  assert.deepEqual(await k.ws.list(k.trip, '/files/'), []);
  const copy = (await eventsIn(k, k.kyoto, ['msg.user']))[0];
  assert.deepEqual(copy.data.handed.map((/** @type {any} */ f) => f.path), ['/trip/files/hotel.pdf', '/trip/files/tickets.pdf']);

  const k2 = await chatKit();
  const [a, b] = [await handIn(k2, 'hotel.pdf'), await handIn(k2, 'tickets.pdf')];
  k2.agent.send('Our Kyoto stay', { handed: [a, b], handover: 'h-1' });
  await k2.agent.idle();
  await openBy(k2, { trip: k2.kyoto, files: ['/trip/files/tickets.pdf'] }, 'h-1');
  assert.deepEqual((await k2.ws.list(k2.kyoto, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/tickets.pdf']);
  assert.deepEqual((await k2.ws.list(k2.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
});

test('open_trip in a chat with no hand-over moves no file, and the trip opens at Open', async (t) => {
  useClock(t);
  const k = await chatKit();
  await handIn(k, 'hotel.pdf'); // the chat's own, from before: not handed in this turn
  k.agent.send("Let's carry on in Kyoto");
  await k.agent.idle();
  await openBy(k, { trip: k.kyoto });
  await k.agent.idle();
  assert.equal(k.agent.trip, k.kyoto);
  assert.deepEqual(await k.ws.list(k.kyoto, '/files/'), []);
  assert.deepEqual((await k.ws.list(k.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
});

test("start_trip in a dated trip with a hand-over and no files named moves none, as before: its files stay unless she names them", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' });
  await k.agent.opening;
  const hotel = await handIn(k, 'hotel.pdf');
  k.agent.send('', { handed: [hotel], handover: 'h-1' });
  await k.agent.idle();
  await run(k, 'start_trip', { title: 'Kyoto' }, 'h-1');
  const kyoto = await tripNamed(k, 'Kyoto');
  assert.deepEqual(await k.ws.list(kyoto.id, '/files/'), []);
  assert.deepEqual((await k.ws.list(k.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
});

// What the user sees: the card, then at Open the trip at once with their line and her recap; anything else ends the card, nothing moved.

const RECAP = 'We found the ramen place by the station.';
const ANSWER = 'Here in Kyoto: shall I put the ramen place on the plan?';
/** She answers a question here, then calls open_trip when they ask to carry on there; in Kyoto, told they came, she answers. @param {any} k */
const moving = (k) => rescript(k, { rules: [
  { match: 'You moved the user here', reply: say(ANSWER) },
  { match: 'the user wrote', reply: say('The ramen place is by the station.'), times: 1 },
  { match: 'the user wrote', reply: call('open_trip', { trip: k.kyoto, recap: RECAP }), then: say('We stay here, then.') },
] });
/** Every text of a request's user messages. @param {any} req @returns {string[]} */
const userTexts = (req) => req.messages.filter((/** @type {any} */ m) => m.role === 'user').flatMap((/** @type {any} */ m) => m.parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text));
/** @param {any} k @param {string} id */
const scopeRec = (k, id) => k.store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
/** open_trip's results in a conversation. @param {any} k @param {string} scope */
const openResults = async (k, scope) => (await eventsIn(k, scope, ['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'open_trip').map((/** @type {any} */ e) => e.data.content);

test("Open, tapped: Kyoto opens at the tap, with the user's line, her recap below it and one answer of hers; the chat ends saying where they went, and owes nothing when opened again", async (t) => {
  useClock(t);
  const k = await chatKit();
  await moving(k);
  /** @type {any[]} */
  const went = [];
  k.agent.on('went', (/** @type {any} */ x) => went.push(x));
  k.agent.send('Where was the ramen place in Kyoto?');
  await k.agent.idle();
  assert.equal((await scopeRec(k, k.kyoto)).talked, null, 'nobody talked in Kyoto yet');
  k.agent.send("Let's carry on in Kyoto");
  await until(() => k.asks.length === 1);
  const question = `Carry on in Kyoto, ${dateRange('2027-04-01', '2027-04-08')}?`;
  assert.deepEqual([k.asks[0].actor, k.asks[0].data.question, k.asks[0].data.options], ['system', question, ['Open', 'Not now']]);
  // Nothing moves, and nothing is written there, before the answer.
  assert.equal(k.agent.target, k.trip);
  assert.deepEqual(await eventsIn(k, k.kyoto, ['msg.user', 'wake']), []);
  k.agent.answer(k.asks[0].data.tap, 'Open');
  await until(() => k.agent.target === k.kyoto);
  assert.deepEqual(went, [{ trip: k.kyoto, chose: true }], "the user's own choice: from home the screen follows");
  await k.agent.idle();
  assert.equal(k.agent.trip, k.kyoto);
  assert.equal((await readAppSettings(k.ws)).activeTrip, k.kyoto);
  // Kyoto: exactly the user's last line, copied as theirs (from the chat), then her recap below it, both in one turn; then her one answer.
  const there = await eventsIn(k, k.kyoto, ['msg.user', 'heard', 'wake', 'out.speak']);
  assert.deepEqual(there.map((/** @type {any} */ e) => [e.type, e.data.text ?? e.data.reasons.map((/** @type {any} */ r) => r.recap ?? r.kind).join()]), [
    ['wake', 'user'], ['msg.user', "Let's carry on in Kyoto"], ['wake', RECAP], ['out.speak', ANSWER],
  ]);
  assert.equal(there[1].data.from, k.trip);
  assert.equal(new Set(there.slice(0, 3).map((/** @type {any} */ e) => e.data.id ?? e.data.wake)).size, 1, 'one wake: one turn');
  // With no files, annai's own line (a cue), so the screen says nothing of files added; no restart wake ("you haven't answered") either.
  assert.equal(there[2].data.reasons[0].kind, 'cue');
  const kyotos = k.requests.filter((/** @type {any} */ r) => JSON.stringify(r.messages).includes('You moved the user here'));
  assert.equal(kyotos.length, 1, 'one request there, her answer');
  assert.doesNotMatch(JSON.stringify(kyotos[0]), /haven't answered this yet|annai restarted/);
  // The copy is the user's talking there: Kyoto's row moves to now.
  assert.equal(typeof (await scopeRec(k, k.kyoto)).talked, 'number');
  // She reads the line as the user's, and the recap as hers, in annai's line below it: never as the user's words.
  const sent = userTexts(kyotos[0]);
  assert.ok(sent.includes("Let's carry on in Kyoto"));
  const recap = sent.filter((x) => x.includes(RECAP));
  assert.equal(recap.length, 1);
  assert.match(recap[0], /^\[annai\] You moved the user here from another conversation, "Big Sur", to carry on here: their line from there is above\. Your recap/);
  assert.ok(sent.indexOf("Let's carry on in Kyoto") < sent.indexOf(recap[0]), 'their line, then the recap');
  assert.ok(!sent.includes('Where was the ramen place in Kyoto?') && !sent.some((x) => x.includes('by the station.') && !x.includes(RECAP)), 'nothing else of the chat');
  // The chat stays, its lines all there, then the card, its answer, and its own line saying where they went; nothing of hers after it.
  const chat = await eventsIn(k, k.trip, ['msg.user', 'out.speak', 'out.ask', 'conversation.moved', 'handover.moved', 'paused']);
  assert.deepEqual(chat.map((/** @type {any} */ e) => [e.type, e.data.text ?? e.data.question ?? e.data]), [
    ['msg.user', 'Where was the ramen place in Kyoto?'], ['out.speak', 'The ramen place is by the station.'], ['msg.user', "Let's carry on in Kyoto"],
    ['out.ask', question], ['msg.user', 'Open'], ['conversation.moved', { to: k.kyoto, title: 'Kyoto' }],
  ]);
  // The move is what the call was for: its result says they chose Open, a success and no cut (the Trace shows it so), and the chat's own line
  // about the move is its conversation's last record.
  const results = (await eventsIn(k, k.trip, ['tool.result'])).map((/** @type {any} */ e) => [e.data.name, e.data.content, e.data.ok, e.data.cut]);
  assert.deepEqual(results.filter(([name]) => name === 'open_trip'), [['open_trip', 'They chose Open: that conversation is open now, and you answer them there; this one stays.', true, false]]);
  assert.equal((await eventsIn(k, k.trip, [...SAID])).at(-1).type, 'conversation.moved');
  // Her turn there was let go at the tap, settled: nothing is taken up when the chat is opened again.
  assert.deepEqual((await eventsIn(k, k.trip, ['error'])).map((/** @type {any} */ e) => [e.data.kind, e.data.quiet]), [['left', true]]);
  assert.equal((await Transcript.load(k.store, k.trip)).unanswered, false);
  const before = k.requests.length;
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal(k.requests.length, before, 'nobody wakes in the chat');
  // A later turn there reads where they went.
  await rescript(k, { rules: [{ match: 'the user wrote', reply: say('Back in the chat.') }] });
  k.agent.send('And the museum?');
  await k.agent.idle();
  assert.ok(userTexts(k.requests.at(-1)).some((x) => /^\[annai\] The user carried this conversation on in "Kyoto": their line and your recap went there, where you answer them\. Nothing of it is left to do here\.$/.test(x)));
});

for (const how of /** @type {const} */ (['Not now', 'a typed line', 'a Stop', 'Start fresh', 'another conversation'])) {
  test(`the card ended by ${how}: nothing moved, nothing was written into Kyoto, and the chat has no line of a move`, async (t) => {
    useClock(t);
    const k = await chatKit();
    await rescript(k, { rules: [
      { match: 'the user wrote', reply: call('open_trip', { trip: k.kyoto, recap: RECAP }), then: say('We stay here, then.'), times: 1 },
      { match: '.', reply: sleep },
    ] });
    const other = await createTrip(k.ws, { title: 'Museum day' });
    let went = 0;
    k.agent.on('went', () => { went++; });
    const hotel = await handIn(k, 'hotel.pdf');
    k.agent.send("Let's carry on in Kyoto", { handed: [hotel], handover: 'h-1' });
    await until(() => k.asks.length === 1);
    if (how === 'Not now') k.agent.answer(k.asks[0].data.tap, 'Not now');
    else if (how === 'a typed line') k.agent.send('No, wait, stay here');
    else if (how === 'a Stop') k.agent.stopKokoro();
    else if (how === 'Start fresh') await k.agent.startFresh();
    else await k.agent.open(other);
    await k.agent.idle();
    assert.equal(k.agent.kokoro.pendingId, null, 'the card ended');
    assert.equal(k.agent.trip, how === 'another conversation' ? other : k.trip);
    assert.equal(went, 0);
    assert.notEqual((await readAppSettings(k.ws)).activeTrip, k.kyoto);
    assert.deepEqual(await eventsIn(k, k.kyoto, ['msg.user', 'heard', 'wake']), [], 'nothing written there');
    assert.deepEqual(await k.ws.list(k.kyoto, '/files/'), [], 'nothing moved');
    assert.deepEqual((await k.ws.list(k.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
    assert.deepEqual(await eventsIn(k, k.trip, ['conversation.moved', 'handover.moved']), []);
    const [result] = await openResults(k, k.trip);
    assert.equal(result, {
      'Not now': 'The user tapped Not now: they stay here, and nothing moved. Carry on here, and don\'t call open_trip for "Kyoto" again unless they ask. Start no trip for the files unless they ask.',
      'a typed line': 'Not opened: only a tap on annai\'s card takes them into "Kyoto"; this card is closed, and nothing moved. If they meant yes, tell them only a tap answers it, and call open_trip again. The user wrote: No, wait, stay here',
      'a Stop': 'Stopped by the user.',
      'Start fresh': 'Stopped by the user.',
      'another conversation': 'Not answered: the user opened another conversation; what they say next may answer it.',
    }[how]);
  });
}

test("a reminder's turn that calls open_trip shows the card, and nothing moves while it waits; the user's tap is what moves them, whoever's turn asked", async (t) => {
  useClock(t);
  const k = await chatKit();
  await rescript(k, { rules: [{ match: 'a watch fired', reply: call('open_trip', { trip: k.kyoto, recap: RECAP }) }, { match: 'You moved the user here', reply: say(ANSWER) }] });
  k.agent.wake({ kind: 'trigger', text: 'a watch fired', fallbacks: [{ watch: 'w1', text: 'Leave for the station.' }] });
  await until(() => k.asks.length === 1);
  await new Promise((r) => setTimeout(r, 300)); // a while: nothing moves by itself
  assert.equal(k.agent.target, k.trip);
  assert.equal(k.agent.kokoro.pendingId, k.asks[0].data.tap, 'the card waits');
  assert.deepEqual(await eventsIn(k, k.kyoto, ['msg.user', 'wake']), []);
  k.agent.answer(k.asks[0].data.tap, 'Open');
  await k.agent.idle();
  assert.equal(k.agent.trip, k.kyoto);
  assert.deepEqual((await eventsIn(k, k.kyoto, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), [ANSWER]);
  // The reminder its turn owed is shown in the chat at the cut, once.
  assert.deepEqual((await eventsIn(k, k.trip, ['reminder'])).map((/** @type {any} */ e) => e.data.text), ['Leave for the station.']);
});

for (const how of ['removed', 'archived']) {
  test(`the trip ${how} while its card waits: Open says so, nothing moves, and the chat stays open with every line`, async (t) => {
    useClock(t);
    const k = await chatKit();
    await moving(k);
    let went = 0;
    k.agent.on('went', () => { went++; });
    k.agent.send('Where was the ramen place in Kyoto?');
    await k.agent.idle();
    k.agent.send("Let's carry on in Kyoto");
    await until(() => k.asks.length === 1);
    if (how === 'removed') await removeTrip(k.store, k.kyoto);
    else await setTripStatus(k.store, k.kyoto, 'archived');
    k.agent.answer(k.asks[0].data.tap, 'Open');
    await k.agent.idle();
    assert.equal(k.agent.trip, k.trip, 'the chat is still the one open');
    assert.equal(went, 0);
    assert.notEqual((await readAppSettings(k.ws)).activeTrip, k.kyoto);
    assert.match((await openResults(k, k.trip))[0], how === 'removed' ? /There is no trip/ : /"Kyoto" is archived/);
    assert.deepEqual(await eventsIn(k, k.trip, ['conversation.moved']), []);
    assert.deepEqual(await eventsIn(k, k.kyoto, ['msg.user', 'wake']), []);
  });
}

test("the user's last line is what they said last: a heard line counts, one set aside doesn't, nor an answer to annai's card; a line typed in other words while it showed does; one with no words yet goes as no copy, the recap still going", async (t) => {
  useClock(t);
  const k = await chatKit();
  const heard = (/** @type {string} */ id, /** @type {Record<string, any>} */ more) => record(k.store, k.trip, { type: 'heard', actor: 'user', data: { id, ...more } });
  k.agent.send('Is it far?');
  await k.agent.idle();
  await heard('h1', { text: 'Take me to Kyoto' });
  await heard('h2', { text: 'turn left here', dismissed: true });
  /** The move, and back to the chat. @param {string} to */
  const move = async (to) => {
    await openBy(k, { trip: to, recap: RECAP });
    await k.agent.idle();
    assert.equal(k.agent.trip, to);
    await k.agent.open(k.trip);
    await k.agent.idle();
  };
  await move(k.kyoto);
  assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['Take me to Kyoto'], 'not "Open"');
  // Its words written down later count too (heard.text).
  const tokyo = await createTrip(k.ws, { title: 'Tokyo', start: '2027-05-01' });
  await heard('h3', {});
  await record(k.store, k.trip, { type: 'heard.text', actor: 'system', data: { of: 'h3', text: 'And then Tokyo' } });
  await move(tokyo);
  assert.deepEqual((await eventsIn(k, tokyo, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['And then Tokyo']);
  // A line typed while a card showed, in its own words, is theirs: it ended that card, and the next move copies it.
  const osaka = await createTrip(k.ws, { title: 'Osaka', start: '2027-06-01' });
  const n = k.asks.length;
  const unanswered = run(k, 'open_trip', { trip: tokyo, recap: RECAP });
  await until(() => k.asks.length === n + 1);
  k.agent.send('Actually, Osaka first');
  assert.match(String(await unanswered), /^Not opened: .* The user wrote: Actually, Osaka first$/);
  await k.agent.idle();
  await move(osaka);
  assert.deepEqual((await eventsIn(k, osaka, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['Actually, Osaka first']);
  // No words yet: no copy, and nothing in its place; her recap goes.
  const nara = await createTrip(k.ws, { title: 'Nara', start: '2027-07-01' });
  await heard('h4', {});
  await openBy(k, { trip: nara, recap: RECAP });
  await k.agent.idle();
  assert.deepEqual(await eventsIn(k, nara, ['msg.user']), []);
  assert.ok((await eventsIn(k, nara, ['wake'])).some((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.recap === RECAP)));
});

test("a hand-over and a line after it, then the move: the hand-over's message with its files, then the last line, in order", async (t) => {
  useClock(t);
  const k = await chatKit();
  const hotel = await handIn(k, 'hotel.pdf');
  k.agent.send('Our hotel', { handed: [hotel], handover: 'h-1' });
  k.agent.send("and let's carry on in Kyoto");
  await k.agent.idle();
  await openBy(k, { trip: k.kyoto, recap: RECAP }, 'h-1');
  await k.agent.idle();
  const copies = await eventsIn(k, k.kyoto, ['msg.user']);
  assert.deepEqual(copies.map((/** @type {any} */ e) => [e.data.text, e.data.handed?.map((/** @type {any} */ f) => f.path) ?? null, e.data.handover ?? null]), [
    ['Our hotel', ['/trip/files/hotel.pdf'], 'h-1'], ["and let's carry on in Kyoto", null, null],
  ]);
  // The files went too: both lines say so in the chat, where Undo finds the trip.
  assert.deepEqual((await eventsIn(k, k.trip, ['handover.moved', 'conversation.moved'])).map((/** @type {any} */ e) => [e.type, e.data]), [
    ['handover.moved', { handover: 'h-1', to: k.kyoto, started: false, count: 1 }], ['conversation.moved', { to: k.kyoto, title: 'Kyoto' }],
  ]);
});

for (const word of ['yes', 'Nope']) {
  test(`"${word}" typed to the card, and not a tap, is the card's answer and not their last line: the line before it is what the next move copies`, async (t) => {
    useClock(t);
    const k = await chatKit();
    k.agent.send("Let's carry on in Kyoto");
    await k.agent.idle();
    const n = k.asks.length;
    const unanswered = run(k, 'open_trip', { trip: k.kyoto, recap: RECAP });
    await until(() => k.asks.length === n + 1);
    k.agent.send(word); // typed: annai's card takes a tap, or a word it hears, and a typed yes opens nothing
    assert.match(String(await unanswered), new RegExp(`^Not opened: .* The user wrote: ${word}$`));
    await k.agent.idle();
    await openBy(k, { trip: k.kyoto, recap: RECAP });
    await k.agent.idle();
    assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ["Let's carry on in Kyoto"]);
  });
}

test("a second open_trip copies no line an earlier move carried, and one said after that move goes", async (t) => {
  useClock(t);
  const k = await chatKit();
  const tokyo = await createTrip(k.ws, { title: 'Tokyo', start: '2027-05-01' });
  const nara = await createTrip(k.ws, { title: 'Nara', start: '2027-06-01' });
  k.agent.send("Let's carry on in Kyoto");
  await k.agent.idle();
  await openBy(k, { trip: k.kyoto, recap: RECAP });
  await k.agent.idle();
  await k.agent.open(k.trip);
  await k.agent.idle();
  // Back in the chat with nothing new from them (a reminder's turn, or her own call): Tokyo gets her recap, and no copy of that line.
  await openBy(k, { trip: tokyo, recap: RECAP });
  await k.agent.idle();
  assert.deepEqual(await eventsIn(k, tokyo, ['msg.user']), []);
  assert.ok((await eventsIn(k, tokyo, ['wake'])).some((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.recap === RECAP)));
  await k.agent.open(k.trip);
  await k.agent.idle();
  k.agent.send('And Nara, later');
  await k.agent.idle();
  await openBy(k, { trip: nara, recap: RECAP });
  await k.agent.idle();
  assert.deepEqual((await eventsIn(k, nara, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['And Nara, later']);
});

test("a Stop in the moment after Open: nothing opens, and what is written into the trip is in order, their line and then her recap", async (t) => {
  useClock(t);
  const k = await chatKit();
  k.agent.send("Let's carry on in Kyoto");
  await k.agent.idle();
  const stop = new AbortController();
  const opening = k.agent.kokoro.loopTools().find((/** @type {any} */ x) => x.name === 'open_trip').run({ trip: k.kyoto, recap: RECAP }, {
    id: 'c', scope: k.agent.scope, trip: k.agent.trip, signal: stop.signal, model: null, wake: 'w', author: 'shiori',
  });
  await until(() => k.asks.length === 1);
  k.agent.answer(k.asks[0].data.tap, 'Open');
  stop.abort(); // before the files have moved
  await opening;
  await k.agent.idle();
  assert.equal(k.agent.target, k.trip, 'nothing opened');
  assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user', 'wake'])).map((/** @type {any} */ e) => e.data.text ?? e.data.reasons.map((/** @type {any} */ r) => r.recap ?? r.kind).join()), [
    'user', "Let's carry on in Kyoto", RECAP,
  ]);
});

test("open_trip's description says annai asks, so she doesn't ask or announce the move", async (t) => {
  useClock(t);
  const k = await chatKit();
  const tool = k.agent.kokoro.loopTools().find((/** @type {any} */ x) => x.name === 'open_trip');
  assert.match(tool.description, /annai asks them itself with its own card[^.]* so don't ask them first or say you are taking them: call it/);
});
