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
  await expect(page.locator('.trace li')).toHaveCount(1);
  await page.locator('.trace summary').first().click();
  await expect(page.locator('.trace pre').first()).toContainText('"type": "scope.create"');
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
