// The drive-test follow-ups, section 3: a booking Shiori writes under other names for its fields (a small model's checkin, pickup,
// flights, name, address, total) is stored in the format's own, in one call; a top-level field the booking schema doesn't list is refused.
// Aliases rename only this write's own keys, before the merge; what is stored is never read or changed by them (the revised rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shioriBooking, unalias, dropsAtPlace } from '../../src/core/bookings.js';
import { BOOKING_SCHEMA } from '../../src/plugins/core-schemas/schemas.js';
import { createMemoryStore } from '../fakes/store-memory.js';
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

test('a car: pickup and dropoff as { location, at } become start and end, the pick-up place its place, the drop-off in fields, compared with nothing', () => {
  const got = guard({ ...base, kind: 'car', name: 'Test Rentals compact', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Downtown desk', at: '2026-11-27T09:00' } });
  assert.deepEqual(got, {
    ...base, kind: 'car', title: 'Test Rentals compact', place: { name: 'Airport lot' }, fields: { dropoff: 'Downtown desk' },
    start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK },
  });
  // The drop-off written first, and an address beside the pick-up's place: the drop-off is kept as written. Returned where it was picked up,
  // too: the readers tell a drop-off at the booking's own place (dropsAtPlace), from the whole stored record (booking-time-next: the write
  // compared it with the place this write gives, so a patch, which gives none, drew a Drop-off line repeating it).
  const first = guard({ ...base, kind: 'car', dropoff: { location: 'Airport lot', at: '2026-11-27T09:00' }, address: '1 Test Road', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' } });
  assert.deepEqual([first.place, first.fields, dropsAtPlace(first)], [{ name: 'Airport lot', address: '1 Test Road' }, { dropoff: 'Airport lot' }, true]);
  const same = guard({ ...base, kind: 'car', pick_up: { location: 'Airport lot', at: '2026-11-20T10:00', tz: AK }, return: { location: 'Airport lot', at: '2026-11-27T09:00' } });
  assert.deepEqual([same.place, same.fields, same.end.at, dropsAtPlace(same)], [{ name: 'Airport lot' }, { dropoff: 'Airport lot' }, '2026-11-27T09:00:00-09:00', true]);
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
  assert.throws(() => guard({ ...base, kind: 'flight', depart: '2026-11-20T08:00' }), /^Error: depart "2026-11-20T08:00" has no time zone annai knows \(the time of a flight, a train, a ferry, a bus or a coach is in the place it leaves or arrives, so the trip's time zone isn't assumed\): write start as \{ "at"/);
  assert.throws(() => guard({ ...base, kind: 'rail', checkin: '2026-11-20T08:00' }), /the time of a flight, a train, a ferry, a bus or a coach/);
  assert.throws(() => guard({ ...base, kind: 'flight', flights: [{ departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00' }] }), /flights\[0\]\.departure .*the time of a flight, a train, a ferry, a bus or a coach.* Or give the leg a "tz"\./);
  // An offset string with no zone beside it is the same: the offset doesn't say the zone.
  assert.throws(() => guard({ ...base, kind: 'flight', depart: '2026-11-20T08:00:00-08:00' }), /the time of a flight, a train, a ferry, a bus or a coach/);
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

test("booking-next: a ferry's, a bus's or a coach's booking is a kind of the format's own, and its times are read as a train's: never in the trip's only zone, which says nothing of the place it leaves or arrives (main took the trip's zone for a ride booked as `other`, and refused the kind)", () => {
  assert.deepEqual(['ferry', 'bus', 'coach'].filter((kind) => BOOKING_SCHEMA.properties.kind.enum.includes(kind)), ['ferry', 'bus', 'coach']);
  for (const kind of ['ferry', 'bus', 'coach']) {
    assert.throws(() => guard({ ...base, kind, depart: '2026-11-20T19:00' }), /^Error: depart "2026-11-20T19:00" has no time zone annai knows \(the time of a flight, a train, a ferry, a bus or a coach is in the place it leaves or arrives/, kind);
    assert.throws(() => guard({ ...base, kind, arrive: '2026-11-21T07:00:00-09:00' }), /the time of a flight, a train, a ferry, a bus or a coach/, kind);
    // Its own zone, in it, is its zone, as a train's is; a zone written beside the times is the departure's only (fix 1: an arrival can be in another zone).
    assert.deepEqual(guard({ ...base, kind, depart: { at: '2026-11-20T19:00', tz: TOKYO }, arrive: { at: '2026-11-21T07:00', tz: TOKYO } }), { ...base, kind, start: { at: '2026-11-20T19:00:00+09:00', tz: TOKYO }, end: { at: '2026-11-21T07:00:00+09:00', tz: TOKYO } }, kind);
    assert.deepEqual(guard({ ...base, kind, depart: '2026-11-20T19:00', arrive: { at: '2026-11-21T07:00', tz: TOKYO }, tz: TOKYO }), { ...base, kind, start: { at: '2026-11-20T19:00:00+09:00', tz: TOKYO }, end: { at: '2026-11-21T07:00:00+09:00', tz: TOKYO } }, kind);
    assert.throws(() => guard({ ...base, kind, depart: '2026-11-20T19:00', arrive: '2026-11-21T07:00', tz: TOKYO }), /^Error: arrive "2026-11-21T07:00" has no time zone annai knows \(.*an arrival can be in another time zone than the departure, so the arrival needs a tz of its own\): write end as \{ "at".* in place of arrive\.$/, kind);
  }
  // A patch to a stored ride booking reads the stored kind, as a stored train's.
  assert.throws(() => unalias({ arrive: '2026-11-21T07:00' }, { zones: [AK], schema: BOOKING_SCHEMA, kind: 'ferry' }), /the time of a flight, a train, a ferry, a bus or a coach/);
  // What isn't a carrier still takes the trip's only zone.
  assert.equal(guard({ ...base, kind: 'other', depart: '2026-11-20T19:00' }).start.tz, AK);
});

test('review 4: a flight with its start and end and its legs keeps the legs in fields.flights, comparing nothing derived', () => {
  const flights = [{ flight: 'AN 1', departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00' }];
  const start = { at: '2026-11-20T08:00:00-08:00', tz: 'America/Los_Angeles' };
  const end = { at: '2026-11-21T14:05:00+09:00', tz: TOKYO };
  const got = guard({ ...base, kind: 'flight', start, end, flights });
  assert.deepEqual([got.start, got.end, got.fields], [start, end, { flights }]);
  // Only the one it lacks is derived, and then it needs its zone.
  assert.throws(() => guard({ ...base, kind: 'flight', start, flights }), /flights\[0\]\.arrival .*the time of a flight, a train, a ferry, a bus or a coach/);
});

test('refusals in words: a time with no zone in a trip of two, a date with no time; nothing else changes', () => {
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-11-20 15:00' }, [AK, TOKYO]),
    /^Error: checkin "2026-11-20 15:00" has no time zone annai knows \(this trip has America\/Anchorage, Asia\/Tokyo\): write start as \{ "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" \} in place of checkin\.$/);
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
  assert.deepEqual([flight.fields, flight.unsure], [{ to: 'Test Airport' }, ['end']], "its place is where it arrives (fields.to), not under the word of its time");
});

test('a patch: its own changes are renamed, + forms too; the schema in force keeps its own names', () => {
  const o = { schema: BOOKING_SCHEMA, zones: [AK], append: true };
  assert.deepEqual(unalias({ 'notes+': ['late arrival'], notes: 'x' }, o), { notes: null, fields: { 'notes+': ['late arrival'], notes: 'x' } });
  // A write isn't a patch: a "+" key is left for the unknown-field check.
  assert.deepEqual(unalias({ 'notes+': ['x'] }, { schema: BOOKING_SCHEMA }), { 'notes+': ['x'] });
  // The stored kind decides a flight's zone: a checkout patched onto a stored flight never takes the trip's zone.
  assert.throws(() => unalias({ checkout: '2026-11-23T11:00' }, { ...o, kind: 'flight' }), /the time of a flight, a train, a ferry, a bus or a coach/);
  // A null removes the format's field and a stored key under that name, as a merge patch does.
  assert.deepEqual(unalias({ checkin: null }, o), { start: null, checkin: null });
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
  // Returned where it was picked up: the drop-off is kept as written, and read as the place (booking-time-next: a whole write dropped it).
  await run('write', { path: '/trip/bookings/car.json', content: { ...base, kind: 'car', name: 'Test Rentals compact', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Airport lot', at: '2026-11-27T09:00' } } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/car.json'), { ...base, kind: 'car', title: 'Test Rentals compact', place: { name: 'Airport lot' }, fields: { dropoff: 'Airport lot' }, start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK } });
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
  // Her patch with its own times sets them, and the old names it renames go with them (fix pass 3, 1).
  await run('patch', { path: '/trip/bookings/stay.json', changes: { checkin: '2026-11-20T15:00', checkout: null } });
  const now = await ws.readJSON(trip, '/bookings/stay.json');
  assert.deepEqual([now.start, 'checkin' in now, 'checkout' in now], [{ at: '2026-11-20T15:00:00-09:00', tz: AK }, false, false]);
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
  // A leg's tz is the zone it leaves in: the arrival has its own.
  const legs = (/** @type {string} */ d, /** @type {string} */ a) => [{ flight: 'AN 1', departure: d, arrival: { at: a, tz: TOKYO }, tz: TOKYO }];
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
  // A drop-off elsewhere is fields.dropoff; an arrival's place is fields.to, where it arrives (not a drop-off, and not fields.arrival, which
  // the details read "Arrival", the word of the time they draw beside it as "Arrives": booking-next fix 2).
  const end = (/** @type {any} */ x) => guard({ ...base, ...x }).fields;
  assert.deepEqual(end({ kind: 'car', dropoff: { location: 'Downtown desk', at: '2026-11-27T09:00' } }), { dropoff: 'Downtown desk' });
  assert.deepEqual(end({ kind: 'flight', depart: { at: '2026-11-27T09:00', tz: AK }, arrival: { location: 'Test Airport', at: '2026-11-27T12:00', tz: AK } }), { to: 'Test Airport' });
  assert.deepEqual(end({ kind: 'ferry', depart: { at: '2026-11-27T09:00', tz: AK }, arrive: { location: 'Beppu port', at: '2026-11-27T12:00', tz: AK } }), { to: 'Beppu port' });
});

test('review 8 through the tool: a fields that is a string is refused by the format check, not replaced', async () => {
  const { ws, trip, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/stay.json', content: { ...base, kind: 'lodging', room: '12', fields: 'a string' } }), /fields/);
  assert.equal(await ws.read(trip, '/bookings/stay.json'), undefined);
});

test('fix pass 2, 1: a place alias in a patch replaces the stored place whole; an address alone sets only the address', async () => {
  const { ws, trip, run } = await setup([AK]);
  const stay = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', place: { name: 'Hotel Aurora Test', address: '1 Test St', lat: 61.2, lng: -149.9 } };
  await ws.write(trip, '/bookings/s.json', stay, { author: 'user' });
  await run('patch', { path: '/trip/bookings/s.json', changes: { address: '2 Test St' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).place, { name: 'Hotel Aurora Test', address: '2 Test St' }); // the old position went with the old address
  await run('patch', { path: '/trip/bookings/s.json', changes: { location: 'Hotel Borealis Test' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).place, { name: 'Hotel Borealis Test' });
  // A car's pick-up moved: the old address and coordinates go with the old place.
  await ws.write(trip, '/bookings/c.json', { ...base, kind: 'car', place: { name: 'Airport lot', address: '5000 Test Rd', lat: 61.17, lng: -149.99 }, start: { at: '2026-11-20T10:00:00-09:00', tz: AK } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/c.json', changes: { pickup: { location: 'Downtown desk', at: '2026-11-20T11:00' } } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/c.json')).place, { name: 'Downtown desk' });
  // A booking with no name: the address is its name, filled in from the merged record.
  await ws.write(trip, '/bookings/n.json', { ...base, kind: 'lodging', place: { name: 'Gone' } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/n.json', changes: { place: { name: null }, address: '3 Test St' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/n.json')).place, { name: '3 Test St', address: '3 Test St' });
  // A whole write with only an address: the same name.
  await run('write', { path: '/trip/bookings/w.json', content: { ...base, kind: 'lodging', address: '4 Test St' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/w.json')).place, { name: '4 Test St', address: '4 Test St' });
});

test('fix pass 2, 2 and 3: the refusal says "in place of checkin"; an edit adding a known alias is told the format\'s field', async () => {
  const { ws, trip, run } = await setup([AK, TOKYO]);
  await assert.rejects(run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', checkin: '2026-11-20 15:00', start: { at: '2026-11-20T15:00:00-09:00', tz: AK } } }),
    /write start as \{ "at": "YYYY-MM-DDTHH:MM:SS±HH:MM", "tz": "<IANA zone>" \} in place of checkin\./);
  await ws.write(trip, '/bookings/e.json', { ...base, kind: 'lodging', title: 'Hotel' }, { author: 'user' });
  await assert.rejects(run('edit', { path: '/trip/bookings/e.json', old: '"title": "Hotel"', new: '"title": "Hotel",\n  "checkout": "2026-11-27 11:00"' }),
    /"checkout" isn't a booking field, so nothing was written\. checkout is end: write end as \{ "at"/);
  await assert.rejects(run('edit', { path: '/trip/bookings/e.json', old: '"title": "Hotel"', new: '"title": "Hotel", "name": "H", "total": "10 USD"' }),
    /name is title: write title as text\. total is cost: write cost as \{ "amount": 245, "currency": "EUR" \}\./);
  assert.equal((await ws.readJSON(trip, '/bookings/e.json')).title, 'Hotel');
});

test('fix pass 2, 4 and 5: unsure+ is renamed like unsure; a flights+ patch moves end to the last appended leg, and a leg with no time of arrival removes it (said in the result)', async () => {
  const { ws, trip, run } = await setup([AK]);
  await ws.write(trip, '/bookings/s.json', { ...base, kind: 'lodging', title: 'T' }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/s.json', changes: { checkout: '2026-11-23T11:00', 'unsure+': ['checkout'] } });
  await run('patch', { path: '/trip/bookings/s.json', changes: { name: 'U', 'unsure+': 'name' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).unsure, ['end', 'title']);
  const leg = (/** @type {string} */ d, /** @type {string} */ a) => ({ flight: 'AN 1', departure: d, arrival: { at: a, tz: TOKYO }, tz: TOKYO });
  await run('write', { path: '/trip/bookings/f.json', content: { ...base, kind: 'flight', flights: [leg('2026-11-20T08:00', '2026-11-20T10:00')] } });
  await run('patch', { path: '/trip/bookings/f.json', changes: { 'flights+': [leg('2026-11-20T12:00', '2026-11-20T15:00')] } });
  const f = await ws.readJSON(trip, '/bookings/f.json');
  assert.deepEqual([f.start, f.end, f.fields.flights.length], [{ at: '2026-11-20T08:00:00+09:00', tz: TOKYO }, { at: '2026-11-20T15:00:00+09:00', tz: TOKYO }, 2]);
  // A leg with no time of arrival is still appended; the booking's end goes, and the result says so (booking-time-next: the end stayed at the
  // leg before, a time out of date).
  assert.match(await run('patch', { path: '/trip/bookings/f.json', changes: { 'flights+': [{ flight: 'AN 3' }] } }), /^Patched \/trip\/bookings\/f\.json\. The last leg's arrival isn't written as a date with a time \(YYYY-MM-DDTHH:MM\), so the booking has no arrival time now: /);
  const g = await ws.readJSON(trip, '/bookings/f.json');
  assert.deepEqual(['end' in g, g.start, g.fields.flights.length], [false, f.start, 3]);
});

test('fix pass 2, 6: one time written two ways is the same time; a different instant or zone still differs', () => {
  const start = { at: '2026-11-20T15:00-09:00', tz: AK };
  assert.deepEqual(guard({ ...base, kind: 'lodging', start, checkin: '2026-11-20T15:00' }).start, { at: '2026-11-20T15:00:00-09:00', tz: AK });
  assert.throws(() => guard({ ...base, kind: 'lodging', start, checkin: '2026-11-20T16:00' }), /checkin and start are both given and differ/);
});

test('fix pass 2, S1 to S3: a null alias deletes its own field and its stored alias; "+" with null adds nothing; a whole write drops nulls', async () => {
  const { ws, trip, run } = await setup([AK]);
  const old = { ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, checkin: '2026-11-20 15:00', notes: 'old', fields: { notes: 'n', room: '1' } };
  await ws.write(trip, '/bookings/s.json', old, { author: 'user' });
  await run('patch', { path: '/trip/bookings/s.json', changes: { checkin: null, notes: null } });
  const got = await ws.readJSON(trip, '/bookings/s.json');
  assert.deepEqual([got.start, 'checkin' in got, 'notes' in got, got.fields], [undefined, false, false, { room: '1' }]);
  await run('patch', { path: '/trip/bookings/s.json', changes: { 'notes+': null } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).fields, { room: '1' });
  assert.deepEqual(unalias({ checkin: null }, { zones: [AK], append: true }), { start: null, checkin: null });
  assert.deepEqual(unalias({ checkin: null, start: { at: 'x', tz: AK } }, { zones: [AK], append: true }), { start: { at: 'x', tz: AK }, checkin: null });
  await run('write', { path: '/trip/bookings/w.json', content: { ...base, kind: 'lodging', checkout: null, notes: null, title: 'T' } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/w.json'), { ...base, kind: 'lodging', title: 'T' });
});

test('fix pass 3: place aliases merge into the place like a merge patch; the stale parts of a renamed place go, the ones this write gives stay; a drop-off is kept as written, and one at the address of a place made from an address is read as the place', async () => {
  const { ws, trip, run } = await setup([AK]);
  const P = '/trip/bookings/s.json';
  const hotel = { ...base, kind: 'lodging', title: 'Hilton', place: { name: 'Hilton Airport', address: '1 Airport Rd', lat: 61.17, lng: -149.99 } };
  /** @param {any} changes */
  const patch = async (changes) => {
    await ws.write(trip, '/bookings/s.json', hotel, { author: 'user' });
    await run('patch', { path: P, changes });
    return (await ws.readJSON(trip, '/bookings/s.json')).place;
  };
  // The same name: the rest of the place stays, and what is given replaces.
  assert.deepEqual(await patch({ location: { lat: 61.2, lng: -149.9 } }), { name: 'Hilton Airport', address: '1 Airport Rd', lat: 61.2, lng: -149.9 });
  // Another address: the old position goes, unless this write gives one.
  assert.deepEqual(await patch({ address: '2 Test St' }), { name: 'Hilton Airport', address: '2 Test St' });
  assert.deepEqual(await patch({ location: { address: '2 Test St', lat: 61.2, lng: -149.9 } }), { name: 'Hilton Airport', address: '2 Test St', lat: 61.2, lng: -149.9 });
  // Another name: the address and position of the old place go, unless this write gives them (even as they were).
  assert.deepEqual(await patch({ location: 'Downtown Inn' }), { name: 'Downtown Inn' });
  assert.deepEqual(await patch({ place: { name: 'Downtown Inn' } }), { name: 'Downtown Inn' });
  assert.deepEqual(await patch({ location: 'Hilton Anchorage', address: '1 Airport Rd' }), { name: 'Hilton Anchorage', address: '1 Airport Rd' });
  assert.deepEqual(await patch({ location: { name: 'Downtown Inn', lat: 61.2, lng: -149.9 } }), { name: 'Downtown Inn', lat: 61.2, lng: -149.9 });
  // A place stored with only an address (its name a copy of it): naming it keeps the address; another address takes the copy along.
  const bare = async (/** @type {any} */ changes) => {
    await ws.write(trip, '/bookings/b.json', { ...base, kind: 'lodging', title: 'T', place: { name: '1 Main St', address: '1 Main St' } }, { author: 'user' });
    await run('patch', { path: '/trip/bookings/b.json', changes });
    return (await ws.readJSON(trip, '/bookings/b.json')).place;
  };
  assert.deepEqual(await bare({ location: 'Garden Inn Test' }), { name: 'Garden Inn Test', address: '1 Main St' });
  assert.deepEqual(await bare({ address: '2 Other St' }), { name: '2 Other St', address: '2 Other St' });
  // A pick-up's location is the name, its address the address.
  assert.deepEqual(await patch({ pickup: { location: 'Downtown desk', address: '5 Main St', at: '2026-11-20T10:00' } }), { name: 'Downtown desk', address: '5 Main St' });
  assert.deepEqual(await patch({ pickup: { address: '5 Main St', at: '2026-11-20T10:00' } }), { name: 'Hilton Airport', address: '5 Main St' });
  // Nulls: an address null removes the address, a location null the place.
  assert.deepEqual(await patch({ address: null }), { name: 'Hilton Airport', lat: 61.17, lng: -149.99 });
  assert.equal(await patch({ location: null }), undefined);
  // A place of its own and an alias merge; different values for one part, or a null place beside an alias, are refused naming both.
  assert.deepEqual(await patch({ place: { address: '7 X St' }, location: 'X desk' }), { name: 'X desk', address: '7 X St' });
  await assert.rejects(run('patch', { path: P, changes: { place: { name: 'X' }, location: 'Y' } }), /location and place are both given and differ/);
  await assert.rejects(run('patch', { path: P, changes: { place: null, location: 'Y' } }), /location and place are both given and differ/);
  await assert.rejects(run('patch', { path: P, changes: { place: null, address: '1 A' } }), /address and place are both given and differ/);
  // No place and a null address: still no place.
  await ws.write(trip, '/bookings/n.json', { ...base, kind: 'lodging', title: 'T' }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/n.json', changes: { address: null } });
  assert.equal('place' in (await ws.readJSON(trip, '/bookings/n.json')), false);
  // A total null removes the cost and fields.total.
  await ws.write(trip, '/bookings/t.json', { ...base, kind: 'lodging', cost: { amount: 5, currency: 'USD' }, fields: { total: 'about 5', room: '1' } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/t.json', changes: { total: null } });
  const t = await ws.readJSON(trip, '/bookings/t.json');
  assert.deepEqual([t.cost, t.fields], [undefined, { room: '1' }]);
  // A total that becomes a cost also takes a total kept in words before.
  await ws.write(trip, '/bookings/t.json', { ...base, kind: 'lodging', fields: { total: 'about 100 dollars', room: '1' } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/t.json', changes: { total: '100 USD' } });
  const t2 = await ws.readJSON(trip, '/bookings/t.json');
  assert.deepEqual([t2.cost, t2.fields], [{ amount: 100, currency: 'USD' }, { room: '1' }]);
  // An empty pick-up address or location says nothing: the stored place stays, and the new time is written.
  assert.deepEqual(await patch({ pickup: { address: '', at: '2026-11-20T10:00' } }), hotel.place);
  assert.deepEqual(await patch({ pickup: { location: '', at: '2026-11-20T10:00' } }), hotel.place);
  // Empty top-level names and addresses say nothing too; an empty drop-off name leaves its address as the drop-off (a stay's too: its
  // check-out's place is kept as its drop-off, as a car's; booking-time-next's first round took it out, which dropped it silently).
  assert.deepEqual(await patch({ address: '' }), hotel.place);
  assert.deepEqual(await patch({ location: '' }), hotel.place);
  await ws.write(trip, '/bookings/s.json', hotel, { author: 'user' });
  await run('patch', { path: P, changes: { dropoff: { location: '', address: '5 Main St', at: '2026-11-27T09:00' } } });
  const d = await ws.readJSON(trip, '/bookings/s.json');
  assert.deepEqual([d.place, d.fields?.dropoff], [hotel.place, '5 Main St']);
  // A total turned cost on a booking with no fields leaves none.
  await ws.write(trip, '/bookings/t.json', { ...base, kind: 'lodging' }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/t.json', changes: { total: '100 USD' } });
  assert.equal('fields' in (await ws.readJSON(trip, '/bookings/t.json')), false);
  // A detail alias beside a fields that isn't an object is left for the format check: the patch is refused, nothing lost.
  await ws.write(trip, '/bookings/f.json', { ...base, kind: 'lodging', fields: { room: '9' } }, { author: 'user' });
  await assert.rejects(run('patch', { path: '/trip/bookings/f.json', changes: { room: '12', fields: null } }));
  assert.deepEqual((await ws.readJSON(trip, '/bookings/f.json')).fields, { room: '9' });
  // A drop-off at the address of a place made only from an address is the place itself: kept as written, and read so (dropsAtPlace;
  // booking-time-next: it was dropped at the write).
  await run('write', { path: '/trip/bookings/c.json', content: { ...base, kind: 'car', address: '1 Main St', pickup: { at: '2026-11-20T10:00' }, dropoff: { location: '1 Main St', at: '2026-11-27T09:00' } } });
  const c = await ws.readJSON(trip, '/bookings/c.json');
  assert.deepEqual([c.place, c.fields, dropsAtPlace(c)], [{ name: '1 Main St', address: '1 Main St' }, { dropoff: '1 Main St' }, true]);
});

test('fix pass 3, 1: a renamed alias in a patch also nulls its own key, so a stored copy goes at once; "+" never deletes', async () => {
  const o = { zones: [AK], append: true };
  assert.deepEqual(unalias({ checkin: '2026-11-21T15:00' }, o), { start: { at: '2026-11-21T15:00:00-09:00', tz: AK }, checkin: null });
  assert.deepEqual(unalias({ name: 'U', notes: 'x', total: '5 USD' }, o), { title: 'U', name: null, cost: { amount: 5, currency: 'USD' }, total: null, fields: { notes: 'x', total: null }, notes: null });
  assert.deepEqual(unalias({ 'notes+': 'x' }, o), { fields: { 'notes+': 'x' } });
  const { ws, trip, run } = await setup([AK]);
  await ws.write(trip, '/bookings/s.json', { ...base, kind: 'lodging', title: 'Inn', checkin: '2026-11-20 15:00', checkout: '2026-11-27 11:00' }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/s.json', changes: { checkin: '2026-11-21T15:00' } });
  const got = await ws.readJSON(trip, '/bookings/s.json');
  assert.deepEqual([got.start.at, 'checkin' in got, got.checkout], ['2026-11-21T15:00:00-09:00', false, '2026-11-27 11:00']);
  // Her whole write of the record as read is then the same time written once.
  await run('write', { path: '/trip/bookings/s.json', content: { ...got, confirmation: 'X1' } });
});

test('fix pass 3, 2: appending to a stored value that is not a list keeps it as the first item', async () => {
  const { mergePatch } = await import('../../src/core/patch.js');
  assert.deepEqual(mergePatch({ n: 'a' }, { 'n+': 'b' }, { append: true }), { n: ['a', 'b'] });
  assert.deepEqual(mergePatch({ n: 5 }, { 'n+': [6] }, { append: true }), { n: [5, 6] });
  assert.deepEqual(mergePatch({ n: null }, { 'n+': 'b' }, { append: true }), { n: ['b'] });
  const { ws, trip, run } = await setup([AK]);
  await run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', title: 'Inn', notes: 'late arrival' } });
  await run('patch', { path: '/trip/bookings/s.json', changes: { 'notes+': 'door code' } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).fields, { notes: ['late arrival', 'door code'] });
});

test('fix pass 3, 3: a whole write with unsure null is refused by the format check, not stripped', async () => {
  const { ws, trip, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', title: 'Inn', unsure: null } }), /unsure/);
  await run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', title: 'Inn', unsure: ['title'] } });
  await assert.rejects(run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', title: 'Inn 2', checkin: '2026-11-20T15:00', unsure: null } }), /unsure/);
  assert.deepEqual((await ws.readJSON(trip, '/bookings/s.json')).unsure, ['title']);
});

const LA = 'America/Los_Angeles';

test("booking-next fix 1: what carries the traveller arrives in a zone of its own: a leg's tz or a tz beside the times is the departure's, an arrival takes its own { tz } or is refused asking for it (it took the departure's, up to 17 hours out); a last leg whose arrival is no date with a time (an airport, a clock alone, text) gives no end, said, and is never refused", async () => {
  // SFO to NRT, the leg's tz the departure's: the arrival with none of its own is refused, in words that ask for the arrival's zone.
  const leg = { flight: 'NH 7', departure: { iataCode: 'SFO', at: '2026-11-20T11:05' }, arrival: { iataCode: 'NRT', at: '2026-11-21T15:40' }, tz: LA };
  assert.throws(() => guard({ ...base, kind: 'flight', flights: [leg] }), /^Error: flights\[0\]\.arrival "2026-11-21T15:40" has no time zone annai knows \(.*an arrival can be in another time zone than the departure, so the arrival needs a tz of its own\): write end as \{ "at".* Give the arrival its own "tz": the leg's "tz" is the zone it leaves in\.$/);
  const placed = guard({ ...base, kind: 'flight', flights: [{ ...leg, arrival: { ...leg.arrival, tz: TOKYO } }] });
  assert.deepEqual([placed.start, placed.end], [{ at: '2026-11-20T11:05:00-08:00', tz: LA }, { at: '2026-11-21T15:40:00+09:00', tz: TOKYO }]);
  assert.equal(Date.parse(placed.end.at), Date.parse('2026-11-21T06:40:00Z'), 'the ticket says 15:40 in Tokyo, which is 06:40 UTC (the leg tz gave 23:40 UTC)');
  // An offset says no zone: the same refusal.
  assert.throws(() => guard({ ...base, kind: 'flight', flights: [{ ...leg, arrival: '2026-11-21T15:40:00+09:00' }] }), /flights\[0\]\.arrival .*needs a tz of its own/);
  // A Stockholm to Helsinki ferry with one top-level tz: the tz is the departure's (Helsinki is an hour ahead).
  const ferry = { ...base, kind: 'ferry', depart: '2026-11-20T17:00', arrive: '2026-11-21T09:00', tz: 'Europe/Stockholm' };
  assert.throws(() => guard(ferry), /^Error: arrive "2026-11-21T09:00" has no time zone annai knows \(.*the arrival needs a tz of its own\): write end as \{ "at".* in place of arrive\.$/);
  const crossed = guard({ ...ferry, arrive: { at: '2026-11-21T09:00', tz: 'Europe/Helsinki' } });
  assert.deepEqual([crossed.start, crossed.end], [{ at: '2026-11-20T17:00:00+01:00', tz: 'Europe/Stockholm' }, { at: '2026-11-21T09:00:00+02:00', tz: 'Europe/Helsinki' }]);
  assert.equal(Date.parse(crossed.end.at), Date.parse('2026-11-21T07:00:00Z'));
  // A train too, and an arrival alone with a tz beside it.
  assert.throws(() => guard({ ...base, kind: 'rail', checkin: '2026-11-20T08:00', checkout: '2026-11-20T11:00', tz: 'Europe/Paris' }), /checkout "2026-11-20T11:00" has no time zone annai knows/);
  assert.throws(() => guard({ ...base, kind: 'rail', arrive: '2026-11-20T11:00', tz: 'Europe/Paris' }), /arrive "2026-11-20T11:00" has no time zone annai knows/);
  // A stay's, a car's and an event's shared zone is unchanged: one place.
  assert.deepEqual(guard({ ...base, kind: 'lodging', checkin: '2026-11-20T15:00', checkout: '2026-11-22T11:00', tz: TOKYO }, [AK, TOKYO]).end, { at: '2026-11-22T11:00:00+09:00', tz: TOKYO });
  assert.deepEqual(guard({ ...base, kind: 'car', pickup: '2026-11-20T10:00', dropoff: '2026-11-22T09:00', tz: TOKYO }, [AK, TOKYO]).end, { at: '2026-11-22T09:00:00+09:00', tz: TOKYO });
  const event = guard({ ...base, kind: 'event', depart: '2026-11-20T10:00', arrive: '2026-11-20T12:00', tz: TOKYO }, [AK, TOKYO]);
  assert.deepEqual([event.start, event.end], [{ at: '2026-11-20T10:00:00+09:00', tz: TOKYO }, { at: '2026-11-20T12:00:00+09:00', tz: TOKYO }]);
  // Through the write tool, the refusal stores nothing.
  const { ws, trip, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/nh7.json', content: { ...base, kind: 'flight', flights: [leg] } }), /flights\[0\]\.arrival .*needs a tz of its own/);
  assert.equal(await ws.read(trip, '/bookings/nh7.json'), undefined);
  // A flights+ patch whose last leg has a timed arrival with no zone of its own is refused, as a whole write is, in the arrival's words and
  // naming the appended leg (not the stored first one); nothing is stored. It left the end where it was, and the Arrives row a time too early.
  await run('write', { path: '/trip/bookings/nh7.json', content: { ...base, kind: 'flight', flights: [{ ...leg, arrival: { ...leg.arrival, tz: TOKYO } }] } });
  const before = await ws.readJSON(trip, '/bookings/nh7.json');
  const next = { flight: 'NH 8', departure: { at: '2026-11-25T10:00', tz: TOKYO }, arrival: '2026-11-25T08:00', tz: TOKYO };
  await assert.rejects(run('patch', { path: '/trip/bookings/nh7.json', changes: { 'flights+': [next] } }), /^Error: flights\+\[0\]\.arrival "2026-11-25T08:00" has no time zone annai knows \(.*the arrival needs a tz of its own\): write end as .* Give the arrival its own "tz": the leg's "tz" is the zone it leaves in\./);
  // A leg written alone (not in a list), and the last of two appended: each is named by its place in the patch.
  await assert.rejects(run('patch', { path: '/trip/bookings/nh7.json', changes: { 'flights+': next } }), /flights\+\[0\]\.arrival "2026-11-25T08:00"/);
  await assert.rejects(run('patch', { path: '/trip/bookings/nh7.json', changes: { 'flights+': [{ ...next, arrival: { at: '2026-11-25T08:00', tz: TOKYO } }, next] } }), /flights\+\[1\]\.arrival "2026-11-25T08:00"/);
  assert.deepEqual(await ws.readJSON(trip, '/bookings/nh7.json'), before, 'nothing stored');
  // The retry the words ask for: the arrival's own zone moves the end to it (08:00 in Tokyo on the 25th).
  await run('patch', { path: '/trip/bookings/nh7.json', changes: { 'flights+': [{ ...next, arrival: { at: '2026-11-25T08:00', tz: TOKYO } }] } });
  const after = await ws.readJSON(trip, '/bookings/nh7.json');
  assert.deepEqual([after.end, after.fields.flights.length], [{ at: '2026-11-25T08:00:00+09:00', tz: TOKYO }, 2]);
  // A leg with no time of arrival still appends, and the end goes: the last leg is where it arrives, and it says no time (a leg with no times,
  // an arrival that is an airport alone as an object). Each is its own patch: the last leg's arrival is the one that ends the booking.
  // booking-time-next: the end stayed at the leg before ("Arrives" a leg too early, silently).
  for (const leg of /** @type {any[]} */ ([{ flight: 'NH 9' }, { flight: 'NH 10', arrival: { iataCode: 'HND' } }])) {
    await run('patch', { path: '/trip/bookings/nh7.json', changes: { 'flights+': [leg] } });
    assert.equal('end' in (await ws.readJSON(trip, '/bookings/nh7.json')), false, JSON.stringify(leg));
  }
  assert.equal((await ws.readJSON(trip, '/bookings/nh7.json')).fields.flights.length, 4);
  // An arrival written as text that is no date with a time ("08:00" with no day, "HND") is the same: the leg as written, no end, and the note
  // says so (booking-time-next: it was refused, a retry she can't satisfy when the booking doesn't say; fix round 3 had taken it and left the
  // old end beside the later leg, the reason for the refusal).
  for (const arrival of ['08:00', '2026-11-26 6:00 PM', 'HND']) {
    /** @type {string[]} */
    const notes = [];
    const got = unalias({ 'flights+': [{ flight: 'NH 12', arrival }] }, { zones: [AK], append: true, kind: 'flight', notes });
    assert.deepEqual([got.end, got.fields, notes.length], [null, { 'flights+': [{ flight: 'NH 12', arrival }] }, 1], arrival);
  }
  // The flights+ hint is the leg's, as a whole write's is: through the unalias a refusal names the leg too.
  assert.throws(() => unalias({ 'flights+': [next] }, { zones: [AK], append: true, kind: 'flight' }), /^Error: flights\+\[0\]\.arrival .* Give the arrival its own "tz"/);
});

test("booking-next fix 1: a stay written with arrival and departure is checked in at the arrival and out at the departure, as a hotel's confirmation says it; a flight, a train, a ride, a car, an event and anything else keep the departure as the start and the arrival as the end (they were swapped for a stay)", async () => {
  const stay = (/** @type {string} */ a, /** @type {string} */ d) => guard({ ...base, kind: 'lodging', [a]: '2026-11-20T15:00', [d]: '2026-11-22T11:00' });
  for (const [a, d] of [['arrival', 'departure'], ['arrive', 'depart']]) {
    const got = stay(a, d);
    assert.deepEqual([got.start, got.end], [{ at: '2026-11-20T15:00:00-09:00', tz: AK }, { at: '2026-11-22T11:00:00-09:00', tz: AK }], a);
  }
  // Only the stay: the others read leaving as the start and arriving as the end (a car or a tour moves the traveller).
  for (const kind of ['car', 'event', 'other', 'restaurant']) {
    const got = guard({ ...base, kind, departure: '2026-11-20T15:00', arrival: '2026-11-22T11:00' });
    assert.deepEqual([got.start.at, got.end.at], ['2026-11-20T15:00:00-09:00', '2026-11-22T11:00:00-09:00'], kind);
  }
  const fly = guard({ ...base, kind: 'flight', departure: { at: '2026-11-20T15:00', tz: LA }, arrival: { at: '2026-11-21T18:00', tz: TOKYO } });
  assert.deepEqual([fly.start.tz, fly.end.tz], [LA, TOKYO]);
  // The names in unsure follow the field, and an arrival's place is the stay's place; a null departure in a patch clears the check-out.
  const named = guard({ ...base, kind: 'lodging', arrival: { at: '2026-11-20T15:00', location: 'Harbor Inn' }, departure: '2026-11-22T11:00', unsure: ['arrival', 'departure'] });
  assert.deepEqual([named.unsure, named.place, named.fields], [['start', 'end'], { name: 'Harbor Inn' }, undefined]);
  // Through the write tool and a patch onto the stored stay (the stored kind decides).
  const { ws, trip, run } = await setup([AK]);
  await run('write', { path: '/trip/bookings/inn.json', content: { ...base, kind: 'lodging', title: 'Harbor Inn', arrival: '2026-11-20T15:00', departure: '2026-11-22T11:00' } });
  const inn = await ws.readJSON(trip, '/bookings/inn.json');
  assert.deepEqual([inn.start.at, inn.end.at, 'arrival' in inn, 'departure' in inn], ['2026-11-20T15:00:00-09:00', '2026-11-22T11:00:00-09:00', false, false]);
  await run('patch', { path: '/trip/bookings/inn.json', changes: { departure: '2026-11-23T11:00' } });
  const later = await ws.readJSON(trip, '/bookings/inn.json');
  assert.deepEqual([later.start.at, later.end.at], ['2026-11-20T15:00:00-09:00', '2026-11-23T11:00:00-09:00']);
  // A null departure clears the check-out and keeps the check-in; a null arrival clears the check-in and keeps the check-out.
  await run('patch', { path: '/trip/bookings/inn.json', changes: { departure: null } });
  const noOut = await ws.readJSON(trip, '/bookings/inn.json');
  assert.deepEqual([noOut.start?.at, noOut.end, 'departure' in noOut], ['2026-11-20T15:00:00-09:00', undefined, false]);
  await run('patch', { path: '/trip/bookings/inn.json', changes: { departure: '2026-11-23T11:00' } });
  await run('patch', { path: '/trip/bookings/inn.json', changes: { arrival: null } });
  const noIn = await ws.readJSON(trip, '/bookings/inn.json');
  assert.deepEqual([noIn.start, noIn.end?.at, 'arrival' in noIn], [undefined, '2026-11-23T11:00:00-09:00', false]);
  await run('patch', { path: '/trip/bookings/inn.json', changes: { arrival: '2026-11-20T15:00' } });
  // An edit that adds one of the names is told the right field for its kind.
  await assert.rejects(run('edit', { path: '/trip/bookings/inn.json', old: '"title": "Harbor Inn"', new: '"title": "Harbor Inn", "arrival": "2026-11-20 15:00"' }), /"arrival" isn't a booking field, so nothing was written\. arrival is start: write start as \{ "at"/);
});

test("booking-next fix 1: a start or an end written as it is stored gets the check its aliases get (a zone annai knows, an offset the zone has then); only a time this write changes is checked", async () => {
  const wrong = { at: '2026-11-20T15:00:00+09:00', tz: LA }; // 15:00 in Tokyo, in Los Angeles' zone
  assert.throws(() => guard({ ...base, kind: 'lodging', start: wrong }), /^Error: start "2026-11-20T15:00:00\+09:00" has an offset America\/Los_Angeles doesn't have then \(it is -08:00\): write start as \{ "at"/);
  assert.throws(() => guard({ ...base, kind: 'flight', end: wrong }), /^Error: end "2026-11-20T15:00:00\+09:00" has an offset America\/Los_Angeles doesn't have then/);
  assert.throws(() => guard({ ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00+09:00', tz: 'Alaska' } }), /start "2026-11-20T15:00:00\+09:00" has no time zone annai knows: write start as/);
  // The same as the alias says.
  assert.throws(() => guard({ ...base, kind: 'lodging', checkin: '2026-11-20T15:00:00+09:00', tz: LA }), /has an offset America\/Los_Angeles doesn't have then \(it is -08:00\)/);
  // Right ones, and a UTC time in a zone that is at UTC then, are taken as written.
  assert.deepEqual(guard({ ...base, kind: 'lodging', start: { at: '2026-11-20T15:00:00+09:00', tz: TOKYO }, end: { at: '2026-11-20T15:00:00Z', tz: 'Europe/London' } }).start, { at: '2026-11-20T15:00:00+09:00', tz: TOKYO });
  const { ws, trip, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/s.json', content: { ...base, kind: 'lodging', title: 'Inn', start: wrong } }), /start .* has an offset America\/Los_Angeles doesn't have then/);
  assert.equal(await ws.read(trip, '/bookings/s.json'), undefined);
  // A stored time the check would refuse (the user's own, or older) never blocks a write that leaves it alone: a patch of something else, a
  // patch of the other time, and a whole write that carries it back as it was.
  const odd = { ...base, kind: 'lodging', title: 'Inn', start: { at: '2026-11-20T15:00:00+09:00', tz: 'Tokyo' }, end: wrong };
  await ws.write(trip, '/bookings/odd.json', odd, { author: 'user' });
  await run('patch', { path: '/trip/bookings/odd.json', changes: { confirmation: 'X1' } });
  await run('write', { path: '/trip/bookings/odd.json', content: { ...odd, confirmation: 'X2' } });
  assert.equal((await ws.readJSON(trip, '/bookings/odd.json')).confirmation, 'X2');
  await run('patch', { path: '/trip/bookings/odd.json', changes: { start: { at: '2026-11-19T15:00:00+09:00', tz: TOKYO } } });
  assert.deepEqual((await ws.readJSON(trip, '/bookings/odd.json')).end, wrong);
  // One it changes is checked, as written, and as merged into the stored one (a patch of the clock alone, under the stored zone).
  await assert.rejects(run('patch', { path: '/trip/bookings/odd.json', changes: { end: { at: '2026-11-22T11:00:00+09:00', tz: LA } } }), /end "2026-11-22T11:00:00\+09:00" has an offset America\/Los_Angeles doesn't have then/);
  await ws.write(trip, '/bookings/ok.json', { ...base, kind: 'lodging', title: 'Inn', start: { at: '2026-11-20T15:00:00-08:00', tz: LA } }, { author: 'user' });
  await assert.rejects(run('patch', { path: '/trip/bookings/ok.json', changes: { start: { at: '2026-11-21T15:00:00+09:00' } } }), /start "2026-11-21T15:00:00\+09:00" has an offset America\/Los_Angeles doesn't have then/);
  assert.equal((await ws.readJSON(trip, '/bookings/ok.json')).start.at, '2026-11-20T15:00:00-08:00');
});

test("booking-next fix 2: a time with no offset is read in the zone it is written in, so whether two times of one write conflict is the same on a phone in any zone (it was read in the phone's: UTC took 01:00 in Tokyo as the 10:00 in Tokyo it is not, Los Angeles refused the 10:00 that is the same)", () => {
  const was = process.env.TZ;
  try {
    for (const zone of ['UTC', LA, TOKYO, 'Pacific/Auckland']) {
      process.env.TZ = zone;
      // 01:00 in Tokyo is not the 10:00 checkin in Tokyo, whichever zone the phone is in (01:00 UTC is 10:00 in Tokyo).
      assert.throws(() => unalias({ ...base, kind: 'lodging', start: { at: '2026-11-20T01:00', tz: TOKYO }, checkin: '2026-11-20T10:00', tz: TOKYO }, { zones: [TOKYO] }), /^Error: checkin and start are both given and differ/, zone);
      // The same 10:00 written two ways is one time.
      const got = unalias({ ...base, kind: 'lodging', start: { at: '2026-11-20T10:00', tz: TOKYO }, checkin: '2026-11-20T10:00', tz: TOKYO }, { zones: [TOKYO] });
      assert.deepEqual(got.start, { at: '2026-11-20T10:00:00+09:00', tz: TOKYO }, zone);
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test("booking-next fix 2: a write that leaves a booking's end before its start is refused, in words, when it changes the start or the end: a round trip's arrival and departure written as one car or other booking (it was stored starting Nov 25 and ending Nov 20)", async () => {
  const trip = { arrival: '2026-11-20T14:00', departure: '2026-11-25T10:00' };
  for (const kind of ['car', 'other', 'event']) {
    assert.throws(() => guard({ ...base, kind, ...trip }), /^Error: end "2026-11-20T14:00:00-09:00" is before start "2026-11-25T10:00:00-09:00", so nothing was written: a booking ends after it starts\. Check each date against the booking \(an overnight trip arrives on the next day's date\), and write a round trip's two ways as two bookings\.$/, kind);
    // The words never ask for a swap: for an overnight ferry or flight written with the arrival on the departure's date, or a stay moved a week later by
    // its start first, a swap stores the times backwards.
    assert.throws(() => guard({ ...base, kind, ...trip }), (e) => !/swap|earlier time|later as end|as start/.test(/** @type {Error} */ (e).message), kind);
  }
  // A stay reads them the other way round, so the same two words are right there; a start and an end written as they are stored, too.
  assert.deepEqual(guard({ ...base, kind: 'lodging', ...trip }).start.at, '2026-11-20T14:00:00-09:00');
  assert.throws(() => guard({ ...base, kind: 'lodging', start: { at: '2026-11-25T10:00:00-09:00', tz: AK }, end: { at: '2026-11-20T14:00:00-09:00', tz: AK } }), /end .* is before start/);
  // The same moment is no stretch, but is not before; instants are compared, each in its own zone (the clock alone says the wrong thing).
  const same = { at: '2026-11-20T14:00:00-09:00', tz: AK };
  assert.deepEqual(guard({ ...base, kind: 'event', start: same, end: same }).end, same);
  const fly = (/** @type {string} */ from, /** @type {string} */ to) => guard({ ...base, kind: 'flight', start: { at: from, tz: LA }, end: { at: to, tz: TOKYO } });
  assert.throws(() => fly('2026-11-20T11:05:00-08:00', '2026-11-20T15:40:00+09:00'), /end .* is before start/, 'the clock reads later, the instant is 12 hours earlier');
  assert.equal(fly('2026-11-20T11:05:00-08:00', '2026-11-21T15:40:00+09:00').end.at, '2026-11-21T15:40:00+09:00');
  assert.equal(guard({ ...base, kind: 'flight', start: { at: '2026-11-21T08:00:00+09:00', tz: TOKYO }, end: { at: '2026-11-20T20:00:00-08:00', tz: LA } }).end.tz, LA, 'the clock reads earlier, the instant is 5 hours later');
  // Through the tool: nothing stored; a patch that moves the end before the stored start; a patch of something else on a stored booking that
  // is already so (the user's own edit) is not refused, and one that mends it is.
  const { ws, trip: t, run } = await setup([AK]);
  await assert.rejects(run('write', { path: '/trip/bookings/ride.json', content: { ...base, kind: 'car', title: 'Airport transfer', ...trip } }), /end .* is before start/);
  assert.equal(await ws.read(t, '/bookings/ride.json'), undefined);
  await run('write', { path: '/trip/bookings/ride.json', content: { ...base, kind: 'car', title: 'Airport transfer', pickup: '2026-11-20T14:00', dropoff: '2026-11-20T16:00' } });
  await assert.rejects(run('patch', { path: '/trip/bookings/ride.json', changes: { dropoff: '2026-11-19T16:00' } }), /end "2026-11-19T16:00:00-09:00" is before start "2026-11-20T14:00:00-09:00"/);
  await assert.rejects(run('patch', { path: '/trip/bookings/ride.json', changes: { pickup: '2026-11-21T14:00' } }), /end .* is before start/);
  assert.equal((await ws.readJSON(t, '/bookings/ride.json')).end.at, '2026-11-20T16:00:00-09:00');
  await ws.write(t, '/bookings/odd.json', { ...base, kind: 'car', title: 'Odd', start: { at: '2026-11-25T10:00:00-09:00', tz: AK }, end: { at: '2026-11-20T14:00:00-09:00', tz: AK } }, { author: 'user' });
  await run('patch', { path: '/trip/bookings/odd.json', changes: { title: 'Odd one' } });
  assert.equal((await ws.readJSON(t, '/bookings/odd.json')).title, 'Odd one');
  await assert.rejects(run('patch', { path: '/trip/bookings/odd.json', changes: { dropoff: '2026-11-21T14:00' } }), /end .* is before start/);
  await run('patch', { path: '/trip/bookings/odd.json', changes: { dropoff: '2026-11-26T14:00' } });
  assert.equal((await ws.readJSON(t, '/bookings/odd.json')).end.at, '2026-11-26T14:00:00-09:00');
});

test("booking-next fix 2: a stay's check-out written with the hotel's own address is no drop-off elsewhere (the readers hide it: dropsAtPlace); one at another address still is, kept as written (it drew a \"Drop-off\" line with the hotel's address)", () => {
  const checkin = { at: '2026-11-20T15:00', location: 'Hotel Aurora', address: '1 Test Street' };
  const out = (/** @type {any} */ x) => guard({ ...base, kind: 'lodging', checkin, ...x });
  // The write files what it is given, compared with nothing (booking-time-next); the readers, which see the stored place, tell the hotel's own.
  for (const checkout of [{ at: '2026-11-22T11:00', address: '1 Test Street' }, { at: '2026-11-22T11:00', location: 'Hotel Aurora' }, { at: '2026-11-22T11:00', location: 'Hotel Aurora', address: '1 Test Street' }]) {
    const got = out({ checkout });
    assert.deepEqual([got.place, got.end.at, dropsAtPlace(got)], [{ name: 'Hotel Aurora', address: '1 Test Street' }, '2026-11-22T11:00:00-09:00', true], JSON.stringify(checkout));
  }
  const departure = out({ departure: { at: '2026-11-22T11:00', address: '1 Test Street' } });
  assert.deepEqual([departure.fields, dropsAtPlace(departure)], [{ dropoff: '1 Test Street' }, true], 'a departure too');
  const other = out({ checkout: { at: '2026-11-22T11:00', address: '9 Other Road' } });
  assert.deepEqual([other.fields, dropsAtPlace(other)], [{ dropoff: '9 Other Road' }, false]);
});

test("booking-next: a write that gives fields.to and an arrival's place that differs from it is refused in words, and nothing is stored; the same place written both ways is taken (fix round 3 dropped the differing place silently, so this stays a refusal until the design check of the time-writing path)", () => {
  const flight = (/** @type {any} */ to) => guard({ ...base, kind: 'flight', fields: { from: 'SFO', to }, depart: { at: '2026-11-20T11:05', tz: LA }, arrival: { at: '2026-11-21T18:00', tz: TOKYO, location: 'Haneda Airport' } });
  assert.throws(() => flight('Osaka (KIX)'), /arrival and fields\.to are both given and differ/);
  assert.deepEqual(flight('Haneda Airport').fields, { from: 'SFO', to: 'Haneda Airport' });
});
