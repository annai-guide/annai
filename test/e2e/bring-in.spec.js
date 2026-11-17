import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, allFiles, goToHash, startTrip as startNamed } from './helpers.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';

/** A dated trip: Share and a dropped file offer dated trips (timeline stage 4). @param {import('@playwright/test').Page} page @param {string} title @returns {Promise<string>} its id */
async function startTrip(page, title) {
  return startNamed(page, title, { start: '2026-11-25', end: '2026-11-29' });
}

/** A small Wallet pass. */
async function passBytes() {
  const z = new ZipWriter();
  await z.add('pass.json', utf8(JSON.stringify({ organizationName: 'Example Air', boardingPass: { transitType: 'PKTransitTypeAir', primaryFields: [{ key: 'origin', label: 'SFO', value: 'San Francisco' }] } })));
  return Buffer.from(await z.finish().arrayBuffer());
}

const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:dinner@example.com', 'SUMMARY:Thanksgiving dinner', 'DTSTART;TZID=America/New_York:20261126T170000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:museum', 'SUMMARY:Museum day', 'DTSTART;VALUE=DATE:20261127', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('two files with the same name are both kept; nothing asks for a model', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Thanksgiving');
  const pdf = (/** @type {string} */ body) => ({ name: 'confirmation.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${body}`) });
  await page.getByLabel('Add photos or files').setInputFiles(pdf('flight'));
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/confirmation\.pdf/ })).toBeVisible();
  await page.getByLabel('Add photos or files').setInputFiles(pdf('hotel'));
  await expect(page.getByRole('link', { name: /\/files\/confirmation \(2\)\.pdf/ })).toBeVisible();
  await expect(page.getByText('No model is set')).toHaveCount(0);
});

test('a calendar file becomes plan items when it is added', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Thanksgiving');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'thanksgiving.ics', mimeType: 'text/calendar', buffer: Buffer.from(ICS) });
  await expect(page.getByText('Added a file, and 2 itinerary items from the calendar')).toBeVisible();
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/plan\/ics-dinner-example-com-[0-9a-f]{8}\.json/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/plan\/ics-museum-[0-9a-f]{8}\.json/ })).toBeVisible();
});

test('a shared pass and shared text go to the trip you choose', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Thanksgiving');
  const pass = [...(await passBytes())];
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    form.append('title', 'Your stay at Hoboken Inn');
    form.append('text', 'Confirmation 7788, Nov 25–29');
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, pass);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 2 files' })).toBeVisible();
  await expect(page.getByText('flight.pkpass')).toBeVisible();
  await expect(page.getByText('shared text.txt')).toBeVisible();
  // Any site can post to the share target, so what was shared is shown before it is added.
  await expect(page.getByText('Your stay at Hoboken Inn')).toBeVisible();
  await expect(page.getByText('Add only what you just shared yourself.')).toBeVisible();
  // A way out without adding (the top bar was it once): the crumb goes home, and the share stays in the inbox.
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 2 files' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to Thanksgiving' }).click();
  await expect(page.getByRole('heading', { name: 'Thanksgiving' })).toBeVisible();
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/flight\.pkpass/ })).toBeVisible();
  await page.getByRole('link', { name: /\/files\/shared text\.txt/ }).click();
  await expect(page.locator('#file-content')).toHaveValue('Your stay at Hoboken Inn\n\nConfirmation 7788, Nov 25–29');
});

test('a share still being added does not pull the traveller back when they have left its screen', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const trip = await startTrip(page, 'Thanksgiving');
  const pass = [...(await passBytes())];
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, pass);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  // Hold the add at its end (it empties the share inbox there), as a slow phone would: the page's own Cache API, held until released.
  await page.evaluate(() => {
    const real = Cache.prototype.delete;
    const held = new Promise((go) => { /** @type {any} */ (window).release = go; });
    Cache.prototype.delete = function (request, options) { return held.then(() => real.call(this, request, options)); };
  });
  await page.getByRole('button', { name: 'Add to Thanksgiving' }).click();
  await expect(page.getByText('Adding 1 of 1…')).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.evaluate(() => /** @type {any} */ (window).release());
  // The add finishes and says so (its toast comes right after where it would have gone to the trip), and the traveller is still on Trips.
  await expect(page.getByText('Added a file')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await (await caches.open('annai-inbox')).keys()).length)).toBe(0);
  await goToHash(page, `#/trip/${encodeURIComponent(trip)}`); // the files were kept, in the trip it was added to
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/flight\.pkpass/ })).toBeVisible();
});

test('a pass dropped on annai goes to a trip, not to the archive reader', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Thanksgiving');
  const pass = [...(await passBytes())];
  // As in shell.spec.js: a DataTransfer made in the page, dispatched by Playwright.
  const files = await page.evaluateHandle((bytes) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    return d;
  }, pass);
  await page.dispatchEvent('main.view', 'dragover', { dataTransfer: files });
  await page.dispatchEvent('main.view', 'drop', { dataTransfer: files });
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await page.getByRole('button', { name: 'Add to Thanksgiving' }).click();
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/flight\.pkpass/ })).toBeVisible();
});

test('a calendar without .ics in its name, sent as text/calendar, becomes plan items', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Thanksgiving');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'invite', mimeType: 'text/calendar', buffer: Buffer.from(ICS) });
  await expect(page.getByText('Added a file, and 2 itinerary items from the calendar')).toBeVisible();
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/plan\/ics-dinner-example-com-[0-9a-f]{8}\.json/ })).toBeVisible();
});

test('a backup shared with a pass is named, and opens on its own', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Thanksgiving');
  const pass = [...(await passBytes())];
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    form.append('files', new File(['not a zip'], 'trip.annai.zip', { type: 'application/zip' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, pass);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await expect(page.getByText('flight.pkpass')).toBeVisible();
  await expect(page.getByText(/Also here: trip\.annai\.zip/)).toBeVisible();
  await page.getByRole('button', { name: 'Open it' }).click();
  await expect(page.getByRole('heading', { name: 'Open an annai file' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("isn't an annai file");
  // Opened, it leaves the share inbox; the pass still waits there.
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await expect(page.getByText('flight.pkpass')).toBeVisible();
  await expect(page.getByText(/trip\.annai\.zip/)).toHaveCount(0);
});
