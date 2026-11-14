import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, FIRST_DRAW, turnOnSwipes, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, filterTrace, happeningTrip, writeRecords, catchAgent } from './helpers.js';
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
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
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
  // It lands the next day, in another zone: its arrival is a row of its own there (the drive-test follow-ups, section 2).
  await expect(day.locator('.plan-row')).toHaveText(/^21:00●Fixed: UA 456 to San Francisco/);
  await tabs.nth(4).click();
  await expect(day.locator('.plan-row')).toHaveText(/^00:30 PT●Fixed: Arrive · UA 456 to San Francisco/);
  await tabs.last().click();
  await expect(day).toContainText('Ice skating');
  await expect(page.getByText("1 itinerary file and 1 booking file couldn't be read. Open the trip's files to fix them.")).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
  await page.getByRole('region', { name: 'Not on a day' }).getByRole('link', { name: /Museum pass/ }).click();
  await expect(page.getByRole('heading', { name: 'Museum pass' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Check out · Hotel Aurora Test/ }).click();
  await expect(page.getByRole('heading', { name: 'Hotel Aurora Test' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
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

// Noon UTC is the same calendar day everywhere from Honolulu to Tokyo, so the test's own clock fixes "today".
const NOON = new Date('2030-11-27T12:00:00Z');
const HAPPENING = {
  patch: { '/trip.json': { start: '2030-11-26', end: '2030-11-28' } },
  write: {
    '/plan/bridge.json': { id: 'bridge', title: 'Testville Bridge', fixed: false, start: { at: '2030-11-27T13:00:00Z', tz: 'UTC' }, place: { name: 'Testville Bridge', lat: 36.3715, lng: -121.9017 } },
    '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Hotel Aurora Test', fixed: true, start: { at: '2030-11-27T15:00:00Z', tz: 'UTC' }, place: { name: 'Hotel Aurora Test', lat: 36.2213, lng: -121.7567 } },
  },
};

test("today's tab of a trip happening now starts with where you are and Driving; another day's doesn't", async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  await records(page, trip, HAPPENING);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.locator('.today-top .now-place')).toBeVisible();
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toBeVisible();
  await page.getByRole('tab').first().click(); // yesterday
  await expect(page.locator('.today-top')).toBeHidden();
  await page.getByRole('tab').nth(1).click(); // back on today
  await expect(page.locator('.today-top .now-place')).toBeVisible();
});

test("today's top keeps up after its tab is left and come back to", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.3715, longitude: -121.9017, accuracy: 10 });
  await page.clock.install({ time: NOON });
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  await records(page, trip, HAPPENING);
  await page.reload(); // written outside the app's own files layer: live mode reads the plan again as it starts
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await page.locator('.live-chip').click();
  await expect(page.locator('.today-top .now-place')).toHaveText('At Testville Bridge');
  await page.getByRole('tab').first().click();
  await context.setGeolocation({ latitude: 36.2213, longitude: -121.7567, accuracy: 10 });
  await page.clock.fastForward(5000);
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('.today-top .now-place')).toHaveText('At Hotel Aurora Test');
});

test("Driving is linked from the trip in play's today, not from the open trip's when that is another", async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await openApp(page);
  const playing = await happeningTrip(page, 'Testville'); // dated today through the app's own path, so its record carries the dates
  await records(page, playing, { write: HAPPENING.write });
  const open = await startTrip(page, 'Second Testville'); // undated and open: the happening trip stays in play
  await records(page, open, { write: HAPPENING.write });
  await page.goto(`/#/trip/${encodeURIComponent(open)}/plan`);
  await expect(page.locator('.today-top .now-place')).toBeVisible();
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toHaveCount(0);
  await page.goto(`/#/trip/${encodeURIComponent(playing)}/plan`);
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toBeVisible();
});

