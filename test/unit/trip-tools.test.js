import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, rescript, until, raw, holdAtDoor, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { tripTools } from '../../src/core/agent/trip-tools.js';
import { Agent } from '../../src/core/agent/loop.js';
import { Transcript, SAID } from '../../src/core/agent/transcript.js';
import { createTrip, listTrips, removeTrip, setTripStatus } from '../../src/core/scopes.js';
import { readAppSettings, updateAppSettings } from '../../src/core/settings.js';
import { readNames } from '../../src/core/names.js';
import { utf8 } from '../../src/core/bytes.js';
import { storedTexts, record } from '../../src/core/agent/log.js';
import { importCalendar } from '../../src/core/imports.js';
import { undoHandover, handOverText } from '../../src/core/handover.js';
import { dateRange } from '../../src/core/intl.js';
import { StorageFullError } from '../../src/core/errors.js';

const say = (/** @type {string} */ text, /** @type {Record<string, any>} */ more = {}) => ({ ...more, toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const call = (/** @type {string} */ name, /** @type {any} */ input) => ({ toolCalls: [{ name, input }] });
const handedFlight = { path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true };
const PDF = utf8('%PDF-1.4\n% ANNAI AIR AN 123\n');

/**
 * Shiori as Halves with her trip tools, a dated trip open (start_trip works there; since timeline stage 7 no turn runs with none open), a flight PDF in its
 * Files with its short name. @param {any[]} script @param {Record<string, any>} [o]
 */
async function kit(script, o = {}) {
  const k = await agentKit([script], { halves: true, ...o });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' });
  const pdf = await k.ws.write(k.trip, '/files/flight.pdf', PDF, { author: 'user', type: 'application/pdf' });
  await k.ws.write(k.trip, '/names.json', { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20' }, { author: 'shiori' });
  return { ...k, pdfHash: pdf.hash };
}
/** The open trip's files. @param {any} k */
const tripFiles = async (k) => (await k.ws.list(k.trip, '/files/')).map((/** @type {any} */ f) => f.path);
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

test('start_trip while a trip is open: the new trip keeps its files waiting to be read, and the open trip stays open', async (t) => {
  useClock(t);
  const k = await agentKit([[call('start_trip', { title: 'Kyoto · Apr', files: ['/trip/files/temple.pdf'] }), say('That one is for Kyoto: I started a trip for it.')]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' }); // a trip, not a chat: it may start another
  await k.ws.write(k.trip, '/files/temple.pdf', utf8('%PDF temple'), { author: 'user', type: 'application/pdf' });
  k.agent.send('', { handed: [{ path: '/trip/files/temple.pdf', type: 'application/pdf', name: 'temple.pdf', new: true }], handover: 'h-1' });
  await idleAtOnce(k);
  assert.equal(k.agent.trip, k.trip);
  const kyoto = await tripNamed(k, 'Kyoto · Apr');
  const owed = await Transcript.load(k.store, kyoto.id);
  assert.equal(owed.unanswered, true);
  assert.equal(owed.handover, 'h-1');
  const [wake] = (await eventsIn(k, kyoto.id, ['wake'])).filter((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.kind === 'file'));
  assert.deepEqual(wake.data.reasons[0].files, ['/files/temple.pdf']);
  assert.equal(await k.ws.read(k.trip, '/files/temple.pdf'), undefined);
  const result = (await k.events(['tool.result'])).find((/** @type {any} */ e) => e.data.name === 'start_trip');
  assert.match(result.data.content ?? '', /Its files: .*It doesn't open\. Its files wait to be read there\. Tell the user where they went\./);
});

test('start_trip needs only a title; a date that is not one is refused in words', async (t) => {
  useClock(t);
  const k = await agentKit([[call('start_trip', { title: 'Somewhere', start: '20 Nov' }), call('start_trip', { title: 'Just a name' }), say('Started.')]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' }); // a trip, not a chat: it may start another
  k.agent.send('Start a trip for us');
  await idleAtOnce(k);
  const [bad, good] = (await eventsIn(k, k.trip, ['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'start_trip');
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.content, /YYYY-MM-DD/);
  assert.equal(await tripNamed(k, 'Somewhere'), undefined);
  assert.equal(good.data.ok, true);
  // No file moved, so it says none wait there.
  assert.match(good.data.content, /doesn't open\.$/);
  assert.doesNotMatch(good.data.content, /files wait|Tell the user where/);
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
  assert.deepEqual(moved.data, { handover: 'h-1', wake: 'w', to: kyoto, started: false, count: 1 }); // the wake of the turn that moved it, as her lines carry it
  // Refused: to the open trip; a path outside /trip/files/; an archived trip.
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
  await idleAtOnce(k);
  const kyoto = await tripNamed(k, 'Kyoto · Apr');
  // annai starts again: a fresh Shiori opens the trip.
  k.agent.hush?.('away');
  const fresh = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, timeZone: () => 'UTC', secondMs: 10 });
  await fresh.open(kyoto.id);
  await idleAtOnce({ agent: fresh });
  const wrote = (await eventsIn(k, kyoto.id, ['file.write'])).find((/** @type {any} */ e) => e.data.path === '/notes/temple.md');
  assert.equal(wrote?.data.handover, 'h-1');
});

// The fix pass: every file is found before anything is made or moved.

test('start_trip naming a file that is not there makes no trip and moves nothing; the retry makes one trip', async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('', { handed: [handedFlight], handover: 'h-1' });
  await idleAtOnce(k);
  await assert.rejects(run(k, 'start_trip', { title: 'Anchorage', files: ['/trip/files/flight.pdf', '/trip/files/fligth.pdf'] }, 'h-1'), /Nothing was done[\s\S]*fligth\.pdf/);
  assert.equal((await listTrips(k.store)).active.some((s) => s.title === 'Anchorage'), false);
  assert.deepEqual(await tripFiles(k), ['/files/flight.pdf']);
  await run(k, 'start_trip', { title: 'Anchorage', files: ['/trip/files/flight.pdf', '/trip/files/flight.pdf'] }, 'h-1');
  const made = (await listTrips(k.store)).active.filter((s) => s.title === 'Anchorage');
  assert.equal(made.length, 1);
  assert.deepEqual((await k.ws.list(made[0].id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
});

test("start_trip forgives a path's case, as the files tools do", async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('', { handed: [handedFlight], handover: 'h-1' });
  await idleAtOnce(k);
  await run(k, 'start_trip', { title: 'Anchorage', files: ['/trip/Files/Flight.PDF'] }, 'h-1');
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
  await k.ws.update(k.trip, '/trip.json', ({ start: _s, end: _e, ...rest }) => rest, { author: 'user' }); // no dates: a chat, where open_trip works
  await assert.rejects(run(k, 'open_trip', { trip: kyoto, files: ['/trip/files/flight.pdf', '/trip/files/nope.pdf'] }, 'h-1'), /Nothing was done/);
  assert.deepEqual(await tripFiles(k), ['/files/flight.pdf']);
  assert.deepEqual(await k.ws.list(kyoto, '/files/'), []);
});

test("start_trip with the hand-over's file named: the copy of a long message keeps its words", async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  const words = `Our trip. ${'We land late and want a quiet hotel near the water. '.repeat(50)}`;
  k.agent.send(words, { handed: [handedFlight], handover: 'h-1' });
  await idleAtOnce(k);
  await run(k, 'start_trip', { title: 'Anchorage', files: ['/trip/files/flight.pdf'] }, 'h-1');
  const trip = await tripNamed(k, 'Anchorage');
  assert.deepEqual((await k.ws.list(trip.id, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/flight.pdf']);
  assert.deepEqual(await tripFiles(k), []);
  const copy = (await eventsIn(k, trip.id, ['msg.user']))[0];
  assert.equal(String(copy.data.text ?? (await storedTexts(k.store, copy)).text), words.trim());
  assert.deepEqual(copy.data.handed.map((/** @type {any} */ f) => f.path), ['/trip/files/flight.pdf']);
});

test('start_trip with no hand-over and no files writes no copy of a message: only her line', async (t) => {
  useClock(t);
  const k = await kit([sleep]);
  k.agent.send('Start a trip for Kyoto, please');
  await idleAtOnce(k);
  await run(k, 'start_trip', { title: 'Kyoto' });
  const trip = await tripNamed(k, 'Kyoto');
  assert.deepEqual(await eventsIn(k, trip.id, ['msg.user']), []);
  assert.deepEqual(await tripFiles(k), ['/files/flight.pdf']);
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

test("a calendar file filed into a trip she started is not said to be on its plan unless annai put its events there", async () => {
  const text = handOverText([{ path: '/trip/files/dinner.ics', type: 'text/calendar', name: 'dinner.ics', new: true }]);
  assert.doesNotMatch(text, /on the plan already/);
  assert.match(handOverText([{ path: '/trip/files/dinner.ics', type: 'text/calendar', name: 'dinner.ics', new: true, planned: 2 }]), /"\/trip\/files\/dinner\.ics": annai put its 2 events on the plan already/);
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
  await idleAtOnce(k);
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
  await idleAtOnce(k);
  await openBy(k, { trip: k.kyoto }, 'h-1');
  await idleAtOnce(k); // their lines go in as Kyoto opens
  assert.deepEqual((await k.ws.list(k.kyoto, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf', '/files/tickets.pdf']);
  assert.deepEqual(await k.ws.list(k.trip, '/files/'), []);
  const copy = (await eventsIn(k, k.kyoto, ['msg.user']))[0];
  assert.deepEqual(copy.data.handed.map((/** @type {any} */ f) => f.path), ['/trip/files/hotel.pdf', '/trip/files/tickets.pdf']);

  const k2 = await chatKit();
  const [a, b] = [await handIn(k2, 'hotel.pdf'), await handIn(k2, 'tickets.pdf')];
  k2.agent.send('Our Kyoto stay', { handed: [a, b], handover: 'h-1' });
  await idleAtOnce(k2);
  await openBy(k2, { trip: k2.kyoto, files: ['/trip/files/tickets.pdf'] }, 'h-1');
  assert.deepEqual((await k2.ws.list(k2.kyoto, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/tickets.pdf']);
  assert.deepEqual((await k2.ws.list(k2.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
});

test('open_trip in a chat with no hand-over moves no file, and the trip opens at Open', async (t) => {
  useClock(t);
  const k = await chatKit();
  await handIn(k, 'hotel.pdf'); // the chat's own, from before: not handed in this turn
  k.agent.send("Let's carry on in Kyoto");
  await idleAtOnce(k);
  await openBy(k, { trip: k.kyoto });
  await idleAtOnce(k);
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
  await idleAtOnce(k);
  await run(k, 'start_trip', { title: 'Kyoto' }, 'h-1');
  const kyoto = await tripNamed(k, 'Kyoto');
  assert.deepEqual(await k.ws.list(kyoto.id, '/files/'), []);
  assert.deepEqual((await k.ws.list(k.trip, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf']);
  // Nothing of the hand-over was copied (no words, its file not moved), so her cue doesn't say a message of theirs is above (H1-1, fix round 2).
  assert.deepEqual(await eventsIn(k, kyoto.id, ['msg.user']), [], 'no copy of the hand-over');
  const [wake] = await eventsIn(k, kyoto.id, ['wake']);
  assert.equal(wake.data.reasons[0].text, "You started this trip from another trip's conversation.");
});

test("start_trip with a hand-over that has words says their message is above; open_trip's cue says what they handed only when something of it was copied", async (t) => {
  useClock(t);
  const k = await agentKit([[sleep]], { halves: true });
  k.agent.addLoopTools(tripTools(k.agent));
  await k.ws.patch(k.trip, '/trip.json', { start: '2026-11-20', end: '2026-11-27' }, { author: 'user' });
  await k.agent.opening;
  const hotel = await handIn(k, 'hotel.pdf');
  k.agent.send('Our Kyoto stay', { handed: [hotel], handover: 'h-1' });
  await idleAtOnce(k);
  await run(k, 'start_trip', { title: 'Kyoto' }, 'h-1');
  const kyoto = await tripNamed(k, 'Kyoto');
  const cueOf = (await eventsIn(k, kyoto.id, ['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).find((/** @type {any} */ r) => /You started this trip/.test(r.text ?? ''));
  assert.equal(cueOf.text, "You started this trip from another trip's conversation, for what the user handed you there (their message is above).");
  assert.equal((await eventsIn(k, kyoto.id, ['msg.user'])).length, 1);
  // open_trip: a hand-over of words-less files she doesn't move copies nothing, so the cue doesn't say they handed anything there, nor that a line is above.
  const c = await chatKit();
  const [tickets, other] = [await handIn(c, 'tickets.pdf'), await handIn(c, 'other.pdf')];
  c.agent.send('', { handed: [tickets], handover: 'h-1' });
  await idleAtOnce(c);
  await openBy(c, { trip: c.kyoto, files: [other.path] }, 'h-1');
  await idleAtOnce(c);
  assert.deepEqual(await eventsIn(c, c.kyoto, ['msg.user']), [], 'no copy of the hand-over');
  const cue = (await eventsIn(c, c.kyoto, ['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons).find((/** @type {any} */ r) => /You moved the user here/.test(r.text ?? ''));
  assert.match(cue.text, /^You moved the user here from another conversation, ".*", to carry on here\./);
  assert.doesNotMatch(cue.text, /handed|above/);
});

// What the user sees: the card, then at Open the trip at once with their line and her recap; anything else ends the card, nothing moved.

const RECAP = 'We found the ramen place by the station.';
const NOT_SAVED = "Something for Shiori wasn't saved";
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
  await idleAtOnce(k);
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
  assert.deepEqual(went, [{ trip: k.kyoto }], 'a trip opened on the user\'s own choice: from home the screen follows');
  await idleAtOnce(k);
  assert.equal(k.agent.trip, k.kyoto);
  assert.equal((await readAppSettings(k.ws)).activeTrip, k.kyoto);
  // Kyoto: exactly the user's last line, copied as theirs (from the chat), then her recap below it, both in one turn; then her one answer.
  const there = await eventsIn(k, k.kyoto, ['msg.user', 'heard', 'wake', 'out.speak']);
  assert.deepEqual(there.map((/** @type {any} */ e) => [e.type, e.data.text ?? e.data.reasons.map((/** @type {any} */ r) => r.recap ?? r.kind).join()]), [
    ['wake', 'user'], ['msg.user', "Let's carry on in Kyoto"], ['wake', RECAP], ['out.speak', ANSWER],
  ]);
  assert.equal(there[1].data.from, k.trip);
  assert.equal(new Set(there.slice(0, 3).map((/** @type {any} */ e) => e.data.id ?? e.data.wake)).size, 1, 'one wake: one turn');
  // With no files, annai's own line, of its own kind (not a cue, which a restart reads as Try again's), so the screen says nothing of files added; no restart wake ("you haven't answered") either.
  assert.equal(there[2].data.reasons[0].kind, 'move');
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
  // The chat stays, its lines all there, then the card, its answer, and its own line saying where they went, with the wake of her turn that moved
  // them; nothing of hers after it.
  const chat = await eventsIn(k, k.trip, ['msg.user', 'out.speak', 'out.ask', 'conversation.moved', 'handover.moved', 'paused']);
  const turn = (await eventsIn(k, k.trip, ['wake'])).filter((/** @type {any} */ e) => !e.data.meanwhile).at(-1).data.id;
  assert.deepEqual(chat.map((/** @type {any} */ e) => [e.type, e.data.text ?? e.data.question ?? e.data]), [
    ['msg.user', 'Where was the ramen place in Kyoto?'], ['out.speak', 'The ramen place is by the station.'], ['msg.user', "Let's carry on in Kyoto"],
    ['out.ask', question], ['msg.user', 'Open'], ['conversation.moved', { to: k.kyoto, title: 'Kyoto', wake: turn }],
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
  await idleAtOnce(k);
  assert.equal(k.requests.length, before, 'nobody wakes in the chat');
  // A later turn there reads where they went.
  await rescript(k, { rules: [{ match: 'the user wrote', reply: say('Back in the chat.') }] });
  k.agent.send('And the museum?');
  await idleAtOnce(k);
  assert.ok(userTexts(k.requests.at(-1)).some((x) => /^\[annai\] The user carried this conversation on in "Kyoto": their line and your recap went there, where you answer them\. Nothing of it is left to do here\.$/.test(x)));
});

// Open tapped, and the store refuses from carryOn on: an open that fails says so as the one the user asks for from Trips does ("That conversation
// didn't open", tellNotOpen's words), the storage card in its place on a full phone; one whose reads work opens, and her turn there is what stops. The
// chat's line of a move is written whether or not the open worked (it says where the lines went, and links to that conversation): on a full phone its own
// write is refused, and told (quiet-writes-next: nobody waits on it once her call has ended).
for (const [how, which] of /** @type {const} */ ([['reads and writes refused (Chromium at no byte free)', 'everything'], ['reads refused (any other failed open)', 'reads'], ['writes refused, reads fine (WebKit on a full disk)', 'all']])) {
  test(`Open tapped, the store refusing ${how}: ${which === 'all' ? 'Kyoto opens, and her turn there stops' : `a card says that conversation didn't open and carries the error (its words are the note that they couldn't be checked: the store refuses that read too); the screens were told of the move, and the chat stays the one open${which === 'reads' ? ', with its line of the move' : ''}`}`, async (t) => {
    useClock(t);
    const k = await chatKit();
    await rescript(k, { rules: [
      { match: 'the user wrote', reply: call('open_trip', { trip: k.kyoto, recap: RECAP }), then: say('We stay here, then.') },
      { match: '.', reply: sleep },
    ] });
    const store = refusing(k);
    const own = raw(k); // each half's own cards: Halves drops a repeat of the card before it, which would hide a keep told twice
    /** @type {any[]} */
    const went = [];
    k.agent.on('went', (/** @type {any} */ x) => went.push(x));
    const carry = k.agent.carryOn.bind(k.agent);
    /** @type {Promise<void>} */
    let carried = Promise.resolve();
    k.agent.carryOn = (/** @type {any[]} */ ...a) => {
      store.full(which);
      carried = carry(...a);
      return carried;
    };
    k.agent.send("Let's carry on in Kyoto");
    await until(() => k.asks.length === 1);
    k.agent.answer(k.asks[0].data.tap, 'Open');
    await until(() => went.length === 1);
    assert.deepEqual(went, [{ trip: k.kyoto }]);
    const NOT_OPEN = "That conversation didn't open";
    if (which === 'all') {
      await until(() => k.notices.some((/** @type {any} */ n) => n.title === 'Shiori stopped'));
      // The first "Shiori stopped" is the chat's turn: Kyoto's own open may still be running (Halves drops its identical card), so wait for it to settle.
      let settled = false;
      k.agent.kokoro.opening.catch(() => {}).finally(() => { settled = true; });
      await until(() => settled);
      assert.equal(k.agent.trip, k.kyoto, 'an open only reads');
      assert.equal(k.notices.some((/** @type {any} */ n) => n.title === NOT_OPEN), false);
    } else {
      await until(() => k.notices.some((/** @type {any} */ n) => n.title === NOT_OPEN));
      const card = k.notices.find((/** @type {any} */ n) => n.title === NOT_OPEN);
      assert.equal(card.error?.name, 'UnknownError', 'the refused read, carried for the card');
      // Its words: the store refuses the read that checks them for keys too, so the card says so in their place (spec §9.9).
      assert.equal(card.body, "annai couldn't check this message for keys, so it is not shown.");
      await until(() => k.agent.target === k.trip);
      assert.equal(k.agent.trip, k.trip, 'the chat stays open');
      // The lines carried for Kyoto are kept there, as the open's failure leaves them: refused too when reads and writes both are, and then a second card
      // says so (the storage card in its place for the full phone); nothing is silent, and nothing waits unannounced.
      const saved = own.filter((/** @type {any} */ n) => n.title === NOT_SAVED);
      if (which === 'everything') assert.ok(saved.length >= 1 && saved[0].error instanceof StorageFullError, 'the keep that was refused is told');
      else assert.deepEqual(saved, [], 'the keep worked: nothing to tell');
    }
    // The line of the move is asked for as carryOn returns: it is dealt with (written, or refused) before room comes back, by order, so the count below
    // is the phone's answer to that write and not whether the lift happened to fall first. The store runs its transactions in turn, so one asked for now is last.
    await carried;
    await new Promise((r) => setImmediate(r));
    await k.store.tx(['events'], 'readonly', async () => {}).catch(() => {});
    // Reads and writes refused: the keep and the line of the move, each told once; reads alone refused: the keep and the line are written, nothing told.
    if (which === 'everything') await until(() => own.filter((/** @type {any} */ n) => n.title === NOT_SAVED).length === 2);
    if (which !== 'all') {
      const saved = own.filter((/** @type {any} */ n) => n.title === NOT_SAVED);
      assert.equal(saved.length, which === 'everything' ? 2 : 0, 'the keep and the line of the move, refused, told once each');
      assert.ok(saved.every((/** @type {any} */ n) => n.error instanceof StorageFullError));
    }
    // Room again: nothing is left running, and Kyoto opens.
    store.full(null);
    await k.agent.open(k.kyoto);
    await idleAtOnce(k);
    assert.equal(k.agent.trip, k.kyoto);
    // A write that came late, after room was back (on a timer, as a phone slow to answer), would land now and count: the order above holds the refusal, the
    // wait here that nothing arrives behind it within 50 ms (virtual time; a write later still would go uncounted).
    await new Promise((r) => setTimeout(r, 50));
    // One line of the move where its write worked; none where the phone refused it.
    assert.equal((await eventsIn(k, k.trip, ['conversation.moved'])).length, which === 'reads' ? 1 : 0);
  });
}

// In production open_trip runs only in her own turn, and the open it asks for ends that turn at once: the call's result is the one an open gives
// (#runCall records it, whatever carryOn finds; chief's decision C171 of 2026-11-20 accepts it), so the chat's word is annai's card, and its line of the
// move says where the files and lines went: they are in that conversation. Kokoro alone, and with Koe on and the halves split, in each order: Koe's open,
// free, fails first while Kokoro's waits for her stopped turn; Koe's works and Kokoro's read, after it, fails; or Koe's alone fails and Kokoro's works, so the
// screen is in Kyoto under the card. The line no longer depends on which: it says where the lines went, wherever the traveller is. The store refuses both
// halves' reads alike; Koe's open failing alone is a read of its own refused, through a store of its half's (as agent-loop.test.js does).
const KOE_ON = { koe: { talk: [say('Noted.')], type: [say('Noted.')] } };
for (const [how, o] of /** @type {[string, { koe?: any, koeFirst?: boolean, koeAlone?: boolean }][]} */ ([
  ['', {}], [', with Koe on', KOE_ON], [", with Koe on, Koe's open working and Kokoro's failing after it", { ...KOE_ON, koeFirst: true }],
  [", with Koe on, Koe's open alone failing while Kokoro's works: the screen is in Kyoto", { ...KOE_ON, koeAlone: true }],
])) {
  test(`Open tapped and the open fails, in her own turn: her call's result is the one an open gives, the chat has its line of the move, and the files and lines carried are in that conversation${how}`, async (t) => {
    useClock(t);
    const k = await chatKit(o.koe ? { koe: o.koe } : {});
    if (o.koe) {
      k.agent.send('Hello'); // the halves split: Koe opens on its own
      await idleAtOnce(k);
    }
    await rescript(k, { rules: [
      { match: 'the user wrote', reply: call('open_trip', { trip: k.kyoto, recap: RECAP, files: ['/trip/files/hotel.pdf'] }), then: say('We stay here, then.') },
      { match: '.', reply: sleep },
    ] });
    const store = refusing(k);
    const carry = k.agent.carryOn.bind(k.agent);
    k.agent.carryOn = (/** @type {any[]} */ ...a) => {
      if (o.koeFirst) {
        // Koe opens Kyoto before Kokoro reads: her open waits for her turn to end, and her turn's own writes wait at a door until Koe's open is done, when
        // the reads are refused, so her read, which comes after, fails.
        let holding = true;
        const door = holdAtDoor(k, (_stores, mode) => holding && mode === 'readwrite');
        const off = k.agent.koe.on('open', () => {
          off?.();
          holding = false;
          store.full('reads');
          door.open();
        });
      }
      else if (o.koeAlone) {
        // Koe's own read of Kyoto's conversation fails, through a store of its half alone (the other half's reads work), so its own failure path runs.
        const own = Object.create(k.store);
        own.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {(t: any) => any} */ fn) => k.store.tx(stores, mode, (/** @type {any} */ t) => fn(mode === 'readonly' ? { ...t, listEvents: (/** @type {string} */ scope, /** @type {any[]} */ ...a) => (scope === k.kyoto ? Promise.reject(new Error('IDB read failed')) : t.listEvents(scope, ...a)) } : t));
        k.agent.koe.store = own;
      }
      else store.full('reads'); // the open fails, and writes work: the keep of the lines succeeds
      return carry(...a);
    };
    const hotel = await handIn(k, 'hotel.pdf');
    k.agent.send("Let's carry on in Kyoto", { handed: [hotel], handover: 'h-1' });
    await until(() => k.asks.length === 1);
    k.agent.answer(k.asks[0].data.tap, 'Open');
    await until(() => k.notices.some((/** @type {any} */ n) => n.title === "That conversation didn't open"));
    // Her read is made, refused or not, before room comes back: the lift can't fall before it. Bounded: where Koe's open fails in the Koe-first order the door
    // is never lifted by it, and her open would wait for ever.
    let settled = false;
    k.agent.kokoro.opening.catch(() => {}).finally(() => { settled = true; });
    await until(() => settled);
    store.full(null);
    await idleAtOnce(k);
    assert.deepEqual(await openResults(k, k.trip), ['They chose Open: that conversation is open now, and you answer them there; this one stays.'], 'the open ended her call: the result of one that worked');
    assert.deepEqual((await eventsIn(k, k.trip, ['conversation.moved'])).map((/** @type {any} */ e) => e.data.to), [k.kyoto], 'one line of the move in the chat');
    const where = o.koeAlone ? k.kyoto : k.trip; // the screen follows Kokoro: with only Koe's open failed they are in Kyoto
    assert.equal(k.agent.trip, where, o.koeAlone ? 'in Kyoto, under the card' : 'still here');
    assert.equal(k.agent.kokoro.target, where);
    if (o.koeAlone) assert.equal(k.agent.koe.target, k.trip, "Koe's own open failed and put its target back: its failure path ran");
    assert.deepEqual((await k.ws.list(k.kyoto, '/files/')).map((/** @type {any} */ f) => f.path), ['/files/hotel.pdf'], 'the files are in that conversation already');
    const lines = await eventsIn(k, k.kyoto, ['msg.user']);
    assert.deepEqual(lines.map((/** @type {any} */ e) => [e.data.text, e.data.from, e.data.handover]), [["Let's carry on in Kyoto", k.trip, 'h-1']], 'their line, with its hand-over');
    assert.deepEqual((await eventsIn(k, k.kyoto, ['wake'])).flatMap((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => r.recap ?? r.kind)).includes(RECAP), true, 'her recap is written there');
  });
}

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
    await idleAtOnce(k);
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
      'Not now': 'The user tapped Not now: they stay here, and nothing moved. Carry on here, and don\'t call open_trip for "Kyoto" again unless they ask.',
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
  await idleAtOnce(k);
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
    await idleAtOnce(k);
    k.agent.send("Let's carry on in Kyoto");
    await until(() => k.asks.length === 1);
    if (how === 'removed') await removeTrip(k.store, k.kyoto);
    else await setTripStatus(k.store, k.kyoto, 'archived');
    k.agent.answer(k.asks[0].data.tap, 'Open');
    await idleAtOnce(k);
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
  await idleAtOnce(k);
  await heard('h1', { text: 'Take me to Kyoto' });
  await heard('h2', { text: 'turn left here', dismissed: true });
  /** The move, and back to the chat. @param {string} to */
  const move = async (to) => {
    await openBy(k, { trip: to, recap: RECAP });
    await idleAtOnce(k);
    assert.equal(k.agent.trip, to);
    await k.agent.open(k.trip);
    await idleAtOnce(k);
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
  await idleAtOnce(k);
  await move(osaka);
  assert.deepEqual((await eventsIn(k, osaka, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['Actually, Osaka first']);
  // No words yet: no copy, and nothing in its place; her recap goes.
  const nara = await createTrip(k.ws, { title: 'Nara', start: '2027-07-01' });
  await heard('h4', {});
  await openBy(k, { trip: nara, recap: RECAP });
  await idleAtOnce(k);
  assert.deepEqual(await eventsIn(k, nara, ['msg.user']), []);
  assert.ok((await eventsIn(k, nara, ['wake'])).some((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.recap === RECAP)));
});

test("a hand-over and a line after it, then the move: the hand-over's message with its files, then the last line, in order", async (t) => {
  useClock(t);
  const k = await chatKit();
  const hotel = await handIn(k, 'hotel.pdf');
  k.agent.send('Our hotel', { handed: [hotel], handover: 'h-1' });
  k.agent.send("and let's carry on in Kyoto");
  await idleAtOnce(k);
  await openBy(k, { trip: k.kyoto, recap: RECAP }, 'h-1');
  await idleAtOnce(k);
  const copies = await eventsIn(k, k.kyoto, ['msg.user']);
  assert.deepEqual(copies.map((/** @type {any} */ e) => [e.data.text, e.data.handed?.map((/** @type {any} */ f) => f.path) ?? null, e.data.handover ?? null]), [
    ['Our hotel', ['/trip/files/hotel.pdf'], 'h-1'], ["and let's carry on in Kyoto", null, null],
  ]);
  // The files went too: both lines say so in the chat, where Undo finds the trip.
  assert.deepEqual((await eventsIn(k, k.trip, ['handover.moved', 'conversation.moved'])).map((/** @type {any} */ e) => [e.type, e.data]), [
    ['handover.moved', { handover: 'h-1', wake: 'w', to: k.kyoto, started: false, count: 1 }], ['conversation.moved', { to: k.kyoto, title: 'Kyoto', wake: 'w' }],
  ]);
});

for (const word of ['yes', 'Nope']) {
  test(`"${word}" typed to the card, and not a tap, is the card's answer and not their last line: the line before it is what the next move copies`, async (t) => {
    useClock(t);
    const k = await chatKit();
    k.agent.send("Let's carry on in Kyoto");
    await idleAtOnce(k);
    const n = k.asks.length;
    const unanswered = run(k, 'open_trip', { trip: k.kyoto, recap: RECAP });
    await until(() => k.asks.length === n + 1);
    k.agent.send(word); // typed: annai's card takes a tap, or a word it hears, and a typed yes opens nothing
    assert.match(String(await unanswered), new RegExp(`^Not opened: .* The user wrote: ${word}$`));
    await idleAtOnce(k);
    await openBy(k, { trip: k.kyoto, recap: RECAP });
    await idleAtOnce(k);
    assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ["Let's carry on in Kyoto"]);
  });
}

test("a second open_trip copies no line an earlier move carried, and one said after that move goes", async (t) => {
  useClock(t);
  const k = await chatKit();
  const tokyo = await createTrip(k.ws, { title: 'Tokyo', start: '2027-05-01' });
  const nara = await createTrip(k.ws, { title: 'Nara', start: '2027-06-01' });
  k.agent.send("Let's carry on in Kyoto");
  await idleAtOnce(k);
  await openBy(k, { trip: k.kyoto, recap: RECAP });
  await idleAtOnce(k);
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  // Back in the chat with nothing new from them (a reminder's turn, or her own call): Tokyo gets her recap, and no copy of that line.
  await openBy(k, { trip: tokyo, recap: RECAP });
  await idleAtOnce(k);
  assert.deepEqual(await eventsIn(k, tokyo, ['msg.user']), []);
  assert.ok((await eventsIn(k, tokyo, ['wake'])).some((/** @type {any} */ e) => e.data.reasons.some((/** @type {any} */ r) => r.recap === RECAP)));
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  k.agent.send('And Nara, later');
  await idleAtOnce(k);
  await openBy(k, { trip: nara, recap: RECAP });
  await idleAtOnce(k);
  assert.deepEqual((await eventsIn(k, nara, ['msg.user'])).map((/** @type {any} */ e) => e.data.text), ['And Nara, later']);
});

test("a Stop in the moment after Open: nothing opens, and what is written into the trip is in order, their line and then her recap", async (t) => {
  useClock(t);
  const k = await chatKit();
  k.agent.send("Let's carry on in Kyoto");
  await idleAtOnce(k);
  const stop = new AbortController();
  const opening = k.agent.kokoro.loopTools().find((/** @type {any} */ x) => x.name === 'open_trip').run({ trip: k.kyoto, recap: RECAP }, {
    id: 'c', scope: k.agent.scope, trip: k.agent.trip, signal: stop.signal, model: null, wake: 'w', author: 'shiori',
  });
  await until(() => k.asks.length === 1);
  k.agent.answer(k.asks[0].data.tap, 'Open');
  stop.abort(); // before the files have moved
  await opening;
  await idleAtOnce(k);
  assert.equal(k.agent.target, k.trip, 'nothing opened');
  assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user', 'wake'])).map((/** @type {any} */ e) => e.data.text ?? e.data.reasons.map((/** @type {any} */ r) => r.recap ?? r.kind).join()), [
    'user', "Let's carry on in Kyoto", RECAP,
  ]);
});

test("a move's line with no files and no line of theirs to copy, written into a conversation that was closed where an older hand-over is still owed (a Stop after Open): its restart takes nothing up, so what she files for the move is outside that hand-over's Undo", async (t) => {
  useClock(t);
  const k = await chatKit();
  const log = (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ texts = []) => record(k.store, k.kyoto, { type, actor: type === 'msg.user' ? 'user' : 'system', data, texts });
  // Kyoto: the user handed her a file there and her turn failed ("Shiori can't reach her model"); nothing took it up since.
  await log('wake', { id: 'w-0', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
  await log('msg.user', { wake: 'w-0', handed: [handedFlight], handover: 'h-1' }, [['text', 'Our trip']]);
  await log('error', { kind: 'model', wake: 'w-0', message: "Shiori can't reach her model." });
  const reads = async () => { const r = await Transcript.load(k.store, k.kyoto); return [r.unanswered, r.handover, r.owedHandover]; };
  assert.deepEqual(await reads(), [false, null, 'h-1'], "her turn failed and ended: nothing is owed, and the user's next turn would carry it");
  const stop = new AbortController();
  const opening = k.agent.kokoro.loopTools().find((/** @type {any} */ x) => x.name === 'open_trip').run({ trip: k.kyoto, recap: RECAP }, {
    id: 'c', scope: k.agent.scope, trip: k.agent.trip, signal: stop.signal, model: null, wake: 'w', author: 'shiori',
  });
  await until(() => k.asks.length === 1);
  k.agent.answer(k.asks[0].data.tap, 'Open');
  stop.abort(); // before the files have moved: nothing opens, the lines wait in Kyoto
  await opening;
  await idleAtOnce(k);
  assert.equal(k.agent.target, k.trip, 'nothing opened');
  assert.deepEqual((await eventsIn(k, k.kyoto, ['msg.user', 'wake'])).slice(2).map((/** @type {any} */ e) => e.data.reasons.map((/** @type {any} */ r) => [r.kind, r.recap])), [[['move', RECAP]]], 'no line of theirs to copy: annai\'s own line, with her recap');
  assert.deepEqual(await reads(), [true, null, 'h-1'], 'a move\'s line is no one\'s: it takes nothing up, and the hand-over stays owed to the user\'s next line');
});

// A move's line skips quiet hours and the hourly limit, as a cue does (wake()'s list in loop.js): the user tapped Open and is waiting in Kyoto. With no
// line of theirs to copy, nothing else wakes her there, so it is the move's own wake that the budgets would hold or drop.
for (const [what, budgets, spent] of /** @type {[string, Record<string, any>, boolean][]} */ ([
  ['quiet hours on all day', { quietHours: { from: '00:00', to: '23:59' } }, false],
  ['the hour\'s one wake already spent', { wakesPerHour: 1 }, true],
])) {
  test(`Open on a move with no line of theirs to copy, ${what}: Kyoto's turn runs at once, one request there, no "skipped a wake" card`, async (t) => {
    useClock(t);
    const k = await chatKit({ agent: { now: () => Date.parse('2026-11-26T12:00:00Z') } }); // a clock pinned at noon, inside the first row's quiet hours (00:00 to 23:59), so no minute of the day lets it pass
    await rescript(k, { rules: [{ match: 'You moved the user here', reply: say(ANSWER) }, { match: 'a tide', reply: sleep }] });
    await updateAppSettings(k.ws, { shiori: { budgets } });
    if (spent) { // one wake of annai's admitted this hour; the move is the next
      k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'a tide' });
      await idleAtOnce(k);
    }
    await openBy(k, { trip: k.kyoto, recap: RECAP });
    await until(() => k.agent.target === k.kyoto);
    await idleAtOnce(k);
    const kyotos = k.requests.filter((/** @type {any} */ r) => JSON.stringify(r.messages).includes('You moved the user here'));
    assert.equal(kyotos.length, 1, 'her turn in Kyoto ran at once, on the move');
    assert.deepEqual((await eventsIn(k, k.kyoto, ['out.speak'])).map((/** @type {any} */ e) => e.data.text), [ANSWER]);
    assert.deepEqual(k.notices.filter((/** @type {any} */ n) => n.title === 'Shiori skipped a wake'), []);
  });
}

test("open_trip's description says annai asks, so she doesn't ask or announce the move", async (t) => {
  useClock(t);
  const k = await chatKit();
  const tool = k.agent.kokoro.loopTools().find((/** @type {any} */ x) => x.name === 'open_trip');
  assert.match(tool.description, /annai asks them itself with its own card[^.]* so don't ask them first or say you are taking them: call it/);
});
