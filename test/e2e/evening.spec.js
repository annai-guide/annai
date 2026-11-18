// The user's evening, done again (the bookings-and-trips design, "Done looks like", steps 1–7), end to end with the stand-in model
// playing Shiori. The booking files are synthetic (scripts/make-booking-fixtures.mjs): ANNAI AIR, TESTQ1, Hotel Aurora Test.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, addProvider, startModelServer, anthropicToolReply, atConversation, openItinerary } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const fixture = async (/** @type {string} */ name, /** @type {string} */ mimeType) => ({ name, mimeType, buffer: await readFile(new URL(`../fixtures/bookings/${name}`, import.meta.url)) });
const TITLE = 'Anchorage · Nov 20–27';
const MESSAGES = '/b/v1/messages';
const LA = 'America/Los_Angeles';
const AK = 'America/Anchorage';
const asText = (/** @type {any} */ body) => JSON.stringify(body ?? {});

/** Her bookings from the two files: the flight there and back from the PDF, the stay from the screenshot. @param {string} hotel its path in the trip */
const bookings = (hotel) => [
  { name: 'write', input: { path: '/trip/bookings/an123.json', content: { id: 'an123', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', confirmation: 'TESTQ1', unsure: ['seat'],
    start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK }, fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)', flight: 'AN 123', airline: 'ANNAI AIR', seat: '14C' } } } },
  { name: 'write', input: { path: '/trip/bookings/an124.json', content: { id: 'an124', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 124', confirmation: 'TESTQ1', unsure: [],
    start: { at: '2026-11-27T13:00:00-09:00', tz: AK }, end: { at: '2026-11-27T17:30:00-08:00', tz: LA }, fields: { from: 'Anchorage (ANC)', to: 'Seattle (SEA)', flight: 'AN 124', airline: 'ANNAI AIR' } } } },
  { name: 'write', input: { path: '/trip/bookings/stay.json', content: { id: 'stay', kind: 'lodging', status: 'unverified', source: hotel, title: 'Hotel Aurora Test', unsure: ['end'],
    place: { name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }, start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK } } } },
  { name: 'patch', input: { path: '/trip/names.json', changes: { '/files/flight.pdf': 'ANNAI AIR flight · Nov 20', [hotel]: 'Hotel Aurora Test stay' } } },
  { name: 'speak', input: { text: 'Your flights and the stay are on the plan. Is check-out at 11:00?' } },
  { name: 'sleep', input: {} },
];

