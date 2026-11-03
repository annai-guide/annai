// The drive-test follow-ups, section 3: a booking Shiori writes under other names for its fields (a small model's checkin, pickup,
// flights, name, address, total) is stored in the format's own, in one call; a top-level field the booking schema doesn't list is refused.
// Aliases rename only this write's own keys, before the merge; what is stored is never read or changed by them (the revised rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shioriBooking, unalias } from '../../src/core/bookings.js';
import { BOOKING_SCHEMA } from '../../src/plugins/core-schemas/schemas.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';

const AK = 'America/Anchorage';
const TOKYO = 'Asia/Tokyo';
const base = { id: 'b', status: 'unverified', source: '/files/b.pdf', unsure: [] };
/** A write's whole value, as the write tool does it. @param {any} next @param {any} [before] */
const guard = (next, zones = [AK], before = undefined) => shioriBooking(before, unalias(next, { zones, schema: BOOKING_SCHEMA, kind: before?.kind }), { schema: BOOKING_SCHEMA });

test('a stay: checkin and checkout strings in the trip\'s only zone, name, address and a total become start, end, title, place and cost', () => {
  const got = guard({ ...base, kind: 'lodging', name: 'Hotel Aurora Test', address: '1 Test Street', checkin: '2026-11-20 15:00', checkout: '2026-11-27T11:00', total: '1234.50 USD' });
  assert.deepEqual(got, {
    ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test', address: '1 Test Street' },
    start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK }, cost: { amount: 1234.5, currency: 'USD' },
  });
  // The other spellings, a tz beside them (used, so gone), a price as { amount, currency }, and a location as the place's name.
  for (const [i, o] of [['check_in', 'check_out'], ['checkIn', 'checkOut']].entries()) {
    const b = guard({ ...base, kind: 'lodging', [i === 0 ? 'check_in' : 'checkIn']: '2026-11-20T15:00', [o[1]]: '2026-11-22T10:00', tz: TOKYO, price: { amount: '30,000', currency: 'jpy' }, location: 'Test Ryokan' }, [AK, TOKYO]);
    assert.deepEqual([b.start, b.end, b.cost, b.place, 'tz' in b], [{ at: '2026-11-20T15:00:00+09:00', tz: TOKYO }, { at: '2026-11-22T10:00:00+09:00', tz: TOKYO }, { amount: 30000, currency: 'JPY' }, { name: 'Test Ryokan' }, false]);
  }
  // A time with an offset is a good at as written; its zone still comes from beside it, or the trip's only one.
  assert.deepEqual(guard({ ...base, kind: 'event', depart: '2026-11-20T15:00:00-09:00', arrive: '2026-11-20T18:00:00-09:00' }).start, { at: '2026-11-20T15:00:00-09:00', tz: AK });
  // A total that isn't an amount and a currency is kept in fields, as written.
  assert.deepEqual(guard({ ...base, kind: 'lodging', total: 'about 100 dollars' }).fields, { total: 'about 100 dollars' });
  assert.deepEqual(guard({ ...base, kind: 'lodging', price: 'USD 99', fields: { room: '12' } }).cost, { amount: 99, currency: 'USD' });
});

