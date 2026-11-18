// The booking time path's design check (2026-11-18, its Option 1): an end's place is read by what is booked and filed whole, never compared
// at write time; a flight's end is its last leg's placed arrival, or none, and the write's result says so; one answer (dropsAtPlace) to
// whether a drop-off names the booking's own place, read by the Plan's Return row, the details and the check. Fix round 1: a stay's
// check-out place is kept as any other kind's; a leg with no arrival clears the end of a flight only. Fix round 2: a restaurant's or an event's
// arrival is its end, as on main (the build's item 4, its arrival as its start, went: a write can't tell what a booking's start stands for);
// a removed alias removes the field it stands for and nothing else; legs move the times of what carries the traveller only; a whole write's
// first leg that gives no departure is said whatever else the write gives, and a leg's time given to anything else is said too (the touch
// before merge). booking-rest-next, one of the two Deferred entries after it: unsure's names for a time (departure and arrival, a stay's
// check-in and check-out, a car's pick-up and return) mark the part they stand for, read by the record where the marks are read (checkOf),
// however the time was written and whoever stored the booking. The other, a lone `flights` value, stays as on main (it gives no times; its
// fix needs the stored leg in the writer), pinned as it is, but for a blank `flights+` value, which is none (a stored end stays). Each shape goes through the
// files plugin's write and patch tools, then what the details draw
// (bookingFacts), what the Plan draws (planRows), what the check marks (checkOf, checkCount) and what Shiori is told (checkWords, the tool's result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOf, checkWords, dropsAtPlace, there } from '../../src/core/bookings.js';
import { planRows, record, CARRIERS } from '../../src/core/plan.js';
import { bookingFacts, checkCount } from '../../src/ui/format.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';

const AK = 'America/Anchorage';
const TOKYO = 'Asia/Tokyo';
const LA = 'America/Los_Angeles';
const base = { id: 'b', status: 'unverified', source: '/files/b.pdf', unsure: [] };
const at = (/** @type {string} */ x, tz = AK) => ({ at: x, tz });
/** What the write and patch tools add when a flight's last leg gives no time of arrival. */
const NO_END = 'The last leg\'s arrival isn\'t written as a date with a time (YYYY-MM-DDTHH:MM), so the booking has no arrival time now: when you know when it arrives, write end as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }.';

/** What the write tool adds when a whole flights write's first leg gives no departure (a text leg), and the end is not left out with it. */
const NO_START = 'The first leg\'s departure isn\'t written as a date with a time (YYYY-MM-DDTHH:MM), so the booking has no start now: when you know when it leaves, write start as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }.';
/** What it adds when the end is left out with the start (the last leg gave an arrival, and the write gave no end: an end with no start is on no day). */
const NO_START_END = 'The first leg\'s departure isn\'t written as a date with a time (YYYY-MM-DDTHH:MM), so the booking has no start or end now: when you know when it leaves and arrives, write start and end as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }.';
/** What a write adds when legs with a time are given to a booking that isn't a flight, a train, a ferry, a bus or a coach. */
const NO_LEGS = 'The legs\' times are kept as written and set no start or end for this booking (only a flight, train, ferry, bus or coach takes them from its legs): when it has no start or end of its own, write them as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }.';

