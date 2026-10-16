import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers.js';

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
    '/bookings/flight.json': { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pkpass', title: 'UA 123', confirmation: 'ABC123', start: { at: '2026-11-25T08:00:00-08:00', tz: LA } },
    '/bookings/hotel.json': { id: 'hotel', kind: 'lodging', status: 'confirmed', source: '/files/hotel.pdf', title: 'Hoboken Inn' },
  },
  text: { '/plan/broken.json': 'not json' },
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
  await expect(day.locator('.plan-row').first()).toContainText('08:00–16:30');
  await expect(day.locator('.plan-row').first()).toContainText('●');
  await expect(day.getByRole('link', { name: 'Check this' })).toHaveCount(1);
  await expect(day.locator('.leg')).toHaveCount(0); // SFO to Hoboken is a flight, not a leg
  await tabs.nth(1).click();
  await expect(day.locator('.plan-row').first()).toContainText('○');
  await expect(day.locator('.leg')).toContainText('≈ 0.4 mi apart');
  await expect(day.locator('.leg').getByRole('link', { name: 'Directions' })).toHaveAttribute('href', /^https:\/\/(maps\.apple\.com|www\.google\.com\/maps)/);
  await expect(day.getByText('Booking missing')).toBeVisible();
  await tabs.last().click();
  await expect(day).toContainText('Ice skating');
  await expect(page.getByText("1 plan file couldn't be read")).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bookings' })).toContainText('UA 123');
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
