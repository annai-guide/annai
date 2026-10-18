import { test, expect } from '@playwright/test';
import { openApp, turnOnSwipes } from './helpers.js';

// What the user saw on an iPhone (2026-10-18): the page scrolled sideways, a date box stuck out of
// its card, Shiori sat over the camera button in a corner, and the top bar hid that it scrolls.
const SCREENS = ['#/trips', '#/now', '#/talk', '#/plan', '#/trace', '#/settings', '#/models', '#/voice', '#/tools', '#/plugins', '#/backups', '#/notifications', '#/shiori',
  '#/about', '#/experimental', '#/welcome'];

for (const width of [320, 420]) {
  test(`every screen fits a phone ${width} px wide: nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page);
    /** @type {string[]} */
    const wide = [];
    for (const s of SCREENS) {
      // Wait for this screen to be drawn, not a fixed time: a slow screen would pass without being looked at.
      // The screen open already (Trips, as openApp opens it) is looked at as it is.
      await page.evaluate((hash) => { if (location.hash === hash) return; document.querySelector('main')?.firstElementChild?.setAttribute('data-old', ''); location.hash = hash; }, s);
      await page.waitForFunction(() => document.querySelector('main')?.firstElementChild && !document.querySelector('main > [data-old]'));
      await page.waitForTimeout(100);
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

test('a screen you go to opens at its top, and Back brings you back to where you were', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/settings');
  await page.evaluate(() => scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(600);
  const was = await page.evaluate(() => scrollY);
  await page.evaluate(() => { location.hash = '#/models'; });
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(was - 3);
  expect(Math.abs(await page.evaluate(() => scrollY) - was)).toBeLessThan(3);
});

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

// Swiping between tabs is experimental and off by default (the user, 2026-10-18): Settings → Experimental.
test('swiping between tabs is off by default: a sideways swipe stays on its screen, which leaves sideways panning to the browser', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/trips');
  const current = page.locator('.topnav a[aria-current="page"]');
  await expect(current).toHaveText('Trips');
  await swipe(page, 280, 120);
  await page.waitForTimeout(200);
  await expect(current).toHaveText('Trips');
  await expect(page.locator('main.view')).toHaveCSS('touch-action', 'auto');
});

test('swiping a screen sideways moves along the top bar; not from its edge, nor on something that scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/trips');
  await turnOnSwipes(page);
  await page.evaluate(() => { location.hash = '#/trips'; });
  const current = page.locator('.topnav a[aria-current="page"]');
  await expect(current).toHaveText('Trips');
  await expect(page.locator('main.view')).toHaveCSS('touch-action', 'pan-y pinch-zoom');
  await swipe(page, 280, 120);
  await expect(current).toHaveText('Plan');
  await swipe(page, 100, 280);
  await expect(current).toHaveText('Trips');
  await swipe(page, 10, 200); // from the left edge: the phone's own back gesture
  await expect(current).toHaveText('Trips');
  await swipe(page, 280, 250); // too short
  await expect(current).toHaveText('Trips');
});

test('Settings → Shiori shows every way she can look, with the words the dock shows under her', async ({ page }) => {
  await openApp(page, '#/shiori');
  const looks = page.locator('.looks .look');
  await expect(looks).toHaveCount(8);
  expect(await looks.evaluateAll((els) => els.map((e) => `${/** @type {HTMLElement} */ (e).dataset.state}=${e.querySelector('.av')?.getAttribute('data-state')}`)))
    .toEqual(['sleeping', 'listening', 'hearing', 'thinking', 'speaking', 'waiting', 'away', 'offline'].map((s) => `${s}=${s}`));
  await expect(page.getByRole('img', { name: 'Shiori, thinking' })).toBeVisible();
  await expect(looks.nth(0)).toContainText('Tap to talk');
});

test("a code block in Shiori's words wraps instead of widening the page", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openApp(page, '#/talk');
  const over = await page.evaluate(async () => {
    const url = '/src/ui/markdown.js'; // the app's own module, in the page
    const { renderMarkdown } = await import(url);
    document.querySelector('main .screen')?.append(renderMarkdown(`Your stops:\n\n\`\`\`\n${'Big Sur Station -> Pfeiffer Beach -> McWay Falls -> '.repeat(4)}\n\`\`\``));
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  expect(over).toBe(0);
});

test('where you were survives a reload: Back after one still brings you there', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/settings');
  await page.evaluate(() => scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(600);
  const was = await page.evaluate(() => scrollY);
  await page.evaluate(() => { location.hash = '#/models'; });
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(was - 3);
});

test('a Settings page belongs to the Settings tab, and swiping from it moves along the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/models');
  await turnOnSwipes(page);
  await page.evaluate(() => { location.hash = '#/models'; });
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  const current = page.locator('.topnav a[aria-current="page"]');
  await expect(current).toHaveText('Settings');
  await page.evaluate(() => {
    const main = /** @type {HTMLElement} */ (document.querySelector('main'));
    const opts = (/** @type {number} */ x) => ({ bubbles: true, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 300, pointerId: 7 });
    main.dispatchEvent(new PointerEvent('pointerdown', opts(100)));
    main.dispatchEvent(new PointerEvent('pointerup', opts(280)));
  });
  await expect(current).toHaveText('Trace');
});

test('a swipe never brings back a screen you pass through, such as opening a file', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/trips');
  await turnOnSwipes(page);
  await page.evaluate(() => { location.hash = '#/import'; });
  await expect(page.getByRole('heading', { name: 'Open a trip', level: 1 })).toBeVisible();
  const current = page.locator('.topnav a[aria-current="page"]');
  await expect(current).toHaveText('Trips');
  await swipe(page, 280, 100, 300);
  await expect(current).toHaveText('Plan');
  await swipe(page, 100, 280, 300);
  await expect(page.getByRole('heading', { name: 'Trips', level: 1 })).toBeVisible();
});

// The bug the user found (2026-10-18): swiping away from a Settings page and back opened Settings itself, at its top.
test('swiping back into a tab brings back the screen you last had open in it, where you were on it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/settings');
  await turnOnSwipes(page);
  await page.evaluate(() => { location.hash = '#/models'; });
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 300));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(250);
  const was = await page.evaluate(() => scrollY);
  const current = page.locator('.topnav a[aria-current="page"]');
  await swipe(page, 100, 280, 300);
  await expect(current).toHaveText('Trace');
  await expect(page.getByRole('heading', { name: 'Trace', level: 1 })).toBeVisible();
  await swipe(page, 280, 100, 300);
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/models');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(was - 3);
  // Tapping the tab still opens its first screen.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
});