/** The files plugin with the core schemas, a trip in Anchorage, and what each booking file comes out as on the screens. */
async function setup() {
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Anchorage' });
  await ws.patch(trip, '/trip.json', { timezones: [AK] }, { author: 'user' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @param {string} name @param {any} input @returns {Promise<string>} */
  const run = (name, input) => tools[name].run(input, { scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori' });
  /** @param {string} file @param {any} content */
  const write = (file, content) => run('write', { path: `/trip/bookings/${file}`, content });
  /** @param {string} file @param {any} changes */
  const patch = (file, changes) => run('patch', { path: `/trip/bookings/${file}`, changes });
  /** @param {string} file @param {any} value as the user stored it */
  const store = (file, value) => ws.write(trip, `/bookings/${file}`, value, { author: 'user' });
  /** @param {string} file */
  const read = (file) => ws.readJSON(trip, `/bookings/${file}`);
  return { ws, trip, run, write, patch, store, read };
}

/** The details' lines, as label: value. @param {any} b */
const lines = (b) => bookingFacts(b, { fallbackTz: AK }).map((f) => `${f.label}: ${f.value}${f.unsure ? ' (check)' : ''}`);
/** The Plan's rows of one booking, as from@day time, and where (with its position, when it has one). @param {any} b */
const rows = (b) => planRows([], [{ path: '/bookings/x.json', booking: b }], { fallbackTz: AK }).map((r) => `${r.from}@${r.day} ${r.time} ${r.item.place ? `${r.item.place.name}${typeof r.item.place.lat === 'number' ? ' (pin)' : ''}` : '-'}`);

/**
 * What Shiori is told of the check, the chip and the drawn lines agree with what checkOf marks: every part it marks is drawn with its check
 * (the name is the heading), every check drawn is a part it marks, the chip counts what is drawn, and her words are empty exactly when
 * nothing is marked (the words themselves are asserted where a test names them).
 * @param {any} b
 */
function agrees(b) {
  const marks = checkOf(b).fields;
  const facts = bookingFacts(b, { fallbackTz: AK });
  const drawn = facts.filter((f) => f.unsure).flatMap((f) => (f.key === 'route' ? ['from', 'to'].filter((k) => marks.includes(k)) : [f.key]));
  const named = marks.filter((k) => k !== 'title' || (typeof b.title === 'string' && b.title.trim()));
  assert.deepEqual([...new Set(drawn)].sort(), named.filter((k) => k !== 'title').sort(), `drawn checks against checkOf: ${JSON.stringify(b)}`);
  assert.equal(checkCount(b, { fallbackTz: AK }), named.length, 'the chip');
  const words = checkWords(b);
  assert.equal(words === '', named.length === 0, `her words: ${words}`);
}

test("a stay's check-out is kept as its drop-off, as any other kind's: patched with its own address or name, or a departure with its address, the end moves and what was written is filed (no Drop-off line repeating the place: dropsAtPlace); a shuttle stop is drawn as a Drop-off line, and the Plan's check-out row stays at the hotel, with its position (it was dropped, silently)", async () => {
  const { store, patch, read } = await setup();
  const stay = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test', address: '1 Test Street', lat: 61.2, lng: -149.9 }, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-27T11:00:00-09:00') };
  /** @type {[any, string, boolean][]} what is written, the drop-off filed, and whether it names the place (so no Drop-off line) */
  const cases = [
    [{ checkout: { at: '2026-11-26T11:00', location: '1 Test Street' } }, '1 Test Street', true],
    [{ checkout: { at: '2026-11-26T11:00', location: 'Hotel Aurora Test' } }, 'Hotel Aurora Test', true],
    [{ departure: { at: '2026-11-26T11:00', address: '1 Test Street' } }, '1 Test Street', true],
    [{ checkout: { at: '2026-11-26T11:00', location: 'Shuttle stop B' } }, 'Shuttle stop B', false],
  ];
  for (const [changes, dropoff, atPlace] of cases) {
    await store('s.json', stay);
    assert.equal(await patch('s.json', changes), 'Patched /trip/bookings/s.json.');
    const got = await read('s.json');
    assert.deepEqual([got.end, got.fields, got.place, dropsAtPlace(got)], [at('2026-11-26T11:00:00-09:00'), { dropoff }, stay.place, atPlace], JSON.stringify(changes));
    assert.deepEqual(lines(got).filter((l) => /^(Place|Drop-off|To):/.test(l)), ['Place: Hotel Aurora Test, 1 Test Street', ...(atPlace ? [] : [`Drop-off: ${dropoff}`])], JSON.stringify(changes));
    // The Plan's check-out row is at the hotel, with its position, whatever the drop-off says (as on main: only a car returns elsewhere).
    assert.equal(rows(got).find((r) => r.startsWith('end@')), 'end@2026-11-26 11:00 Hotel Aurora Test (pin)', 'the check-out at the hotel, with its position');
    // Marked unsure, the mark is on the line drawn: the drop-off's, or the place's when the drop-off names it.
    for (const x of [got, { ...got, unsure: ['dropoff'] }, { ...got, unsure: ['end'] }]) agrees(x);
  }
});

test("a stay's place or address written only with its check-out is kept as its drop-off, as on main (it was dropped, silently); one that names the stay's own place draws no Drop-off line; the one shape left: a check-in with the name only and a check-out with the address draws \"Drop-off: <the address>\" under \"Place: <the name>\", as on main", async () => {
  const { write, read } = await setup();
  const drawn = (/** @type {any} */ x) => lines(x).filter((l) => /^(Place|Drop-off):/.test(l));
  // A check-in with the name and a check-out with the address: the address is kept, and drawn on a line of its own (the shape left).
  await write('a.json', { ...base, kind: 'lodging', checkin: { at: '2026-11-20T15:00', location: 'Hotel Aurora' }, checkout: { at: '2026-11-22T11:00', address: '1 Test Street' } });
  const a = await read('a.json');
  assert.deepEqual([a.place, a.fields, a.end], [{ name: 'Hotel Aurora' }, { dropoff: '1 Test Street' }, at('2026-11-22T11:00:00-09:00')]);
  assert.deepEqual(drawn(a), ['Place: Hotel Aurora', 'Drop-off: 1 Test Street']);
  // A check-in with a time only and a check-out with the name: the name is kept, drawn as the drop-off (no place to name it).
  await write('b.json', { ...base, kind: 'lodging', checkin: '2026-11-20T15:00', checkout: { at: '2026-11-22T11:00', location: 'Hotel Aurora' } });
  const b = await read('b.json');
  assert.deepEqual([b.place, b.fields, b.end], [undefined, { dropoff: 'Hotel Aurora' }, at('2026-11-22T11:00:00-09:00')]);
  assert.deepEqual(drawn(b), ['Drop-off: Hotel Aurora']);
  // A dropoff written on a stay is its check-out's place too.
  await write('c.json', { ...base, kind: 'lodging', title: 'Hotel Aurora', checkin: '2026-11-20T15:00', dropoff: { at: '2026-11-22T11:00', location: 'Airport' } });
  const c = await read('c.json');
  assert.deepEqual([c.fields, c.end], [{ dropoff: 'Airport' }, at('2026-11-22T11:00:00-09:00')]);
  // A check-out that says what the place says (its name, its address, or both, as filed) is the place: no Drop-off line.
  for (const checkout of [{ location: 'Hotel Aurora' }, { address: '1 Test Street' }, { location: 'Hotel Aurora', address: '1 Test Street' }]) {
    await write('d.json', { ...base, kind: 'lodging', checkin: { at: '2026-11-20T15:00', location: 'Hotel Aurora', address: '1 Test Street' }, checkout: { at: '2026-11-22T11:00', ...checkout } });
    const d = await read('d.json');
    assert.deepEqual([dropsAtPlace(d), drawn(d)], [true, ['Place: Hotel Aurora, 1 Test Street']], JSON.stringify(checkout));
    agrees(d);
  }
  for (const x of [a, b, c]) agrees(x);
});

test("a car: its return's name and address are both kept; one returned where it was picked up keeps its drop-off and is drawn at its place, with no Drop-off line and the Return row's pin (whole write and patch); a stored drop-off elsewhere patched back to the lot returns at the lot", async () => {
  const { write, store, patch, read } = await setup();
  const lot = { name: 'Airport lot', lat: 61.17, lng: -149.99 };
  // Returned to a name and an address: both, as one place ("the alias took the first of location, place and address", and the address was lost).
  await write('one.json', { ...base, kind: 'car', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Airport lot', address: '9 Other Road', at: '2026-11-27T09:00' } });
  const one = await read('one.json');
  assert.deepEqual([one.place, one.fields], [{ name: 'Airport lot' }, { dropoff: 'Airport lot, 9 Other Road' }]);
  assert.deepEqual(lines(one).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Airport lot', 'Drop-off: Airport lot, 9 Other Road']);
  assert.equal(rows(one).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Airport lot, 9 Other Road');
  // Returned where it was picked up, in a whole write: the drop-off is kept as she wrote it (compared with nothing), and read as the place.
  await write('same.json', { ...base, kind: 'car', title: 'Test Rentals compact', place: lot, pickup: '2026-11-20T10:00', return: { location: 'Airport lot', at: '2026-11-27T09:00' } });
  const same = await read('same.json');
  assert.deepEqual([same.place, same.fields, dropsAtPlace(same)], [lot, { dropoff: 'Airport lot' }, true]);
  assert.deepEqual(lines(same).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Airport lot']);
  assert.equal(rows(same).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Airport lot (pin)');
  // The same in a patch of the stored car (the patch sees no place, so it drew "Drop-off: Airport lot" and the Return row lost the pin).
  const car = { ...base, kind: 'car', title: 'Test Rentals compact', place: lot, start: at('2026-11-20T10:00:00-09:00'), end: at('2026-11-27T09:00:00-09:00') };
  await store('c.json', car);
  await patch('c.json', { return: { at: '2026-11-26T09:00', location: 'Airport lot' } });
  const back = await read('c.json');
  assert.deepEqual([back.place, back.fields, back.end], [lot, { dropoff: 'Airport lot' }, at('2026-11-26T09:00:00-09:00')]);
  assert.deepEqual(lines(back).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Airport lot']);
  assert.equal(rows(back).find((r) => r.startsWith('end@')), 'end@2026-11-26 09:00 Airport lot (pin)');
  // A one-way rental stored with its drop-off downtown, patched back to the lot: the Return row is at the lot (a patch that compared with the
  // stored place would keep "Downtown desk").
  await store('w.json', { ...car, fields: { dropoff: 'Downtown desk' } });
  assert.equal(rows(await read('w.json')).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Downtown desk');
  await patch('w.json', { dropoff: { at: '2026-11-27T09:00', location: 'Airport lot' } });
  const lotAgain = await read('w.json');
  assert.deepEqual([lotAgain.fields, rows(lotAgain).find((r) => r.startsWith('end@'))], [{ dropoff: 'Airport lot' }, 'end@2026-11-27 09:00 Airport lot (pin)']);
  // Returned elsewhere: its Drop-off line, and the Return row there.
  await patch('w.json', { dropoff: { at: '2026-11-27T09:00', location: 'Downtown desk' } });
  const away = await read('w.json');
  assert.deepEqual(lines(away).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Airport lot', 'Drop-off: Downtown desk']);
  assert.equal(rows(away).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Downtown desk');
  for (const b of [one, same, back, lotAgain, away]) agrees(b);
});

test("dropsAtPlace: a drop-off names the booking's own place when all it says is the place's name, its address or the two as filed, trimmed and in the case written; a stored stay's drop-off naming its address is drawn as its Place line alone, and a check on it is the place's", async () => {
  const place = { name: 'Hotel Aurora Test', address: '1 Test Street' };
  const b = (/** @type {any} */ dropoff, /** @type {any} */ p = place) => ({ ...base, kind: 'car', place: p, fields: { dropoff } });
  for (const d of ['Hotel Aurora Test', ' 1 Test Street ', 'Hotel Aurora Test, 1 Test Street', { name: 'Hotel Aurora Test' }, { name: 'Hotel Aurora Test', address: '1 Test Street', lat: 61.2 }, { name: '1 Test Street', address: '' }]) assert.equal(dropsAtPlace(b(d)), true, JSON.stringify(d));
  // Anything else is somewhere else: another place, another case, an object whose address is another's, a value that isn't text or a place.
  for (const d of ['Downtown desk', 'hotel aurora test', 'Hotel Aurora Test, 9 Other Road', { name: 'Hotel Aurora Test', address: '9 Other Road' }, { lat: 61.2, lng: -149.9 }, 42, ['Hotel Aurora Test'], '', null]) assert.equal(dropsAtPlace(b(d)), false, JSON.stringify(d));
  assert.equal(dropsAtPlace({ ...base, kind: 'car', fields: { dropoff: 'Hotel Aurora Test' } }), false, 'no place');
  assert.equal(dropsAtPlace(b('Hotel Aurora Test', { name: 'Hotel Aurora Test' })), true);
  // A stay stored with a drop-off its older check-out filed with the hotel's address (on main: "Drop-off: 1 Test Street" under the Place line).
  const { store, read } = await setup();
  const stay = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-22T11:00:00-09:00'), fields: { dropoff: '1 Test Street', room: '12' } };
  await store('s.json', stay);
  assert.deepEqual(lines(await read('s.json')).filter((l) => /^(Place|Drop-off|Room):/.test(l)), ['Place: Hotel Aurora Test, 1 Test Street', 'Room: 12']);
  // Marked unsure, the drop-off is the place: the Place line carries the check, the chip counts one, and Shiori is told the place.
  const marked = { ...stay, unsure: ['dropoff'] };
  assert.deepEqual([checkOf(marked).fields, checkWords(marked), checkCount(marked, { fallbackTz: AK })], [['place'], 'not sure the place was read right', 1]);
  assert.deepEqual(lines(marked).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Hotel Aurora Test, 1 Test Street (check)']);
  // One from before (no unsure, not confirmed) marks each part it has once: the drop-off is the place, not a part of its own.
  const { unsure: _, ...old } = stay;
  assert.deepEqual(checkOf(old).fields, ['title', 'start', 'end', 'place', 'room']);
  for (const x of [stay, marked, old, { ...marked, unsure: ['dropoff', 'place'] }]) agrees(x);
});

test("a ride arriving where it left keeps where it arrives (fields.to), compared with nothing (it was dropped as the same place)", async () => {
  const { write, read } = await setup();
  await write('bus.json', { ...base, kind: 'bus', title: 'Glacier tour', depart: { at: '2026-11-21T08:00', tz: AK, location: 'Hotel Aurora Test' }, arrive: { at: '2026-11-21T18:00', tz: AK, location: 'Hotel Aurora Test' } });
  const bus = await read('bus.json');
  assert.deepEqual([bus.place, bus.fields], [{ name: 'Hotel Aurora Test' }, { to: 'Hotel Aurora Test' }]);
  assert.deepEqual(lines(bus).filter((l) => /^(Place|To):/.test(l)), ['Place: Hotel Aurora Test', 'To: Hotel Aurora Test']);
  // A flight's arrival with its airport's name and address: where it arrives, both.
  await write('f.json', { ...base, kind: 'flight', depart: at('2026-11-20T11:05', LA), arrival: { at: '2026-11-21T15:40', tz: TOKYO, location: 'Haneda Airport', address: '3-3-2 Hanedakuko' } });
  assert.deepEqual((await read('f.json')).fields, { to: 'Haneda Airport, 3-3-2 Hanedakuko' });
  agrees(bus);
});

test("fields.to beside an arrival's place that says something else is refused, nothing stored; the arrival's place is now its name and its address, so fields.to with the name alone beside both is refused too (main took it and lost the address)", async () => {
  const { write, read, ws, trip } = await setup();
  const flight = (/** @type {any} */ to, /** @type {any} */ arrival) => write('f.json', { ...base, kind: 'flight', fields: { from: 'SFO', to }, depart: at('2026-11-20T11:05', LA), arrival: { at: '2026-11-21T15:40', tz: TOKYO, ...arrival } });
  await assert.rejects(flight('Haneda Airport', { location: 'Haneda Airport', address: '3-3-2 Hanedakuko' }), /^Error: arrival and fields\.to are both given and differ: keep one and remove the other\.$/);
  await assert.rejects(flight('Osaka (KIX)', { location: 'Haneda Airport' }), /^Error: arrival and fields\.to are both given and differ/);
  assert.equal(await ws.read(trip, '/bookings/f.json'), undefined);
  // The same place both ways is taken.
  await flight('Haneda Airport, 3-3-2 Hanedakuko', { location: 'Haneda Airport', address: '3-3-2 Hanedakuko' });
  assert.deepEqual((await read('f.json')).fields, { from: 'SFO', to: 'Haneda Airport, 3-3-2 Hanedakuko' });
  agrees(await read('f.json'));
  // Marked unsure by the word she wrote it with (`arrival`), the mark is on the end that is stored: the Arrives line carries the check.
  await write('m.json', { ...base, kind: 'flight', fields: { from: 'SFO' }, depart: at('2026-11-20T11:05', LA), arrival: { at: '2026-11-21T15:40', tz: TOKYO, location: 'Haneda Airport' }, unsure: ['arrival'] });
  const marked = await read('m.json');
  assert.deepEqual([marked.unsure, checkOf(marked).fields, lines(marked).filter((l) => /^Arrives:.*\(check\)$/.test(l)).length], [['end'], ['end'], 1]);
  agrees(marked);
});

/** A flight stored through the write tool with one leg, SFO to NRT, ending 15:40 in Tokyo on the 21st. */
const NH7 = { flight: 'NH 7', departure: { iataCode: 'SFO', at: '2026-11-20T11:05' }, arrival: { iataCode: 'NRT', at: '2026-11-21T15:40', tz: TOKYO }, tz: LA };
const ARRIVES = at('2026-11-21T15:40:00+09:00', TOKYO);

test("flights+ whose last leg's arrival is no date with a time annai reads (none, an airport, a clock alone, text, a date alone, a number, a day that doesn't exist, a date and a time written in a form it can't read) is appended as written, the booking's end is removed, and the result says so (the end stayed at the leg before, or it was refused)", async () => {
  const { write, patch, read } = await setup();
  // The last two are a date and a time that annai can't read ("6:00 PM", "2026/11/26 08:00"): the note is true for them too (it said the leg gave none).
  for (const arrival of [undefined, { iataCode: 'HND' }, 'HND', '08:00', '8:00 AM', '2026-11-25', 800, '2026-11-31T08:00', { iataCode: 'HND', at: '' }, { iataCode: 'HND', at: '08:00', tz: TOKYO }, '2026-11-26 6:00 PM', '2026/11/26 08:00']) {
    const label = String(JSON.stringify(arrival)); // an assert message is a string: JSON.stringify(undefined) is not
    await write('f.json', { ...base, kind: 'flight', title: 'NH 7 / NH 8', flights: [NH7] });
    assert.deepEqual((await read('f.json')).end, ARRIVES);
    const leg = { flight: 'NH 8', departure: { at: '2026-11-25T06:00', tz: TOKYO }, ...(arrival === undefined ? {} : { arrival }) };
    const said = await patch('f.json', { 'flights+': [leg] });
    assert.equal(said, `Patched /trip/bookings/f.json. ${NO_END}`, label);
    // The note says what is wrong with the arrival (it isn't a date with a time, in a form), and what the booking has now: the result's own words.
    assert.match(said, /^Patched \/trip\/bookings\/f\.json\. The last leg's arrival isn't written as a date with a time \(YYYY-MM-DDTHH:MM\), so the booking has no arrival time now: when you know when it arrives, write end as \{ "at": /, label);
    const got = await read('f.json');
    assert.deepEqual(['end' in got, got.start, got.fields.flights], [false, at('2026-11-20T11:05:00-08:00', LA), [NH7, leg]], label);
    agrees(got);
  }
});

test("flights+ with two legs whose last has no arrival: no end (it stayed two legs back); with end in the same patch: that end, said nothing; a last leg's date and time with no zone of its own: refused, nothing stored; with its zone: the end moves", async () => {
  const { write, patch, read } = await setup();
  const leg = (/** @type {string} */ n, /** @type {any} */ arrival) => ({ flight: n, departure: { at: '2026-11-25T06:00', tz: TOKYO }, ...(arrival ? { arrival } : {}) });
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  await patch('f.json', { 'flights+': [leg('NH 8', at('2026-11-25T08:00', TOKYO)), leg('NH 9')] });
  const two = await read('f.json');
  assert.deepEqual(['end' in two, two.fields.flights.length], [false, 3]);
  agrees(two);
  // The end she gives herself, beside a leg with no arrival.
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  assert.equal(await patch('f.json', { 'flights+': [leg('NH 8')], end: at('2026-11-25T08:00:00+09:00', TOKYO) }), 'Patched /trip/bookings/f.json.');
  assert.deepEqual((await read('f.json')).end, at('2026-11-25T08:00:00+09:00', TOKYO));
  agrees(await read('f.json'));
  // Kept as today: a time with no zone of its own is refused in today's words, the file as it was; its own zone moves the end.
  const before = await read('f.json');
  await assert.rejects(patch('f.json', { 'flights+': [leg('NH 9', { at: '2026-11-26T08:00' })] }), /^Error: flights\+\[0\]\.arrival "2026-11-26T08:00" has no time zone annai knows \(.*the arrival needs a tz of its own\): write end as .* Give the arrival its own "tz": the leg's "tz" is the zone it leaves in\.$/);
  assert.deepEqual(await read('f.json'), before);
  assert.equal(await patch('f.json', { 'flights+': [leg('NH 9', { at: '2026-11-26T08:00', tz: TOKYO })] }), 'Patched /trip/bookings/f.json.');
  assert.deepEqual((await read('f.json')).end, at('2026-11-26T08:00:00+09:00', TOKYO));
  // A whole flights write whose last leg has no arrival is taken with no end, and said (it was refused); its first leg still gives the start.
  assert.match(await write('g.json', { ...base, kind: 'flight', flights: [{ ...NH7, arrival: { iataCode: 'NRT' } }] }), new RegExp(`^Wrote /trip/bookings/g\\.json \\(\\d+ bytes\\)\\. ${NO_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const g = await read('g.json');
  assert.deepEqual(['end' in g, g.start], [false, at('2026-11-20T11:05:00-08:00', LA)]);
  agrees(g);
  // A leg written as text, not an object, is a last leg with no arrival too (its end stayed at the leg before).
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  assert.equal(await patch('f.json', { 'flights+': 'NH 8 to HND' }), `Patched /trip/bookings/f.json. ${NO_END}`);
  assert.deepEqual(['end' in (await read('f.json')), (await read('f.json')).fields.flights], [false, [NH7, 'NH 8 to HND']]);
  agrees(await read('f.json'));
});

test("a booking stored with a start and an end and no legs, given a leg with no arrival, has no end, and is told so; the details and the Plan of a flight with no end have no Arrives line and no Arrive row", async () => {
  const { store, patch, read } = await setup();
  await store('f.json', { ...base, kind: 'flight', title: 'NH 7', start: at('2026-11-20T11:05:00-08:00', LA), end: ARRIVES });
  assert.deepEqual(lines(await read('f.json')).map((l) => l.split(':')[0]), ['Departs', 'Arrives']);
  assert.deepEqual(rows(await read('f.json')).map((r) => r.split(' ')[0]), ['booking@2026-11-20', 'end@2026-11-21']);
  assert.equal(await patch('f.json', { 'flights+': [{ flight: 'NH 8', departure: { at: '2026-11-25T06:00', tz: TOKYO }, arrival: { iataCode: 'HND' } }] }), `Patched /trip/bookings/f.json. ${NO_END}`);
  const got = await read('f.json');
  assert.equal('end' in got, false);
  assert.deepEqual(lines(got), ['Departs: Fri, Nov 20, 11:05 AM (PT)', 'Flights: NH 8 · Nov 25 06:00 – iataCode: HND']);
  assert.deepEqual(rows(got), ['booking@2026-11-20 11:05 -']);
  agrees(got);
});

test("a restaurant's or an event's arrival is its end, as on main, whole write or patch: written alone it is stored as an end with no start (on no day of the Plan: the Deferred entry), beside a time it starts the same; what travels the same; an edit that adds one is told it is the end", async () => {
  const { write, store, patch, read, run } = await setup();
  // Alone, as on main: an end, no start, and no row on any day (the Deferred entry, "written with only an arrival").
  await write('r.json', { ...base, kind: 'restaurant', title: 'Test Bistro', arrive: { at: '2026-11-20T18:30', location: 'Test Bistro' } });
  const r = await read('r.json');
  assert.deepEqual([r.start, r.end, r.fields], [undefined, at('2026-11-20T18:30:00-09:00'), { to: 'Test Bistro' }]);
  assert.deepEqual(rows(r), ['booking@null  -'], 'an end with no start is on no day of the Plan (a row with no day)');
  await write('e.json', { ...base, kind: 'event', title: 'Concert', arrival: '2026-11-20T19:00', unsure: ['arrival'] });
  const e = await read('e.json');
  assert.deepEqual([e.start, e.end, e.unsure], [undefined, at('2026-11-20T19:00:00-09:00'), ['end']]);
  // The same in a patch: the arrival is the end.
  await store('p.json', { ...base, kind: 'restaurant', title: 'Test Bistro', start: at('2026-11-20T18:30:00-09:00') });
  await patch('p.json', { arrive: '2026-11-20T19:00' });
  assert.deepEqual([(await read('p.json')).start, (await read('p.json')).end], [at('2026-11-20T18:30:00-09:00'), at('2026-11-20T19:00:00-09:00')]);
  // Written with `arrive` and moved with the same word, the end moves, later or earlier, or goes (the re-review's R1: the start it never had
  // was kept, a refusal came for an earlier time, and arrive: null removed nothing); no start appears anywhere.
  for (const [changes, end] of /** @type {[any, string | undefined][]} */ ([[{ arrive: '2026-11-20T20:00' }, '2026-11-20T20:00:00-09:00'], [{ arrive: '2026-11-20T18:00' }, '2026-11-20T18:00:00-09:00'], [{ arrive: null }, undefined]])) {
    await write('q.json', { ...base, kind: 'restaurant', title: 'Test Bistro', arrive: { at: '2026-11-20T19:00', location: 'Test Bistro' } });
    assert.equal(await patch('q.json', changes), 'Patched /trip/bookings/q.json.');
    assert.deepEqual([(await read('q.json')).start, (await read('q.json')).end?.at], [undefined, end], JSON.stringify(changes));
  }
  // Beside a time it starts (a departure, a start), the arrival ends it: a tour booked as an event departs and arrives back.
  await write('t.json', { ...base, kind: 'event', title: 'Glacier tour', depart: '2026-11-21T08:00', arrive: '2026-11-21T18:00' });
  assert.deepEqual([(await read('t.json')).start.at, (await read('t.json')).end.at], ['2026-11-21T08:00:00-09:00', '2026-11-21T18:00:00-09:00']);
  await write('s.json', { ...base, kind: 'restaurant', title: 'Test Bistro', start: at('2026-11-20T18:30:00-09:00'), arrival: '2026-11-20T20:30' });
  assert.deepEqual([(await read('s.json')).start.at, (await read('s.json')).end.at], ['2026-11-20T18:30:00-09:00', '2026-11-20T20:30:00-09:00']);
  // What travels keeps its arrival as its end, alone too.
  for (const kind of ['car', 'other', 'ferry']) {
    await write('x.json', { ...base, kind, arrive: { at: '2026-11-20T18:30', tz: AK } });
    assert.deepEqual([(await read('x.json')).start, (await read('x.json')).end?.at], [undefined, '2026-11-20T18:30:00-09:00'], kind);
  }
  // An edit that adds one is told it is the end, whether the booking has a start or not (one word, one meaning, in every tool).
  for (const start of [undefined, at('2026-11-20T18:30:00-09:00')]) {
    await store('d.json', { ...base, kind: 'restaurant', title: 'Test Bistro', ...(start ? { start } : {}) });
    await assert.rejects(run('edit', { path: '/trip/bookings/d.json', old: '"title": "Test Bistro"', new: '"title": "Test Bistro", "arrival": "2026-11-20 20:30"' }), /"arrival" isn't a booking field, so nothing was written\. arrival is end: write end as \{ "at"/);
  }
  for (const x of [r, e]) agrees(x);
});

test("a patch's arrival is the end of a restaurant or an event, as on main, and never moves or clears its start (the review's F1: an event 08:00 to 18:00 patched with an arrival got a start of 5:30 PM, lost its start with arrive: null, and refused an arrival after 18:00)", async () => {
  const { write, store, patch, read } = await setup();
  const day = (/** @type {string} */ t) => `2026-11-21T${t}`;
  const tour = { ...base, kind: 'event', title: 'Glacier tour', depart: day('08:00'), arrive: day('18:00') };
  /** @type {[any, string | undefined][]} the patch, and the end it leaves (the start is 08:00 in each) */
  const cases = [[{ arrive: day('17:30') }, '17:30'], [{ arrive: null }, undefined], [{ arrive: day('19:00') }, '19:00'], [{ arrival: { at: day('17:30'), location: 'Harbor' } }, '17:30']];
  for (const [changes, end] of cases) {
    await write('e.json', tour);
    assert.equal(await patch('e.json', changes), 'Patched /trip/bookings/e.json.', JSON.stringify(changes));
    const got = await read('e.json');
    assert.deepEqual([got.start?.at, got.end?.at, got.place], ['2026-11-21T08:00:00-09:00', end && `${day(end)}:00-09:00`, undefined], JSON.stringify(changes));
    assert.deepEqual(rows(got).slice(0, 1), ['booking@2026-11-21 08:00 -'], 'on its day of the Plan');
    agrees(got);
  }
  // An arrival's place is where it arrives, as on main: fields.to, and the booking's place is left as it was.
  assert.deepEqual((await read('e.json')).fields, { to: 'Harbor' });
  // A restaurant with its place pinned, patched with the arrival's location the same as its address: the place, its name, its address and its
  // position stay (it became { name: "2 Test Street" } with no pin), and the arrival's place is filed as where it arrives.
  const place = { name: 'Test Bistro', address: '2 Test Street', lat: 61.2, lng: -149.9 };
  await store('r.json', { ...base, kind: 'restaurant', title: 'Test Bistro', place, start: at('2026-11-20T18:30:00-09:00') });
  await patch('r.json', { arrive: { at: '2026-11-20T20:00', location: '2 Test Street' } });
  const r = await read('r.json');
  assert.deepEqual([r.place, r.start, r.end, r.fields], [place, at('2026-11-20T18:30:00-09:00'), at('2026-11-20T20:00:00-09:00'), { to: '2 Test Street' }]);
  assert.deepEqual(rows(r)[0], 'booking@2026-11-20 18:30 Test Bistro (pin)');
  agrees(r);
  // One stored before, with an end and no start, patched: its end moves, as on main.
  await store('o.json', { ...base, kind: 'restaurant', title: 'Test Bistro', end: at('2026-11-20T18:30:00-09:00') });
  await patch('o.json', { arrive: '2026-11-20T19:00' });
  assert.deepEqual([(await read('o.json')).start, (await read('o.json')).end], [undefined, at('2026-11-20T19:00:00-09:00')]);
});

test("legs move the times of what carries the traveller only: a stay or an other booking given legs keeps its start and its end (the review's F2 and the re-review's R3: a stay lost its check-out and its nights, a leg with an arrival moved the check-out, and a whole flights write the check-in too), told nothing when the legs have no time and one note when they have one (it was silent); a train, a ferry, a bus or a coach is read as a flight is", async () => {
  const { store, write, patch, read } = await setup();
  const stay = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test' }, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-27T11:00:00-09:00') };
  const timed = { flight: 'AS 1', departure: { at: '2026-11-25T06:00', tz: LA }, arrival: { at: '2026-11-25T08:00', tz: AK } };
  for (const kind of ['lodging', 'other', 'car', 'restaurant', 'event']) {
    for (const [key, legs, said] of /** @type {[string, any, boolean][]} */ ([['flights+', 'AS 1', false], ['flights+', [{ flight: 'AS 1' }], false], ['flights+', [{ flight: 'AS 1', arrival: { iataCode: 'ANC' } }], false], ['flights+', [timed], true], ['flights', [{ flight: 'AS 1' }], false], ['flights', [timed], true], ['flights', [{ flight: 'AS 1', depart: '2026-11-25T06:00' }], true], ['flights+', [{ flight: 'AS 1', arrive: { at: '2026-11-25T08:00' } }], true]])) {
      const what = `${kind} ${key} ${JSON.stringify(legs)}`;
      await store('s.json', { ...stay, kind });
      assert.equal(await patch('s.json', { [key]: legs }), `Patched /trip/bookings/s.json.${said ? ` ${NO_LEGS}` : ''}`, what);
      const got = await read('s.json');
      assert.deepEqual([got.start, got.end], [stay.start, stay.end], what);
      assert.deepEqual(lines(got).filter((l) => /^(Check-in|Check-out|Starts|Ends|Nights)/.test(l)).length > 0, true, 'the times are drawn');
      assert.equal(rows(got).some((r) => r.startsWith('end@')), true, 'the Plan keeps its end row');
      agrees(got);
    }
  }
  // A whole write of such a booking with legs alone gives no start or end (what it derived from them on main is a flight's rule): said once, whatever the kind.
  for (const kind of ['other', 'lodging', 'car', 'restaurant', 'event']) {
    const said = (await write('o.json', { ...base, kind, title: 'Tour', flights: [timed, { ...timed, flight: 'AS 2' }] })).replace(/ \(\d+ bytes\)(?=\.)/, '');
    assert.equal(said, `Wrote /trip/bookings/o.json. ${NO_LEGS}`, kind);
    const o = await read('o.json');
    assert.deepEqual([o.start, o.end, o.fields.flights], [undefined, undefined, [timed, { ...timed, flight: 'AS 2' }]], kind);
  }
  // Legs with no time say nothing; her own times beside timed legs are kept, and the note is still true of the legs.
  assert.match(await write('o.json', { ...base, kind: 'other', title: 'Tour', flights: [{ flight: 'AS 1' }, 'AS 2'] }), /^Wrote \/trip\/bookings\/o\.json \(\d+ bytes\)\.$/);
  assert.match(await write('o.json', { ...base, kind: 'other', title: 'Tour', start: at('2026-11-25T06:00:00-08:00', LA), flights: [timed] }), /^Wrote \/trip\/bookings\/o\.json \(\d+ bytes\)\. The legs' times are kept as written and set no start or end for this booking \(only a flight, train, ferry, bus or coach takes them from its legs\): when it has no start or end of its own, write them as \{ "at": /);
  assert.deepEqual((await read('o.json')).start, at('2026-11-25T06:00:00-08:00', LA));
  // What carries the traveller keeps what it had: the first leg's departure and the last leg's arrival, and a last leg with no arrival says so.
  for (const kind of ['flight', 'rail', 'ferry', 'bus', 'coach']) {
    await write('t.json', { ...base, kind, title: 'Ride', flights: [timed] });
    const t = await read('t.json');
    assert.deepEqual([t.start, t.end], [at('2026-11-25T06:00:00-08:00', LA), at('2026-11-25T08:00:00-09:00', AK)], kind);
    assert.equal(await patch('t.json', { 'flights+': [{ flight: 'AS 2' }] }), `Patched /trip/bookings/t.json. ${NO_END}`, kind);
    assert.equal('end' in (await read('t.json')), false, kind);
  }
});

test("a drop-off with an object name beside an address keeps the address in the object when it has none, so the Return row keeps its place and pin (a list of the two left the row with no place); an object with an address of its own beside another stays a list", async () => {
  const { write, read } = await setup();
  const car = (/** @type {any} */ dropoff) => write('c.json', { ...base, kind: 'car', title: 'Rentals', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { at: '2026-11-27T09:00', ...dropoff } });
  await car({ location: { name: 'Downtown desk', lat: 61.2, lng: -149.9 }, address: '5 Main St' });
  const got = await read('c.json');
  assert.deepEqual(got.fields, { dropoff: { name: 'Downtown desk', lat: 61.2, lng: -149.9, address: '5 Main St' } });
  assert.equal(rows(got).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Downtown desk (pin)');
  assert.match(lines(got).find((l) => l.startsWith('Drop-off:')) ?? '', /5 Main St/, 'the address is drawn');
  agrees(got);
  // An object with an address of its own beside another one: both kept, as a list (nothing is lost).
  await car({ location: { name: 'Downtown desk', address: '4 Main St' }, address: '5 Main St' });
  assert.deepEqual((await read('c.json')).fields, { dropoff: [{ name: 'Downtown desk', address: '4 Main St' }, '5 Main St'] });
});

test("blank text is not given: a drop-off's blank location files nothing (the Return row stays at the car's place, with its pin), a blank address joins nothing, a blank pick-up location names no place", async () => {
  const { write, read } = await setup();
  const lot = { name: 'Airport lot', address: '9 Other Road', lat: 61.1, lng: -149.9 };
  await write('a.json', { ...base, kind: 'car', title: 'Rentals', place: lot, pickup: '2026-11-20T10:00', dropoff: { at: '2026-11-27T09:00', location: '  ' } });
  const a = await read('a.json');
  assert.deepEqual([a.fields, a.place], [undefined, lot]);
  assert.equal(rows(a).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Airport lot (pin)');
  // A blank address beside a real name joins nothing ("Airport lot,    " was the Drop-off line).
  await write('b.json', { ...base, kind: 'car', title: 'Rentals', place: { name: 'Airport lot', lat: 61.1, lng: -149.9 }, pickup: '2026-11-20T10:00', dropoff: { at: '2026-11-27T09:00', location: 'Downtown desk', address: '   ' } });
  assert.deepEqual((await read('b.json')).fields, { dropoff: 'Downtown desk' });
  await write('c.json', { ...base, kind: 'car', title: 'Rentals', pickup: { at: '2026-11-20T10:00', location: '  ' }, dropoff: '2026-11-27T09:00' });
  assert.equal((await read('c.json')).place, undefined, 'a blank name is no place (it stored { name: "  " })');
  agrees(a);
});

test("a removed alias removes the field it stands for and nothing else, as on main: dropoff: null on a car clears its end and keeps its drop-off, arrive: null keeps a hand-written route (fields.to), checkout: null on a stay keeps its drop-off; a patch of the key itself removes it", async () => {
  const { store, patch, read } = await setup();
  const car = { ...base, kind: 'car', title: 'Rentals', place: { name: 'Airport lot' }, start: at('2026-11-20T10:00:00-09:00'), end: at('2026-11-27T09:00:00-09:00'), fields: { dropoff: 'Downtown Garage, 5 Main St', notes: 'x' } };
  await store('c.json', car);
  assert.equal(await patch('c.json', { dropoff: null }), 'Patched /trip/bookings/c.json.');
  const c = await read('c.json');
  assert.deepEqual([c.end, c.fields], [undefined, car.fields]);
  assert.deepEqual(lines(c).filter((l) => /^(Drop-off|Return|Ends)/.test(l)), ['Drop-off: Downtown Garage, 5 Main St'], 'the drop-off stays, with no time');
  agrees(c);
  // A flight written with its route by hand (the Route line): the arrival removed, its destination stays (the re-review's R2: it was deleted, silently).
  const flight = { ...base, kind: 'flight', title: 'NH 7', fields: { from: 'SFO', to: 'HND' }, start: at('2026-11-20T11:05:00-08:00', LA), end: ARRIVES };
  await store('f.json', flight);
  await patch('f.json', { arrival: null });
  const f = await read('f.json');
  assert.deepEqual([f.end, f.fields], [undefined, { from: 'SFO', to: 'HND' }]);
  assert.deepEqual(lines(f).filter((l) => /^(Route|Arrives)/.test(l)), ['Route: SFO → HND']);
  const stay = { ...base, kind: 'lodging', title: 'Hotel', place: { name: 'Hotel' }, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-22T11:00:00-09:00'), fields: { dropoff: 'Shuttle stop B' } };
  await store('s.json', stay);
  await patch('s.json', { checkout: null });
  assert.deepEqual([(await read('s.json')).end, (await read('s.json')).fields], [undefined, { dropoff: 'Shuttle stop B' }]);
  // The key of its own removes it, in the same patch or another.
  await store('c.json', car);
  await patch('c.json', { dropoff: null, fields: { dropoff: null } });
  assert.deepEqual([(await read('c.json')).end, (await read('c.json')).fields], [undefined, { notes: 'x' }]);
  await store('c.json', car);
  await patch('c.json', { dropoff: null, fields: { dropoff: 'Downtown desk' } });
  assert.deepEqual([(await read('c.json')).end, (await read('c.json')).fields.dropoff], [undefined, 'Downtown desk']);
});

test("a whole flights write whose first leg is text gives no start, as on main, and is told wherever that is true (it was silent, or the note said no end): with the end left out as well when the last leg gave an arrival, beside the arrival's note when the last leg gave none, and alone when the write gives the end itself (end, or an arrival alias); an object first leg with a text last leg gives the start and no end, told; the write's own start lets the last leg's arrival give the end", async () => {
  const { write, read, store, patch } = await setup();
  /** What the write tool says, without the file's size. @param {string} result */
  const told = (result) => result.replace(/ \(\d+ bytes\)(?=\.)/, '');
  const leg = { flight: 'NH 8', departure: { at: '2026-11-25T06:00', tz: TOKYO }, arrival: { at: '2026-11-25T08:00', tz: TOKYO } };
  // A text first leg and a last leg with an arrival: neither is stored (an end with no start is on no day of the Plan), and the first leg is named.
  const said = told(await write('f.json', { ...base, kind: 'flight', flights: ['NH 7', leg] }));
  assert.equal(said, `Wrote /trip/bookings/f.json. ${NO_START_END}`);
  // What it says is true of a first leg that does have a time in it, written in a form annai can't read ("NH 7 SFO-NRT 2026-11-20 11:05"): the departure isn't a date with a time.
  assert.match(said, /^Wrote \/trip\/bookings\/f\.json\. The first leg's departure isn't written as a date with a time \(YYYY-MM-DDTHH:MM\), so the booking has no start or end now: when you know when it leaves and arrives, write start and end as \{ "at": /);
  assert.equal(told(await write('f.json', { ...base, kind: 'flight', flights: ['NH 7 SFO-NRT 2026-11-20 11:05', leg] })), `Wrote /trip/bookings/f.json. ${NO_START_END}`);
  const f = await read('f.json');
  assert.deepEqual([f.start, f.end, f.fields.flights], [undefined, undefined, ['NH 7 SFO-NRT 2026-11-20 11:05', leg]]);
  assert.equal(rows(f).some((r) => r.startsWith('end@')), false, 'no Arrive row for an end that is not there');
  agrees(f);
  // Text legs with no arrival: no start and no end, both said, so she writes both (the arrival's note is the last leg's).
  for (const flights of [['NH 7', 'NH 8'], ['NH 7'], ['NH 7', { flight: 'NH 8' }]]) {
    assert.equal(told(await write('t.json', { ...base, kind: 'flight', flights })), `Wrote /trip/bookings/t.json. ${NO_START} ${NO_END}`, JSON.stringify(flights));
    const t = await read('t.json');
    assert.deepEqual([t.start, t.end, t.fields.flights], [undefined, undefined, flights], JSON.stringify(flights));
    agrees(t);
  }
  // A write that gives the end itself (end, or an arrival alias), beside a text first leg: the end is kept and the missing start is said, whether
  // the last leg gave an arrival or not (it was silent: an end with no start).
  const end = at('2026-11-25T08:00:00+09:00', TOKYO);
  for (const [own, flights] of /** @type {[any, any][]} */ ([[{ end: at('2026-11-25T08:00:00+09:00', TOKYO) }, ['NH 7', leg]], [{ end: at('2026-11-25T08:00:00+09:00', TOKYO) }, ['NH 7', 'NH 8']], [{ arrival: { at: '2026-11-25T08:00', tz: TOKYO } }, ['NH 7', leg]], [{ arrive: { at: '2026-11-25T08:00', tz: TOKYO } }, ['NH 7']]])) {
    const label = JSON.stringify([own, flights]);
    assert.equal(told(await write('e.json', { ...base, kind: 'flight', ...own, flights })), `Wrote /trip/bookings/e.json. ${NO_START}`, label);
    const e = await read('e.json');
    assert.deepEqual([e.start, e.end, e.fields.flights], [undefined, end, flights], label);
    agrees(e);
  }
  // An object first leg with a text last leg: the start, no end, told.
  assert.equal(told(await write('g.json', { ...base, kind: 'flight', flights: [leg, 'NH 9 to HND'] })), `Wrote /trip/bookings/g.json. ${NO_END}`);
  const g = await read('g.json');
  assert.deepEqual([g.start?.at, g.end], ['2026-11-25T06:00:00+09:00', undefined]);
  agrees(g);
  // A start the write gives itself is the booking's start: the last leg's arrival is then its end, and nothing is left out.
  assert.equal(told(await write('h.json', { ...base, kind: 'flight', start: at('2026-11-25T06:00:00+09:00', TOKYO), flights: ['NH 7', leg] })), 'Wrote /trip/bookings/h.json.');
  const h = await read('h.json');
  assert.deepEqual([h.start, h.end], [at('2026-11-25T06:00:00+09:00', TOKYO), at('2026-11-25T08:00:00+09:00', TOKYO)]);
  agrees(h);
  // A patch that replaces the legs with a text first leg keeps the start it has stored and moves the end to the last leg's arrival; nothing
  // false is said (NO_START is a whole write's: the stored booking still has a start).
  await store('p.json', { ...base, kind: 'flight', title: 'NH 7', start: at('2026-11-20T11:05:00-08:00', LA), end: ARRIVES });
  assert.equal(await patch('p.json', { flights: ['NH 7', leg] }), 'Patched /trip/bookings/p.json.');
  const p = await read('p.json');
  assert.deepEqual([p.start, p.end], [at('2026-11-20T11:05:00-08:00', LA), at('2026-11-25T08:00:00+09:00', TOKYO)]);
  agrees(p);
});

test("a blank top-level location or address says nothing, as one in an alias object does: in a patch the stored place stays (it was wiped to the blank name, and its address and pin went with it), in a whole write no place is made of it", async () => {
  const { write, store, patch, read } = await setup();
  const place = { name: 'Hilton Airport', address: '1 Airport Rd', lat: 61.17, lng: -149.99 };
  const hotel = { ...base, kind: 'lodging', title: 'Hilton', place, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-22T11:00:00-09:00') };
  for (const changes of [{ location: '  ' }, { address: '  ' }, { location: ' ', address: '\t' }]) {
    await store('h.json', hotel);
    assert.equal(await patch('h.json', changes), 'Patched /trip/bookings/h.json.', JSON.stringify(changes));
    assert.deepEqual((await read('h.json')).place, place, JSON.stringify(changes));
  }
  // Beside a real one, the blank adds nothing: the new address replaces the old (its pin goes with it), the name stays.
  await store('h.json', hotel);
  await patch('h.json', { location: '  ', address: '2 New Road' });
  assert.deepEqual((await read('h.json')).place, { name: 'Hilton Airport', address: '2 New Road' });
  await write('w.json', { ...base, kind: 'lodging', title: 'Hilton', location: '  ', address: '\t' });
  assert.equal((await read('w.json')).place, undefined, 'a place of blanks is no place');
});

test("a car stored with a blank drop-off (on main a blank was stored) returns at its place with its pin: the Plan's Return row reads a drop-off by whether it is there, not whether it is written", async () => {
  const { store, read } = await setup();
  const lot = { name: 'Airport lot', address: '9 Other Road', lat: 61.1, lng: -149.9 };
  for (const dropoff of ['  ', { name: '  ' }, { name: ' ', address: ' ' }]) {
    await store('c.json', { ...base, kind: 'car', title: 'Rentals', place: lot, start: at('2026-11-20T10:00:00-09:00'), end: at('2026-11-27T09:00:00-09:00'), fields: { dropoff } });
    const c = await read('c.json');
    assert.equal(rows(c).find((r) => r.startsWith('end@')), 'end@2026-11-27 09:00 Airport lot (pin)', JSON.stringify(dropoff));
    assert.deepEqual(lines(c).filter((l) => /^Drop-off/.test(l)), [], 'a blank drop-off is not drawn');
  }
});

test("the Plan's Return row moves to the drop-off for a car only: a stay's, an event's, a restaurant's or an other booking's drop-off elsewhere leaves its end row at its own place, with its pin", async () => {
  const { store, read } = await setup();
  const place = { name: 'Test Place', address: '1 Test Street', lat: 61.2, lng: -149.9 };
  for (const kind of ['lodging', 'other', 'event', 'restaurant']) {
    await store('k.json', { ...base, kind, title: 'Test', place, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-23T11:00:00-09:00'), fields: { dropoff: 'Shuttle stop B' } });
    const k = await read('k.json');
    assert.equal(rows(k).find((r) => r.startsWith('end@')), 'end@2026-11-23 11:00 Test Place (pin)', kind);
    assert.deepEqual(lines(k).filter((l) => /^Drop-off/.test(l)), ['Drop-off: Shuttle stop B'], `${kind}: drawn, as a line`);
  }
  // The same drop-off on a car is the Return row's place.
  await store('k.json', { ...base, kind: 'car', title: 'Test', place, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-23T11:00:00-09:00'), fields: { dropoff: 'Shuttle stop B' } });
  assert.equal(rows(await read('k.json')).find((r) => r.startsWith('end@')), 'end@2026-11-23 11:00 Shuttle stop B');
});

test("unsure's name for an end that has a place is its time's: a stay's check-out at a shuttle stop written with unsure checkout, and a car's drop-off with unsure dropoff, are stored as the end, and the end's line carries the check (the rename keeps the mark on the line it names)", async () => {
  const { write, read } = await setup();
  await write('s.json', { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test' }, checkin: '2026-11-20T15:00', checkout: { at: '2026-11-22T11:00', location: 'Shuttle stop B' }, unsure: ['checkout'] });
  const s = await read('s.json');
  assert.deepEqual([s.unsure, s.fields, checkOf(s).fields], [['end'], { dropoff: 'Shuttle stop B' }, ['end']]);
  assert.deepEqual(lines(s).filter((l) => /^(Check-out|Drop-off)/.test(l)), ['Check-out: Sun, Nov 22, 11:00 AM (AKT) (check)', 'Drop-off: Shuttle stop B']);
  agrees(s);
  await write('c.json', { ...base, kind: 'car', title: 'Rentals', place: { name: 'Airport lot' }, pickup: '2026-11-20T10:00', dropoff: { at: '2026-11-27T09:00', location: 'Downtown desk' }, unsure: ['dropoff', 'pickup'] });
  const c = await read('c.json');
  assert.deepEqual([c.unsure, checkOf(c).fields], [['end', 'start'], ['end', 'start']]);
  agrees(c);
});

/** One leg, Seattle to Anchorage, each time with its own zone. */
const AS1 = { flight: 'AS 1', departure: { at: '2026-11-25T06:00', tz: LA }, arrival: { at: '2026-11-25T08:00', tz: AK } };
const AS1_START = at('2026-11-25T06:00:00-08:00', LA);
const AS1_END = at('2026-11-25T08:00:00-09:00', AK);
/** The labels of the lines drawn with a check. @param {any} b */
const checked = (b) => lines(b).filter((l) => l.endsWith(' (check)')).map((l) => l.slice(0, l.indexOf(':')));

test("what carries the traveller departs and arrives: unsure's departure or depart marks its start, and arrival or arrive its end, where the booking has that time, however the time was written or stored (its legs, the other alias, start and end, a patch of unsure alone, a file the user or an older annai stored with the name, an end added after her write): the Departs or Arrives line carries the check, the chip counts it and Shiori is told it (it marked nothing: the Deferred entry); the name is read where the marks are read, and nothing is written back", async () => {
  const { write, store, patch, read } = await setup();
  for (const kind of ['flight', 'rail', 'ferry', 'bus', 'coach']) {
    // The legs gave the times: each name on its own.
    for (const [name, to, line, words] of [['departure', 'start', 'Departs', 'the departure time'], ['depart', 'start', 'Departs', 'the departure time'], ['arrival', 'end', 'Arrives', 'the arrival time'], ['arrive', 'end', 'Arrives', 'the arrival time']]) {
      await write('l.json', { ...base, kind, flights: [AS1], unsure: [name] });
      const l = await read('l.json');
      assert.deepEqual([checkOf(l).fields, checked(l), checkWords(l), checkCount(l, { fallbackTz: AK })], [[to], [line], `not sure ${words} was read right`, 1], `${kind} ${name}`);
      agrees(l);
    }
    // The other alias gave the time (arrival beside unsure arrive; depart beside unsure departure), and start and end as stored.
    await write('a.json', { ...base, kind, depart: at('2026-11-25T06:00', LA), arrival: at('2026-11-25T08:00', AK), unsure: ['arrive', 'departure'] });
    const a = await read('a.json');
    assert.deepEqual([a.start, a.end, checkOf(a).fields, checked(a)], [AS1_START, AS1_END, ['end', 'start'], ['Departs', 'Arrives']], kind);
    agrees(a);
    await write('s.json', { ...base, kind, start: AS1_START, end: AS1_END, unsure: ['depart', 'arrival', 'title'] });
    assert.deepEqual(checkOf(await read('s.json')).fields, ['start', 'end'], kind);
    agrees(await read('s.json'));
    // A patch of unsure alone, on a stored booking: unsure, then unsure+ (one name, not a list).
    await store('p.json', { ...base, kind, title: 'AS 1', start: AS1_START, end: AS1_END });
    assert.equal(await patch('p.json', { unsure: ['departure'] }), 'Patched /trip/bookings/p.json.');
    assert.deepEqual([checkOf(await read('p.json')).fields, checked(await read('p.json'))], [['start'], ['Departs']], kind);
    await patch('p.json', { 'unsure+': 'arrive' });
    const p = await read('p.json');
    assert.deepEqual([checkOf(p).fields, checked(p), checkWords(p)], [['start', 'end'], ['Departs', 'Arrives'], 'not sure the departure time or the arrival time was read right'], kind);
    agrees(p);
    // A booking the user stored, or an older annai, or a restore brought back, with the names as she wrote them: marked, and nothing is
    // written back (the reading is the screens' own). Her words and the chip say it too.
    const old = { ...base, kind, title: 'AS 1', start: AS1_START, end: AS1_END, unsure: ['arrival', 'depart', 'title'] };
    await store('o.json', old);
    const o = await read('o.json');
    assert.deepEqual([o.unsure, checkOf(o).fields, checked(o), checkWords(o), checkCount(o, { fallbackTz: AK })], [old.unsure, ['end', 'start', 'title'], ['Departs', 'Arrives'], 'not sure the arrival time, the departure time or the name was read right', 3], kind);
    agrees(o);
    // An unrelated patch of such a booking changes no mark (before, it was marked as a side effect of the write).
    await patch('o.json', { confirmation: 'ABC123' });
    assert.deepEqual([checkOf(await read('o.json')).fields, (await read('o.json')).unsure], [['end', 'start', 'title'], old.unsure], kind);
    // An end added after her write (by the user, or a later patch): the name she gave, the line it names.
    await write('n.json', { ...base, kind, depart: at('2026-11-25T06:00', LA), unsure: ['arrival'] });
    assert.deepEqual([checkOf(await read('n.json')).fields, checkWords(await read('n.json'))], [[], ''], kind);
    await store('n.json', { ...(await read('n.json')), end: AS1_END });
    assert.deepEqual([checkOf(await read('n.json')).fields, checked(await read('n.json'))], [['end'], ['Arrives']], kind);
  }
});

test("unsure's departure and arrival are read by what the record has: no such time (of its own, or a detail named `start` or `end`, which the details draw as its line) marks nothing, and marks it once it is there; a key of fields of that name, blank or not, is that detail (a blank one is no detail, so the time is marked); a stay's arrival and check-in are its start and its check-out and departure its end, a car's pick-up and departure its start and its return and arrival its end, an `other` booking's as what carries the traveller's; a drop-off is never an end; a restaurant's and an event's are read as written (their arrival is the open Deferred entry)", async () => {
  const { write, store, patch, read } = await setup();
  // No end: the arrival marks nothing, as it has nothing to mark; the end, once there, takes the mark (a later write, or the user's own).
  await write('n.json', { ...base, kind: 'flight', depart: at('2026-11-25T06:00', LA), unsure: ['arrival'] });
  const n = await read('n.json');
  assert.deepEqual([checkOf(n).fields, checked(n), checkWords(n)], [[], [], '']);
  await patch('n.json', { end: AS1_END });
  assert.deepEqual([checkOf(await read('n.json')).fields, checked(await read('n.json'))], [['end'], ['Arrives']]);
  agrees(await read('n.json'));
  // A key of fields named arrival or departure (annai filed an arrival's place as fields.arrival before booking-next; a model writes one):
  // the name is that detail, whatever the legs gave, and whoever stored it. Its line carries the check; the time's doesn't.
  const detail = { ...base, kind: 'flight', fields: { arrival: 'Terminal 2', departure: 'Gate 9' }, flights: [AS1] };
  await write('f.json', { ...detail, unsure: ['arrival', 'depart'] });
  const f = await read('f.json');
  assert.deepEqual([checkOf(f).fields, checked(f)], [['arrival', 'start'], ['Departs', 'Arrival']]);
  agrees(f);
  await store('f2.json', { ...f, unsure: ['arrival', 'departure'] });
  assert.deepEqual([checkOf(await read('f2.json')).fields, checked(await read('f2.json'))], [['arrival', 'departure'], ['Arrival', 'departure']]);
  agrees(await read('f2.json'));
  await store('g.json', { ...base, kind: 'flight', title: 'AS 1', start: AS1_START, end: AS1_END, fields: { arrival: 'Haneda Airport' } });
  await patch('g.json', { 'unsure+': ['arrival'] });
  assert.deepEqual([checkOf(await read('g.json')).fields, checked(await read('g.json'))], [['arrival'], ['Arrival']]);
  // A detail of that name that is blank is no detail: the name is the time's (the details draw no line for it).
  await write('h.json', { ...base, kind: 'flight', fields: { arrival: ' ', departure: null }, flights: [AS1], unsure: ['arrival', 'departure'] });
  const h = await read('h.json');
  assert.deepEqual([checkOf(h).fields, checked(h)], [['end', 'start'], ['Departs', 'Arrives']]);
  agrees(h);
  // A detail given later takes the name: the mark moves to it (the name follows the record).
  await patch('h.json', { fields: { arrival: 'Terminal 2' } });
  assert.deepEqual([checkOf(await read('h.json')).fields, checked(await read('h.json'))], [['arrival', 'start'], ['Departs', 'Arrival']]);
  // A name for a time marks the part it stands for where the booking has it: its own, or a detail named like it. A flight with no start of
  // its own and a detail named `start` is drawn "Departs: <the detail>" (format.js draws a same-named detail as the part's line when the part
  // draws nothing), and her departure is that line's time: the line carries the check, and her words name the departure time.
  await store('m.json', { ...base, kind: 'flight', title: 'AS 1', fields: { start: 'Gate opens 05:00', end: 'Gate shuts 07:30' }, unsure: ['departure', 'arrival'] });
  const m = await read('m.json');
  assert.deepEqual(lines(m), ['Departs: Gate opens 05:00 (check)', 'Arrives: Gate shuts 07:30 (check)']);
  assert.deepEqual([checkOf(m).fields, checked(m), checkWords(m), checkCount(m, { fallbackTz: AK })], [['start', 'end'], ['Departs', 'Arrives'], 'not sure the departure time or the arrival time was read right', 2]);
  agrees(m);
  await store('m.json', { ...m, unsure: ['start', 'end', 'depart'] });
  assert.deepEqual(checkOf(await read('m.json')).fields, ['start', 'end']);
  agrees(await read('m.json'));
  await store('m.json', { ...m, start: AS1_START, end: AS1_END, unsure: ['depart', 'arrive'] }); // once the time is there, the name is its
  assert.deepEqual([checkOf(await read('m.json')).fields, checked(await read('m.json'))], [['start', 'end'], ['Departs', 'Arrives']]);
  // A stay's arrival is its check-in, as unalias reads its alias (stored as the start there); in a patch of unsure alone, or stored by the
  // user, a stay's names are read the same: arrival and check-in its start, departure and check-out its end. Never its drop-off.
  await write('i.json', { ...base, kind: 'lodging', title: 'Inn', arrival: '2026-11-20T15:00', departure: '2026-11-22T11:00', unsure: ['arrival'] });
  assert.deepEqual([checkOf(await read('i.json')).fields, checked(await read('i.json'))], [['start'], ['Check-in']]);
  const stay = { ...base, title: 'Inn', start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-22T11:00:00-09:00') };
  const car = { ...stay, kind: 'car', title: 'Rentals' };
  /** @type {[any, string[], string[], string, string][]} the booking, unsure as stored, the marks, the line drawn with a check, the words */
  const reads = [
    [{ ...stay, kind: 'lodging' }, ['arrival'], ['start'], 'Check-in', 'the check-in time'],
    [{ ...stay, kind: 'lodging' }, ['arrive', 'checkin'], ['start'], 'Check-in', 'the check-in time'],
    [{ ...stay, kind: 'lodging' }, ['departure'], ['end'], 'Check-out', 'the check-out time'],
    [{ ...stay, kind: 'lodging' }, ['checkout', 'depart'], ['end'], 'Check-out', 'the check-out time'],
    [car, ['departure', 'pickup'], ['start'], 'Starts', 'the pick-up time'],
    [car, ['arrival', 'return'], ['end'], 'Ends', 'the return time'],
    // Each of those names alone (the pairs above are marked by their departure or arrival name too), and a flight's `checkin`: every name
    // `unalias` reads is read for every kind but a restaurant or an event (a flight's `checkin:` is its start).
    [{ ...stay, kind: 'lodging' }, ['checkin'], ['start'], 'Check-in', 'the check-in time'],
    [{ ...stay, kind: 'lodging' }, ['checkout'], ['end'], 'Check-out', 'the check-out time'],
    [car, ['pickup'], ['start'], 'Starts', 'the pick-up time'],
    [car, ['return'], ['end'], 'Ends', 'the return time'],
    [{ ...stay, kind: 'flight', title: 'AS 1' }, ['checkin'], ['start'], 'Departs', 'the departure time'],
    [{ ...stay, kind: 'other', title: 'Tour' }, ['depart'], ['start'], 'Starts', 'the start time'],
    [{ ...stay, kind: 'other', title: 'Tour' }, ['arrive'], ['end'], 'Ends', 'the end time'],
  ];
  for (const [b, unsure, marks, label, words] of reads) {
    const what = `${b.kind} ${JSON.stringify(unsure)}`;
    await store('k.json', b);
    assert.equal(await patch('k.json', { unsure }), 'Patched /trip/bookings/k.json.', what);
    const k = await read('k.json');
    assert.deepEqual([k.unsure, checkOf(k).fields, checked(k), checkWords(k)], [unsure, marks, [label], `not sure ${words} was read right`], what);
    agrees(k);
    await store('k.json', { ...b, unsure }); // stored by the user: the same
    assert.deepEqual(checkOf(await read('k.json')).fields, marks, what);
  }
  // A drop-off is a place too: it is never read as the end, in any of its spellings (a car's drop-off elsewhere marks its drop-off line; with
  // none, nothing).
  for (const name of ['dropoff', 'drop_off', 'dropOff']) {
    await store('d.json', { ...car, unsure: [name] });
    assert.deepEqual([checkOf(await read('d.json')).fields, checkWords(await read('d.json'))], [[], ''], name);
  }
  await store('d.json', { ...car, unsure: ['dropoff'], fields: { dropoff: 'Downtown desk' } });
  assert.deepEqual([checkOf(await read('d.json')).fields, checked(await read('d.json'))], [['dropoff'], ['Drop-off']]);
  // A name that is no time, or an odd one, marks nothing and throws nothing.
  await store('d.json', { ...car, unsure: ['constructor', '__proto__', 'toString', 'nights'] });
  assert.deepEqual(checkOf(await read('d.json')).fields, []);
  // A restaurant's or an event's names are as written: its arrival marks nothing unless it is a key of fields (the Deferred entry).
  for (const kind of ['event', 'restaurant']) {
    await store('k.json', { ...stay, kind });
    await patch('k.json', { unsure: ['departure', 'arrival', 'depart', 'arrive', 'checkin', 'checkout'] });
    assert.deepEqual([checkOf(await read('k.json')).fields, checkWords(await read('k.json'))], [[], ''], kind);
    agrees(await read('k.json'));
  }
});

test("a lone flights value is no leg, as on main (the Deferred entry): a whole write of an object or of text gives no start and no end and says nothing, a bare object is taken, a top-level tz beside it is refused, and any other kind is told nothing; a patch's lone value is merged into what is stored and moves no time (so a new lone leg keeps the old Departs, Arrives and Plan day), and a lone object patched onto a list of legs replaces them all; a list of legs, and a lone flights+ value in a patch, give the times, and a blank one is none (the stored end stays)", async () => {
  const { write, store, patch, read, ws, trip } = await setup();
  const told = (/** @type {string} */ result) => result.replace(/ \(\d+ bytes\)(?=\.)/, '');
  // A whole write: the object and the text are kept as written and give no times, and the result says only "Wrote" (the details draw the
  // Flights line, and the Plan lists the booking on no day). A one-leg list gives them.
  assert.equal(told(await write('o.json', { ...base, kind: 'flight', title: 'AS 1', flights: AS1 })), 'Wrote /trip/bookings/o.json.');
  const o = await read('o.json');
  assert.deepEqual([o.start, o.end, o.fields.flights, lines(o), rows(o)], [undefined, undefined, AS1, ['Flights: AS 1 · Nov 25 06:00–⁠08:00'], ['booking@null  -']]);
  agrees(o);
  assert.equal(told(await write('t.json', { ...base, kind: 'flight', flights: 'AS 1 SEA-ANC 2026-11-25 06:00' })), 'Wrote /trip/bookings/t.json.');
  assert.deepEqual([(await read('t.json')).start, (await read('t.json')).end], [undefined, undefined]);
  await write('l.json', { ...base, kind: 'flight', title: 'AS 1', flights: [AS1] });
  assert.deepEqual([(await read('l.json')).start, (await read('l.json')).end], [AS1_START, AS1_END]);
  // A bare object (no departure) is taken as it was, not refused; a top-level tz beside it is no booking field; another kind is told nothing.
  assert.equal(told(await write('b.json', { ...base, kind: 'flight', flights: { flight: 'AS 1' } })), 'Wrote /trip/bookings/b.json.');
  await assert.rejects(write('z.json', { ...base, kind: 'flight', tz: LA, flights: AS1 }), /^Error: "tz" isn't a booking field, so nothing was written\./);
  assert.equal(told(await write('x.json', { ...base, kind: 'other', title: 'Tour', flights: AS1 })), 'Wrote /trip/bookings/x.json.');
  assert.equal(await ws.read(trip, '/bookings/z.json'), undefined);
  // A patch's lone value is merged into what is stored (an object key by key) and moves no time, whatever it holds: part of a leg, a whole
  // leg with its own times (the old Departs, Arrives and Plan day stay beside the new Flights line), or text.
  const was = { ...base, kind: 'flight', title: 'AS 1', start: AS1_START, end: AS1_END, fields: { flights: AS1 } };
  const next = { flight: 'AS 3', departure: { at: '2026-11-26T06:00', tz: LA }, arrival: { at: '2026-11-26T08:00', tz: AK } };
  /** @type {[any, any][]} the patch's lone value, and the stored leg after it */
  const parts = [
    [{ flight: 'AS 2' }, { ...AS1, flight: 'AS 2' }],
    [{ departure: { at: '2026-11-25T07:00', tz: LA } }, { ...AS1, departure: { at: '2026-11-25T07:00', tz: LA } }],
    [{ arrival: { at: '2026-11-25T09:00', tz: AK } }, { ...AS1, arrival: { at: '2026-11-25T09:00', tz: AK } }],
    [next, next],
    ['AS 9 to HND', 'AS 9 to HND'],
  ];
  for (const [flights, leg] of parts) {
    await store('s.json', was);
    assert.equal(await patch('s.json', { flights }), 'Patched /trip/bookings/s.json.', JSON.stringify(flights));
    const s = await read('s.json');
    assert.deepEqual([s.start, s.end, s.fields.flights], [AS1_START, AS1_END, leg], JSON.stringify(flights));
    agrees(s);
  }
  assert.deepEqual(rows(await read('s.json')), ['booking@2026-11-25 06:00 -', 'end@2026-11-25 08:00 -'], 'the Plan stays on the old day');
  // A lone object onto a list of legs replaces every leg (a merge patch replaces a list), silently.
  await store('s.json', { ...was, fields: { flights: [AS1, next] } });
  assert.equal(await patch('s.json', { flights: { flight: 'AS 3' } }), 'Patched /trip/bookings/s.json.');
  assert.deepEqual((await read('s.json')).fields.flights, { flight: 'AS 3' });
  // A top-level tz, or a start past the stored end, beside a lone value: as without it.
  await assert.rejects(patch('s.json', { flights: AS1, tz: LA }), /^Error: "tz" isn't a booking field, so nothing was written\./);
  await assert.rejects(patch('s.json', { flights: AS1, start: at('2026-11-30T09:00:00-08:00', LA) }), /is before start/);
  // A lone flights+ value in a patch is one leg: it appends and moves the end. A blank one is none (round 1's guard, kept): nothing is read
  // from it and the stored end stays, said nothing (main read it as a leg with no arrival and removed the end, said).
  await store('s.json', { ...was, fields: {}, end: ARRIVES });
  assert.equal(await patch('s.json', { 'flights+': AS1 }), 'Patched /trip/bookings/s.json.');
  assert.deepEqual([(await read('s.json')).start, (await read('s.json')).end], [AS1_START, AS1_END]);
  const flight = { ...base, kind: 'flight', title: 'NH 7', start: at('2026-11-20T11:05:00-08:00', LA), end: ARRIVES };
  for (const leg of ['', {}, '  ']) {
    await store('q.json', flight);
    assert.equal(await patch('q.json', { 'flights+': leg }), 'Patched /trip/bookings/q.json.', JSON.stringify(leg));
    const q = await read('q.json');
    assert.deepEqual([q.start, q.end], [flight.start, ARRIVES], JSON.stringify(leg));
    agrees(q);
    // Beside a top-level tz (a blank leg is none, so the tz is nobody's: refused as on any booking), or a start past the stored end
    // (refused, end before start): main took both only because the blank leg cleared the end.
    await assert.rejects(patch('q.json', { 'flights+': leg, tz: AK }), /^Error: "tz" isn't a booking field, so nothing was written\./, JSON.stringify(leg));
    await assert.rejects(patch('q.json', { 'flights+': leg, start: at('2026-11-30T09:00:00-08:00', LA) }), /is before start/, JSON.stringify(leg));
    assert.deepEqual(await read('q.json'), q, 'nothing was stored');
  }
});

test("a grid of shapes: for every kind, way of writing the times and unsure list, Shiori's words, the chip and the drawn lines agree with what the check marks, and each departure or arrival she named is marked on the part it stands for (a carrier's Departs or Arrives, a stay's check-in or check-out, a car's or an `other` booking's start or end) where the booking has that time and no detail has that name, and a restaurant's or an event's names are read as written", async () => {
  const { write, store, patch, read } = await setup();
  const stored = { ...base, title: 'Booking', start: at('2026-11-25T06:00:00-08:00', LA), end: at('2026-11-26T08:00:00-09:00', AK) };
  const two = { ...AS1, arrival: { at: '2026-11-26T08:00', tz: AK } };
  /** Each way of writing the times: [name, the write or the patch, whether it is a patch of a stored booking]. @type {[string, any, boolean][]} */
  const ways = [
    ['legs', { flights: [two] }, false],
    ['departure and arrival', { departure: at('2026-11-25T06:00', LA), arrival: at('2026-11-26T08:00', AK) }, false],
    ['depart and arrive', { depart: at('2026-11-25T06:00', LA), arrive: at('2026-11-26T08:00', AK) }, false],
    ['start and end', { start: stored.start, end: stored.end }, false],
    ['legs and details', { flights: [two], fields: { arrival: 'Terminal 2', departure: 'Gate 9' } }, false],
    ['unsure alone', {}, true],
    ['flights+', { 'flights+': [{ ...two, flight: 'AS 2', departure: { at: '2026-11-26T10:00', tz: AK }, arrival: { at: '2026-11-26T12:00', tz: AK } }] }, true],
  ];
  const lists = [[], ['departure'], ['depart'], ['arrival'], ['arrive'], ['departure', 'arrive'], ['arrival', 'end'], ['depart', 'arrival', 'flights']];
  const [arriving, leaving] = [['arrive', 'arrival'], ['depart', 'departure']];
  /** The part each of her four names stands for, by kind: a stay's arrival is its check-in; a restaurant's and an event's are read as written. */
  const part = (/** @type {string} */ kind, /** @type {string} */ name) => {
    if (kind === 'restaurant' || kind === 'event') return '';
    return (arriving.includes(name) ? kind === 'lodging' : kind !== 'lodging') ? 'start' : 'end';
  };
  let shapes = 0;
  let refused = 0;
  for (const kind of ['flight', 'rail', 'ferry', 'bus', 'coach', 'lodging', 'car', 'other', 'event', 'restaurant']) {
    for (const [way, own, isPatch] of ways) {
      for (const unsure of lists) {
        const what = `${kind} ${way} ${JSON.stringify(unsure)}`;
        if (isPatch) {
          await store('g.json', { ...stored, kind });
          await patch('g.json', { ...own, unsure });
        } else {
          try {
            await write('g.json', { ...base, kind, title: 'Booking', ...own, unsure });
          } catch (e) {
            // A stay's departure before its arrival is its check-out before its check-in: refused, so no shape to look at. Nothing else is.
            if (kind !== 'lodging' || !/ is before start /.test(String(/** @type {any} */ (e)?.message))) throw e;
            refused++;
            continue;
          }
        }
        const b = await read('g.json');
        agrees(b);
        shapes++;
        const details = record(b.fields) ?? {};
        const marks = checkOf(b).fields;
        for (const name of [...arriving, ...leaving]) {
          const to = part(kind, name);
          const reads = Boolean(to) && b.unsure.includes(name) && there(b[to]) && !there(details[name]);
          if (reads) {
            assert.ok(marks.includes(to), `${what}: ${name} marks ${to}`);
            if (CARRIERS.has(kind)) assert.ok(checked(b).includes(to === 'start' ? 'Departs' : 'Arrives'), `${what}: ${name} on the line it names`);
          } else if (b.unsure.includes(name) && there(details[name])) assert.ok(marks.includes(name), `${what}: ${name} is the detail`);
          else if (!to && !b.unsure.includes('start') && !b.unsure.includes('end')) assert.deepEqual(marks.filter((k) => k === 'start' || k === 'end'), [], `${what}: ${name} read as written`);
        }
      }
    }
  }
  assert.equal(refused, 16, 'the stays refused: a check-out before its check-in, in the two ways that give a departure and an arrival');
  assert.equal(shapes, 544, `${shapes} shapes`);
});
