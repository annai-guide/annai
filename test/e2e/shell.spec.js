import { test, expect } from '@playwright/test';
import { openApp, watchConsole } from './helpers.js';

test('starts without errors and shows Trips', async ({ page }) => {
  const errors = watchConsole(page);
  await openApp(page);
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the install warning shows in a browser tab and explains how', async ({ page }) => {
  await openApp(page);
  const banner = page.getByRole('region', { name: 'Install annai' });
  await expect(banner).toContainText("annai isn't installed yet");
  await banner.getByRole('button', { name: 'Show me how' }).click();
  await expect(banner.getByRole('listitem').first()).toBeVisible();
});

test('only one tab runs annai at a time', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'annai is open in another tab' })).toBeVisible();
  await second.getByRole('button', { name: 'Use it here' }).click();
  await expect(second.getByRole('heading', { name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'annai was opened in another tab' })).toBeVisible();
});

test('an unexpected error shows a card and annai keeps running', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => { setTimeout(() => { throw new Error('test boom'); }, 0); });
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});
