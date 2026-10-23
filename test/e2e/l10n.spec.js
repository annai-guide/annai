import { test, expect } from '@playwright/test';
import { openApp, unmarked } from './helpers.js';
import { accented } from '../../src/core/l10n-pseudo.js';

test('the pseudo-locale en-XA says its language, and ar-XB its direction', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/trips');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.goto('/?l10n=ar-XB#/trips');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-XB');
});

test('the Trips screen speaks through t: its words, its form and its cards are pseudo text under en-XA', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/trips');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(accented('Trips'));
  await expect(page.locator('p.empty')).toHaveText(accented('No trips yet. Start one below, or open a trip someone sent you.'));
  await expect(page.getByRole('heading', { level: 2, name: accented('Start a trip') })).toBeVisible();
  await expect(page.getByLabel(accented('Starts'))).toBeVisible();
  await expect(page.getByLabel(accented('Ends'))).toBeVisible();
  await expect(page.getByPlaceholder(accented('Big Sur · Thanksgiving'))).toBeVisible();
  await expect(page.locator('p.sub').last()).toHaveText(accented('No backup yet. Export everything from Settings, or set up automatic backups there.'));
  await page.getByLabel(accented('Trip name')).fill('Kyoto Spring');
  await page.getByRole('button', { name: accented('Start trip') }).click();
  await expect(page.getByRole('heading', { name: 'Kyoto Spring' })).toBeVisible();
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(accented('Trips'));
  const facts = page.locator('.trip-card .sub');
  await expect(facts).toContainText(accented('not backed up'));
  await expect(facts).toContainText(/⟦úṕðáţéð [^⟧]*⟧/);
  // A report for whoever extracts a screen next, not an assertion: what is still plain English here.
  console.log(`unmarked on Trips (en-XA):\n  ${(await unmarked(page, ['Kyoto Spring'])).join('\n  ') || 'nothing'}`);
});

test('without a pseudo-locale the page is English, in the phone\'s region, and says so', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-l10n-failed', /./);
});

test('a pseudo-locale that does not exist is ignored', async ({ page }) => {
  await openApp(page, '?l10n=xx#/trips');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
});

test('the Languages section speaks through t under en-XA, its statuses whole', async ({ page }) => {
  await openApp(page, '?l10n=en-XA#/shiori');
  const panel = page.getByRole('region', { name: accented('Languages') });
  await expect(panel.getByRole('heading', { name: accented('Languages') })).toBeVisible();
  await expect(panel.getByRole('list', { name: accented('Languages you speak') })).toBeVisible();
  await expect(panel.getByLabel(accented('Add a language'))).toBeVisible();
  await expect(panel.getByLabel(accented('Shiori answers in'))).toBeVisible();
  await panel.getByLabel(accented('Add a language')).selectOption('ja');
  await panel.getByRole('button', { name: accented('Add'), exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(accented('Added {0}. Saved').replace('{0}', 'Japanese'));
});
