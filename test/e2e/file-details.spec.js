import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';
import { fileTrip } from './file-details-fixture.js';

test('Files: one row per file, by its first booking day then name, each one link with what it is; no record names, no Ask; a plain photo is not listed', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  const files = page.getByRole('region', { name: 'Files', exact: true });
  const rows = files.locator('.trip-file');
  await expect(rows.locator('.name')).toHaveText(['ANNAI AIR itinerary', 'Hotel Aurora Test', 'walks.ics', 'new.pdf']);
  await expect(rows.locator('.became')).toHaveText(['2 flights · Nov 20, Nov 27', 'Stay · Nov 20', 'Plan items from a calendar', 'Waiting for Shiori to read it']);
  for (const row of await rows.all()) await expect(row.getByRole('link')).toHaveCount(1);
  await expect(files.getByRole('button', { name: 'Ask Shiori about this' })).toHaveCount(0);
  await expect(files).not.toContainText('.json');
  await expect(rows.first().getByRole('link')).toHaveAttribute('href', /\/booking\?path=%2Ffiles%2Fitinerary\.pdf&from=%23%2Ftrip%2F/);
  await expect(files).not.toContainText('view.png');
});
