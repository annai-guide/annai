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

test('Booking confirmation: what it says, beside its original; Looks right confirms it, and the plan stops asking', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await records(page, trip, THANKSGIVING);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: 'Check this' }).click();
  await expect(page.getByRole('heading', { name: 'UA 123' })).toBeVisible();
  await expect(page.getByText('Check this against the original, then confirm it.')).toBeVisible();
  await expect(page.locator('dl.facts')).toContainText('ABC123');
  // The booking's zone is named the way people say it, never by its id.
  await expect(page.locator('dl.facts')).toContainText('(PT)');
  await expect(page.locator('dl.facts')).not.toContainText('America/Los_Angeles');
  await expect(page.getByText("The original, /files/flight.pkpass, isn't in the trip.")).toBeVisible();
  await page.getByRole('button', { name: 'Looks right' }).click();
  await expect(page.locator('.chip.ok')).toHaveText('Confirmed');
  await expect(page.getByRole('button', { name: 'Looks right' })).toHaveCount(0);
  await page.getByRole('main').getByRole('link', { name: 'Plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Wed, Nov 25' }).click();
  await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Check this' })).toHaveCount(0);
});

test("a booking link to something that isn't a booking opens nothing", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/trip.json')}`);
  await expect(page.getByRole('heading', { name: "This booking isn't in the trip" })).toBeVisible();
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('milestone 4 done: a pass and a calendar are added, Shiori writes the booking and its plan item, the user confirms it, and the plan goes to the calendar', async ({ page }) => {
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

    // The card opens the booking; the user checks it and confirms it.
    await page.locator('.convo').getByRole('link', { name: 'Open the booking' }).last().click();
    await expect(page.getByRole('heading', { name: 'UA 123 SFO → EWR' })).toBeVisible();
    await expect(page.getByText('From /files/flight.pkpass')).toBeVisible();
    await page.getByRole('button', { name: 'Looks right' }).click();
    await expect(page.locator('.chip.ok')).toHaveText('Confirmed');

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
