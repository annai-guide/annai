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
