import { test, expect } from '@playwright/test';
import { openApp, buildAndSave } from './helpers.js';

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

test('a trip card says when the trip was last backed up, and when it changed since', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const card = page.getByRole('link', { name: /Big Sur/ });
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('not backed up');
  await card.click();
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('backed up just now');
  await expect(card).not.toContainText('changed since');
  await card.click();
  await page.getByLabel('File path').fill('/notes/day1.md');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: '/notes/day1.md' })).toBeVisible();
  await page.getByRole('link', { name: 'Trips', exact: true }).click();
  await expect(card).toContainText('changed since');
});

test('a Backup saved while storage is full still says it was saved', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByRole('button', { name: 'Export trip' }).click();
  await page.getByRole('button', { name: 'Build file' }).click();
  const save = page.getByRole('button', { name: 'Save file' });
  await expect(save).toBeVisible();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  });
  const downloading = page.waitForEvent('download');
  await save.click();
  await downloading;
  await expect(page.getByText('Saved to your downloads.')).toBeVisible();
  await expect(page.getByText("annai's storage is full", { exact: true })).toBeVisible();
});

/** How many images annai has stored. @param {import('@playwright/test').Page} page @returns {Promise<number>} */
function storedImages(page) {
  return /** @type {Promise<number>} */ (page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const db = r.result;
      const all = db.transaction('blobs').objectStore('blobs').getAll();
      all.onsuccess = () => {
        db.close();
        resolve(all.result.filter((b) => String(b.type).startsWith('image/')).length);
      };
      all.onerror = () => reject(all.error);
    };
    r.onerror = () => reject(r.error);
  })));
}

test('remove a trip: asks once, and again only when it changed after its last Backup', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  await page.getByLabel('Add photos or files').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('link', { name: /\/files\/gate\.(webp|jpg)/ })).toBeVisible();
  expect(await storedImages(page)).toBe(1);

  // Escape is a no.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toContainText('This removes everything in this trip from this device');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Never backed up: a second question, and Cancel keeps the trip.
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  const warning = page.getByRole('dialog', { name: 'Not backed up' });
  await expect(warning).toContainText("This trip hasn't been backed up since it last changed. Remove it anyway?");
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();

  // Backed up and unchanged: one question, then the trip and its photo are gone.
  await page.getByRole('button', { name: 'Export trip' }).click();
  await buildAndSave(page);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/^Removed Big Sur\. .+ freed\.$/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Big Sur/ })).toHaveCount(0);
  expect(await storedImages(page)).toBe(0);
});

test('an archived trip can be removed too', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Old trip');
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await page.getByText('Archived trips (1)').click();
  await page.getByRole('link', { name: /Old trip/ }).click();
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Old trip' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByText(/Archived trips/)).toHaveCount(0);
});

test('Remove trip runs once at a time', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const button = page.locator('button', { hasText: 'Remove trip' });
  await button.click();
  await expect(page.getByRole('dialog', { name: 'Big Sur' })).toBeVisible();
  await expect(button).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(button).toBeEnabled();
});

test('a log line written into a removed trip is gone after the next start', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  /** Puts one log line into the scope (a request that ignored Stop, finishing late), or counts its lines. */
  const events = (/** @type {'put' | 'count'} */ op) => page.evaluate(({ scope, op }) => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const tx = r.result.transaction('events', op === 'put' ? 'readwrite' : 'readonly');
      const os = tx.objectStore('events');
      /** @type {IDBRequest} */
      const q = op === 'put'
        ? os.put({ scope, seq: 7, ts: Date.now(), type: 'net.request', actor: 'system', data: { url: 'https://example.com/' } })
        : os.count(IDBKeyRange.bound([scope, -Infinity], [scope, Infinity]));
      tx.oncomplete = () => { r.result.close(); resolve(q.result); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }), { scope: id, op });
  await events('put');
  expect(await events('count')).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  expect(await events('count')).toBe(0);
});

test('removing a trip that is already gone says so', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Big Sur');
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.evaluate((scope) => new Promise((resolve, reject) => {
    const r = indexedDB.open('annai');
    r.onsuccess = () => {
      const tx = r.result.transaction('scopes', 'readwrite');
      tx.objectStore('scopes').delete(scope);
      tx.oncomplete = () => { r.result.close(); resolve(undefined); };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  }), id);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'Big Sur' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByText('That trip was already removed.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});
