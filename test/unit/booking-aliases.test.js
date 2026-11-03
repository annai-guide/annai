// The drive-test follow-ups, section 3: a booking Shiori writes under other names for its fields (a small model's checkin, pickup,
// flights, name, address, total) is stored in the format's own, in one call; a top-level field the booking schema doesn't list is refused.
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
const guard = (/** @type {any} */ next, zones = [AK], before = undefined) => shioriBooking(before, next, { zones, schema: BOOKING_SCHEMA });

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
  assert.deepEqual(guard({ ...base, kind: 'car', drop_off: '2026-11-27T09:00', pickUp: '2026-11-20T10:00', dropOff: undefined }).start.at, '2026-11-20T10:00:00-09:00');
});

test("a flight's legs: start is the first leg's departure, end the last's arrival, the legs kept in fields.flights as written, no place", () => {
  const flights = [
    { flight: 'AN 1', origin: 'AAA', destination: 'BBB', departure: '2026-11-20T08:00', arrival: '2026-11-20T10:00' },
    { flight: 'AN 2', origin: 'BBB', destination: 'CCC', departure: '2026-11-20T11:30', arrival: '2026-11-20T14:05' },
  ];
  const got = guard({ ...base, kind: 'flight', flights, unsure: ['flights', 'name'], name: 'AN 1 / AN 2' });
  assert.deepEqual(got, {
    ...base, kind: 'flight', title: 'AN 1 / AN 2', unsure: ['flights', 'title'], fields: { flights },
    start: { at: '2026-11-20T08:00:00-09:00', tz: AK }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK },
  });
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
  assert.equal(unalias(plain, []), plain);
});

test('an alias beside its own field: the same, it is dropped quietly; different, refused naming both', () => {
  const stored = { ...base, kind: 'lodging', title: 'Hotel Aurora Test', name: 'Hotel Aurora Test', start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, checkin: '2026-11-20T15:00' };
  assert.deepEqual(guard(stored), { ...base, kind: 'lodging', title: 'Hotel Aurora Test', start: { at: '2026-11-20T15:00:00-09:00', tz: AK } });
  assert.throws(() => guard({ ...stored, name: 'Another Hotel' }), /^Error: name and title are both given and differ: keep one and remove the other \(write it as null in a patch\)\.$/);
  assert.throws(() => guard({ ...stored, checkin: '2026-11-21T15:00' }), /checkin and start are both given and differ/);
  // One whose own zone isn't known can't be the same.
  assert.throws(() => guard({ ...stored, checkin: '2026-11-20 15:00' }, [AK, TOKYO]), /checkin and start are both given and differ/);
  assert.throws(() => guard({ ...base, kind: 'lodging', total: 'about 100 dollars', fields: { total: 'about 90 dollars' } }), /total and fields\.total are both given/);
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

test('through write and patch: stored right in one call; refused with nothing stored; a stored booking with old names is fixed when she next touches it', async () => {
  const { ws, trip, run } = await setup([AK]);
  await run('write', { path: '/trip/bookings/car.json', content: { ...base, kind: 'car', name: 'Test Rentals compact', pickup: { location: 'Airport lot', at: '2026-11-20T10:00' }, dropoff: { location: 'Airport lot', at: '2026-11-27T09:00' } } });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/car.json'), { ...base, kind: 'car', title: 'Test Rentals compact', place: { name: 'Airport lot' }, start: { at: '2026-11-20T10:00:00-09:00', tz: AK }, end: { at: '2026-11-27T09:00:00-09:00', tz: AK } });
  await assert.rejects(run('write', { path: '/trip/bookings/odd.json', content: { ...base, kind: 'other', rooms: 2 } }), /"rooms" isn't a booking field/);
  assert.equal(await ws.read(trip, '/bookings/odd.json'), undefined);
  // A booking stored before, with old names (the user's edit or an import): read as it is; her next patch moves them.
  const old = { ...base, kind: 'lodging', name: 'Hotel Aurora Test', checkin: '2026-11-20 15:00', checkout: '2026-11-27 11:00' };
  await ws.write(trip, '/bookings/stay.json', old, { author: 'user' });
  assert.deepEqual(await ws.readJSON(trip, '/bookings/stay.json'), old);
  await run('patch', { path: '/trip/bookings/stay.json', changes: { confirmation: 'TEST42' } });
  const fixed = await ws.readJSON(trip, '/bookings/stay.json');
  assert.deepEqual([fixed.title, fixed.start, fixed.end, fixed.confirmation, 'checkin' in fixed], ['Hotel Aurora Test', { at: '2026-11-20T15:00:00-09:00', tz: AK }, { at: '2026-11-27T11:00:00-09:00', tz: AK }, 'TEST42', false]);
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
