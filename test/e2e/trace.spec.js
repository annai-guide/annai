import { test, expect } from '@playwright/test';
import { openApp, filterTrace } from './helpers.js';

test('the trace shows what happened, newest first, and filters by type', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('Trace trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Trace trip' })).toBeVisible();
  await page.getByRole('link', { name: 'Trace' }).click();
  await expect(page.getByRole('heading', { name: 'Trace' })).toBeVisible();
  await expect(page.getByText('/trip.json').first()).toBeVisible();
  await page.getByLabel('Type contains').fill('scope.create');
  // The trip's, and the standing draft's: + opens one, made ready as annai starts (timeline stage 4).
  await expect(page.locator('.trace li')).toHaveCount(2);
  const made = page.locator('.trace li', { hasText: 'Trace trip' });
  await expect(made).toHaveCount(1);
  await made.locator('summary').click();
  await expect(made.locator('pre')).toContainText('"type": "scope.create"');
});

test('a read that failed and tried again by itself is a line in the Trace under Errors, "read: …", in the device log', async ({ page }) => {
  await openApp(page);
  await page.getByLabel('Trip name').fill('Trace trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Trace trip' })).toBeVisible();
  // As Live and the push mirror write it when a read fails and is tried again by itself.
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    await logEvent(store, 'sys:device', { type: 'error', actor: 'system', data: { kind: 'read', message: 'The transaction was aborted, so the request cannot be fulfilled.' } });
    store.close();
  });
  await page.goto('/#/trace');
  await filterTrace(page, { kind: 'Errors' });
  const row = page.locator('ol.trace li', { hasText: 'read: The transaction was aborted' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('System');
});

// R1: the same route on a real page. A read of the log fails twice as a trip is archived, and so does the write of the line that says so: the line waits until it can be written.
test('a read that failed with the write of its Trace line failing too still leaves its line, once, and no card', async ({ page }) => {
  await page.clock.install(); // the page's own timers: the line is tried again a minute later
  await openApp(page);
  await page.getByLabel('Trip name').fill('Trace trip');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Trace trip' })).toBeVisible();
  await page.evaluate(() => {
    const real = IDBDatabase.prototype.transaction;
    Object.assign(window, { rvFail: true, rvReads: 0, rvWrites: 0 });
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      const w = /** @type {any} */ (window);
      if (w.rvFail && String(stores) === 'events' && (mode === 'readonly' ? w.rvReads < 2 : w.rvWrites < 2)) {
        if (mode === 'readonly') w.rvReads++; else w.rvWrites++;
        throw new DOMException('The transaction was aborted, so the request cannot be fulfilled.', 'AbortError');
      }
      return real.call(this, stores, mode, ...rest);
    };
  });
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await page.waitForFunction(() => /** @type {any} */ (window).rvReads >= 2 && /** @type {any} */ (window).rvWrites >= 2);
  await page.evaluate(() => { /** @type {any} */ (window).rvFail = false; });
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  const row = page.locator('ol.trace li', { hasText: 'read: The transaction was aborted' });
  await page.clock.fastForward(61_000);
  await page.waitForTimeout(500);
  await page.goto('/#/trace');
  await filterTrace(page, { kind: 'Errors' });
  await expect(row).toHaveCount(1);
});
