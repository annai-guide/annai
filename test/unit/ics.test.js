import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, planItems, planToIcs, MAX_EVENTS, MAX_ICS_BYTES } from '../../src/core/ics.js';
import { importCalendar } from '../../src/core/imports.js';
import { validate } from '../../src/core/schema.js';
import { PLAN_ITEM_SCHEMA, CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { utf8 } from '../../src/core/bytes.js';

const NY = 'America/New_York';
const CAL = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//EN',
  'BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time', 'X-LIC-LOCATION:America/Los_Angeles', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:flight-ua123@example.com', 'SUMMARY:UA 123 SFO → EWR', 'DTSTART:20261125T160000Z', 'DTEND:20261126T001500Z',
  'LOCATION:San Francisco International Airport', 'GEO:37.6213;-122.3790', 'DESCRIPTION:Seat 21C\\nConfirmation ABC123\\, bo', ' oked', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:dinner@example.com', 'SUMMARY:Thanksgiving dinner', 'DTSTART;TZID=America/New_York:20261126T170000', 'DURATION:PT3H',
  "LOCATION:Aunt Mei's\\, Hoboken", 'BEGIN:VALARM', 'TRIGGER:-PT30M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:museum', 'SUMMARY:Museum day', 'DTSTART;VALUE=DATE:20261127', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:outlook-1', 'SUMMARY:Car pickup', 'DTSTART;TZID="Pacific Standard Time":20261129T093000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:mystery', 'SUMMARY:Somewhere', 'DTSTART;TZID=Mars/Olympus:20261128T120000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:floating', 'SUMMARY:Breakfast', 'DTSTART:20261128T080000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:gone', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'DTSTART:20261128T090000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseIcs: zones, UTC, floating and all-day times, durations, escapes, folded lines; cancelled events left out', () => {
  const ev = parseIcs(CAL, { defaultTz: NY });
  assert.deepEqual(ev.map((e) => e.uid), ['flight-ua123@example.com', 'dinner@example.com', 'museum', 'outlook-1', 'mystery', 'floating']);
  const [flight, dinner, museum, car, mystery, breakfast] = ev;
  assert.deepEqual(flight.start, { at: '2026-11-25T11:00:00-05:00', tz: NY });
  assert.deepEqual(flight.end, { at: '2026-11-25T19:15:00-05:00', tz: NY });
  assert.equal(flight.description, 'Seat 21C\nConfirmation ABC123, booked');
  assert.deepEqual(flight.geo, { lat: 37.6213, lng: -122.379 });
  assert.equal(dinner.location, "Aunt Mei's, Hoboken");
  assert.deepEqual(dinner.end, { at: '2026-11-26T20:00:00-05:00', tz: NY });
  assert.equal(dinner.description, ''); // the alarm's description is not the event's
  assert.deepEqual(museum.start, { at: '2026-11-27T00:00:00-05:00', tz: NY, allDay: true });
  assert.deepEqual(car.start, { at: '2026-11-29T09:30:00-08:00', tz: 'America/Los_Angeles' });
  assert.deepEqual(mystery.start, { at: '2026-11-28T12:00:00-05:00', tz: NY });
  assert.deepEqual(mystery.notes, [`The calendar's time zone "Mars/Olympus" isn't one annai knows, so ${NY} was used.`]);
  assert.equal(breakfast.repeats, true);
  assert.deepEqual(breakfast.start, { at: '2026-11-28T08:00:00-05:00', tz: NY });
});

test('parseIcs: broken lines are skipped, and a huge calendar is refused in plain words', () => {
  const broken = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:x', 'SUMMARY no colon here', 'DTSTART:not-a-date', 'SUMMARY:Kept', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  assert.deepEqual(parseIcs(broken, { defaultTz: NY }).map((e) => [e.summary, e.start]), [['Kept', null]]);
  const many = ['BEGIN:VCALENDAR', ...Array.from({ length: MAX_EVENTS + 1 }, (_, i) => `BEGIN:VEVENT\r\nUID:${i}\r\nDTSTART:20261125T160000Z\r\nEND:VEVENT`), 'END:VCALENDAR'].join('\r\n');
  assert.throws(() => parseIcs(many, { defaultTz: NY }), /more than 500 events/);
});

