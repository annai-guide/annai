import { test, expect } from '@playwright/test';
import { openApp, allFiles } from './helpers.js';
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

/** Opens a file's details from the trip's Files, by the row's name. @param {import('@playwright/test').Page} page @param {string} name */
async function openRow(page, name) {
  await page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file', { hasText: name }).getByRole('link').click();
}

/** @param {import('@playwright/test').Page} page @param {string} trip @param {string} path @param {string} [from] */
async function openAt(page, trip, path, from) {
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`);
}

test('a file with two flights: one screen, two blocks in time order, each with its heading, facts and Change it; Fly home under the second; the preview, Open, Download, Ask with the file and both flights', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'ANNAI AIR itinerary');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ANNAI AIR itinerary');
  await expect(page.locator('.booking-block h2')).toHaveText(['ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
  const second = page.getByRole('region', { name: 'ANNAI AIR AN 124' });
  await expect(second.locator('dl.facts .mark-check')).toHaveCount(1); // the seat
  await expect(second.getByRole('region', { name: 'On the plan' })).toContainText('Fly home');
  await expect(second.getByRole('region', { name: 'On the plan' })).toContainText('Terminal S.');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'The original' })).toContainText('From itinerary.pdf');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  expect((await downloading).suggestedFilename()).toBe('itinerary.pdf');
  await page.getByRole('button', { name: 'Ask Shiori about this' }).click();
  await expect(page.locator('.type-sheet .attach-chip .attach-name')).toHaveText(['ANNAI AIR itinerary', 'ANNAI AIR AN 123', 'ANNAI AIR AN 124']);
});

test('a link to the second flight opens the file at its block, focused and in view', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/back.json');
  const h = page.getByRole('heading', { name: 'ANNAI AIR AN 124' });
  await expect(h).toBeFocused();
  await expect(h).toBeInViewport();
});

test('one booking reads as the booking details did: the stay, its photo as the preview, Change it and Open in Maps at the foot; Open shows the photo', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'Hotel Aurora Test');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotel Aurora Test');
  await expect(page.getByRole('heading', { name: 'Hotel Aurora Test' })).toHaveCount(1); // no second heading of the same title
  await expect(page.locator('dl.facts dt')).toHaveText(['Place', 'Check-in', 'Check-out', 'Nights']);
  await expect(page.locator('.original img.file-preview')).toBeVisible();
  await expect(page.locator('.screen > .acts').last().getByRole('link', { name: 'Change it' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Maps' })).toBeVisible();
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open the photo full size' })).toBeVisible();
});

test('a booking with no file: its block alone, no preview, Open or Download; its plan item listed though it has no notes', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/said.json');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Testville Grill');
  await expect(page.getByRole('region', { name: 'The original' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'On the plan' })).toContainText('Dinner at the grill');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(1);
});

test('a calendar file lists its plan items with their days, each opening its item and coming back; no Change it, and Open is its editor', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'walks.ics');
  const made = page.getByRole('region', { name: 'Plan items from a calendar' });
  await expect(made.getByRole('link')).toHaveText(['Aurora walk · Sun, Nov 22']);
  await made.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Aurora walk' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('walks.ics');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.locator('#file-content')).toHaveValue(/BEGIN:VCALENDAR/);
});

test('a file waiting to be read says so, with Open, Download and Ask, and no Change it', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'new.pdf');
  await expect(page.locator('.screen > .sub').first()).toHaveText('Waiting for Shiori to read it');
  await expect(page.getByRole('link', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask Shiori about this' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(0);
});

test("a link to a file that isn't there says so", async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/files/nope.pdf');
  await expect(page.getByRole('heading', { name: "This file isn't in the trip" })).toBeVisible();
});

/** The crumb of the open screen. @param {import('@playwright/test').Page} page */
const crumbOf = (page) => page.getByRole('main').locator('.crumbs a');

test('Back from the trip: the crumb names the trip', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'Hotel Aurora Test');
  await expect(crumbOf(page)).toContainText('Anchorage');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
});

test('Back from the Plan: a tap on the return flight lands on its block, and the crumb goes back to the Plan', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Fly home/ }).first().click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 124' })).toBeFocused();
  await expect(crumbOf(page)).toContainText('Plan');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Plan');
});

test('Back from Now and from the Conversation', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/stay.json', '#/now');
  await expect(crumbOf(page)).toContainText('Now');
  await crumbOf(page).click();
  await expect(page).toHaveURL(/#\/now$/);
  await openAt(page, trip, '/bookings/stay.json', '#/talk');
  await expect(crumbOf(page)).toContainText('Conversation');
  await crumbOf(page).click();
  await expect(page).toHaveURL(/#\/talk$/);
});

test("Back from a plan item's details, both ways; Open and Change it come back here", async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'ANNAI AIR itinerary');
  await page.getByRole('region', { name: 'ANNAI AIR AN 124' }).getByRole('link', { name: /^Fly home/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fly home');
  await page.getByRole('main').getByRole('link', { name: /^Booked: ANNAI AIR AN 124/ }).click();
  await expect(page.getByRole('heading', { name: 'ANNAI AIR AN 124' })).toBeFocused();
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fly home');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ANNAI AIR itinerary');
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(crumbOf(page)).toContainText('Details');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ANNAI AIR itinerary');
  await page.getByRole('link', { name: 'Change it' }).first().click();
  await expect(page.locator('#file-content')).toHaveValue(/"ANNAI AIR AN 123"/);
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ANNAI AIR itinerary');
});

test('an old booking link with no from goes back to the trip', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/back.json');
  await expect(crumbOf(page)).toContainText('Anchorage');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
});

/** Deletes with the two taps. @param {import('@playwright/test').Page} page @param {string} [label] */
async function deleteIt(page, label = 'Delete') {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to delete' }).click();
}

test('Delete removes the file, its bookings and their plan items, says what went, and goes back to the trip', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openRow(page, 'ANNAI AIR itinerary');
  const before = await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const out = { hash: (await ws.list(trip, '/')).find((/** @type {any} */ f) => f.path === '/files/itinerary.pdf').hash, history: (await ws.history(trip, '/files/itinerary.pdf')).length };
    store.close();
    return out;
  }, trip);
  expect(before.history).toBeGreaterThan(0);
  await deleteIt(page);
  await expect(page.getByText(/^Deleted ANNAI AIR itinerary, 2 bookings,? and 1 plan item\. .+ freed\.$/)).toBeVisible();
  // Freed at once: no history for the file's path, and its content gone, as nothing else names it.
  const after = await page.evaluate(async ({ trip, hash }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const out = {
      history: (await ws.history(trip, '/files/itinerary.pdf')).length,
      blob: Boolean(await store.tx(['blobs'], 'readonly', (/** @type {any} */ t) => t.getBlob(hash))),
      names: JSON.stringify(await ws.readJSON(trip, '/names.json').catch(() => null)),
    };
    store.close();
    return out;
  }, { trip, hash: before.hash });
  expect(after).toEqual({ history: 0, blob: false, names: expect.not.stringContaining('itinerary') });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file .name')).toHaveText(['Hotel Aurora Test', 'walks.ics', 'new.pdf']);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Check out · Hotel Aurora Test');
  await expect(page.getByRole('tabpanel')).not.toContainText('ANNAI AIR AN 124');
  await expect(page.getByRole('tabpanel')).not.toContainText('Fly home');
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await expect(page.getByRole('tabpanel')).not.toContainText('ANNAI AIR AN 123');
  // A Back onto the deleted file's screen says it isn't there.
  await openAt(page, trip, '/files/itinerary.pdf');
  await expect(page.getByRole('heading', { name: "This file isn't in the trip" })).toBeVisible();
});

test('Delete from a screen opened from the Plan goes back to the Plan; from an item that went, to the trip', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Check in · Hotel Aurora Test/ }).click();
  await deleteIt(page);
  await expect(page).toHaveURL(/\/plan$/);
  await page.getByRole('tab', { name: 'Sun, Nov 22' }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: /Aurora walk/ }).click();
  await page.getByRole('link', { name: 'Open the original' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('walks.ics');
  await deleteIt(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
});

test('a booking with no file: Delete removes it and its plan item', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/said.json');
  await deleteIt(page);
  await expect(page.getByText(/^Deleted Testville Grill and 1 plan item\. .+ freed\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/item?path=${encodeURIComponent('/plan/grill.json')}`);
  await expect(page.getByRole('heading', { name: "This isn't on the plan" })).toBeVisible();
});

test('the raw file screen says what else its Delete removes, and removes it', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await allFiles(page);
  await page.locator('details.all-files a[href*="file?path=%2Ffiles%2Fitinerary.pdf"]').click();
  await expect(page.getByText('Deleting this file also deletes 2 bookings and 1 plan item.')).toBeVisible();
  await deleteIt(page, 'Delete file');
  await expect(page.getByText(/^Deleted ANNAI AIR itinerary.* freed\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await expect(page.getByRole('tabpanel')).not.toContainText('ANNAI AIR AN 123');
  // Any other file's screen says nothing of the kind.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}`);
  await allFiles(page);
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('#file-content')).toBeVisible();
  await expect(page.getByText(/also deletes/)).toHaveCount(0);
});