test("the user's evening: with no trip open, the type box with the flight PDF and the hotel screenshot; Shiori makes the new conversation Anchorage · Nov 20–27; the Plan has the flight on Nov 20 with Seattle and Anchorage times, and the stay with its check-in, nights and check-out; the flight's details show the PDF; Open the original and Back; nothing asked where a file goes; Ask Shiori about this with \"the seat is 14D\" fixes the seat", async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    // In the new conversation, open when nothing else is (timeline stage 7): a chat becomes the trip by its own dates.
    sse(anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes: { title: TITLE, start: '2026-11-20', end: '2026-11-27', places: ['Anchorage'] } } }])),
    (/** @type {any} */ body) => sse(anthropicToolReply(bookings((/\/trip(\/files\/hotel\.[a-z]+)/.exec(asText(body))?.[1]) ?? '/files/hotel.png'))),
    // From here on, by what was said: the ask fixes the seat, then she says so; anything else, she sleeps.
    (/** @type {any} */ body) => {
      const last = asText(body.messages.at(-1));
      if (last.includes('the seat is 14D')) return sse(anthropicToolReply([{ name: 'patch', input: { path: '/trip/bookings/an123.json', changes: { fields: { seat: '14D' }, unsure: [] } } }]));
      if (last.includes('an123.json')) return sse(anthropicToolReply([{ name: 'speak', input: { text: 'Seat 14D it is.' } }, { name: 'sleep', input: {} }]));
      return sse(anthropicToolReply([{ name: 'sleep', input: {} }]));
    },
  ] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'Stand-in / b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
    await page.goto('/#/talk'); // the open conversation: the new one, as nothing else is open; the dock at rest on home has no type button
    await atConversation(page);
    const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);

    // 1. No trip open: the box's + with the flight PDF and the hotel screenshot, no words.
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Give Shiori photos or files').setInputFiles([await fixture('flight.pdf', 'application/pdf'), await fixture('hotel.png', 'image/png')]);
    await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(2);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // 2. She made this conversation the trip.
    await expect(page.locator('.convo').getByText('Your flights and the stay are on the plan. Is check-out at 11:00?')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.talk-head .talk-name')).toHaveText(TITLE); // the trip's name heads its conversation (timeline stage 3)
    expect(new URL(page.url()).hash).toBe(`#/trip/${id}/talk`); // the same conversation, now a trip
    // 6. Nothing asked where a file goes.
    await expect(page.locator('.convo .shiori .acts button')).toHaveCount(0);

    // 3. The Plan: the flight on Nov 20 at each airport's time, the stay's check-in, a line for each night, its check-out.
    await openItinerary(page);
    const day = page.getByRole('tabpanel');
    await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
    // Its departure and its Arrive, each at its airport's time (carrier-rows-next), each with the booking's check.
    await expect(day.locator('.plan-row', { hasText: 'ANNAI AIR AN 123' })).toHaveText([/^11:20ANNAI AIR AN 123Check 1 detail$/, /^14:05 AKTArrive · ANNAI AIR AN 123Check 1 detail$/]);
    await expect(day.locator('.plan-row', { hasText: 'ANNAI AIR AN 123' }).getByRole('link', { name: 'Check 1 detail' })).toHaveCount(2);
    await expect(day.getByRole('link', { name: 'Check in · Hotel Aurora Test' })).toBeVisible();
    await page.getByRole('tab', { name: 'Sat, Nov 21' }).click();
    await expect(day.locator('.plan-row.night')).toHaveText('Staying at Hotel Aurora Test · night 2 of 7');
    await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
    await expect(day.getByRole('link', { name: /Check out · Hotel Aurora Test/ })).toBeVisible();
    await expect(day.locator('.plan-row', { hasText: 'ANNAI AIR AN 124' })).toHaveText([/^13:00ANNAI AIR AN 124$/, /^17:30 PTArrive · ANNAI AIR AN 124$/]);

    // 4. The flight's details: Seattle and Anchorage, each in its own zone, and the PDF.
    await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
    await day.getByRole('link', { name: /ANNAI AIR AN 123/ }).first().click();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
    // The itinerary became two flights, so the file's screen has a block for each; the first is this one.
    await expect(page.locator('dl.facts dd').first()).toHaveText('Seattle (SEA) → Anchorage (ANC)');
    await expect(page.locator('dl.facts').first()).toContainText('(PT)');
    await expect(page.locator('dl.facts').first()).toContainText('(AKT)');
    const original = page.getByRole('region', { name: 'The file', exact: true }); // two flights above it: the region is named by its heading
    const draws = await page.evaluate(async () => { const load = (/** @type {string} */ u) => import(u); return (await load('/src/ui/preview.js')).imgDrawsPdf(); });
    if (draws) await expect(original.locator('img.file-preview')).toBeVisible();
    else await expect(original.locator('.file-card')).toContainText('2 pages');
    await expect(original).toContainText('From flight.pdf');
    // 5. Open shows the file, and Back returns to the details.
    await page.getByRole('link', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR flight · Nov 20' })).toBeVisible();
    await expect(page.getByText('File name: flight.pdf')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();

    // 7. Ask Shiori about this, with "the seat is 14D": she fixes the seat, and nothing is left to check on it.
    await expect(page.locator('dl.facts .mark-check')).toHaveCount(1);
    await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
    await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['ANNAI AIR flight · Nov 20', 'ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
    await page.getByLabel('Message to Shiori').fill('the seat is 14D');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Seat 14D it is.')).toBeVisible({ timeout: 60_000 });
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
    await expect(page.locator('dl.facts').first()).toContainText('14D');
    await expect(page.locator('dl.facts .mark-check')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

/** The evening through + (timeline stage 4): her bookings from the files, in the new conversation. @param {string} hotel its path in it */
const plusBookings = (/** @type {string} */ hotel) => [
  { name: 'write', input: { path: '/trip/bookings/an123.json', content: { id: 'an123', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', confirmation: 'TESTQ1', unsure: ['seat'],
    start: { at: '2026-11-20T11:20:00-08:00', tz: LA }, end: { at: '2026-11-20T14:05:00-09:00', tz: AK }, fields: { from: 'Seattle (SEA)', to: 'Anchorage (ANC)', flight: 'AN 123', airline: 'ANNAI AIR', seat: '14C' } } } },
  { name: 'write', input: { path: '/trip/bookings/stay.json', content: { id: 'stay', kind: 'lodging', status: 'unverified', source: hotel, title: 'Hotel Aurora Test', unsure: ['end'],
    place: { name: 'Hotel Aurora Test', address: '1 Test Way, Testville' }, start: { at: '2026-11-20T15:00:00-09:00', tz: AK }, end: { at: '2026-11-27T11:00:00-09:00', tz: AK } } } },
  { name: 'speak', input: { text: 'Your flight and the stay are on the plan.' } },
  { name: 'sleep', input: {} },
];

test("the user's evening from home: + with the files, no words; she dates the new conversation by a patch, its header names it, it is a card below now, and its Plan has the flight", async ({ page }) => {
  // The trip is dated Nov 20–27 and is a card below Now only until its last day is over, so the test's own clock fixes today, as plan.spec.js does
  // (noon UTC is the same calendar day everywhere from Honolulu to Tokyo): the real date reaching the trip's days must not turn the gate red.
  await page.clock.setFixedTime(new Date('2026-11-16T12:00:00Z'));
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes: { title: TITLE, start: '2026-11-20', end: '2026-11-27' } } }])),
    (/** @type {any} */ body) => sse(anthropicToolReply(plusBookings((/\/trip(\/files\/hotel\.[a-z]+)/.exec(asText(body))?.[1]) ?? '/files/hotel.png'))),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'Stand-in / b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByLabel('Add a model to main').locator('option', { hasText: 'b-model' })).toHaveCount(0);
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
    const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await expect(page.getByLabel('Message to Shiori')).toBeFocused();
    await page.getByLabel('Give Shiori photos or files').setInputFiles([await fixture('flight.pdf', 'application/pdf'), await fixture('hotel.png', 'image/png')]);
    await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(2);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Your flight and the stay are on the plan.')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.talk-head .talk-name')).toHaveText(TITLE);
    await expect(page.locator('.dates-line')).toContainText('Shiori set the dates');
    expect(new URL(page.url()).hash).toBe(`#/trip/${id}/talk`); // the same conversation, now a trip
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    const card = page.locator('.trip-card', { has: page.locator('.name', { hasText: TITLE }) });
    await expect(card).not.toHaveClass(/\bline\b/);
    await expect(page.locator('.ahead .trip-card .name')).toContainText([TITLE]);
    await page.goto(`/#/trip/${id}/plan`);
    await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
    await expect(page.getByRole('tabpanel').locator('.plan-row', { hasText: 'ANNAI AIR AN 123' })).toHaveText([/^11:20ANNAI AIR AN 123/, /^14:05 AKTArrive · ANNAI AIR AN 123/]);
  } finally {
    await llm.stop();
  }
});