test('planItems: one valid plan item per event, named after its UID, the same each time', () => {
  const items = planItems(parseIcs(CAL, { defaultTz: NY }));
  for (const { item } of items) assert.deepEqual(validate(PLAN_ITEM_SCHEMA, item), []);
  assert.deepEqual(items.map((x) => x.path), planItems(parseIcs(CAL, { defaultTz: NY })).map((x) => x.path));
  for (const { path, item } of items) assert.equal(path, `/plan/${item.id}.json`);
  const flight = items[0].item;
  assert.match(flight.id, /^ics-flight-ua123-example-com-[0-9a-f]{8}$/);
  assert.deepEqual(flight, {
    id: flight.id, title: 'UA 123 SFO → EWR', kind: 'event', fixed: true,
    start: { at: '2026-11-25T11:00:00-05:00', tz: NY }, end: { at: '2026-11-25T19:15:00-05:00', tz: NY },
    place: { name: 'San Francisco International Airport', lat: 37.6213, lng: -122.379 }, notes: 'Seat 21C\nConfirmation ABC123, booked',
  });
  assert.equal(items[2].item.kind, 'all-day');
  assert.match(items[4].item.notes, /Mars\/Olympus/);
  assert.match(items[5].item.notes, /repeats in the calendar; only its first time is here/);
  // UIDs that differ only in punctuation stay apart.
  const [a, b] = planItems(parseIcs(['BEGIN:VEVENT', 'UID:a@b', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:a#b', 'END:VEVENT'].join('\n'), { defaultTz: NY }));
  assert.notEqual(a.path, b.path);
});

test('planToIcs: CRLF, lines of at most 75 octets, escapes, UTC times and all-day dates; it reads back the same', () => {
  const long = `Dinner at the long-named place ${'é🦊'.repeat(30)}; bring wine, cheese`;
  const items = [
    { id: 'dinner', title: long, kind: 'event', fixed: true, start: { at: '2026-11-26T17:00:00-05:00', tz: NY }, end: { at: '2026-11-26T20:00:00-05:00', tz: NY }, place: { name: "Aunt Mei's", address: 'Hoboken, NJ', lat: 40.74, lng: -74.03 }, notes: 'Line one\nLine two' },
    { id: 'museum', title: 'Museum day', kind: 'all-day', fixed: true, start: { at: '2026-11-27T00:00:00-05:00', tz: NY } },
    { id: 'someday', title: 'Ice skating', fixed: false },
  ];
  const { text, left } = planToIcs(items, { name: 'Thanksgiving', tripId: 't-1', now: Date.UTC(2026, 9, 16, 12) });
  assert.equal(left, 1);
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.match(text, /\r\nDTSTART:20261126T220000Z\r\n/);
  assert.match(text, /\r\nDTSTART;VALUE=DATE:20261127\r\n/);
  assert.match(text, /\r\nUID:dinner\.t-1@annai\.guide\r\n/);
  assert.match(text, /\r\nGEO:40\.74;-74\.03\r\n/);
  const back = parseIcs(text, { defaultTz: NY });
  assert.deepEqual(back.map((e) => e.summary), [long, 'Museum day']);
  assert.equal(back[0].description, 'Line one\nLine two');
  assert.equal(back[0].location, "Aunt Mei's, Hoboken, NJ");
  assert.deepEqual(back[0].start, items[0].start);
  assert.deepEqual(back[1].start, { ...items[1].start, allDay: true });
});

test('importCalendar writes plan items from a file in the trip, and the same file again updates them', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Thanksgiving' });
  await ws.write(trip, '/files/trip.ics', utf8(CAL), { author: 'user', type: 'text/calendar' });
  const paths = await importCalendar(ws, trip, '/files/trip.ics', { defaultTz: NY });
  assert.equal(paths.length, 6);
  const entry = (await ws.list(trip, '/plan/')).find((f) => f.path === paths[0]);
  assert.equal(entry?.author, 'user');
  assert.equal(entry?.source, '/files/trip.ics');
  await importCalendar(ws, trip, '/files/trip.ics', { defaultTz: NY });
  assert.equal((await ws.list(trip, '/plan/')).length, 6);
  await ws.write(trip, '/files/huge.ics', new Uint8Array(MAX_ICS_BYTES + 1), { author: 'user', type: 'text/calendar' });
  await assert.rejects(importCalendar(ws, trip, '/files/huge.ics', { defaultTz: NY }), /larger than a trip's calendar/);
});
