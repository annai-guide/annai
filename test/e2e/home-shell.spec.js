import { test, expect } from '@playwright/test';
import { openApp, goToHash, startTrip, atConversation, writeEvent, FIRST_DRAW } from './helpers.js';
import { fileTrip } from './file-details-fixture.js';

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

test("what stuck under the bar sticks at the top: a long conversation's head, opaque, its ⋯ menu below it and inside the screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  const id = await startTrip(page, 'Testville');
  for (let i = 0; i < 40; i++) await writeEvent(page, id, { type: 'out.speak', data: { id: `s${i}`, text: `Line ${i} of a long conversation, long enough to fill the screen.` } });
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.locator('.convo > li')).toHaveCount(40);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400);
  const head = await atConversation(page);
  const at = await head.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const over = document.elementFromPoint(innerWidth / 2, b.bottom - 2); // what a finger meets at its foot: the head, not a line scrolled under it
    return { top: b.top, paper: getComputedStyle(el).backgroundColor, mine: Boolean(over && el.contains(over)) };
  });
  expect(Math.abs(at.top)).toBeLessThanOrEqual(1);
  expect(at.paper).not.toBe('rgba(0, 0, 0, 0)');
  expect(at.mine).toBe(true);
  await head.locator('.tidy-toggle').click();
  const menu = page.locator('.tidy-menu');
  await expect(menu).toBeVisible();
  const box = await page.evaluate(() => {
    const m = /** @type {HTMLElement} */ (document.querySelector('.tidy-menu')).getBoundingClientRect();
    const toggle = /** @type {HTMLElement} */ (document.querySelector('.talk-head .tidy-toggle')).getBoundingClientRect();
    const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
    return { below: m.top >= toggle.bottom - 1, inside: m.top >= 0 && m.bottom <= dock.top + 1 && m.left >= 0 && m.right <= innerWidth };
  });
  expect(box).toEqual({ below: true, inside: true });
});

test("home's box sticks at the top of the screen with a card, and opened is at most half the screen", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page, '#/settings');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { record } = await import(at('/src/core/agent/log.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (let i = 0; i < 24; i++) { // a long past: home opens scrolled to the now line
      const id = await createTrip(ws, { title: `Chat ${i}` });
      await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', `Chat ${i}`]], now: Date.now() - (60 * 24 * i + 5) * 60_000 });
    }
    store.close();
  });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await goToHash(page, '#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  // A long card, in a box of the test's own in the real one's place (createNotices), as timeline.spec.js's scrolledHome does.
  await page.evaluate(async () => {
    const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
    const n = createNotices();
    document.querySelector('.notices')?.replaceWith(n.el);
    n.card({ title: 'A long card', body: 'These are many words, and more of them. '.repeat(30), actions: [{ label: 'Go on', run() {} }] });
  });
  const card = page.locator('.notices .notice');
  await expect(card).toBeVisible();
  await expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0);
  const box = () => page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('.notices'));
    const b = el.getBoundingClientRect();
    return { top: b.top, height: b.height, half: innerHeight / 2, pos: getComputedStyle(el).position };
  });
  const stuck = await box();
  expect(stuck.pos).toBe('sticky');
  expect(Math.abs(stuck.top)).toBeLessThanOrEqual(1);
  await card.getByRole('button', { name: 'More' }).click();
  await expect(page.locator('.notices:has(> .notice.grow, .notice.open)')).toHaveCount(1); // the quarter is lifted: the half holds
  const opened = await box();
  expect(Math.abs(opened.top)).toBeLessThanOrEqual(1);
  expect(opened.height).toBeLessThanOrEqual(opened.half + 1);
  expect(opened.height).toBeGreaterThan(opened.half * 0.9); // the card needs more: the box is at its half
});

test("a booking opened at one of several blocks lands with that block's heading in view, focused, with nothing over it", async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/booking?path=${encodeURIComponent('/bookings/back.json')}`);
  const h = page.getByRole('heading', { name: 'ANNAI AIR AN 124' });
  await expect(h).toBeFocused();
  await expect(h).toBeInViewport({ ratio: 1 });
  const top = await h.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
});
