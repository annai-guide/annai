import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers.js';

/** A fixture photo, ready for setInputFiles. @param {string} name */
async function photo(name) {
  const mimeType = { heic: 'image/heic', png: 'image/png', webp: 'image/webp' }[/** @type {string} */ (name.split('.').pop())] ?? 'image/jpeg';
  return { name, mimeType, buffer: await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)) };
}

/** @param {import('@playwright/test').Page} page @param {string} title */
async function startTrip(page, title) {
  await page.getByLabel('Trip name').fill(title);
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('several photos and files are added at once', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles([
    await photo('upright.jpg'), await photo('screenshot.png'), { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Nepenthe at 7') },
  ]);
  await expect(page.getByText('Added 3 files')).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1230\.(webp|jpg)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/screenshot\.(webp|jpg)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/notes\.txt/ })).toBeVisible();
});

test("a HEIC photo this browser can't read is kept as it is, with a note", async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles(await photo('portrait.heic'));
  await expect(page.getByText('A photo was kept as it is')).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/2026-11-26-1904\.heic/ })).toBeVisible();
});