/** A day's rows, enough to scroll past on a phone. @param {string} day @param {string} stem */
const manyRows = (day, stem) => Object.fromEntries(Array.from({ length: 14 }, (_, i) => {
  const at = `${day}T${String(8 + i).padStart(2, '0')}:00:00Z`;
  return [`/plan/${stem}${i}.json`, { id: `${stem}${i}`, title: `${stem} stop ${i}`, fixed: false, start: { at, tz: 'UTC' } }];
}));

/**
 * A two-week trip around today, longer than the strip on a phone, whose today and late day have many rows, one on each changed by Shiori. Its Itinerary is shown, by the top bar.
 * @param {import('@playwright/test').Page} page
 */
async function longTrip(page) {
  await openApp(page);
  const trip = await startTrip(page, 'Long way');
  const write = { ...manyRows('2030-11-27', 'today'), ...manyRows('2030-12-02', 'late') };
  await records(page, trip, { patch: { '/trip.json': { start: '2030-11-20', end: '2030-12-03' } }, write });
  const changed = (/** @type {string} */ path) => ({ ...write[path], notes: 'Shiori was here.' });
  await writeRecords(page, trip, { author: 'shiori', write: { '/plan/today6.json': changed('/plan/today6.json'), '/plan/late6.json': changed('/plan/late6.json') } });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(TODAY_TAB);
  return trip;
}

const TODAY_TAB = 'Wed, Nov 27';
const LATE_TAB = 'Mon, Dec 2';
/** Where the Itinerary stands: the tab shown, and where the page, the strip and the top bar are scrolled to. @param {import('@playwright/test').Page} page */
const place = (page) => page.evaluate(() => ({
  tab: document.querySelector('[role=tab][aria-selected=true]')?.textContent,
  y: Math.round(scrollY),
  strip: Math.round(/** @type {HTMLElement} */ (document.querySelector('.tabs')).scrollLeft),
  bar: Math.round(/** @type {HTMLElement} */ (document.querySelector('.topnav')).scrollLeft),
}));
/** Whether the tab shown is inside the strip, whole. @param {import('@playwright/test').Page} page */
const tabInView = (page) => page.evaluate(() => {
  const b = /** @type {HTMLElement} */ (document.querySelector('[role=tab][aria-selected=true]')).getBoundingClientRect();
  const s = /** @type {HTMLElement} */ (document.querySelector('.tabs')).getBoundingClientRect();
  return b.left >= s.left - 1 && b.right <= s.right + 1;
});

test('on a phone, Undo on a late day leaves everything where it was: the tab, the page, the strip and the top bar', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await longTrip(page);
  await page.getByRole('tab', { name: LATE_TAB }).click();
  const undo = page.getByRole('button', { name: 'Changed by Shiori · Undo' });
  await undo.scrollIntoViewIfNeeded();
  await page.evaluate(() => { /** @type {HTMLElement} */ (document.querySelector('.tabs')).scrollLeft -= 40; document.querySelector('.topnav')?.scrollBy(60, 0); });
  const before = await place(page);
  expect(before.strip).toBeGreaterThan(0);
  expect(before.y).toBeGreaterThan(0);
  expect(before.bar).toBeGreaterThan(0);
  await undo.click();
  await expect(undo).toHaveCount(0); // the redraw landed
  await expect.poll(() => page.evaluate(() => new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); })).then(() => place(page))).toEqual(before);
});

test('on a phone, a row opened from a late day and Back: the same tab, the same place on the page, and the tab in view', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await longTrip(page);
  await page.getByRole('tab', { name: LATE_TAB }).click();
  const row = page.getByRole('link', { name: /late stop 9/ });
  await row.scrollIntoViewIfNeeded();
  const { tab, y } = await place(page);
  await row.click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(LATE_TAB);
  await expect.poll(async () => { const p = await place(page); return [p.tab, p.y]; }).toEqual([tab, y]);
  await expect.poll(() => tabInView(page)).toBe(true);
});

test("on a phone, leaving the Itinerary and coming back by the top bar opens today's, in view, whatever was picked", async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await longTrip(page);
  await page.getByRole('tab', { name: LATE_TAB }).click();
  const bar = page.getByRole('navigation', { name: 'Main' });
  await bar.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await bar.getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(TODAY_TAB);
  await expect.poll(() => tabInView(page)).toBe(true);
});