test('a car: pickup and dropoff as { location, at } become start and end, the pick-up place its place, a drop-off elsewhere in fields', () => {
  const got = guard({ ...base, kind: 'car', name: 'Test Rentals compact', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Downtown desk', at: '2026-11-27T09:00' } });
  assert.deepEqual(got, {
    ...base, kind: 'car', title: 'Test Rentals compact', place: { name: 'Airport lot' }, fields: { dropoff: 'Downtown desk' },
    start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK },
  });
  // The drop-off written first, and an address beside the pick-up's place: the same.
  const first = guard({ ...base, kind: 'car', dropoff: { location: 'Airport lot', at: '2026-11-27T09:00' }, address: '1 Test Road', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' } });
  assert.deepEqual([first.place, first.fields], [{ name: 'Airport lot', address: '1 Test Road' }, undefined]);
  // Returned where it was picked up: nothing extra.
  const same = guard({ ...base, kind: 'car', pick_up: { location: 'Airport lot', at: '2026-11-20T10:00', tz: AK }, return: { location: 'Airport lot', at: '2026-11-27T09:00' } });
  assert.deepEqual([same.place, same.fields, same.end.at], [{ name: 'Airport lot' }, undefined, '2026-11-27T09:00:00-09:00']);
  assert.deepEqual(guard({ ...base, kind: 'car', drop_off: '2026-11-27T09:00', pickUp: '2026-11-20T10:00' }).start.at, '2026-11-20T10:00:00-09:00');
});

test("a flight's legs: start is the first leg's departure, end the last's arrival, in each leg's own zone; the legs kept in fields.flights as written, no place", () => {
  const LA = 'America/Los_Angeles';
  const flights = [
    { flight: 'AN 1', origin: 'AAA', destination: 'BBB', departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00', tz: LA },
    { flight: 'AN 2', origin: 'BBB', destination: 'CCC', departure: '2026-11-20T11:30', arrival: { at: '2026-11-21T14:05', tz: TOKYO } },
  ];
  const got = guard({ ...base, kind: 'flight', flights, unsure: ['flights', 'name'], name: 'AN 1 / AN 2' }, [AK]);
  assert.deepEqual(got, {
    ...base, kind: 'flight', title: 'AN 1 / AN 2', unsure: ['flights', 'title'], fields: { flights },
    start: { at: '2026-11-20T08:00:00-08:00', tz: LA }, end: { at: '2026-11-21T14:05:00+09:00', tz: TOKYO },
  });
});

test("review 1: a flight's or train's time never takes the trip's only zone; an offset its zone doesn't have then is refused", () => {
  // Naive: refused in words, whatever the trip's zones, and for the legs.
  assert.throws(() => guard({ ...base, kind: 'flight', depart: '2026-11-20T08:00' }), /^Error: depart "2026-11-20T08:00" has no time zone annai knows \(a flight's or train's time is in the place it leaves or arrives, so the trip's time zone isn't assumed\): write start as \{ "at"/);
  assert.throws(() => guard({ ...base, kind: 'rail', checkin: '2026-11-20T08:00' }), /a flight's or train's time/);
  assert.throws(() => guard({ ...base, kind: 'flight', flights: [{ departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00' }] }), /flights\[0\]\.departure .*a flight's or train's time.* Or give the leg a "tz"\./);
  // An offset string with no zone beside it is the same: the offset doesn't say the zone.
  assert.throws(() => guard({ ...base, kind: 'flight', depart: '2026-11-20T08:00:00-08:00' }), /a flight's or train's time/);
  // A zone beside it (or in it) is the zone; a kind that isn't one of them still takes the trip's only zone.
  assert.deepEqual(guard({ ...base, kind: 'flight', depart: { at: '2026-11-20T08:00', tz: 'America/Los_Angeles' } }).start, { at: '2026-11-20T08:00:00-08:00', tz: 'America/Los_Angeles' });
  assert.deepEqual(guard({ ...base, kind: 'flight', depart: '2026-11-20T08:00:00-08:00', tz: 'America/Los_Angeles' }).start, { at: '2026-11-20T08:00:00-08:00', tz: 'America/Los_Angeles' });
  assert.equal(guard({ ...base, kind: 'event', depart: '2026-11-20T08:00' }).start.tz, AK);
  // An offset the chosen zone doesn't have at that instant (here Alaska is -09:00 in November): refused, naming the right one.
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-11-20T15:00:00-08:00' }), /^Error: checkin "2026-11-20T15:00:00-08:00" has an offset America\/Anchorage doesn't have then \(it is -09:00\): write start as/);
  assert.throws(() => guard({ ...base, kind: 'flight', depart: { at: '2026-07-01T08:00:00-08:00', tz: 'America/Los_Angeles' } }), /has an offset America\/Los_Angeles doesn't have then \(it is -07:00\)/);
  assert.equal(guard({ ...base, kind: 'lodging', checkin: '2026-11-20T15:00:00Z', tz: 'Europe/London' }).start.at, '2026-11-20T15:00:00Z');
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-13-45T25:00' }), /isn't a date with a time/);
});

test('review 4: a flight with its start and end and its legs keeps the legs in fields.flights, comparing nothing derived', () => {
  const flights = [{ flight: 'AN 1', departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00' }];
  const start = { at: '2026-11-20T08:00:00-08:00', tz: 'America/Los_Angeles' };
  const end = { at: '2026-11-21T14:05:00+09:00', tz: TOKYO };
  const got = guard({ ...base, kind: 'flight', start, end, flights });
  assert.deepEqual([got.start, got.end, got.fields], [start, end, { flights }]);
  // Only the one it lacks is derived, and then it needs its zone.
  assert.throws(() => guard({ ...base, kind: 'flight', start, flights }), /flights\[0\]\.arrival .*a flight's or train's time/);
});

test('refusals in words: a time with no zone in a trip of two, a date with no time; nothing else changes', () => {
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-11-20 15:00' }, [AK, TOKYO]),
    /^Error: checkin "2026-11-20 15:00" has no time zone annai knows \(this trip has America\/Anchorage, Asia\/Tokyo\): write start as \{ "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" \}\.$/);
  assert.throws(() => guard({ ...base, kind: 'lodging', checkout: '2026-11-27' }), /checkout "2026-11-27" isn't a date with a time: write end as \{ "at"/);
  assert.throws(() => guard({ ...base, kind: 'car', pickup: { location: 'Airport lot' } }), /pickup null isn't a date with a time/);
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-11-20T15:00', tz: 'Alaska' }), /has no time zone annai knows: write start/);
  // A booking with none of these names is what she wrote, untouched.
  const plain = { ...base, kind: 'lodging', title: 'x' };
  assert.equal(guard(plain), plain);
  assert.equal(unalias(plain), plain);
  // A date that doesn't exist is refused, not read as the next month's.
  assert.throws(() => guard({ ...base, kind: 'lodging', checkout: '2026-11-31T11:00' }), /checkout "2026-11-31T11:00" isn't a date with a time/);
  assert.throws(() => guard({ ...base, kind: 'lodging', checkout: '2026-11-30T24:00' }), /isn't a date with a time/);
});

test('an alias beside its own field in the same write: the same, it is dropped quietly; different, refused naming both', () => {
  const start = { at: '2026-11-20T15:00:00-09:00', tz: AK };
  const both = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', name: 'Hotel Aurora Test', start, checkin: '2026-11-20T15:00' };
  assert.deepEqual(guard(both), { ...base, kind: 'lodging', title: 'Hotel Aurora Test', start });
  assert.throws(() => guard({ ...both, name: 'Another Hotel' }), /^Error: name and title are both given and differ: keep one and remove the other\.$/);
  assert.throws(() => guard({ ...both, checkin: '2026-11-21T15:00' }), /checkin and start are both given and differ/);
  // A bad alias beside a good own field says what is wrong with the alias, not "both given and differ".
  assert.throws(() => guard({ ...both, checkin: 'next Friday' }), /^Error: checkin "next Friday" isn't a date with a time: write start as/);
  assert.throws(() => guard({ ...both, checkin: '2026-11-20T15:00', tz: 'Alaska' }), /checkin .* has no time zone annai knows/);
  assert.throws(() => guard({ ...base, kind: 'lodging', total: 'about 100 dollars', fields: { total: 'about 90 dollars' } }), /total and fields\.total are both given/);
});

test('what is stored is never compared: a stored alias, a stored own field, a stored zone annai doesn\'t know', () => {
  // This write wins over the stored own field; the stored one is never read.
  const stored = { ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00+09:00', tz: 'Tokyo' } };
  assert.deepEqual(guard({ ...base, kind: 'lodging', checkin: '2026-11-22T15:00' }, [AK], stored).start, { at: '2026-11-22T15:00:00-09:00', tz: AK });
  // A stored time in a zone annai doesn't know, beside an alias in the write: no RangeError.
  const odd = { ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00+09:00', tz: 'Tokyo' } };
  assert.deepEqual(guard({ ...odd, checkout: '2026-11-23T11:00' }, [AK], odd).end, { at: '2026-11-23T11:00:00-09:00', tz: AK });
});

test('costs: a comma only groups thousands; anything else goes to fields.total as written', () => {
  const cost = (/** @type {string} */ total) => guard({ ...base, kind: 'lodging', total });
  assert.deepEqual(cost('1,245.00 USD').cost, { amount: 1245, currency: 'USD' });
  assert.deepEqual(cost('245 EUR').cost, { amount: 245, currency: 'EUR' });
  for (const t of ['245,00 EUR', 'EUR 12,5', '1,2,3 USD', '1.2.3 USD']) assert.deepEqual([cost(t).cost, cost(t).fields], [undefined, { total: t }]);
});

test("a car's return written as an arrival is its drop-off, which the Plan's Return row reads; a flight's arrival stays an arrival", () => {
  const car = guard({ ...base, kind: 'car', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, arrive: { location: 'Downtown desk', at: '2026-11-27T09:00' } });
  assert.deepEqual([car.place, car.fields, car.end.at], [{ name: 'Airport lot' }, { dropoff: 'Downtown desk' }, '2026-11-27T09:00:00-09:00']);
  const flight = guard({ ...base, kind: 'flight', depart: { at: '2026-11-27T09:00', tz: AK }, arrival: { location: 'Test Airport', at: '2026-11-27T12:00', tz: AK }, unsure: ['arrival'] });
  assert.deepEqual([flight.fields, flight.unsure], [{ arrival: 'Test Airport' }, ['end']]);
});

test('a patch: its own changes are renamed, + forms too; the schema in force keeps its own names', () => {
  const o = { schema: BOOKING_SCHEMA, zones: [AK], append: true };
  assert.deepEqual(unalias({ 'notes+': ['late arrival'], notes: 'x' }, o), { fields: { 'notes+': ['late arrival'], notes: 'x' } });
  // A write isn't a patch: a "+" key is left for the unknown-field check.
  assert.deepEqual(unalias({ 'notes+': ['x'] }, { schema: BOOKING_SCHEMA }), { 'notes+': ['x'] });
  // The stored kind decides a flight's zone: a checkout patched onto a stored flight never takes the trip's zone.
  assert.throws(() => unalias({ checkout: '2026-11-23T11:00' }, { ...o, kind: 'flight' }), /a flight's or train's time/);
  // A null removes a stored key under that name, as a merge patch does.
  assert.deepEqual(unalias({ checkin: null }, o), { checkin: null });
  const wider = { ...BOOKING_SCHEMA, properties: { ...BOOKING_SCHEMA.properties, seat: { type: 'string' }, notes: { type: 'array' } } };
  assert.deepEqual(unalias({ seat: '12A', 'notes+': ['x'] }, { schema: wider, append: true }), { seat: '12A', 'notes+': ['x'] });
});

test("unknown top-level fields are refused against the booking schema in force, naming its fields and saying to use fields; a plugin's schema adds its own", () => {
  assert.throws(() => guard({ ...base, kind: 'lodging', rooms: 2 }),
    /^Error: "rooms" isn't a booking field, so nothing was written\. A booking's own fields are id, kind, status, source, title, start, end, place, confirmation, cost, fields, unsure; put anything else in fields\.$/);
  assert.throws(() => guard({ ...base, kind: 'lodging', rooms: 2, meal: 'breakfast' }), /"rooms", "meal" aren't booking fields/);
  // A tz beside nothing it was used for is unknown too.
  assert.throws(() => guard({ ...base, kind: 'lodging', tz: AK }), /"tz" isn't a booking field/);
  const wider = { ...BOOKING_SCHEMA, properties: { ...BOOKING_SCHEMA.properties, rooms: { type: 'integer' } } };
  assert.equal(shioriBooking(undefined, { ...base, kind: 'lodging', rooms: 2 }, { schema: wider }).rooms, 2);
  // With no schema to go by, nothing is refused for its name.
  assert.equal(shioriBooking(undefined, { ...base, kind: 'lodging', rooms: 2 }).rooms, 2);
});

/** The files plugin with the core schemas, and maybe a plugin's own booking schema, and a trip in the given zones. @param {string[]} zones @param {any} [extra] */
async function setup(zones, extra) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  if (extra) registry.add('wider', 'schema', { scope: 'trip', pattern: '/bookings/*.json', schema: extra });
  const trip = await createTrip(ws, { title: 'Anchorage' });
  await ws.patch(trip, '/trip.json', { timezones: zones }, { author: 'user' });
  const tools = Object.fromEntries(registry.entries('tool').map((e) => [e.item.name, e.item]));
  /** @param {string} name @param {any} input */
  const run = (name, input) => tools[name].run(input, { scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori' });
  return { ws, trip, run };
}

test('through write and patch: stored right in one call; refused with nothing stored; a stored booking with old names accepts an unrelated patch unchanged', async () => {
  const { ws, trip, run } = await setup([AK]);
  await run('write', { path: '/trip/bookings/car.json', content: { ...base, kind: 'car', name: 'Test Rentals compact', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Airport lot', at: '2026-11-27T09:00' } } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/car.json'), { ...base, kind: 'car', title: 'Test Rentals compact', place: { name: 'Airport lot' }, start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK } });
  // As JSON text, as Gemini writes it: the same.
  await run('write', { path: '/trip/bookings/car2.json', content: JSON.stringify({ ...base, kind: 'car', name: 'Test Rentals compact' }) });
  assert.equal((await ws.readJSON(trip, '/bookings/car2.json')).title, 'Test Rentals compact');
  await assert.rejects(run('write', { path: '/trip/bookings/odd.json', content: { ...base, kind: 'other', rooms: 2 } }), /"rooms" isn't a booking field/);
  assert.equal(await ws.read(trip, '/bookings/odd.json'), undefined);
  // A booking stored before, with old names (the user's edit or an import), and a key annai doesn't know: her patch leaves them.
  const old = { ...base, kind: 'lodging', name: 'Hotel Aurora Test', checkin: '2026-11-20 15:00', checkout: '2026-11-27 11:00', room: '12', guests: 2, rooms: 3 };
  await ws.write(trip, '/bookings/stay.json', old, { author: 'user' });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { confirmation: 'TEST42' } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/stay.json'), { ...old, confirmation: 'TEST42' });
  // Her patch with its own times sets them; the old names stay until she removes them.
  await run('patch', { path: '/trip/bookings/stay.json', changes: { checkin: '2026-11-20T15:00', checkout: null } });
  const now = await ws.readJSON(trip, '/bookings/stay.json');
  assert.deepEqual([now.start, now.checkin, 'checkout' in now], [{ at: '2026-11-20T15:00:00-09:00', tz: AK }, '2026-11-20 15:00', false]);
});

test('through patch: notes append into fields; a rebooked flight moves; a checkout replaces the stored end; an impossible date is refused', async () => {
  const { ws, trip, run } = await setup([AK]);
  const at = (/** @type {string} */ x) => ({ at: x, tz: AK });
  await ws.write(trip, '/bookings/stay.json', { ...base, kind: 'lodging', start: at('2026-11-20T15:00:00-09:00'), end: at('2026-11-27T11:00:00-09:00') }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { 'notes+': ['late arrival'] } });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { 'notes+': ['door code'] } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/stay.json')).fields, { notes: ['late arrival', 'door code'] });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { notes: 'x' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/stay.json')).fields, { notes: 'x' });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { checkout: '2026-11-23T11:00', tz: AK } });
  const stay = await ws.readJSON(trip, '/bookings/stay.json');
  assert.deepEqual([stay.end, 'checkout' in stay, 'tz' in stay], [at('2026-11-23T11:00:00-09:00'), false, false]);
  await assert.rejects(run('patch', { path: '/trip/bookings/stay.json', changes: { checkout: '2026-11-31T11:00' } }), /isn't a date with a time/);
  assert.deepEqual((await ws.readJSON(trip, '/bookings/stay.json')).end, stay.end);
  const legs = (/** @type {string} */ d, /** @type {string} */ a) => [{ flight: 'AN 1', departure: d, arrival: a, tz: TOKYO }];
  await run('write', { path: '/trip/bookings/fly.json', content: { ...base, kind: 'flight', flights: legs('2026-11-20T08:00', '2026-11-20T10:00') } });
  await run('patch', { path: '/trip/bookings/fly.json', changes: { flights: legs('2026-11-21T09:00', '2026-11-21T11:30') } });
  const fly = await ws.readJSON(trip, '/bookings/fly.json');
  assert.deepEqual([fly.start, fly.end, fly.fields.flights], [{ at: '2026-11-21T09:00:00+09:00', tz: TOKYO }, { at: '2026-11-21T11:30:00+09:00', tz: TOKYO }, legs('2026-11-21T09:00', '2026-11-21T11:30')]);
});

test("a plugin's booking schema with top-level seat and notes keeps them top-level, written and stored", async () => {
  const wider = { ...BOOKING_SCHEMA, properties: { ...BOOKING_SCHEMA.properties, seat: { type: 'string' }, notes: { type: 'array' } } };
  const { ws, trip, run } = await setup([AK], wider);
  await run('write', { path: '/trip/bookings/fly.json', content: { ...base, kind: 'flight', seat: '12A' } });
  assert.equal((await ws.readJSON(trip, '/bookings/fly.json')).seat, '12A');
  await run('patch', { path: '/trip/bookings/fly.json', changes: { confirmation: 'T1', 'notes+': ['aisle'] } });
  const got = await ws.readJSON(trip, '/bookings/fly.json');
  assert.deepEqual([got.seat, got.notes, got.fields], ['12A', ['aisle'], undefined]);
});

test('review focus 4: a string time with no zone in a trip with two time zones is refused in words, nothing stored', async () => {
  const { ws, trip, run } = await setup([AK, TOKYO]);
  await assert.rejects(run('write', { path: '/trip/bookings/stay.json', content: { ...base, kind: 'lodging', checkin: '2026-11-20 15:00' } }),
    /checkin "2026-11-20 15:00" has no time zone annai knows \(this trip has America\/Anchorage, Asia\/Tokyo\): write start as \{ "at"/);
  assert.equal(await ws.read(trip, '/bookings/stay.json'), undefined);
});

test("a plugin's registered booking schema with more properties is honoured; the last registered wins", async () => {
  const wider = { ...BOOKING_SCHEMA, properties: { ...BOOKING_SCHEMA.properties, rooms: { type: 'integer' } } };
  const { ws, trip, run } = await setup([AK], wider);
  await run('write', { path: '/trip/bookings/stay.json', content: { ...base, kind: 'lodging', rooms: 2, checkin: '2026-11-20 15:00' } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/stay.json'), { ...base, kind: 'lodging', rooms: 2, start: { at: '2026-11-20T15:00:00-09:00', tz: AK } });
});

test('review 3: a location and an address are one place; a pick-up location and a top-level location or address too', () => {
  const stay = guard({ ...base, kind: 'lodging', address: '1 Test Street', location: 'Hotel Aurora Test' });
  assert.deepEqual(stay.place, { name: 'Hotel Aurora Test', address: '1 Test Street' });
  const car = guard({ ...base, kind: 'car', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, location: '1 Test Road' });
  assert.deepEqual(car.place, { name: 'Airport lot', address: '1 Test Road' });
  assert.deepEqual(guard({ ...base, kind: 'car', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, location: 'Airport lot' }).place, { name: 'Airport lot' });
  // Two addresses for one place still differ.
  assert.throws(() => guard({ ...base, kind: 'lodging', location: 'Hotel Aurora Test', address: '1 Test Street', place: { name: 'Hotel Aurora Test', address: '2 Test Street' } }), /address and place are both given and differ/);
  // An own place and a different location: refused, as before.
  assert.throws(() => guard({ ...base, kind: 'lodging', place: { name: 'Hotel A' }, location: 'Hotel B' }), /location and place are both given and differ/);
});

test('review 6: the extras a model writes at the top level (notes, room, phone, guests, passengers, airline, company, seat, flight) are filed into fields', () => {
  const got = guard({ ...base, kind: 'flight', notes: ['late arrival'], room: '12', phone: '+1 555 0100', guests: 2, passengers: ['A. Test'], airline: 'Test Air', company: 'Test Co', seat: '12A', flight: 'TA 9', fields: { meal: 'veg' }, unsure: ['seat', 'notes'] });
  assert.deepEqual(got.fields, { meal: 'veg', notes: ['late arrival'], room: '12', phone: '+1 555 0100', guests: 2, passengers: ['A. Test'], airline: 'Test Air', company: 'Test Co', seat: '12A', flight: 'TA 9' });
  assert.deepEqual([Object.keys(got).includes('seat'), got.unsure], [false, ['seat', 'notes']]);
  // Beside the same value in fields: dropped quietly; a different one is refused naming both.
  assert.equal(guard({ ...base, kind: 'lodging', room: '12', fields: { room: '12' } }).room, undefined);
  assert.throws(() => guard({ ...base, kind: 'lodging', room: '12', fields: { room: '13' } }), /room and fields\.room are both given and differ/);
});

test("review 8: an alias that files into fields leaves a fields that isn't an object alone, for the format check to refuse", () => {
  const o = { schema: BOOKING_SCHEMA };
  assert.deepEqual(unalias({ ...base, kind: 'lodging', room: '12', fields: 'a string' }, o), { ...base, kind: 'lodging', room: '12', fields: 'a string' });
  assert.deepEqual(unalias({ ...base, kind: 'lodging', room: '12', fields: ['x'] }, o).fields, ['x']);
});

test('a key already stored never blocks a write; only a key this write brings is refused', () => {
  const before = { ...base, kind: 'lodging', title: 'x', rooms: 2, meal: { a: 1 } };
  assert.deepEqual(guard({ ...before, confirmation: 'TEST1' }, [AK], before), { ...before, confirmation: 'TEST1' });
  assert.equal(guard({ ...before, rooms: 3 }, [AK], before).rooms, 3);
  assert.throws(() => guard({ ...before, extra: 1 }, [AK], before), /^Error: "extra" isn't a booking field/);
  // Through the alias check: a place written in another key order is the same as this write's own.
  assert.equal(guard({ ...base, kind: 'lodging', name: 'x', title: 'x', place: { name: 'P', address: 'A' }, location: 'P', address: 'A' }).title, 'x');
});

test('a stored time in a zone annai doesn\'t know, through the tool: a patch with an alias goes through', async () => {
  const { ws, trip, run } = await setup([AK]);
  await ws.write(trip, '/bookings/stay.json', { ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00+09:00', tz: 'Tokyo' } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/stay.json', changes: { checkout: '2026-11-23T11:00' } });
  const got = await ws.readJSON(trip, '/bookings/stay.json');
  assert.deepEqual([got.start.tz, got.end], ['Tokyo', { at: '2026-11-23T11:00:00-09:00', tz: AK }]);
});

test("review 9: unsure keeps the name of a total that went to fields.total; a leg's or arrival's place is named for what it was", () => {
  assert.deepEqual(guard({ ...base, kind: 'lodging', total: 'about 100 dollars', unsure: ['total'] }).unsure, ['total']);
  assert.deepEqual(guard({ ...base, kind: 'lodging', total: '100 USD', unsure: ['total', 'name'], name: 'x' }).unsure, ['cost', 'title']);
  assert.deepEqual(guard({ ...base, kind: 'lodging', price: 'a lot', unsure: ['price'] }).unsure, ['price']);
  // A drop-off elsewhere is fields.dropoff; an arrival's place is fields.arrival (not a drop-off).
  const end = (/** @type {any} */ x) => guard({ ...base, ...x }).fields;
  assert.deepEqual(end({ kind: 'car', dropoff: { location: 'Downtown desk', at: '2026-11-27T09:00' } }), { dropoff: 'Downtown desk' });
  assert.deepEqual(end({ kind: 'flight', depart: { at: '2026-11-27T09:00', tz: AK }, arrival: { location: 'Test Airport', at: '2026-11-27T12:00', tz: AK } }), { arrival: 'Test Airport' });
});

test('review 8 through the tool: a fields that is a string is refused by the format check, not replaced', async () => {
  const { ws, trip, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/stay.json', content: { ...base, kind: 'lodging', room: '12', fields: 'a string' } }), /fields/);
  assert.equal(await ws.read(trip, '/bookings/stay.json'), undefined);
});
