import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByLabel('Starts').fill('2026-11-25');
  await page.getByLabel('Ends').fill('2026-11-29');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('create a trip, edit a note, and restore an earlier version', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur · Thanksgiving');
  await expect(page.getByRole('link', { name: /\/trip\.json/ })).toBeVisible();
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nMcWay Falls at sunset.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByLabel('Content').fill('# Day 1\nChanged my mind.');
  await page.getByRole('button', { name: 'Save' }).click();
  const restore = page.getByRole('button', { name: 'Restore this version' });
  await expect(restore).toHaveCount(2);
  await restore.first().click();
  await expect(page.getByLabel('Content')).toHaveValue('# Day 1\nMcWay Falls at sunset.');
});

test('records are checked against their format before saving', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('File path').fill('/plan/dinner.json');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe" }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('$.fixed: is required');
  await page.getByLabel('Content').fill('{ "id": "dinner", "title": "Nepenthe", "fixed": true }');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
});

test('upload a photo and see it', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ }).click();
  await expect(page.getByRole('img', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
});

test('archive a trip, then bring it back', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(page.getByRole('link', { name: /Old trip/ })).toBeVisible();
});

test('a bad trip name gets a plain explanation', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('   ');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('alert')).toContainText('Give the trip a name');
});

test('a full device says what to do, and nothing is half-saved', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });
  await page.getByLabel('Content').fill('# Day 1');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText("annai's storage is full", { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export a backup' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Content')).toHaveValue('# day1\n'); // still the version from before the failed save
});

test("a trip link can't open your profile or annai's own files", async ({ page }) => {
  await openApp(page, '#/trip/me/file?path=%2Fprofile.md');
  await expect(page.getByRole('heading', { name: "This trip isn't on this device" })).toBeVisible();
});
