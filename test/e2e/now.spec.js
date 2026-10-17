import { test, expect } from '@playwright/test';
import { openApp, startTrip, writeRecords, writeEvent } from './helpers.js';

/** An ISO time some minutes from now, in UTC. @param {number} min */
const soon = (min) => new Date(Date.now() + min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

test('Now: where you are, the sun, what is next and the latest card; live mode from the chip (spec §16.2)', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.372, longitude: -121.901, accuracy: 10 }); // by Bixby Bridge
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, {
    write: {
      '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: soon(30), tz: 'UTC' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
      '/plan/lunch.json': { id: 'lunch', title: 'Lunch at Nepenthe', fixed: true, start: { at: soon(150), tz: 'UTC' }, place: { name: 'Nepenthe', lat: 36.2213, lng: -121.7567 } },
    },
  });
  await writeEvent(page, trip, { type: 'reminder', data: { watch: 'plan:lunch:leave', text: 'Leave soon: Lunch at Nepenthe.' } });
  await page.reload(); // written outside the app's own files layer: live mode reads the plan again as it starts
  await expect(page.locator('main.view > *')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Now' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await expect(page.locator('.now-place')).toHaveText("Live mode is off, so annai isn't following where you are.");
  const next = page.getByRole('region', { name: 'Next' });
  await expect(next.locator('.plan-row')).toHaveCount(2);
  await expect(next.locator('.plan-row').first()).toContainText('Bixby Bridge photo stop');
  await expect(page.locator('.now .chips')).toContainText(/Sunrise|Golden|Sunset|Dusk/); // worked out at the next stop
  await expect(page.getByRole('region', { name: 'Latest' })).toContainText('Reminder: Leave soon: Lunch at Nepenthe.');
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
  await expect(page.locator('.now-place')).toHaveText('At Bixby Creek Bridge');
  await expect(page.locator('.live-chip')).toHaveText(/^Live (on|· )/);
  await expect(page.locator('.now .chips')).toContainText(/^Live /);
  await page.locator('.live-chip').click();
  await expect(page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode off' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Live mode' })).toBeHidden();
});

test('an empty plan: Now and Driving say nothing more is planned, with live mode on and the sun where you are, and nothing goes wrong', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.27, longitude: -121.807, accuracy: 10 });
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.goto('/#/now');
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next' })).toContainText('Nothing more is planned.');
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
  await expect(page.locator('.now-place')).not.toHaveText(/Live mode is off/);
  await expect(page.locator('.now .chips')).toContainText(/Sunrise|Golden|Sunset|Dusk/); // where you are: there is no next stop
  await page.goto('/#/drive');
  await expect(page.getByRole('heading', { name: 'Driving' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'The road ahead' })).toContainText('Nothing more is planned with a place.');
  await expect(page.locator('.notice', { hasText: 'Something went wrong' })).toHaveCount(0);
});

test('a trip with thousands of location points: Now, the Plan and the conversation still show the latest card and the plan', async ({ page }) => {
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
  await expect(page.locator('main.view > *')).toBeVisible();
  await page.goto('/#/now');
  await expect(page.getByRole('region', { name: 'Latest' })).toContainText('Reminder: Leave soon: Lunch at Nepenthe.');
  await expect(page.getByRole('region', { name: 'Next' }).locator('.plan-row')).toContainText('Lunch at Nepenthe');
  await page.goto('/#/plan');
  await expect(page.locator('.plan-row', { hasText: 'Lunch at Nepenthe' })).toBeVisible();
  await page.goto('/#/talk');
  await expect(page.locator('.convo .system-line', { hasText: 'Reminder' })).toContainText('Leave soon: Lunch at Nepenthe.');
  await expect(page.locator('.notice', { hasText: 'Something went wrong' })).toHaveCount(0);
});
