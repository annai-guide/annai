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

test("on iPhone the install warning says the Home Screen app keeps trips of its own, and how to bring them over", async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the iPhone wording');
  await openApp(page);
  const banner = page.getByRole('region', { name: 'Install annai' });
  await expect(banner).toContainText("the Home Screen app keeps trips of its own: what you start here won't be there");
  await banner.getByRole('button', { name: 'Show me how' }).click();
  await expect(banner.getByRole('listitem').last()).toContainText('Open a trip someone sent you');
});

test('only one tab runs annai at a time', async ({ page, context }) => {
  await openApp(page);
  const second = await context.newPage();
  await second.goto('/#/trips');
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

test('a mangled link opens Trips', async ({ page }) => {
  await openApp(page, '#/trip/%E6');
  await expect(page.getByRole('heading', { name: 'Trips' })).toBeVisible();
});

test('dropping a file on annai opens it', async ({ page }) => {
  await openApp(page);
  const files = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(['not a zip'], 'trip.annai.zip', { type: 'application/zip' }));
    return d;
  });
  await page.dispatchEvent('main.view', 'dragover', { dataTransfer: files });
  await page.dispatchEvent('main.view', 'drop', { dataTransfer: files });
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText("isn't an annai file");
});

test('Erase everything goes straight to an empty Trips, with no error on the way', async ({ page }) => {
  await openApp(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.evaluate(() => {
    new MutationObserver(() => {
      if (/couldn't open|Something went wrong/.test(document.body.textContent ?? '')) sessionStorage.setItem('erase-error', '1');
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByLabel('Type ERASE to confirm').fill('ERASE');
  await page.getByRole('button', { name: 'Erase now' }).click();
  await expect(page.getByText('No trips yet.')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('erase-error'))).toBeNull();
});

test("minors 26: a field in a column keeps its own height: no empty gap between a trip's name and its dates", async ({ page }) => {
  await openApp(page);
  const name = page.locator('label.field', { has: page.getByLabel('Trip name') });
  const dates = page.locator('.row', { has: page.getByLabel('Starts') });
  const [a, b] = [await name.boundingBox(), await dates.boundingBox()];
  expect(a && b).toBeTruthy();
  if (!a || !b) return;
  expect(a.height).toBeLessThan(100);
  expect(b.y - (a.y + a.height)).toBeLessThan(30);
  // In a row, fields still share it.
  const [start, end] = [await page.locator('label.field', { has: page.getByLabel('Starts') }).boundingBox(), await page.locator('label.field', { has: page.getByLabel('Ends') }).boundingBox()];
  expect(Math.abs((start?.width ?? 0) - (end?.width ?? 1))).toBeLessThan(2);
});
