import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { startTrip, putFile, writeRecords, writeEvent } from './helpers.js';

const AK = 'America/Anchorage';
const LA = 'America/Los_Angeles';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BACK_START = { at: '2026-11-27T13:00:00-09:00', tz: AK };
const SAID_START = { at: '2026-11-22T19:00:00-09:00', tz: AK };

/**
 * The synthetic trip the file-details tests share: an itinerary PDF that became two flights (outbound and return), a hotel screenshot
 * that became a stay, a restaurant Shiori wrote from what the user said (no file), a file waiting to be read, a plain photo, and, once
 * fileTrip has added it, a one-event calendar. Plan items stand for the return flight and the dinner.
 */
export const FILE_TRIP = {
  patch: { '/trip.json': { start: '2026-11-20', end: '2026-11-27', timezones: [AK] } },
  write: {
    '/bookings/out.json': { id: 'out', kind: 'flight', status: 'unverified', source: '/files/itinerary.pdf', title: 'ANNAI AIR AN 123', unsure: [],
      start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK }, fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)' } },
    '/bookings/back.json': { id: 'back', kind: 'flight', status: 'unverified', source: '/trip/files/itinerary.pdf', title: 'ANNAI AIR AN 124', unsure: ['seat'],
      start: BACK_START, end: { at: '2026-11-27T20:30:00-08:00', tz: LA }, fields: { from: 'Anchorage (ANC)', to: 'Seattle (SEA)', seat: '14C' } },
    '/bookings/stay.json': { id: 'stay', kind: 'lodging', status: 'unverified', source: '/files/hotel.png', title: 'Hotel Aurora Test', unsure: [],
      place: { name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }, start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK } },
    '/bookings/said.json': { id: 'said', kind: 'restaurant', status: 'unverified', source: '/talk', title: 'Testville Grill', unsure: [], start: SAID_START },
    '/plan/fly-home.json': { id: 'fly-home', title: 'Fly home', fixed: true, start: BACK_START, booking: '/trip/bookings/back.json', notes: 'Terminal S.' },
    '/plan/grill.json': { id: 'grill', title: 'Dinner at the grill', fixed: true, start: SAID_START, booking: '/bookings/said.json' },
    '/names.json': { '/files/itinerary.pdf': 'ANNAI AIR itinerary' },
  },
};

/**
 * Builds the trip on the Trips screen and returns its id: Anchorage, with FILE_TRIP's records, its four files, a wake that leaves
 * new.pdf waiting to be read, and walks.ics added by hand (one plan item, "Aurora walk", Nov 22 22:00 Anchorage).
 * @param {import('@playwright/test').Page} page
 */
export async function fileTrip(page) {
  const trip = await startTrip(page, 'Anchorage');
  await putFile(page, trip, '/files/itinerary.pdf', await readFile('test/fixtures/bookings/flight.pdf'), 'application/pdf');
  await putFile(page, trip, '/files/hotel.png', await readFile('test/fixtures/bookings/hotel.png'), 'image/png');
  await putFile(page, trip, '/files/new.pdf', Buffer.from('%PDF-1.4 new'), 'application/pdf');
  await putFile(page, trip, '/files/view.png', PNG, 'image/png');
  await writeRecords(page, trip, FILE_TRIP);
  await writeEvent(page, trip, { type: 'wake', data: { reasons: [{ files: ['/files/new.pdf'] }] } });
  await page.reload();
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:aurora@test.invalid', 'SUMMARY:Aurora walk', 'LOCATION:Testville Park', 'DTSTART;TZID=America/Anchorage:20261122T220000', 'DURATION:PT2H', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await page.getByLabel('Add photos or files').setInputFiles([{ name: 'walks.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) }]);
  await expect(page.getByText(/walks\.ics, and 1 itinerary item from the calendar/)).toBeVisible();
  return trip;
}
