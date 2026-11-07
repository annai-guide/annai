import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, allFiles, putFile, writeRecords, startModelServer, anthropicToolReply, modelSetUp, savedBy } from './helpers.js';
import { fileTrip } from './file-details-fixture.js';

test('Files: one row per file, by its first booking day then name, each one link with what it is; no record names, no Ask; a plain photo is not listed', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  const files = page.getByRole('region', { name: 'Files', exact: true });
  const rows = files.locator('.trip-file');
  await expect(rows.locator('.name')).toHaveText(['ANNAI AIR itinerary', 'Hotel Aurora Test', 'walks.ics', 'new.pdf']);
  await expect(rows.locator('.became')).toHaveText(['2 flights · Nov 20, Nov 27', 'Stay · Nov 20', 'Itinerary items from a calendar', 'Waiting for Shiori to read it']);
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
  // Each block's plan items are named by their block (A6), so two regions never share a name.
  await expect(page.getByRole('region', { name: 'On the itinerary: ANNAI AIR AN 124', exact: true })).toContainText('Fly home');
  await expect(page.getByRole('region', { name: 'On the itinerary', exact: true })).toHaveCount(0);
  await expect(second.getByRole('region', { name: 'On the itinerary' })).toContainText('Terminal S.');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(2);
  // With several bookings the file's region is named by its visible heading, not "The original" (which a booking's block could be).
  await expect(page.getByRole('region', { name: 'The file', exact: true })).toContainText('From itinerary.pdf');
  await expect(page.getByRole('region', { name: 'The original' })).toHaveCount(0);
  // The screenshot review: what the file is, under its name; the file's own part headed; a card opens the file, as Open does; a zone
  // note kept on one line.
  await expect(page.locator('.details > .title + .sub')).toHaveText('2 flights · Nov 20, Nov 27');
  await expect(page.getByRole('region', { name: 'The file', exact: true }).getByRole('heading', { level: 2 })).toHaveText('The file');
  await expect(page.locator('.original .file-card').and(page.locator(':not(a) > .file-card'))).toHaveCount(0);
  await expect(page.locator('dl.facts .zone-note').first()).toHaveText(/^\(.+\)$/);
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
  // In view means below the top bar, not behind it.
  const [bar, top] = await Promise.all([page.locator('header.topbar').boundingBox(), h.boundingBox()]);
  expect(top?.y ?? 0).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0));
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
  await expect(page.getByRole('region', { name: 'On the itinerary' })).toContainText('Dinner at the grill');
  await expect(page.getByRole('link', { name: 'Change it' })).toHaveCount(1);
});

test('a calendar file lists its plan items with their days, each opening its item and coming back; no Change it, and Open is its editor', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'walks.ics');
  const made = page.getByRole('region', { name: 'Itinerary items from a calendar' });
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

test('an untitled booking among several says its kind and day once, as its heading', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await writeRecords(page, trip, { patch: { '/bookings/back.json': { title: null } } });
  await openAt(page, trip, '/files/itinerary.pdf');
  await expect(page.locator('.booking-block h2')).toHaveText(['ANNAI AIR AN 123', 'Flight · Fri, Nov 27']);
  await expect(page.locator('.booking-block').nth(1).locator('> .sub')).toHaveCount(0);
  await expect(page.locator('.booking-block').first().locator('> .sub')).toHaveText('Flight · Fri, Nov 20');
});

