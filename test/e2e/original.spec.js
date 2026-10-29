import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, startTrip, writeRecords } from './helpers.js';

/**
 * Stores a file in a trip through annai's own modules in the page, as the user's. @param {import('@playwright/test').Page} page
 * @param {string} trip @param {string} path @param {Buffer} bytes @param {string} type
 */
async function putFile(page, trip, path, bytes, type) {
  await page.evaluate(async ({ trip, path, data, type }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    await new Workspace(store).write(trip, path, new Uint8Array(data), { author: 'user', type });
    store.close();
  }, { trip, path, data: [...bytes], type });
}

const flight = { id: 'flight', kind: 'flight', status: 'unverified', source: '/files/flight.pdf', title: 'ANNAI AIR AN 123', unsure: [], start: { at: '2026-11-20T11:20:00-08:00', tz: 'America/Los_Angeles' } };

test('Open the original shows a PDF in the browser where it can, else a card with Open and Download; Back returns to the details', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await putFile(page, trip, '/files/flight.pdf', await readFile('test/fixtures/bookings/flight.pdf'), 'application/pdf');
  await writeRecords(page, trip, { write: { '/bookings/flight.json': flight } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/bookings/flight.json')}`);
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
  await page.getByRole('link', { name: 'Open the original' }).click();
  const shows = await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { imgDrawsPdf } = await load('/src/ui/preview.js');
    return Boolean(navigator.pdfViewerEnabled) || (await imgDrawsPdf());
  });
  // What this can and can't check: that the frame is there, named, and loads the PDF's object URL; not that the PDF is drawn in it.
  // Playwright's Linux WebKit says it has a viewer, but its viewer is PDF.js as inline HTML, which the blob document's inherited policy
  // (annai's CSP) refuses, so its frame is blank there and this still passes. Headless Chromium has no viewer and takes the card path.
  // Whether Safari on an iPhone draws the PDF in the frame is checked by hand on the phone.
  if (shows) {
    await expect(page.locator('iframe.pdf-view')).toHaveAttribute('title', 'flight.pdf');
    await expect(page.locator('iframe.pdf-view')).toHaveAttribute('src', /^blob:/);
  } else {
    await expect(page.locator('.file-card')).toContainText('flight.pdf');
    await expect(page.locator('.file-card')).toContainText('2 pages');
    await expect(page.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute('href', /^blob:/);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    expect((await downloading).suggestedFilename()).toBe('flight.pdf');
  }
  // Its crumb goes back to the booking it was opened from, and the top bar stays on Plan.
  await page.getByRole('main').getByRole('link', { name: 'Booking' }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 123' })).toBeVisible();
});

test("a stored PDF's preview is the browser's drawing where an img draws PDFs, else a card naming 2 pages", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Anchorage');
  await putFile(page, trip, '/files/flight.pdf', await readFile('test/fixtures/bookings/flight.pdf'), 'application/pdf');
  await putFile(page, trip, '/files/broken.pdf', Buffer.from('%PDF-1.4 not really'), 'application/pdf');
  const got = await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { filePreview, imgDrawsPdf } = await load('/src/ui/preview.js');
    const store = await createIdbStore();
    const ctx = { store, ws: new Workspace(store), registry: null };
    const shown = await Promise.all(['/files/flight.pdf', '/files/broken.pdf', '/files/none.pdf'].map((p) => filePreview(ctx, trip, p)));
    store.close();
    return { draws: await imgDrawsPdf(), shown: shown.map((el) => (el ? { tag: el.tagName, text: el.textContent } : null)) };
  }, trip);
  if (got.draws) expect(got.shown[0]?.tag).toBe('IMG');
  else expect(got.shown[0]).toEqual({ tag: 'DIV', text: 'flight.pdf2 pages' });
  // A broken PDF is never a broken picture: its card, with no count.
  expect(got.shown[1]).toEqual({ tag: 'DIV', text: 'broken.pdf' });
  expect(got.shown[2]).toBeNull();
});
