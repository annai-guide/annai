import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, waitForServiceWorker, zipOf } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';

// A developer's English on a Japanese screen (localization, decision 11) is marked lang="en", so a screen reader gives it an English
// voice: annai's own checks of a plugin package, and of an itinerary. A plugin's own words are not annai's, and are not marked.

test.use({ locale: 'ja-JP' });

const enc = (/** @type {string} */ s) => Buffer.from(s);

/** The Add screen, ready for a file. @param {import('@playwright/test').Page} page */
async function openAdd(page) {
  await openApp(page, '#/add');
  await waitForServiceWorker(page);
  await expect(page.locator('html')).toHaveAttribute('lang', /^ja/);
  await expect(page.getByRole('heading', { level: 1, name: '追加' })).toBeVisible();
}

test("a plugin whose manifest is broken: Add's card holds annai's English check marked lang=\"en\"", async ({ page }) => {
  await openAdd(page);
  await page.locator('#plugin-file').setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: await zipOf({ 'annai-plugin.json': enc('{ "id": "bad" }') }) });
  const english = page.locator('.notice p span[lang="en"]');
  await expect(english).toContainText('its annai-plugin.json is not valid: ');
  // The card's own title is in Japanese, unmarked.
  expect(await page.locator('.notice strong').getAttribute('lang')).toBeNull();
});

test('a file that is not a zip: the sentence is in Japanese and only the reason, a developer\'s English, is marked', async ({ page }) => {
  await openAdd(page);
  await page.locator('#plugin-file').setInputFiles({ name: 'junk.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') });
  const body = page.locator('.notice p');
  await expect(body.locator('span[lang="en"]')).toHaveText('this is not a zip archive');
  expect(await body.getAttribute('lang')).toBeNull();
  expect(await body.evaluate((p) => p.textContent)).toMatch(/^[^\x00-\x7f]/);
});

test('a plugin that fails to start in its own words: annai marks only its own English, never the plugin\'s', async ({ page }) => {
  await openAdd(page);
  const z = new ZipWriter();
  for (const name of ['annai-plugin.json', 'index.js']) await z.add(`broken/${name}`, new Uint8Array(await readFile(new URL(`../fixtures/plugins/broken/${name}`, import.meta.url))));
  await page.locator('#plugin-file').setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from(await z.finish().arrayBuffer()) });
  await page.locator('.plugin-install .acts .btn.pri').click();
  const body = page.locator('.notice p', { hasText: 'this plugin always fails to start' });
  await expect(body).toBeVisible();
  await expect(body.locator('span[lang="en"]')).toHaveCount(0);
});

test("Simulate: an itinerary that is wrong is said in annai's English, marked lang=\"en\"", async ({ page }) => {
  await openApp(page, '#/simulate');
  await expect(page.locator('html')).toHaveAttribute('lang', /^ja/);
  await page.locator('input[type="radio"][value="file"]').check();
  await page.locator('#sim-file').setInputFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from('{ "start": "tomorrow", "route": [] }') });
  await page.locator('.panel .acts .btn.pri').click();
  const english = page.locator('p.error span[lang="en"]');
  await expect(english).toHaveText(/^An itinerary needs a start/);
  // A file that is not JSON is annai's own Japanese sentence, unmarked.
  await page.locator('#sim-file').setInputFiles({ name: 'trip.json', mimeType: 'application/json', buffer: Buffer.from('nope') });
  await page.locator('.panel .acts .btn.pri').click();
  await expect(page.locator('p.error')).toContainText('JSON');
  await expect(page.locator('p.error span[lang="en"]')).toHaveCount(0);
});
