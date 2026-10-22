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

test('a button under the dock still takes a click while a field has focus: the dock comes back after the press, not at it', async ({ page }) => {
  await openApp(page, '#/models');
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  // A button where the dock is (under it, while it shows): pressing it lets go of the field.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'under-dock';
    b.textContent = 'Under the dock';
    b.style.cssText = 'position: fixed; left: 8px; right: 8px; bottom: 8px; height: 40px; z-index: 1';
    b.addEventListener('click', () => { b.dataset.clicked = '1'; });
    document.querySelector('main')?.append(b);
  });
  await page.getByLabel(/Summarize at/).focus();
  await expect(page.locator('nav.dock')).toBeHidden();
  await page.locator('#under-dock').click();
  await expect(page.locator('#under-dock')).toHaveAttribute('data-clicked', '1');
  await expect(page.locator('nav.dock')).toBeVisible();
});
