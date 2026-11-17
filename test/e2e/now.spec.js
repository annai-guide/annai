import { test, expect } from '@playwright/test';
import { openApp, FIRST_DRAW, startTrip, happeningTrip, writeRecords, writeEvent, goToHash } from './helpers.js';

// Now went in timeline stage 8: where you are, the chips and the sun are at the top of today's Itinerary, its timetable is the Itinerary's own, and
// its latest card is Driving's. These are Now's tests, on the screens that show those parts now.

/** An ISO time some minutes from now, in UTC. @param {number} min */
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
/** Noon by the page's clock, and a trip dated around it: today's Itinerary is 2030-11-27, the same calendar day from Honolulu to Tokyo. */
const NOON = new Date('2030-11-27T12:00:00Z');
const at = (/** @type {number} */ h) => `2030-11-27T${String(h).padStart(2, '0')}:00:00Z`;

test("today's Itinerary: where you are, the sun and the timetable; live mode from the chip; Driving's latest card (spec §16.2, Now's until stage 8)", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.372, longitude: -121.901, accuracy: 10 }); // by Bixby Bridge
  await page.clock.install({ time: NOON });
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, {
    patch: { '/trip.json': { start: '2030-11-26', end: '2030-11-28' } },
    write: {
      '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: at(13), tz: 'UTC' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
      '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: at(15), tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
      // A booking no plan item stands for says nothing of what can move (the user's answer, 2026-11-15: only what was said fixed).
      '/bookings/tour.json': { id: 'tour', kind: 'event', status: 'confirmed', source: '/files/t.pdf', title: 'Garden tour ticket', start: { at: at(14), tz: 'UTC' } },
    },
  });
  await writeEvent(page, trip, { type: 'reminder', data: { watch: 'plan:lunch:leave', text: 'Leave soon: Lunch at Nepenthe.' } });
  await page.reload(); // written outside the app's own files layer: live mode reads the plan again as it starts
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await goToHash(page, `#/trip/${encodeURIComponent(trip)}/plan`);
  const top = page.locator('.today-top');
  await expect(top.locator('.now-place')).toHaveText("GPS is off, so annai isn't following where you are.");
  const rows = page.getByRole('tabpanel').locator('.plan-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Bixby Bridge photo stop');
  // ○ for what Shiori stored as flexible, ● for fixed, and neither mark nor word for the booking's own row.
  await expect(rows.first().locator('.mark')).toHaveText('○');
  await expect(rows.nth(1)).toContainText('Garden tour ticket');
  await expect(rows.nth(1).locator('.mark')).toHaveText('');
  await expect(rows.nth(2).locator('.mark')).toHaveText('●');
  await expect(top.locator('.chips')).toContainText(/Sunrise|Golden|Sunset|Dusk/); // worked out at the next stop
  await page.locator('.live-chip').click();
  await expect(top.locator('.now-place')).toHaveText('At Bixby Creek Bridge');
  await expect(page.locator('.live-chip')).toHaveText(/^GPS on\b/);
  await expect(top.locator('.chips')).toContainText(/^GPS on/);
  await expect(page.locator('.live-chip')).toHaveAttribute('aria-pressed', 'true');
  // The latest card, Now's until stage 8, is Driving's.
  await top.getByRole('link', { name: 'Driving' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Driving' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Leave soon: Lunch at Nepenthe.');
});

test("an empty plan: today's Itinerary and Driving say nothing is planned, with live mode on and the sun where you are, and nothing goes wrong", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.27, longitude: -121.807, accuracy: 10 });
  await openApp(page);
  const trip = await happeningTrip(page, 'Big Sur'); // dated today: its Itinerary has a today
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await goToHash(page, `#/trip/${encodeURIComponent(trip)}/plan`);
  await expect(page.getByText('No itinerary yet.', { exact: false })).toBeVisible();
  const top = page.locator('.today-top');
  await expect(top.locator('.now-place')).toBeVisible();
  await page.locator('.live-chip').click();
  await expect(top.locator('.now-place')).not.toHaveText(/GPS is off/);
  await expect(top.locator('.chips')).toContainText(/Sunrise|Golden|Sunset|Dusk/); // where you are: there is no next stop
  await goToHash(page, '#/drive');
  await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'The road ahead' })).toContainText('Nothing more is planned with a place.');
  await expect(page.locator('.notice', { hasText: 'Something went wrong' })).toHaveCount(0);
});

test('a trip with thousands of location points: Driving, the Itinerary and the conversation still show the latest card and the plan', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: { '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: soon(150), tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } } } });
  await writeEvent(page, trip, { type: 'reminder', data: { watch: 'plan:lunch:leave', text: 'Leave soon: Lunch at Nepenthe.' } });
  // A day of driving after it: the road, as live mode keeps it (spec §4.5).
  await page.evaluate(async (scope) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const store = await createIdbStore();
    await store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
      for (let i = 0; i < 5000; i++) await t.appendEvent(scope, { ts: Date.now(), type: 'location', actor: 'system', data: { lat: 36.6 - i / 1e4, lng: -121.9, accuracy: 8, speed: 20 } });
    });
    store.close();
  }, trip);
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await page.goto('/#/drive');
  await expect(page.getByRole('main')).toContainText('Leave soon: Lunch at Nepenthe.');
  await expect(page.getByRole('list', { name: 'The road ahead' })).toContainText('Nepenthe');
  await page.goto('/#/plan');
  await expect(page.locator('.plan-row', { hasText: 'Lunch at Nepenthe' })).toBeVisible();
  await page.goto('/#/talk');
  await expect(page.locator('.convo .line-reminder')).toContainText('Leave soon: Lunch at Nepenthe.');
  await expect(page.locator('.notice', { hasText: 'Something went wrong' })).toHaveCount(0);
});
