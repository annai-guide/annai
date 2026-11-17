import { test, expect } from '@playwright/test';
import { openApp, goToHash, startTrip, atConversation, FIRST_DRAW } from './helpers.js';

// Timeline stage 8: the top bar goes. Home holds the gear and Trace, every screen the bar reached has its own way back, `#/now` opens today's
// Itinerary, and what stuck under the bar sticks at the top of the screen (docs/superpowers/plans/2026-11-06-timeline-stage-8-top-bar-goes.md).

/**
 * A sideways swipe on the screen, from x to x at height y, as a touch.
 * @param {import('@playwright/test').Page} page @param {number} from @param {number} to @param {number} [y]
 */
const swipe = (page, from, to, y = 400) => page.evaluate(([a, b, yy]) => {
  const main = /** @type {HTMLElement} */ (document.querySelector('main'));
  const at = (/** @type {number} */ x) => document.elementFromPoint(x, yy) ?? main;
  const opts = (/** @type {number} */ x) => ({ bubbles: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: yy, pointerId: 7 });
  at(a).dispatchEvent(new PointerEvent('pointerdown', opts(a)));
  at(b).dispatchEvent(new PointerEvent('pointerup', opts(b)));
}, [from, to, y]);

test('no top bar: home, a conversation and Settings have no Main navigation and no bar', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Testville');
  /** @type {[string, () => Promise<unknown>][]} */
  const screens = [
    ['#/trips', () => expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible()],
    [`#/trip/${trip}/talk`, () => atConversation(page)],
    ['#/settings', () => expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible()],
  ];
  for (const [hash, drawn] of screens) {
    await goToHash(page, hash);
    await drawn();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.locator('.topbar, .topnav, .brand')).toHaveCount(0);
  }
});

test('a sideways swipe leaves the screen where it is, even with the old swipe setting stored', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  // What Settings → Experimental stored before stage 8: read by nothing now.
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { updateAppSettings } = await import(at('/src/core/settings.js'));
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { experimental: { swipeTabs: true } });
    store.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible(FIRST_DRAW);
  for (const [hash, name] of [['#/trips', 'Trips'], ['#/settings', 'Settings']]) {
    await goToHash(page, hash);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(page.locator('main.view')).toHaveCSS('touch-action', 'auto');
    await swipe(page, 280, 120);
    await swipe(page, 100, 280);
    await page.waitForTimeout(300);
    expect(new URL(page.url()).hash).toBe(hash);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  }
});

test('Settings → Experimental has no swipe switch; Remote trace stays, and Settings says what is there', async ({ page }) => {
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByText('Features still being tried, and developer tools such as Remote trace.')).toBeVisible();
  await goToHash(page, '#/experimental');
  await expect(page.getByRole('heading', { level: 1, name: 'Experimental', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Remote trace (for developers)' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Swipe sideways to move between tabs' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Swiping between tabs' })).toHaveCount(0);
});