test("on a phone, a reload opens today's, whatever was picked", async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await longTrip(page);
  await page.getByRole('tab', { name: LATE_TAB }).click();
  await page.reload();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(TODAY_TAB);
  await expect.poll(() => tabInView(page)).toBe(true);
});

test('nothing picked, the clock past midnight, Undo: the new today, not the day it was', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await longTrip(page);
  await page.clock.setFixedTime(new Date('2030-11-28T00:30:00Z'));
  await page.getByRole('button', { name: 'Changed by Shiori · Undo' }).click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Thu, Nov 28');
});

test("play moving to the trip on screen shows its Driving link in place: a row keeps what was drawn on it, and nothing below moves", async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await openApp(page);
  const first = await happeningTrip(page, 'First');
  const second = await happeningTrip(page, 'Second');
  await records(page, second, { write: HAPPENING.write });
  await catchAgent(page);
  /** A line heard with the microphone on: voice is how play moves with the Itinerary still on screen. @param {string} text */
  const hear = (text) => page.evaluate((text) => /** @type {any} */ (window).agent.log({ type: 'heard', actor: 'user', data: { id: text, text, ms: 900, source: 'live' } }), text);
  await page.goto(`/#/trip/${encodeURIComponent(first)}`);
  await expect(page.getByRole('heading', { name: 'First' })).toBeVisible();
  await hear('Good morning');
  await page.goto(`/#/trip/${encodeURIComponent(second)}`); // looking: it opens, and play stays with the other
  await expect(page.getByRole('heading', { name: 'Second' })).toBeVisible();
  await page.getByRole('link', { name: 'Itinerary' }).first().click();
  const link = page.locator('.today-top').getByRole('link', { name: 'Driving' });
  const row = page.locator('.plan-row').first();
  await expect(row).toBeVisible();
  await expect(link).toHaveCount(0);
  await row.evaluate((el) => { /** @type {any} */ (el).marker = true; });
  const top = (await row.boundingBox())?.y;
  await page.clock.setFixedTime(new Date(NOON.getTime() + 60_000));
  await hear('Are we still on for lunch?');
  await expect(link).toBeVisible(); // the line moved play
  await page.waitForTimeout(500); // a redraw has no sign of its own to wait for: it would have landed
  expect(await row.evaluate((el) => /** @type {any} */ (el).marker)).toBe(true);
  expect((await row.boundingBox())?.y).toBe(top);
});

/** Today's top with a long place name and GPS on at it, on a page whose clock the test moves. @param {import('@playwright/test').Page} page @param {import('@playwright/test').BrowserContext} context */
async function longBridge(page, context) {
  await page.addInitScript(() => { // the watch's callbacks, so a test can send "no signal" (a real sensor's error can't be asked for)
    const real = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    /** @type {any} */ (window).geo = [];
    navigator.geolocation.watchPosition = (ok, err, o) => { /** @type {any} */ (window).geo.push({ ok, err }); return real(ok, err, o); };
  });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.3715, longitude: -121.9017, accuracy: 10 });
  await page.clock.install({ time: NOON });
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  await records(page, trip, {
    patch: HAPPENING.patch,
    write: { ...manyRows('2030-11-27', 'today'), '/plan/bridge.json': { ...HAPPENING.write['/plan/bridge.json'], place: { name: 'The Long Named Testville Bridge', lat: 36.3715, lng: -121.9017 } } },
  });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await page.locator('.live-chip').click();
  await expect(page.locator('.today-top .now-place')).toHaveText('At The Long Named Testville Bridge');
}

/** Waits until the page has stopped scrolling by itself (arriving restores the place for a moment). @param {import('@playwright/test').Page} page */
async function scrollRests(page) {
  let same = 0;
  let last = NaN;
  for (let i = 0; i < 60 && same < 12; i++) {
    const y = await page.evaluate(() => scrollY);
    same = y === last ? same + 1 : 0;
    last = y;
    await page.waitForTimeout(100);
  }
  expect(same).toBeGreaterThanOrEqual(12);
}

