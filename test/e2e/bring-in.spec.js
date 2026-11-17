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

/** A pass shared to annai (Android's share sheet), on its share screen. @param {import('@playwright/test').Page} page */
async function sharedPass(page) {
  const pass = [...(await passBytes())];
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, pass);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
}

test('back on the share screen while its add runs, the add shows with its buttons off, so the files are added once', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const trip = await startTrip(page, 'Thanksgiving');
  await sharedPass(page);
  // Held at its end, as a slow phone would: the page's own Cache API, held until released.
  await page.evaluate(() => {
    const real = Cache.prototype.delete;
    const held = new Promise((go) => { /** @type {any} */ (window).release = go; });
    Cache.prototype.delete = function (request, options) { return held.then(() => real.call(this, request, options)); };
  });
  await page.getByRole('button', { name: 'Add to Thanksgiving' }).click();
  await expect(page.getByText('Adding 1 of 1…')).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await expect(page.getByText('Adding 1 of 1…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to Thanksgiving' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'New conversation' })).toBeDisabled();
  await page.evaluate(() => /** @type {any} */ (window).release());
  // The add ends on its own screen: it goes to the trip, as one never left does, with the file there once.
  await expect(page.getByRole('heading', { level: 1, name: 'Thanksgiving', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe(`#/trip/${encodeURIComponent(trip)}`);
  await allFiles(page);
  await expect(page.getByRole('link', { name: /\/files\/flight\.pkpass/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /\/files\/flight \(2\)\.pkpass/ })).toHaveCount(0);
  // The add is over: the share's address, back to, shows the empty import screen, not the add that ended.
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Open an annai file' })).toBeVisible();
  await expect(page.getByText('Adding 1 of 1…')).toHaveCount(0);
});

test('an add that fails after the traveller left the share screen says so on a card, which opens the share again', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  await startTrip(page, 'Thanksgiving');
  await sharedPass(page);
  // The file's write is held, then fails: the page's own Workspace, as annai's modules are shared in the page.
  await page.evaluate(async () => {
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const real = Workspace.prototype.write;
    const held = new Promise((go) => { /** @type {any} */ (window).release = go; });
    Workspace.prototype.write = function (/** @type {string} */ scope, /** @type {string} */ path, /** @type {any[]} */ ...rest) {
      return path.startsWith('/files/') ? held.then(() => { throw new Error('The test made this write fail.'); }) : real.call(this, scope, path, ...rest);
    };
  });
  await page.getByRole('button', { name: 'Add to Thanksgiving' }).click();
  await expect(page.getByText('Adding 1 of 1…')).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.evaluate(() => /** @type {any} */ (window).release());
  const card = page.locator('.notice', { hasText: 'Adding a file failed' });
  await expect(card).toContainText('The test made this write fail.');
  expect(new URL(page.url()).hash).toBe('#/trips');
  // The share is still in annai's inbox: the card's button shows it again, ready to add.
  await card.getByRole('button', { name: 'Add a file' }).click();
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await expect(page.getByText('flight.pkpass')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to Thanksgiving' })).toBeEnabled();
});

/** Two files shared to annai (Android's share sheet), on its share screen. @param {import('@playwright/test').Page} page */
async function sharedPair(page) {
  await page.evaluate(async () => {
    const form = new FormData();
    form.append('files', new File(['%PDF-1.4 one'], 'one.pdf', { type: 'application/pdf' }));
    form.append('files', new File(['%PDF-1.4 two'], 'two.pdf', { type: 'application/pdf' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  });
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 2 files' })).toBeVisible();
}

for (const button of ['Add to Thanksgiving', 'New conversation']) {
  test(`a share that failed on its second file, with the traveller on its screen: the error shows there alone, and "${button}" again adds the rest, into the same place, once`, async ({ page }) => {
    await openApp(page);
    await waitForServiceWorker(page);
    await startTrip(page, 'Thanksgiving');
    await sharedPair(page);
    // The page's own Workspace, as annai's modules are shared in the page: the second file's write fails, once.
    await page.evaluate(async () => {
      const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
      const real = Workspace.prototype.write;
      let files = 0;
      Workspace.prototype.write = function (/** @type {string} */ scope, /** @type {string} */ path, /** @type {any[]} */ ...rest) {
        return path.startsWith('/files/') && ++files === 2 ? Promise.reject(new Error('The test made this write fail.')) : real.call(this, scope, path, ...rest);
      };
    });
    await page.getByRole('button', { name: button }).click();
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'The test made this write fail.' })).toBeVisible();
    // The traveller is on the screen, which says it: no card says it again.
    await expect(page.locator('.notice', { hasText: 'failed' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: button })).toBeEnabled();
    await page.getByRole('button', { name: button }).click();
    // Where it went: the trip, or the conversation made, whose address is in the hash either way.
    await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/trip\//);
    const at = new URL(page.url()).hash.match(/^#\/trip\/([^/]+)/)?.[1] ?? '';
    await goToHash(page, `#/trip/${at}`);
    await allFiles(page);
    await expect(page.getByRole('link', { name: /\/files\/one\.pdf/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /\/files\/two\.pdf/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /\/files\/(one|two) \(2\)\.pdf/ })).toHaveCount(0);
  });
}

test('a share added as a new conversation, left while it is added, does not become the conversation annai reopens', async ({ page }) => {
  await openApp(page);
  await waitForServiceWorker(page);
  const trip = await startTrip(page, 'Thanksgiving');
  /** The conversation annai reopens at a plain start (resume.js): the app settings' activeTrip, read through the page's own modules. */
  const reopens = () => page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { readAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    try { return (await readAppSettings(new Workspace(store))).activeTrip; } finally { store.close(); }
  });
  await goToHash(page, `#/trip/${encodeURIComponent(trip)}/talk`); // the conversation open when the share comes
  await expect.poll(reopens).toBe(trip);
  const pass = [...(await passBytes())];
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'flight.pkpass', { type: 'application/vnd.apple.pkpass' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, pass);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add a file' })).toBeVisible();
  await page.evaluate(() => {
    const real = Cache.prototype.delete;
    const held = new Promise((go) => { /** @type {any} */ (window).release = go; });
    Cache.prototype.delete = function (request, options) { return held.then(() => real.call(this, request, options)); };
  });
  await page.getByRole('button', { name: 'New conversation' }).click();
  await expect(page.getByText('Adding 1 of 1…')).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.evaluate(() => /** @type {any} */ (window).release());
  await expect(page.getByText('Added a file')).toBeVisible();
  await page.waitForTimeout(500); // add() doesn't wait for its settings write: time for one that shouldn't come to land
  expect(await reopens()).toBe(trip); // still the one that was open, not the new conversation the traveller never saw
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
