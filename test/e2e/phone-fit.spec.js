import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// What the user saw on an iPhone (2026-10-18): the page scrolled sideways, a date box stuck out of
// its card, Shiori sat over the camera button in a corner, and the top bar hid that it scrolls.
const SCREENS = ['#/trips', '#/now', '#/talk', '#/plan', '#/trace', '#/settings', '#/models', '#/voice', '#/tools', '#/plugins', '#/backups', '#/notifications', '#/shiori'];

for (const width of [320, 420]) {
  test(`every screen fits a phone ${width} px wide: nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page);
    /** @type {string[]} */
    const wide = [];
    for (const s of SCREENS) {
      await page.evaluate((hash) => { location.hash = hash; }, s);
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) wide.push(`${s} by ${over}px`);
    }
    expect(wide).toEqual([]);
  });

  test(`a form row's boxes stay inside their row on a phone ${width} px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page);
    const out = await page.evaluate(() => [...document.querySelectorAll('.row > .field')].flatMap((f) => {
      const row = /** @type {HTMLElement} */ (f.parentElement).getBoundingClientRect();
      return [...f.querySelectorAll('input, select, textarea')].filter((x) => x.getBoundingClientRect().right > row.right + 1)
        .map((x) => `${x.getAttribute('aria-label') ?? x.closest('label')?.textContent?.trim()}: ${Math.round(x.getBoundingClientRect().right - row.right)}px past`);
    }));
    expect(out).toEqual([]);
  });
}

test('the dock keeps camera, Shiori and type apart, Shiori in the middle', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page);
  const box = async (/** @type {string} */ sel) => {
    const b = await page.locator(sel).first().boundingBox();
    expect(b, sel).toBeTruthy();
    return /** @type {{ x: number, y: number, width: number, height: number }} */ (b);
  };
  const [camera, seat, type, talk] = [await box('.dock-row > label.ib'), await box('.dock .talk .seat'), await box('.dock-end .ib'), await box('.dock .talk')];
  const apart = (/** @type {any} */ a, /** @type {any} */ b) => a.x + a.width <= b.x || b.x + b.width <= a.x;
  expect(apart(camera, seat), 'Shiori clear of the camera').toBe(true);
  expect(apart(seat, type), 'Shiori clear of type').toBe(true);
  expect(seat.x).toBeGreaterThanOrEqual(talk.x - 1);
  expect(seat.x + seat.width).toBeLessThanOrEqual(talk.x + talk.width + 1);
  // In the middle of the screen, give or take.
  expect(Math.abs(seat.x + seat.width / 2 - 160)).toBeLessThan(24);
});

test('the top bar shows there is more of it, and keeps the screen you are on in view', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page);
  const nav = page.locator('.topnav');
  await expect(nav).toHaveClass(/\bmore\b/);
  await page.evaluate(() => { location.hash = '#/settings'; });
  const current = page.locator('.topnav a[aria-current="page"]');
  await expect(current).toHaveText('Settings');
  await expect(current).toBeInViewport({ ratio: 0.9 });
  // Scrolled to its end, nothing more to show.
  await nav.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll')); });
  await expect(nav).not.toHaveClass(/\bmore\b/);
});
