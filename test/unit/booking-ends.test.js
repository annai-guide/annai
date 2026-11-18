// The booking time path's design check (2026-11-18, its Option 1): an end's place is read by what is booked and filed whole, never compared
// at write time; a flight's end is its last leg's placed arrival, or none, and the write's result says so; one answer (dropsAtPlace) to
// whether a drop-off names the booking's own place, read by the Plan's Return row, the details and the check; a restaurant's or an event's
// arrival alone is its start. Each shape goes through the files plugin's write and patch tools, then what the details draw (bookingFacts),
// what the Plan draws (planRows), what the check marks (checkOf, checkCount) and what Shiori is told (checkWords, the tool's result).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOf, checkWords, dropsAtPlace } from '../../src/core/bookings.js';
import { planRows } from '../../src/core/plan.js';
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
const NO_END = 'The last leg gives no date and time of arrival, so the booking has no arrival time now: when you know when it arrives, write end as { "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" }.';

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
 * What Shiori is told of the check, the chip and the drawn lines agree: every part checkOf marks is drawn with its check (the name is the
 * heading), every check drawn is a part it marks, the chip counts what is drawn, and her words name as many parts as the chip counts.
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

test("a stored stay's check-out patched with its own address or name, or a departure with its address: the end moves, and nothing else is kept (no Drop-off line repeating the place; it drew one)", async () => {
  const { store, patch, read } = await setup();
  const stay = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test', address: '1 Test Street', lat: 61.2, lng: -149.9 }, start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-27T11:00:00-09:00') };
  for (const changes of [{ checkout: { at: '2026-11-26T11:00', location: '1 Test Street' } }, { checkout: { at: '2026-11-26T11:00', location: 'Hotel Aurora Test' } }, { departure: { at: '2026-11-26T11:00', address: '1 Test Street' } }, { checkout: { at: '2026-11-26T11:00', location: 'Shuttle stop B' } }]) {
    await store('s.json', stay);
    assert.equal(await patch('s.json', changes), 'Patched /trip/bookings/s.json.');
    const got = await read('s.json');
    assert.deepEqual([got.end, got.fields, got.place], [at('2026-11-26T11:00:00-09:00'), undefined, stay.place], JSON.stringify(changes));
    assert.deepEqual(lines(got).filter((l) => /^(Place|Drop-off|To):/.test(l)), ['Place: Hotel Aurora Test, 1 Test Street'], JSON.stringify(changes));
    assert.equal(rows(got).find((r) => r.startsWith('end@')), 'end@2026-11-26 11:00 Hotel Aurora Test (pin)', 'the check-out at the hotel, with its position');
    agrees(got);
  }
});

test("proposed known limitation: a stay's place or address written only with its check-out is not kept (keeping it needs the comparison that drew a Drop-off line repeating the hotel)", async () => {
  const { write, read } = await setup();
  // A check-in with the name and a check-out with the address: the Place line is the name; the address is not kept.
  await write('a.json', { ...base, kind: 'lodging', checkin: { at: '2026-11-20T15:00', location: 'Hotel Aurora' }, checkout: { at: '2026-11-22T11:00', address: '1 Test Street' } });
  const a = await read('a.json');
  assert.deepEqual([a.place, a.fields, a.end], [{ name: 'Hotel Aurora' }, undefined, at('2026-11-22T11:00:00-09:00')]);
  assert.deepEqual(lines(a).filter((l) => /^(Place|Drop-off):/.test(l)), ['Place: Hotel Aurora']);
  // A check-in with a time only and a check-out with the name: no Place line, and nothing else drawn for it.
  await write('b.json', { ...base, kind: 'lodging', checkin: '2026-11-20T15:00', checkout: { at: '2026-11-22T11:00', location: 'Hotel Aurora' } });
  const b = await read('b.json');
  assert.deepEqual([b.place, b.fields, b.end], [undefined, undefined, at('2026-11-22T11:00:00-09:00')]);
  assert.deepEqual(lines(b).filter((l) => /^(Place|Drop-off):/.test(l)), []);
  // A dropoff written on a stay is read by its kind too: its time alone.
  await write('c.json', { ...base, kind: 'lodging', title: 'Hotel Aurora', checkin: '2026-11-20T15:00', dropoff: { at: '2026-11-22T11:00', location: 'Airport' } });
  assert.deepEqual([(await read('c.json')).fields, (await read('c.json')).end], [undefined, at('2026-11-22T11:00:00-09:00')]);
  for (const x of [a, b]) agrees(x);
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
});

/** A flight stored through the write tool with one leg, SFO to NRT, ending 15:40 in Tokyo on the 21st. */
const NH7 = { flight: 'NH 7', departure: { iataCode: 'SFO', at: '2026-11-20T11:05' }, arrival: { iataCode: 'NRT', at: '2026-11-21T15:40', tz: TOKYO }, tz: LA };
const ARRIVES = at('2026-11-21T15:40:00+09:00', TOKYO);

test("flights+ whose last leg gives no date and time of arrival (none, an airport, a clock alone, text, a date alone, a number, a day that doesn't exist) is appended as written, the booking's end is removed, and the result says so (the end stayed at the leg before, or it was refused)", async () => {
  const { write, patch, read } = await setup();
  for (const arrival of [undefined, { iataCode: 'HND' }, 'HND', '08:00', '8:00 AM', '2026-11-25', 800, '2026-11-31T08:00', { iataCode: 'HND', at: '' }, { iataCode: 'HND', at: '08:00', tz: TOKYO }]) {
    await write('f.json', { ...base, kind: 'flight', title: 'NH 7 / NH 8', flights: [NH7] });
    assert.deepEqual((await read('f.json')).end, ARRIVES);
    const leg = { flight: 'NH 8', departure: { at: '2026-11-25T06:00', tz: TOKYO }, ...(arrival === undefined ? {} : { arrival }) };
    assert.equal(await patch('f.json', { 'flights+': [leg] }), `Patched /trip/bookings/f.json. ${NO_END}`, JSON.stringify(arrival));
    const got = await read('f.json');
    assert.deepEqual(['end' in got, got.start, got.fields.flights], [false, at('2026-11-20T11:05:00-08:00', LA), [NH7, leg]], JSON.stringify(arrival));
  }
});