test("a fix never changes the height of today's top: the place line is one line, a long name ends in …, and the rows below hold", async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await longBridge(page, context);
  const row = page.locator('.plan-row').first();
  await scrollRests(page);
  const place = page.locator('.today-top .now-place');
  const block = () => page.locator('.today-top .now-card').evaluate((el) => el.getBoundingClientRect().height);
  const y = (await row.boundingBox())?.y;
  const height = await block();
  expect(await place.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))).toEqual({ cut: true, overflow: 'ellipsis' });
  await context.setGeolocation({ latitude: 36.3695, longitude: -121.9017, accuracy: 10 }); // about 220 m off: "Near …, ≈ …"
  await page.clock.fastForward(5000);
  await expect(place).toContainText('Near The Long Named Testville Bridge');
  expect(await block()).toBe(height);
  expect((await row.boundingBox())?.y).toBe(y);
  await context.setGeolocation({ latitude: 36.3715, longitude: -121.9017, accuracy: 10 });
  await page.clock.fastForward(5000);
  await expect(place).toHaveText('At The Long Named Testville Bridge');
  expect(await block()).toBe(height);
  expect((await row.boundingBox())?.y).toBe(y);
  // The signal going and coming back moves nothing either: one line each, and the chips never wrap.
  await page.evaluate(() => /** @type {any} */ (window).geo.at(-1).err({ code: 2, message: 'no signal' }));
  await expect(place).toHaveText('No GPS signal right now.');
  expect(await place.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('nowrap'); // English fits on one line anyway; Japanese at this width doesn't
  expect(await block()).toBe(height);
  expect((await row.boundingBox())?.y).toBe(y);
  await context.setGeolocation({ latitude: 36.3715, longitude: -121.9017, accuracy: 10 });
  await page.clock.fastForward(5000);
  await expect(place).toHaveText('At The Long Named Testville Bridge');
  expect(await block()).toBe(height);
  expect((await row.boundingBox())?.y).toBe(y);
  expect(await page.evaluate(() => {
    const tops = [...document.querySelectorAll('.today-top .chips .chip')].map((c) => c.getBoundingClientRect().top);
    return { oneRow: new Set(tops).size === 1, chips: tops.length, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  })).toMatchObject({ oneRow: true, page: 0 });
});

test('the sentences shown with no fix wrap so they are read whole; only a name and the short no-signal line are cut to one line', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await longBridge(page, context);
  const place = page.locator('.today-top .now-place');
  const style = () => place.evaluate((el) => ({ white: getComputedStyle(el).whiteSpace, cut: el.scrollWidth > el.clientWidth }));
  expect(await style()).toEqual({ white: 'nowrap', cut: true });
  await page.locator('.live-chip').click(); // GPS off
  await expect(place).toContainText('GPS is off');
  expect(await style()).toEqual({ white: 'normal', cut: false });
});