test('a booking whose source is a file outside /files/ shows that file, and Open the original leads to it', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await writeRecords(page, trip, { write: { '/notes/grill.md': 'Testville Grill, table for two.' }, patch: { '/bookings/said.json': { source: '/trip/notes/grill.md' } } });
  await openAt(page, trip, '/bookings/said.json');
  const original = page.getByRole('region', { name: 'The original' });
  await expect(original).toContainText('From grill.md');
  await original.getByRole('link', { name: 'Open the original' }).click();
  await expect(page.locator('#file-content')).toHaveValue('Testville Grill, table for two.');
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
  await expect(crumbOf(page)).toContainText('Itinerary');
  await crumbOf(page).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Itinerary');
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
  await expect(page).toHaveURL(/\/talk$/);
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
  await deleteIt(page);
  // Nothing else names it (Shiori never read it in the conversation), so it is freed, and the toast says how much.
  await expect(page.getByText(/^Deleted ANNAI AIR itinerary, 2 bookings,? and 1 itinerary item\. [\d.,]+ (bytes|kB|MB) freed\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file .name')).toHaveText(['Hotel Aurora Test', 'walks.ics', 'new.pdf']);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab', { name: 'Fri, Nov 27' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('Check out · Hotel Aurora Test');
  await expect(page.getByRole('tabpanel')).not.toContainText('ANNAI AIR AN 124');
  await expect(page.getByRole('tabpanel')).not.toContainText('Fly home');
  await page.getByRole('tab', { name: 'Fri, Nov 20' }).click();
  await expect(page.getByRole('tabpanel')).not.toContainText('ANNAI AIR AN 123');
  // Its short name goes with it (the workspace's own listener, because the delete went through the workspace).
  await expect.poll(() => page.evaluate(async (id) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const names = JSON.stringify(await new Workspace(store).readJSON(id, '/names.json').catch(() => null));
    store.close();
    return names;
  }, trip)).not.toContain('itinerary');
  // A Back onto the deleted file's screen says it isn't there.
  await openAt(page, trip, '/files/itinerary.pdf');
  await expect(page.getByRole('heading', { name: "This file isn't in the trip" })).toBeVisible();
  // Its raw screen offers no version to bring back: there is none.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/itinerary.pdf')}`);
  await expect(page.getByText('This file was deleted for good.')).toBeVisible();
  await expect(page.getByText(/bring back a version/)).toHaveCount(0);
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
  await expect(page.getByText(/^Deleted Testville Grill and 1 itinerary item$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/item?path=${encodeURIComponent('/plan/grill.json')}`);
  await expect(page.getByRole('heading', { name: "This isn't on the itinerary" })).toBeVisible();
});

test('the raw file screen says what else its Delete removes, and removes it', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await allFiles(page);
  await page.locator('details.all-files a[href*="file?path=%2Ffiles%2Fitinerary.pdf"]').click();
  await expect(page.getByText('Deleting this file also deletes 2 bookings and 1 itinerary item.')).toBeVisible();
  await deleteIt(page, 'Delete file');
  await expect(page.getByText(/^Deleted ANNAI AIR itinerary/)).toBeVisible();
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

test('a file Shiori never read: Delete frees it and says how much', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'new.pdf');
  await deleteIt(page);
  await expect(page.getByText(/^Deleted new\.pdf\. [\d.,]+ (bytes|kB|MB) freed\.$/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('.trip-file .name')).toHaveText(['ANNAI AIR itinerary', 'Hotel Aurora Test', 'walks.ics']);
});

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

test('a PDF Shiori read in the conversation: Delete keeps it under Deleted, and Restore brings back the file, its booking and its plan item', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'read', input: { path: '/trip/files/booking.pdf' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'A stay at Hotel Aurora Test.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Testville');
    const home = page.url();
    const trip = decodeURIComponent(home.split('#/trip/')[1].split(/[/?]/)[0]);
    // The stand-in reads PDFs, so the conversation keeps the PDF itself.
    await page.goto('/#/models');
    await page.getByRole('link', { name: /Stand-in/ }).click();
    await page.getByRole('link', { name: /^b-model/ }).click();
    await page.getByLabel('Takes PDFs').check();
    await expect(savedBy(page.getByLabel('Takes PDFs'))).toHaveText('Saved');
    await page.goto(home);
    await page.getByLabel('Add photos or files').setInputFiles({ name: 'booking.pdf', mimeType: 'application/pdf', buffer: await readFile(new URL('../fixtures/pdf/booking.pdf', import.meta.url)) });
    await expect.poll(() => llm.bodies('/b/v1/messages').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[1])).toContain('"type":"document"');
    await page.getByRole('link', { name: 'Conversation' }).click();
    await expect(page.getByText('A stay at Hotel Aurora Test.')).toBeVisible({ timeout: 30_000 });
    await writeRecords(page, trip, { write: {
      '/bookings/stay.json': { id: 'stay', kind: 'lodging', status: 'confirmed', source: '/trip/files/booking.pdf', title: 'Hotel Aurora Test', unsure: [] },
      '/plan/check-in.json': { id: 'check-in', title: 'Check in', fixed: true, start: { at: '2026-11-20T15:00:00-09:00', tz: 'America/Anchorage' }, booking: '/bookings/stay.json' },
    } });
    await page.goto(home);
    await openRow(page, 'Hotel Aurora Test');
    await deleteIt(page);
    await expect(page.getByText(/^Deleted Hotel Aurora Test, 1 booking,? and 1 itinerary item\. The conversation still has it, so it's under Deleted, where you can restore it\.$/)).toBeVisible();
    const files = page.getByRole('region', { name: 'Files', exact: true });
    await expect(files.locator(':scope > .file-list > .trip-file')).toHaveCount(0); // its rows; Deleted's are its own
    const deleted = files.locator('details.deleted-files');
    await expect(deleted.locator('summary')).toHaveText('Deleted (1)');
    await deleted.locator('summary').click();
    // Under the name it had in Files (Shiori's short name goes with the file, so the Delete kept it), muted, its chevron hidden from readers.
    await expect(deleted.locator('.trip-file .name')).toHaveText(['Hotel Aurora Test']);
    await expect(deleted.locator('.trip-file .became')).toHaveText(/^Deleted by you /);
    await expect(deleted.locator('.file-row .go')).toHaveAttribute('aria-hidden', 'true');
    await expect(deleted.getByRole('link')).toHaveAccessibleName(/^Hotel Aurora Test Deleted by you [^›]*$/);
    await deleted.getByRole('link').click();
    await expect(page.locator('.original, .pdf-view, .file-card').first()).toBeVisible();
    // Opened from the trip: the crumb names the trip; its name, then the file's own, and no path line again; Restore sits straight under
    // the line saying what it brings back, above the preview; and the one version it brings back has no second button or "Current".
    await expect(page.locator('.crumbs a')).toContainText('Testville');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotel Aurora Test');
    await expect(page.getByText('File name: booking.pdf')).toBeVisible();
    await expect(page.locator('p.sub.mono')).toHaveCount(0);
    await expect(page.getByText(/^This file was deleted\. Restore brings it back with 1 booking,? and 1 itinerary item that Shiori read from it\.$/)).toBeVisible();
    const [restoreAt, previewAt] = await Promise.all([page.getByRole('button', { name: 'Restore', exact: true }), page.locator('.original, .pdf-view, .file-card').first()].map(async (l) => (await l.boundingBox())?.y ?? NaN));
    expect(restoreAt).toBeLessThan(previewAt);
    await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
    await expect(page.getByText('Current', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText(/^Restored booking\.pdf, 1 booking,? and 1 itinerary item$/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hotel Aurora Test');
    await expect(page.getByRole('region', { name: 'On the itinerary' })).toContainText('Check in');
    await page.goto(home);
    await expect(page.getByRole('region', { name: 'Files', exact: true }).locator('details.deleted-files')).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("Delete on a booking's raw screen goes to the trip, not back to the booking's details that it just deleted", async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await openAt(page, trip, '/bookings/said.json', `#/trip/${encodeURIComponent(trip)}`);
  await page.getByRole('link', { name: 'Change it' }).click();
  await deleteIt(page, 'Delete file');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
});

test('a file Shiori never read: Delete leaves nothing under Deleted', async ({ page }) => {
  await openApp(page);
  await fileTrip(page);
  await openRow(page, 'walks.ics');
  await deleteIt(page);
  await expect(page.getByText(/freed\.$/)).toBeVisible();
  await expect(page.locator('details.deleted-files')).toHaveCount(0);
});

/**
 * Shiori deletes a file through the workspace, as her files tool does: the file's history stays, and nothing checks whether anything
 * else names it. With `read`, the conversation has read it first (a tool result naming its content), as it would have.
 * @param {import('@playwright/test').Page} page @param {string} trip @param {string} path @param {{ read?: boolean }} [o]
 */
async function shioriDeletes(page, trip, path, { read = false } = {}) {
  await page.evaluate(async ({ trip, path, read }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { record } = await load('/src/core/agent/log.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    if (read) {
      const { entry } = await ws.read(trip, path);
      await record(store, trip, { type: 'tool.result', actor: 'system', data: { id: 'read-1', name: 'read', ok: true, document: { hash: entry.hash, mediaType: 'application/pdf' } }, blobs: [{ hash: entry.hash, type: 'application/pdf' }] });
    }
    await ws.delete(trip, path, { author: 'shiori' });
    store.close();
  }, { trip, path, read });
}

test('a file Shiori deleted and nothing else names: Delete for good, two taps, frees it, says how much, goes to the trip, and the row leaves Deleted', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await shioriDeletes(page, trip, '/files/new.pdf');
  await page.reload(); // her delete came from outside the page, so the open screen shows the file still
  const deleted = page.getByRole('region', { name: 'Files', exact: true }).locator('details.deleted-files');
  await expect(deleted.locator('summary')).toHaveText('Deleted (1)');
  await deleted.locator('summary').click();
  await deleted.getByRole('link').click();
  await expect(page.getByText(/^This file was deleted\. Restore brings it back\.$/)).toBeVisible();
  const forGood = page.getByRole('button', { name: 'Delete for good', exact: true });
  await expect(forGood).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await forGood.click();
  await expect(page.getByText('This file was deleted. Restore brings it back.')).toBeVisible(); // asked once: nothing has gone yet
  await page.getByRole('button', { name: 'Tap again to delete for good' }).click();
  await expect(page.getByText(/^Deleted new\.pdf for good\. [\d.,]+ (bytes|kB|MB) freed\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await expect(page.locator('details.deleted-files')).toHaveCount(0);
  // Its address now says it was deleted for good, and offers nothing.
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/new.pdf')}`);
  await expect(page.getByText('This file was deleted for good.')).toBeVisible();
});

test('a file Shiori deleted after reading it in the conversation: Restore, and no Delete for good', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await shioriDeletes(page, trip, '/files/new.pdf', { read: true });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/new.pdf')}`);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete for good/ })).toHaveCount(0);
  await expect(page.getByText('Delete for good')).toHaveCount(0);
});

test('two deleted copies of one file: Delete for good on either frees both, says "1 other copy", and both rows leave Deleted', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await putFile(page, trip, '/files/new-copy.pdf', Buffer.from('%PDF-1.4 new'), 'application/pdf'); // the same bytes as new.pdf, which Shiori is waiting to read
  await shioriDeletes(page, trip, '/files/new.pdf');
  await shioriDeletes(page, trip, '/files/new-copy.pdf');
  await page.reload();
  const deleted = page.getByRole('region', { name: 'Files', exact: true }).locator('details.deleted-files');
  await expect(deleted.locator('summary')).toHaveText('Deleted (2)');
  await deleted.locator('summary').click();
  await deleted.getByRole('link').filter({ hasText: 'new-copy.pdf' }).click();
  await expect(page.getByText('Also deletes new.pdf, a copy of this file.')).toBeVisible(); // named before the tap
  await page.getByRole('button', { name: 'Delete for good', exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to delete for good' }).click();
  await expect(page.getByText(/^Deleted new-copy\.pdf and 1 other copy for good\. [\d.,]+ (bytes|kB|MB) freed\.$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Anchorage');
  await expect(page.locator('details.deleted-files')).toHaveCount(0);
});

test("two deleted copies, one deleted with a booking: the line names the booking before the tap, and the tap frees it too", async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await putFile(page, trip, '/files/new-copy.pdf', Buffer.from('%PDF-1.4 new'), 'application/pdf');
  await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write(trip, '/bookings/copy.json', { id: 'copy', kind: 'lodging', status: 'unverified', source: '/files/new-copy.pdf', title: 'Copy stay', unsure: [] }, { author: 'shiori' });
    await ws.writeMany(trip, ['/files/new-copy.pdf', '/bookings/copy.json'].map((path) => ({ path, content: null })), { author: 'user', with: '/files/new-copy.pdf' });
    store.close();
  }, trip);
  await shioriDeletes(page, trip, '/files/new.pdf');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/new.pdf')}`);
  await page.reload();
  await expect(page.getByText('Also deletes new-copy.pdf, a copy of this file, and the 1 booking Shiori read from them.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete for good', exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to delete for good' }).click();
  await expect(page.getByText(/^Deleted new\.pdf and 1 other copy for good\. [\d.,]+ (bytes|kB|MB) freed\.$/)).toBeVisible();
  const history = await page.evaluate(async (trip) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const store = await createIdbStore();
    const n = (await new Workspace(store).history(trip, '/bookings/copy.json')).length;
    store.close();
    return n;
  }, trip);
  expect(history).toBe(0);
});

test('Delete for good on a copy that is still a current file shows no button on the deleted one', async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await putFile(page, trip, '/files/new-copy.pdf', Buffer.from('%PDF-1.4 new'), 'application/pdf'); // stays
  await shioriDeletes(page, trip, '/files/new.pdf');
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/new.pdf')}`);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await expect(page.getByText('Delete for good')).toHaveCount(0);
});