test("flights+ with two legs whose last has no arrival: no end (it stayed two legs back); with end in the same patch: that end, said nothing; a last leg's date and time with no zone of its own: refused, nothing stored; with its zone: the end moves", async () => {
  const { write, patch, read } = await setup();
  const leg = (/** @type {string} */ n, /** @type {any} */ arrival) => ({ flight: n, departure: { at: '2026-11-25T06:00', tz: TOKYO }, ...(arrival ? { arrival } : {}) });
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  await patch('f.json', { 'flights+': [leg('NH 8', at('2026-11-25T08:00', TOKYO)), leg('NH 9')] });
  const two = await read('f.json');
  assert.deepEqual(['end' in two, two.fields.flights.length], [false, 3]);
  // The end she gives herself, beside a leg with no arrival.
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  assert.equal(await patch('f.json', { 'flights+': [leg('NH 8')], end: at('2026-11-25T08:00:00+09:00', TOKYO) }), 'Patched /trip/bookings/f.json.');
  assert.deepEqual((await read('f.json')).end, at('2026-11-25T08:00:00+09:00', TOKYO));
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
  // A leg written as text, not an object, is a last leg with no arrival too (its end stayed at the leg before).
  await write('f.json', { ...base, kind: 'flight', flights: [NH7] });
  assert.equal(await patch('f.json', { 'flights+': 'NH 8 to HND' }), `Patched /trip/bookings/f.json. ${NO_END}`);
  assert.deepEqual(['end' in (await read('f.json')), (await read('f.json')).fields.flights], [false, [NH7, 'NH 8 to HND']]);
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

test("a restaurant or an event written with its arrival alone starts then, at the place it gives, and is on that day of the Plan (it had an end and no start, on no day); beside a time it starts, its arrival is its end, as before", async () => {
  const { write, store, patch, read, run } = await setup();
  await write('r.json', { ...base, kind: 'restaurant', title: 'Test Bistro', arrive: { at: '2026-11-20T18:30', location: 'Test Bistro' } });
  const r = await read('r.json');
  assert.deepEqual([r.start, r.end, r.place, r.fields], [at('2026-11-20T18:30:00-09:00'), undefined, { name: 'Test Bistro' }, undefined]);
  assert.deepEqual(lines(r), ['Starts: Fri, Nov 20, 6:30 PM (AKT)', 'Place: Test Bistro']);
  assert.deepEqual(rows(r), ['booking@2026-11-20 18:30 Test Bistro']);
  await write('e.json', { ...base, kind: 'event', title: 'Concert', arrival: '2026-11-20T19:00', unsure: ['arrival'] });
  const e = await read('e.json');
  assert.deepEqual([e.start, e.end, e.unsure], [at('2026-11-20T19:00:00-09:00'), undefined, ['start']]);
  // A patch of a stored one moves its start.
  await store('p.json', { ...base, kind: 'restaurant', title: 'Test Bistro', start: at('2026-11-20T18:30:00-09:00') });
  await patch('p.json', { arrive: '2026-11-20T19:00' });
  assert.deepEqual([(await read('p.json')).start, (await read('p.json')).end], [at('2026-11-20T19:00:00-09:00'), undefined]);
  // Beside a time it starts (a departure, a start), the arrival ends it, as before: a tour booked as an event departs and arrives back.
  await write('t.json', { ...base, kind: 'event', title: 'Glacier tour', depart: '2026-11-21T08:00', arrive: '2026-11-21T18:00' });
  assert.deepEqual([(await read('t.json')).start.at, (await read('t.json')).end.at], ['2026-11-21T08:00:00-09:00', '2026-11-21T18:00:00-09:00']);
  await write('s.json', { ...base, kind: 'restaurant', title: 'Test Bistro', start: at('2026-11-20T18:30:00-09:00'), arrival: '2026-11-20T20:30' });
  assert.deepEqual([(await read('s.json')).start.at, (await read('s.json')).end.at], ['2026-11-20T18:30:00-09:00', '2026-11-20T20:30:00-09:00']);
  // What travels keeps its arrival as its end, alone too.
  for (const kind of ['car', 'other', 'ferry']) {
    await write('x.json', { ...base, kind, arrive: { at: '2026-11-20T18:30', tz: AK } });
    assert.deepEqual([(await read('x.json')).start, (await read('x.json')).end?.at], [undefined, '2026-11-20T18:30:00-09:00'], kind);
  }
  // An edit that adds one is told the field it is, by the same rule.
  await store('d.json', { ...base, kind: 'restaurant', title: 'Test Bistro' });
  await assert.rejects(run('edit', { path: '/trip/bookings/d.json', old: '"title": "Test Bistro"', new: '"title": "Test Bistro", "arrival": "2026-11-20 18:30"' }), /"arrival" isn't a booking field, so nothing was written\. arrival is start: write start as \{ "at"/);
  await store('d.json', { ...base, kind: 'restaurant', title: 'Test Bistro', start: at('2026-11-20T18:30:00-09:00') });
  await assert.rejects(run('edit', { path: '/trip/bookings/d.json', old: '"title": "Test Bistro"', new: '"title": "Test Bistro", "arrival": "2026-11-20 20:30"' }), /arrival is end: write end as \{ "at"/);
  for (const x of [r, e]) agrees(x);
});