test('a sideways swipe on the chips does not turn into the tab swipe', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await longBridge(page, context);
  await turnOnSwipes(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  const chips = page.locator('.today-top .chips');
  await expect(chips).toBeVisible();
  await chips.evaluate((el) => { for (const w of ['One long chip to swipe past', 'Another long chip', 'And a third one']) el.append(Object.assign(document.createElement('span'), { className: 'chip', textContent: w })); });
  expect(await chips.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.evaluate(() => {
    const el = /** @type {Element} */ (document.querySelector('.today-top .chips .chip'));
    const o = (/** @type {number} */ x) => ({ bubbles: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: el.getBoundingClientRect().top + 5, pointerId: 7 });
    el.dispatchEvent(new PointerEvent('pointerdown', o(280)));
    el.dispatchEvent(new PointerEvent('pointerup', o(120)));
  });
  await page.waitForTimeout(300);
  await expect(page.locator('.topnav a[aria-current="page"]')).toHaveText('Itinerary');
});

test('with the top above the screen, a fix that moves nothing scrolls nothing, and a change that does move rows leaves the ones you read where they are', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 700 }); // narrow: GPS off swaps the one-line place for a sentence that wraps, and adds a button
  await longBridge(page, context);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.scrolls = [];
    const real = window.scrollBy.bind(window);
    window.scrollBy = (/** @type {any[]} */ ...a) => { w.scrolls.push(a); return /** @type {any} */ (real)(...a); }; // a scroll, even by nothing, can stop a flick on an older iPhone
  });
  const row = page.getByRole('link', { name: /today stop 9/ });
  await scrollRests(page);
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, document.querySelector('.today-top')?.getBoundingClientRect().bottom ?? 0)); // the top is above the screen
  await scrollRests(page);
  await page.evaluate(() => { /** @type {any} */ (window).scrolls.length = 0; });
  for (let i = 1; i <= 3; i++) {
    await context.setGeolocation({ latitude: 36.3715 + 0.00002 * i, longitude: -121.9017, accuracy: 10 });
    await page.clock.fastForward(3000);
  }
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(undefined))));
  expect(await page.evaluate(() => /** @type {any} */ (window).scrolls)).toEqual([]);
  const y = (await row.boundingBox())?.y;
  await page.locator('.live-chip').click(); // GPS off: the block grows by lines it didn't have
  await expect(page.locator('.today-top .now-place')).toContainText('GPS is off');
  await expect(page.locator('.today-top').getByRole('button', { name: 'Turn GPS on' })).toBeVisible();
  expect((await row.boundingBox())?.y).toBe(y);
});

test('a trip that ended has no today top', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  await records(page, trip, { patch: { '/trip.json': { start: '2030-11-20', end: '2030-11-22' } }, write: { '/plan/tea.json': { id: 'tea', title: 'Tea', fixed: false, start: { at: '2030-11-21T13:00:00Z', tz: 'UTC' } } } });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.getByRole('tab').first()).toBeVisible();
  await expect(page.locator('.today-top')).toHaveCount(0);
});

