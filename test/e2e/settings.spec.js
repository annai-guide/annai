import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// Settings in the order a user reaches for them, Settings → Experimental, and the Jina key's link (the user, 2026-10-18).

/** The Settings sections' headings, top to bottom. @param {import('@playwright/test').Page} page */
const sections = (page) => page.locator('main .screen > section.panel > h2').allTextContents();

test('Settings lists what a user reaches for most often first, and Erase last', async ({ page }) => {
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  expect(await sections(page)).toEqual(['Models', 'Voice', 'Notifications', 'Backup', 'Shiori', 'Photos', 'Tools', 'Plugins', 'Storage',
    'About', 'Diagnostics', 'Developer', 'Experimental', 'Erase']);
  // Open an annai file sits with Backup.
  await expect(page.locator('section.panel', { has: page.getByRole('heading', { name: 'Backup' }) }).getByText('Open an annai file')).toBeVisible();
  // The version, which the App section showed, is on About's line.
  await expect(page.locator('section.panel', { has: page.getByRole('heading', { name: 'About' }) })).toContainText('annai 0.1.0');
});

test('Settings → Experimental: swiping between tabs is off by default, kept in the app settings when turned on', async ({ page }) => {
  await openApp(page, '#/settings');
  await page.getByRole('link', { name: 'Experimental' }).click();
  await expect(page.getByRole('heading', { name: 'Experimental', level: 1 })).toBeVisible();
  await expect(page.getByText('Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.')).toBeVisible();
  const swipe = page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' });
  await expect(swipe).not.toBeChecked();
  await swipe.check();
  await expect.poll(() => page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { readAppSettings } = await load('/src/core/settings.js');
    const store = await createIdbStore();
    try {
      return (await readAppSettings(new Workspace(store))).experimental?.swipeTabs;
    } finally {
      store.close();
    }
  })).toBe(true);
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' })).toBeChecked();
  await expect(page.locator('main.view')).toHaveCSS('touch-action', 'pan-y pinch-zoom');
});

test('Settings → Tools links the Jina key to where Jina gives one, opening outside annai', async ({ page }) => {
  await openApp(page, '#/tools');
  const link = page.getByRole('link', { name: 'Get a free key from Jina' });
  await expect(link).toHaveAttribute('href', 'https://jina.ai/api-dashboard/key-manager/');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
