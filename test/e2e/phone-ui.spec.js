import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// The screens' side of the user's iPhone findings (2026-10-22).

test('the dock hides while a field outside it has focus, comes back when focus leaves, and its own box still types', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const dock = page.locator('nav.dock');
  await expect(dock).toBeVisible();
  const before = await dock.boundingBox();
  const field = page.getByLabel(/Summarize at/);
  await field.focus();
  await expect(dock).toBeHidden();
  // Hidden by visibility, not removed: its box stays, so the page doesn't move under the keyboard.
  expect(await dock.boundingBox()).toEqual(before);
  await field.blur();
  await expect(dock).toBeVisible();
  // The dock's own box: the dock stays while it is typed in.
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await expect(box).toBeFocused();
  await box.fill('hello');
  await expect(dock).toBeVisible();
  await expect(box).toHaveValue('hello');
});