test('the Plan with nothing in it, and with no trip open', async ({ page }) => {
  await openApp(page);
  await page.goto('/#/plan');
  await expect(page.getByText('Open a trip to see its itinerary.')).toBeVisible();
  await page.goto('/#/trips');
  await startTrip(page, 'Empty');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
  await expect(page.getByText('No itinerary yet. Ask Shiori to plan with you, or add a calendar file (.ics) in Details.')).toBeVisible();
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
  else await expect(original.locator('.file-card')).toHaveText('ANNAI AIR AN 1232 pages'); // named as the file is: by its one booking's title
  await expect(original).toContainText('From flight.pdf');
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: '/files/flight.pdf' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask Shiori about this' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Looks right' })).toHaveCount(0);
  // Change it is the raw form, and comes back here.
  await page.getByRole('link', { name: 'Change it' }).click();
  await expect(page.locator('#file-content')).toHaveValue(/"ANNAI AIR AN 123"/);
  await page.getByRole('main').getByRole('link', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  // Its crumb goes back to the Plan.
  await page.getByRole('main').getByRole('link', { name: 'Itinerary', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Itinerary' })).toBeVisible();
});

test("a plain item's details: what, when, where, notes and its calendar file; never raw JSON first", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await records(page, trip, ANCHORAGE);
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:aurora@test.invalid', 'SUMMARY:Aurora walk', 'LOCATION:Testville Park', 'DTSTART;TZID=America/Anchorage:20261122T220000', 'DURATION:PT2H', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await page.getByLabel('Add photos or files').setInputFiles([{ name: 'walks.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) }]);
  await expect(page.getByText(/^Added .*walks\.ics, and 1 itinerary item from the calendar/)).toBeVisible();
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Sun, Nov 22' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Aurora walk/ }).click();
  await expect(page.getByRole('heading', { name: 'Aurora walk' })).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.locator('dl.facts dt')).toHaveText(['Starts', 'Ends', 'Place']);
  await expect(page.locator('dl.facts')).toContainText('(AKT)');
  await expect(page.locator('dl.facts')).toContainText('Testville Park');
  await expect(page.getByRole('region', { name: 'The original' })).toContainText('From walks.ics');
  await page.getByRole('main').getByRole('link', { name: 'Itinerary', exact: true }).click();
  await page.getByRole('tab', { name: 'Sat, Nov 21' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Dinner with Sam/ }).click();
  await expect(page.getByRole('heading', { name: 'Dinner with Sam' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notes' })).toContainText('Ask for a window table.');
  await expect(page.getByRole('region', { name: 'The original' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask Shiori about this' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it' })).toBeVisible();
  // A link to something that isn't a plan item says so in words, with a way back.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/item?path=${encodeURIComponent('/trip.json')}`);
  await expect(page.getByRole('heading', { name: "This isn't on the itinerary" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the itinerary' })).toBeVisible();
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
    await expect(page.getByText('Added 2 files, and 1 itinerary item from the calendar')).toBeVisible();

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

    // Its crumb goes back to the Conversation it was opened from. The plan: the flight and the calendar's dinner, nothing left to check; and it goes to the calendar.
    await expect(page.getByRole('main').locator('.crumbs a')).toContainText('Conversation');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Itinerary' }).click();
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
  await expect(page.getByRole('tab')).toHaveText(['Wed, Nov 25', 'Thu, Nov 26', 'Sat, Nov 28', 'Sun, Nov 29', 'No time yet (1)']); // the 29th: a flight's arrival
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
  await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file', { hasText: 'Hoboken Inn' }).locator('.became')).toHaveText('Stay');
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
  const notes = page.getByRole('region', { name: 'On the itinerary' });
  await expect(notes).toContainText('Terminal S, arrive 2 h early.');
  await expect(notes).toContainText('One checked bag each.');
  // In reading order: after what she read, before the file.
  expect(await notes.evaluate((el) => Boolean(/** @type {Node} */ (document.querySelector('dl.facts')).compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
});

// Timeline stage 3: the Itinerary is a trip's sheet, with a history entry of its own, its crumb back to the conversation.
test('the Itinerary opens over the conversation: phone Back closes it, the dock stays', async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  await records(page, id, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch', fixed: true, start: { at: '2099-03-03T13:00:00Z', tz: 'UTC' } } } });
  await page.evaluate((id) => { location.hash = `#/trip/${id}/talk`; }, id);
  await page.getByRole('link', { name: /^Next:/ }).click();
  await expect(page.locator('.screen.sheet')).toBeVisible();
  await expect(page.locator('nav.dock')).toBeVisible();
  await expect(page.getByRole('main').locator('.crumbs a')).toHaveAttribute('href', `#/trip/${id}/talk`);
  await page.goBack();
  await expect(page).toHaveURL(/\/talk$/);
  await expect(page.locator('.screen.sheet')).toHaveCount(0);
});

test('#/trip/<id>/plan of another trip opens that conversation', async ({ page }) => {
  await openApp(page);
  const a = await startTrip(page, 'Big Sur');
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const b = await startTrip(page, 'Point Reyes');
  await page.evaluate((a) => { location.hash = `#/trip/${a}/talk`; }, a);
  await expect(page.locator('.talk-head')).toContainText('Big Sur');
  await page.evaluate((b) => { location.hash = `#/trip/${b}/plan`; }, b);
  await expect(page.getByRole('heading', { level: 1, name: 'Itinerary' })).toBeVisible();
  await page.getByRole('main').locator('.crumbs a').click();
  await expect(page).toHaveURL(new RegExp(`/trip/${b}/talk$`));
  await expect(page.locator('.talk-head')).toContainText('Point Reyes');
  // The plain #/talk is now that one.
  await page.evaluate(() => { location.hash = '#/talk'; });
  await expect(page).toHaveURL(new RegExp(`/trip/${b}/talk$`));
});
