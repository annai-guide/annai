import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, filterTrace } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
}

/**
 * Writes trip records through annai's own modules in the page, as the user's (no format check, so a
 * broken file can be written too); patches merge into existing JSON. Text written with type text/plain stays as it is.
 * @param {import('@playwright/test').Page} page @param {string} trip
 * @param {{ write?: Record<string, any>, text?: Record<string, string>, patch?: Record<string, any> }} c
 */
async function records(page, trip, c) {
  await page.evaluate(async ({ trip, c }) => {
    // Through a variable, so the type checker doesn't look for these paths on disk: they are the page's.
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (const [path, value] of Object.entries(c.write ?? {})) await ws.write(trip, path, value, { author: 'user' });
    for (const [path, value] of Object.entries(c.text ?? {})) await ws.write(trip, path, value, { author: 'user', type: 'text/plain' });
    for (const [path, value] of Object.entries(c.patch ?? {})) await ws.patch(trip, path, value, { author: 'user' });
    store.close();
  }, { trip, c });
}

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const THANKSGIVING = {
  patch: { '/trip.json': { start: '2026-11-25', end: '2026-11-29', timezones: [NY] } },
  write: {
    '/plan/flight.json': { id: 'flight', title: 'UA 123 to Newark', kind: 'flight', fixed: true, start: { at: '2026-11-25T08:00:00-08:00', tz: LA }, end: { at: '2026-11-25T16:30:00-05:00', tz: NY }, place: { name: 'SFO', lat: 37.6213, lng: -122.379 }, booking: '/trip/bookings/flight.json' },
    '/plan/hotel.json': { id: 'hotel', title: 'Check in: Hoboken Inn', fixed: true, start: { at: '2026-11-25T20:00:00-05:00', tz: NY }, place: { name: 'Hoboken Inn', lat: 40.744, lng: -74.032 }, booking: '/bookings/hotel.json' },
    '/plan/pie.json': { id: 'pie', title: 'Pick up pies', fixed: false, priority: 1, start: { at: '2026-11-26T10:00:00-05:00', tz: NY }, place: { name: 'Bakery', lat: 40.75, lng: -74.03 } },
    '/plan/dinner.json': { id: 'dinner', title: 'Thanksgiving dinner', fixed: true, start: { at: '2026-11-26T17:00:00-05:00', tz: NY }, place: { name: "Aunt Mei's", lat: 40.745, lng: -74.028 }, booking: '/trip/bookings/gone.json' },
    '/plan/skate.json': { id: 'skate', title: 'Ice skating', fixed: false },
    '/plan/home.json': { id: 'home', title: 'UA 456 to San Francisco', kind: 'flight', fixed: true, start: { at: '2026-11-28T21:00:00-05:00', tz: NY }, end: { at: '2026-11-29T00:30:00-08:00', tz: LA }, place: { name: 'EWR' } },
    '/bookings/flight.json': { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pkpass', title: 'UA 123', confirmation: 'ABC123', start: { at: '2026-11-25T08:00:00-08:00', tz: LA } },
    '/bookings/hotel.json': { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/hotel.pdf', title: 'Hoboken Inn' },
  },
  text: { '/plan/broken.json': 'not json', '/bookings/broken.json': 'not json either' },
};

test('the Plan: day tabs, ● fixed and ○ flexible, legs with directions, Check this, and what it could not read', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await records(page, trip, THANKSGIVING);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveText(['Wed, Nov 25', 'Thu, Nov 26', 'Fri, Nov 27', 'Sat, Nov 28', 'Sun, Nov 29', 'No time yet (1)']);
  await tabs.first().click(); // the open tab is today's when the trip is on, so pick one
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  const day = page.getByRole('tabpanel');
  await expect(day.locator('.plan-row')).toHaveCount(2);
  await expect(day.locator('.plan-row').first()).toContainText('08:00–16:30 ET'); // it lands in another zone
  await expect(day.locator('.plan-row').first()).toContainText('●');
  await expect(day.getByRole('link', { name: 'Check this' })).toHaveCount(1);
  await expect(day.locator('.leg')).toHaveCount(0); // SFO to Hoboken is a flight, not a leg
  await tabs.nth(1).click();
  await expect(day.locator('.plan-row').first()).toContainText('○');
  await expect(day.locator('.leg')).toContainText('≈ 0.4 mi apart');
  await expect(day.locator('.leg').getByRole('link', { name: 'Directions' })).toHaveAttribute('href', /^https:\/\/(maps\.apple\.com|www\.google\.com\/maps)/);
  await expect(day.getByText('Booking missing')).toBeVisible();
  await tabs.nth(3).click();
  await expect(day.locator('.plan-row')).toContainText('21:00–00:30 +1 PT'); // it lands the next day, in another zone
  await tabs.last().click();
  await expect(day).toContainText('Ice skating');
  await expect(page.getByText("1 plan file and 1 booking file couldn't be read. Open the trip's files to fix them.")).toBeVisible();
  // The trip's bookings are on their days: there is no separate Bookings list (goal 9).
  await expect(page.getByRole('region', { name: 'Bookings' })).toHaveCount(0);
  // The calendar file: every timed item, in UTC.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Add to calendar' }).click();
  const ics = await readFile(/** @type {string} */ (await (await downloading).path()), 'utf8');
  expect(ics).toContain('SUMMARY:UA 123 to Newark');
  expect(ics).toContain('DTSTART:20261125T160000Z');
  expect(ics).not.toContain('Ice skating');
  await expect(page.getByText(/1 item has no time yet/)).toBeVisible();
  // Nothing on a phone screen scrolls sideways, the top bar included.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

const AK = 'America/Anchorage';
/** A trip to Anchorage, synthetic: a flight and a stay no plan item stands for, a pass with no day, and a plain plan item. */
const ANCHORAGE = {
  patch: { '/trip.json': { start: '2026-11-20', end: '2026-11-27', timezones: [AK] } },
  write: {
    '/bookings/flight.json': { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', confirmation: 'TESTQ1', unsure: [], start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK }, fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)', seat: '14C' } },
    '/bookings/stay.json': { id: 'stay', kind: 'lodging', status: 'unverified', source: '/files/hotel.png', title: 'Hotel Aurora Test', unsure: [], place: { name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }, start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK } },
    '/bookings/pass.json': { id: 'pass', kind: 'event', status: 'unverified', source: '/files/pass.pkpass', title: 'Museum pass', unsure: [] },
    '/plan/dinner.json': { id: 'dinner', title: 'Dinner with Sam', fixed: true, start: { at: '2026-11-21T18:30:00-09:00', tz: AK }, place: { name: 'Testville Grill' }, notes: 'Ask for a window table.' },
  },
};

test("the Plan: the flight on Nov 20 with its times, the stay's check-in, a line for each night, its check-out; a pass under Not on a day; no Bookings list", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  // Not on a day is above the day tabs.
  const notOnDay = page.getByRole('region', { name: 'Not on a day' });
  await expect(notOnDay).toContainText('Museum pass');
  expect(await notOnDay.evaluate((el) => Boolean(el.compareDocumentPosition(/** @type {Node} */ (document.querySelector('[role="tablist"]'))) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.getByRole('tab')).toHaveText(['Fri, Nov 20', 'Sat, Nov 21', 'Sun, Nov 22', 'Mon, Nov 23', 'Tue, Nov 24', 'Wed, Nov 25', 'Thu, Nov 26', 'Fri, Nov 27']);
  const day = page.getByRole('tabpanel');
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await expect(day.locator('.plan-row').first()).toContainText(/11:20–14:05 AK/);
  await expect(day.locator('.plan-row').first()).toContainText('ANNAI AIR AN 123');
  await expect(day.getByRole('link', { name: /Check in · Hotel Aurora Test/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Sat, Nov 21' }).click();
  // The night comes first in its day, a quiet line that isn't a link, then the day's own rows.
  await expect(day.locator('.plan-row').first()).toHaveText('Staying at Hotel Aurora Test · night 2 of 7');
  await expect(day.locator('.plan-row.night a')).toHaveCount(0);
  await expect(day.locator('.plan-row').nth(1)).toContainText('Dinner with Sam');
  await page.getByRole('tab', { name: 'Thu, Nov 26' }).click();
  await expect(day.locator('.plan-row.night')).toHaveText('Staying at Hotel Aurora Test · night 7 of 7');
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await expect(day.getByRole('link', { name: /Check out · Hotel Aurora Test/ })).toBeVisible();
  await expect(day.locator('.plan-row.night')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Bookings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to calendar' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a tap on any row opens its details, never the raw file', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /ANNAI AIR AN 123/ }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await page.getByRole('region', { name: 'Not on a day' }).getByRole('link', { name: /Museum pass/ }).click();
  await expect(page.getByRole('heading', { name: 'Museum pass' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Check out · Hotel Aurora Test/ }).click();
  await expect(page.getByRole('heading', { name: 'Hotel Aurora Test' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Sat, Nov 21' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Dinner with Sam/ }).click();
  await expect(page.getByRole('heading', { name: 'Dinner with Sam' })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('an old unverified booking says Check this; a new one with an unsure seat says Check 1 detail; an old confirmed one says neither', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  const at = (/** @type {string} */ h) => ({ at: `2026-11-20T${h}:00-09:00`, tz: AK });
  await records(page, trip, { patch: { '/trip.json': { start: '2026-11-20', end: '2026-11-20', timezones: [AK] } }, write: {
    '/bookings/old.json': { id: 'old', kind: 'flight', status: 'unverified', source: '/files/a.pdf', title: 'Old unverified', start: at('08:00') },
    '/bookings/seat.json': { id: 'seat', kind: 'flight', status: 'unverified', source: '/files/b.pdf', title: 'New with a seat', unsure: ['seat'], fields: { seat: '14C' }, start: at('09:00') },
    '/bookings/ok.json': { id: 'ok', kind: 'flight', status: 'confirmed', source: '/files/c.pdf', title: 'Old confirmed', start: at('10:00') },
  } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  const rows = page.getByRole('tabpanel').locator('.plan-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole('link', { name: 'Check this' })).toBeVisible();
  await expect(rows.nth(1).getByRole('link', { name: 'Check 1 detail' })).toBeVisible();
  await expect(rows.nth(1).getByText('Check this')).toHaveCount(0);
  await expect(rows.nth(2).locator('.chip')).toHaveCount(0);
  await rows.nth(1).getByRole('link', { name: 'Check 1 detail' }).click();
  await expect(page.getByRole('heading', { name: 'New with a seat' })).toBeVisible();
});

test('the Plan with nothing in it, and with no trip open', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/plan');
  await expect(page.getByText('Open a trip to see its plan.')).toBeVisible();
  await page.goto('/#/trips');
  await startTrip(page, 'Empty');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan' }).click();
  await expect(page.getByText('No plan yet. Ask Shiori to plan with you, or add a calendar file (.ics) to the trip.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to calendar' })).toBeDisabled();
});

test("Booking details from before: what it says, beside its original, marked whole as Check this, with no confirming step", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await records(page, trip, THANKSGIVING);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: 'Check this' }).click();
  await expect(page.getByRole('heading', { name: 'UA 123' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText("Check this: Shiori read it before annai marked single details. Tell her if it's right, or what's wrong.");
  await expect(page.locator('dl.facts')).toContainText('ABC123');
  // The booking's zone is named the way people say it, never by its id.
  await expect(page.locator('dl.facts')).toContainText('(PT)');
  await expect(page.locator('dl.facts')).not.toContainText('America/Los_Angeles');
  await expect(page.getByText("The original, flight.pkpass, isn't in the trip.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Looks right' })).toHaveCount(0);
});

/**
 * Stores a file in a trip through annai's own modules in the page, as the user's. @param {import('@playwright/test').Page} page
 * @param {string} trip @param {string} path @param {Buffer} bytes @param {string} type
 */
async function putFile(page, trip, path, bytes, type) {
  await page.evaluate(async ({ trip, path, data, type }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    await new Workspace(store).write(trip, path, new Uint8Array(data), { author: 'user', type });
    store.close();
  }, { trip, path, data: [...bytes], type });
}

test("a flight's details: what Shiori read, its PDF's preview or card, Open the original and Back, Ask Shiori about this, Change it; no Looks right", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  await records(page, trip, { patch: { '/bookings/flight.json': { unsure: ['seat'] } } });
  await putFile(page, trip, '/files/flight.pdf', await readFile('test/fixtures/bookings/flight.pdf'), 'application/pdf');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /ANNAI AIR AN 123/ }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  // What she read, in reading order: the route, then each airport's own time.
  const facts = page.locator('dl.facts');
  await expect(facts.locator('dt')).toHaveText(['Route', 'Departs', 'Arrives', 'Seat', 'Confirmation']);
  await expect(facts.locator('dd').first()).toHaveText('Seattle (SEA) → Anchorage (ANC)');
  await expect(facts.locator('dd').nth(1)).toContainText('(PT)');
  await expect(facts.locator('dd').nth(2)).toContainText('(AKT)');
  // Only the seat is marked, with words for screen readers.
  await expect(facts.locator('.mark-check')).toHaveCount(1);
  await expect(facts.locator('dd').nth(3).locator('.mark-check')).toContainText("Shiori isn't sure of this");
  await expect(page.getByRole('note')).toHaveCount(0);
  // The file: the browser's drawing where an <img> draws PDFs, else its card naming 2 pages.
  const original = page.getByRole('region', { name: 'The original' });
  const draws = await page.evaluate(async () => { const load = (/** @type {string} */ u) => import(u); return (await load('/src/ui/preview.js')).imgDrawsPdf(); });
  if (draws) await expect(original.locator('img.file-preview')).toBeVisible();
  else await expect(original.locator('.file-card')).toHaveText('flight.pdf2 pages');
  await expect(original).toContainText('From flight.pdf');
  await page.getByRole('link', { name: 'Open the original' }).click();
  await expect(page.getByRole('heading', { name: '/files/flight.pdf' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Booking' }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask Shiori about this' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Looks right' })).toHaveCount(0);
  // Change it is the raw form, and comes back here.
  await page.getByRole('link', { name: 'Change it' }).click();
  await expect(page.locator('#file-content')).toHaveValue(/"ANNAI AIR AN 123"/);
  await page.getByRole('main').getByRole('link', { name: 'Booking' }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  // Its crumb goes back to the Plan.
  await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
});

test("a plain item's details: what, when, where, notes and its calendar file; never raw JSON first", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:aurora@test.invalid', 'SUMMARY:Aurora walk', 'LOCATION:Testville Park', 'DTSTART;TZID=America/Anchorage:20261122T220000', 'DURATION:PT2H', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await page.getByLabel('Add photos or files').setInputFiles([{ name: 'walks.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) }]);
  await expect(page.getByText(/^Added .*walks\.ics, and 1 plan item from the calendar/)).toBeVisible();
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Sun, Nov 22' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Aurora walk/ }).click();
  await expect(page.getByRole('heading', { name: 'Aurora walk' })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.locator('dl.facts dt')).toHaveText(['Starts', 'Ends', 'Place']);
  await expect(page.locator('dl.facts')).toContainText('(AKT)');
  await expect(page.locator('dl.facts')).toContainText('Testville Park');
  await expect(page.getByRole('region', { name: 'The original' })).toContainText('From walks.ics');
  await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Sat, Nov 21' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Dinner with Sam/ }).click();
  await expect(page.getByRole('heading', { name: 'Dinner with Sam' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notes' })).toContainText('Ask for a window table.');
  await expect(page.getByRole('region', { name: 'The original' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask Shiori about this' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it' })).toBeVisible();
  // A link to something that isn't a plan item says so in words, with a way back.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/item?path=${encodeURIComponent('/trip.json')}`);
  await expect(page.getByRole('heading', { name: "This isn't on the plan" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the plan' })).toBeVisible();
});

test('a booking whose file is gone says so, with no preview, and can still be asked about', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/bookings/stay.json')}`);
  await expect(page.getByRole('heading', { name: 'Hotel Aurora Test' })).toBeVisible();
  await expect(page.getByText("The original, hotel.png, isn't in the trip.")).toBeVisible();
  await expect(page.locator('.file-preview, .file-card')).toHaveCount(0);
  await expect(page.locator('dl.facts dt')).toHaveText(['Place', 'Check-in', 'Check-out', 'Nights']);
  await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['Hotel Aurora Test']);
  await expect(page.getByRole('button', { name: 'Read it again' })).toBeVisible();
});

test("a booking link to something that isn't a booking opens nothing", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/trip.json')}`);
  await expect(page.getByRole('heading', { name: "This booking isn't in the trip" })).toBeVisible();
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('milestone 4 done: a pass and a calendar are added, Shiori writes the booking and its plan item, can\'t confirm it, and the plan goes to the calendar', async ({ page }) => {
  const booking = {
    id: 'ua123', kind: 'flight', status: 'unverified', source: '/files/flight.pkpass', title: 'UA 123 SFO → EWR', confirmation: 'ABC123', unsure: [],
    start: { at: '2026-11-25T08:00:00-08:00', tz: 'America/Los_Angeles' }, end: { at: '2026-11-25T16:30:00-05:00', tz: 'America/New_York' },
  };
  const item = { id: 'ua123', title: 'UA 123 to Newark', kind: 'flight', fixed: true, start: booking.start, end: booking.end, booking: '/trip/bookings/ua123.json' };
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'read', input: { path: '/trip/files/flight.pkpass' } }], 'A boarding pass. Reading it.')),
      sse(anthropicToolReply([
        { name: 'write', input: { path: '/trip/bookings/ua123.json', content: booking } },
        { name: 'write', input: { path: '/trip/plan/ua123.json', content: item } },
        { name: 'patch', input: { path: '/trip/bookings/ua123.json', changes: { status: 'confirmed' } } },
      ])),
      sse(anthropicToolReply([
        { name: 'show', input: { card: { title: 'UA 123 SFO → EWR', text: 'Wed Nov 25, 8:00 from SFO. Check it on the plan.', booking: '/trip/bookings/ua123.json' } } },
        { name: 'sleep', input: {} },
      ])),
    ],
  });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Endpoint B', url: `${llm.origin}/b`, key: 'sk-test-secret-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    const trip = await startTrip(page, 'Thanksgiving');
    await records(page, trip, { patch: { '/trip.json': { start: '2026-11-25', end: '2026-11-29', timezones: ['America/New_York'] } } });

    // One batch: a Wallet pass and a calendar file.
    const z = new ZipWriter();
    await z.add('pass.json', utf8(JSON.stringify({ organizationName: 'Example Air', description: 'Boarding pass', boardingPass: { transitType: 'PKTransitTypeAir', primaryFields: [{ key: 'origin', label: 'SFO', value: 'San Francisco' }, { key: 'destination', label: 'EWR', value: 'Newark' }], backFields: [{ key: 'conf', label: 'Confirmation', value: 'ABC123' }] } })));
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dinner@example.com', 'SUMMARY:Thanksgiving dinner', 'DTSTART;TZID=America/New_York:20261126T170000', 'DURATION:PT3H', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    await page.getByLabel('Add photos or files').setInputFiles([
      { name: 'flight.pkpass', mimeType: 'application/vnd.apple.pkpass', buffer: Buffer.from(await z.finish().arrayBuffer()) },
      { name: 'thanksgiving.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) },
    ]);
    await expect(page.getByText('Added 2 files, and 1 plan item from the calendar')).toBeVisible();

    // Shiori is woken once, reads the pass, writes the booking and its plan item, can't confirm it, and shows it.
    await page.goto('/#/talk');
    await expect(page.locator('.convo .card-title').last()).toHaveText('UA 123 SFO → EWR', { timeout: 20_000 });
    const first = JSON.stringify(llm.bodies('/b/v1/messages')[0]);
    expect(first).toContain('The user added 2 files to the trip');
    expect(first).toContain('annai made 1 plan item from the calendar');
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('Example Air');
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[2])).toContain('Only the user confirms a booking');
    expect(llm.bodies('/b/v1/messages').length).toBe(3);

    // The card opens the booking's details: what she read and its pass, with nothing for the user to confirm (she was sure of it all).
    await page.locator('.convo').getByRole('link', { name: 'Open the booking' }).last().click();
    await expect(page.getByRole('heading', { name: 'UA 123 SFO → EWR' })).toBeVisible();
    await expect(page.getByText('From flight.pkpass')).toBeVisible();
    await expect(page.locator('.mark-check')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Looks right' })).toHaveCount(0);

    // The plan: the flight and the calendar's dinner, nothing left to check; and it goes to the calendar.
    await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
    await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('UA 123 to Newark');
    await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Check this' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Thu, Nov 26' }).click();
    await expect(page.getByRole('tabpanel')).toContainText('Thanksgiving dinner');
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Add to calendar' }).click();
    const saved = await readFile(/** @type {string} */ (await (await downloading).path()), 'utf8');
    expect(saved).toContain('SUMMARY:UA 123 to Newark');
    expect(saved).toContain('SUMMARY:Thanksgiving dinner');

    // The trace has the read of the pass and the refused confirmation, and no key.
    await page.getByRole('link', { name: 'Trace' }).click();
    await filterTrace(page, { kind: 'Tools' });
    await expect(page.getByText(/^read \{"path":"\/trip\/files\/flight\.pkpass"/)).toBeVisible();
    await expect(page.getByText(/^patch · error · .*Only the user confirms a booking/)).toBeVisible();
    for (const summary of await page.locator('ol.trace summary').all()) await summary.click();
    expect(await page.locator('ol.trace').innerText()).not.toContain('sk-test-secret');
  } finally {
    await llm.stop();
  }
});

test('a trip from before: unverified and confirmed bookings without unsure, plan items linking them, a trip with no dates; the Plan, the details and Files all show them, the old unverified one marked whole', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await records(page, trip, { write: THANKSGIVING.write });
  await putFile(page, trip, '/files/hotel.pdf', Buffer.from('%PDF-1.4 hotel'), 'application/pdf');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  // No dates: the days with something on them.
  await expect(page.getByRole('tab')).toHaveText(['Wed, Nov 25', 'Thu, Nov 26', 'Sat, Nov 28', 'No time yet (1)']);
  await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
  const day = page.getByRole('tabpanel');
  await expect(day.locator('.plan-row', { hasText: 'UA 123 to Newark' }).getByRole('link', { name: 'Check this' })).toBeVisible();
  await expect(day.locator('.plan-row', { hasText: 'Hoboken Inn' }).locator('.chip')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Not on a day' })).toHaveCount(0);
  // The details: the unverified one marked whole, the confirmed one not at all.
  await day.getByRole('link', { name: /UA 123 to Newark/ }).click();
  await expect(page.getByRole('heading', { name: 'UA 123' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Check this');
  await page.goBack();
  await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
  await day.getByRole('link', { name: /Check in: Hoboken Inn/ }).click();
  await expect(page.getByRole('heading', { name: 'Hoboken Inn' })).toBeVisible();
  await expect(page.getByRole('note')).toHaveCount(0);
  await expect(page.locator('.mark-check')).toHaveCount(0);
  // Files: the hotel's PDF became the stay.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await expect(page.getByRole('region', { name: 'Files' }).locator('.trip-file', { hasText: 'hotel.pdf' })).toContainText('A stay: Hoboken Inn');
});

test("a plan item's notes on the booking it stands for show on the booking's details, which a tap on that item opens", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  await records(page, trip, { write: {
    '/plan/fly.json': { id: 'fly', title: 'Fly to Anchorage', fixed: true, start: ANCHORAGE.write['/bookings/flight.json'].start, booking: '/trip/bookings/flight.json', notes: 'Terminal S, arrive 2 h early.' },
    '/plan/bags.json': { id: 'bags', title: 'Bags', fixed: false, booking: '/bookings/flight.json', notes: 'One checked bag each.' },
  } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Fly to Anchorage/ }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  const notes = page.getByRole('region', { name: 'Notes' });
  await expect(notes).toContainText('Terminal S, arrive 2 h early.');
  await expect(notes).toContainText('One checked bag each.');
  // In reading order: after what she read, before the file.
  expect(await notes.evaluate((el) => Boolean(/** @type {Node} */ (document.querySelector('dl.facts')).compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});
