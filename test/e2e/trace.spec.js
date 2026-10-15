import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

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
