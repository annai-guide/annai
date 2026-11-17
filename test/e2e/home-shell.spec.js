import { test, expect } from '@playwright/test';
import { openApp, goToHash, goHome, startTrip, happeningTrip, atConversation, writeEvent, writeRecords, pickFile, fixtureFiles, zipOf, FIRST_DRAW } from './helpers.js';
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
  await expect(page.getByText('Features that are still being tried. They may have bugs, and their fixes may come slower than the rest of annai.')).toBeVisible();
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
  expect(at.paper).toMatch(/^rgb\(/); // opaque: a colour with an alpha (rgba) lets the lines under it show
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
  const mine = await h.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    // What a finger meets at the heading's centre and at its top edge: the heading, not what is stuck over it (a bar over the top edge only would pass the centre).
    return [b.top + b.height / 2, b.top + 1].map((y) => { const over = document.elementFromPoint(x, y); return Boolean(over && el.contains(over)); });
  });
  expect(mine).toEqual([true, true]);
});

/** Installs a test plugin from test/fixtures/extensions, used at once. @param {import('@playwright/test').Page} page @param {string} dir @param {string} name */
async function install(page, dir, name) {
  await pickFile(page, { name: `${dir}.zip`, mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles(dir)) });
  await page.getByRole('button', { name: 'Install anyway and use it', exact: true }).click();
  await expect(page.locator('.card', { hasText: name }).getByText('On', { exact: true })).toBeVisible();
}

test("home's gear opens Settings and Trace opens Trace, each with a crumb back home", async ({ page }) => {
  await openApp(page);
  const head = page.locator('main .home-top');
  await expect(head.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  const gear = head.getByRole('link', { name: 'Settings', exact: true });
  await expect(gear).toHaveText('⚙');
  await expect(gear).toBeInViewport({ ratio: 1 });
  expect(await gear.evaluate((el) => Math.min(el.getBoundingClientRect().width, el.getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);
  await gear.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await head.getByRole('link', { name: 'Trace', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trace', exact: true })).toBeVisible();
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/trips');
  await expect(page.locator('main .home-links')).toHaveCount(0); // no plugin with a tab: no row
});

test("a plugin's screen with a tab is a link in home's row; its page's crumb goes home; turned off, the link goes", async ({ page }) => {
  await openApp(page);
  await install(page, 'trail-ui', 'Trail UI');
  await goHome(page);
  const row = page.locator('main .home-links');
  await row.getByRole('link', { name: 'Hike', exact: true }).click();
  await expect(page.getByText('Hike screen')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/ext/trail-ui/hike');
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await goToHash(page, '#/plugins');
  await page.locator('.card', { hasText: 'Trail UI' }).getByRole('button', { name: 'Turn off' }).click();
  await goHome(page);
  await expect(page.locator('main .home-top').getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('main .home-links')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Hike' })).toHaveCount(0);
});

test("a plugin's screen for walking takes over from home as walking begins, and its crumb goes home", async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 36.60, longitude: -121.89, accuracy: 5 });
  await page.clock.install({ time: new Date() });
  await openApp(page);
  await install(page, 'trail-ui', 'Trail UI');
  await startTrip(page, 'Testville');
  await page.locator('.live-chip').click();
  await expect(page.locator('.live-chip')).toHaveText(/^GPS on\b/);
  await goHome(page);
  for (let i = 1; i <= 16; i++) { // 7.5 m every 5 s: 1.5 m/s, a walk
    await context.setGeolocation({ latitude: 36.60 - i * 0.0000675, longitude: -121.89, accuracy: 5 });
    await page.clock.fastForward(5000);
  }
  await expect(page.getByText('Hike screen')).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/ext/trail-ui/hike');
  await page.locator('main .crumbs').getByRole('link', { name: 'Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
});

test("with a plugin's dock, which has no gear of its own, the gear and Trace are on home", async ({ page }) => {
  await openApp(page);
  await install(page, 'trail-look', 'Trail look');
  await goHome(page);
  await expect(page.getByRole('navigation', { name: 'Shiori' }).getByRole('button', { name: 'Talk to Shiori' })).toBeVisible(); // the plugin's dock
  const head = page.locator('main .home-top');
  await head.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
  await goHome(page);
  await head.getByRole('link', { name: 'Trace', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trace', exact: true })).toBeVisible();
});

test('a trip ahead gets the lighter tint; a chat, a past trip and the happening one do not', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { record } = await import(at('/src/core/agent/log.js'));
    const { dayIn, deviceZone } = await import(at('/src/core/time.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const day = (/** @type {number} */ n) => dayIn(Date.now() + n * 86_400_000, deviceZone());
    const chat = await createTrip(ws, { title: 'Ramen' });
    await record(store, chat, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Ramen']], now: Date.now() - 30 * 60_000 });
    await createTrip(ws, { title: 'Pastville', start: day(-20), end: day(-18) });
    await createTrip(ws, { title: 'Nowville', start: day(0), end: day(2) });
    await createTrip(ws, { title: 'Laterton', start: day(10), end: day(12) });
    store.close();
  });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  const row = (/** @type {string} */ name) => page.locator('.trip-card', { has: page.locator('.name', { hasText: name }) });
  await expect(row('Laterton')).toHaveClass(/\bahead\b/);
  await expect(row('Ramen')).not.toHaveClass(/\bahead\b/);
  await expect(row('Pastville')).not.toHaveClass(/\bahead\b/);
  await expect(row('Nowville')).toHaveClass(/\bhappening\b/);
  await expect(row('Nowville')).not.toHaveClass(/\bahead\b/);
  // A lighter version of the happening tint: in the theme the page shows, its luminance lies between a plain card's and the happening one's
  // (the happening tint is the darker of the two on light paper, the lighter on dark). The computed colour is rgb() or, for a mix, color(srgb …).
  const paint = () => page.evaluate(() => {
    const lin = (/** @type {number} */ c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = (/** @type {string} */ css) => {
      const m = css.match(/^rgb\((\d+), (\d+), (\d+)\)$/) ?? css.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/);
      if (!m) throw new Error(`a colour this test can't read: ${css}`);
      const [r, g, b] = m.slice(1).map((v) => (css.startsWith('rgb') ? Number(v) / 255 : Number(v)));
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    /** @param {string} name */
    const of = (name) => luminance(getComputedStyle(/** @type {Element} */ ([...document.querySelectorAll('.trip-card')].find((c) => c.querySelector('.name')?.textContent === name))).backgroundColor);
    return { plain: of('Pastville'), ahead: of('Laterton'), happening: of('Nowville') };
  });
  const light = await paint();
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await paint();
  for (const l of [light, dark]) {
    expect(l.happening).not.toBeCloseTo(l.plain, 3);
    expect(l.ahead).toBeGreaterThan(Math.min(l.plain, l.happening));
    expect(l.ahead).toBeLessThan(Math.max(l.plain, l.happening));
  }
  expect(light.happening).toBeLessThan(light.plain); // light paper: the happening tint is the darker
  expect(dark.happening).toBeGreaterThan(dark.plain); // dark paper: the lighter
});

/** Home is drawn and the trip in play is known to live mode: its happening card shows. @param {import('@playwright/test').Page} page @param {string} name */
async function homeWith(page, name) {
  await goHome(page);
  await expect(page.locator('.trip-card.happening', { has: page.locator('.name', { hasText: name }) })).toBeVisible();
}

test("#/now opens today's Itinerary of the trip in play (where you are, the chips, Driving), by replace: Back never lands on it", async ({ page }) => {
  await openApp(page);
  const id = await happeningTrip(page, 'Testville');
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await homeWith(page, 'Testville');
  await goToHash(page, '#/now');
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}/plan`);
  await expect(page.getByRole('heading', { level: 1, name: 'Itinerary', exact: true })).toBeVisible();
  await expect(page.locator('.today-top')).toBeVisible(); // shown on today's tab only
  await expect(page.locator('.today-top .now-place')).toHaveText("GPS is off, so annai isn't following where you are.");
  await expect(page.locator('.today-top .chips .chip', { hasText: 'GPS off' })).toBeVisible(); // a chip, not an empty row
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
});

test("a cold load at #/now opens today's Itinerary of the trip in play, not that of the conversation left open", async ({ page }) => {
  await openApp(page);
  const id = await happeningTrip(page, 'Testville');
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  // Another conversation is the open one (Details opens it): until live mode has read the trips, the trip in play is this one's stand-in.
  const chat = await startTrip(page, 'Kept open');
  await expect.poll(() => page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { readAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    try { return (await readAppSettings(new Workspace(store))).activeTrip; } finally { store.close(); }
  })).toBe(chat);
  // An old bookmark: annai starts at #/now.
  await page.evaluate(() => history.replaceState(null, '', '#/now'));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Itinerary', exact: true })).toBeVisible(FIRST_DRAW);
  expect(new URL(page.url()).hash).toBe(`#/trip/${id}/plan`);
  await expect(page.locator('main .crumbs')).toContainText('Testville');
  await expect(page.locator('.today-top').getByRole('link', { name: 'Driving' })).toBeVisible();
});

test('#/now with nothing in play goes home, by replace', async ({ page }) => {
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
  await goToHash(page, '#/now');
  await expect.poll(() => new URL(page.url()).hash).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/settings');
});

test("a plugin's ui.go('#/now') lands on today's Itinerary of the trip in play too", async ({ page }) => {
  await openApp(page);
  const id = await happeningTrip(page, 'Testville');
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  const manifest = { id: 'go-now', name: 'Go now', version: '1.0.0', api: 1, entry: 'index.js', files: ['index.js'], description: 'Test plugin: a dock action that goes to #/now.', author: 'annai tests' };
  const code = "export function activate(annai) { const off = annai.ui.slot('dock-action', { id: 'go', label: 'Go now', icon: '→', run: (ui) => ui.go('#/now') }); return () => off(); }";
  await pickFile(page, { name: 'go-now.zip', mimeType: 'application/zip', buffer: await zipOf({ 'annai-plugin.json': Buffer.from(JSON.stringify(manifest)), 'index.js': Buffer.from(code) }) });
  await page.getByRole('button', { name: 'Install anyway', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'Go now' }).getByText('On', { exact: true })).toBeVisible();
  await homeWith(page, 'Testville');
  await goToHash(page, `#/trip/${id}`); // Details: the dock's row is up there
  await expect(page.getByRole('heading', { level: 1, name: 'Testville', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Shiori' }).getByRole('button', { name: 'Go now' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}/plan`);
  await expect(page.locator('.today-top .now-place')).toBeVisible();
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}`);
});

test("a file opened from Now's old address crumbs back to its trip's Details", async ({ page }) => {
  await openApp(page);
  const trip = await fileTrip(page);
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/file?path=${encodeURIComponent('/files/itinerary.pdf')}&from=${encodeURIComponent('#/now')}`);
  const back = page.locator('main .crumbs').getByRole('link');
  await expect(back).toHaveText(/Details$/);
  await expect(back).toHaveAttribute('href', `#/trip/${encodeURIComponent(trip)}`);
});

test("the offline pack's line, Now's until stage 8, is on the Itinerary of a trip with places and no pack", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: {
    '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: '2030-11-27T17:00:00Z', tz: 'America/Los_Angeles' }, place: { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 } },
  } });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await goToHash(page, `#/trip/${trip}/plan`);
  await expect(page.getByRole('heading', { level: 1, name: 'Itinerary', exact: true })).toBeVisible();
  const line = page.locator('main .pack-line');
  await expect(line).toContainText('No offline pack yet.');
  await expect(line.getByRole('link', { name: 'Offline pack' })).toHaveAttribute('href', `#/trip/${encodeURIComponent(trip)}`);
});

test('home has no Start a trip form and no field to type in: a trip begins with +', async ({ page }) => {
  await openApp(page);
  await startTrip(page, 'Testville'); // a trip on the timeline: home has rows, not only its empty words
  await goHome(page);
  await expect(page.getByRole('heading', { name: 'Start a trip' })).toHaveCount(0);
  await expect(page.getByLabel('Trip name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start trip' })).toHaveCount(0);
  await expect(page.locator('main').locator('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file])')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New conversation' })).toBeVisible();
});

test("the conversation's one level-1 heading is its name, which still opens Details; `me`'s is \"Shiori, no trip\"", async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Testville');
  await goToHash(page, `#/trip/${id}/talk`);
  const head = await atConversation(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Testville');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toHaveCount(0); // the hidden one is gone
  // The name looks as it did: one line, 44 px, the row's room.
  const name = head.locator('.talk-name');
  expect(await name.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(44);
  await expect(name).toHaveCSS('font-size', '20px');
  await page.getByRole('heading', { level: 1, name: 'Testville' }).getByRole('link').click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}`);
  await expect(page.locator('.trip-edit')).toBeVisible(); // Details drew
  await goToHash(page, '#/talk/me');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Shiori, no trip');
  await expect(page.getByRole('heading', { level: 1 }).getByRole('link')).toHaveCount(0);
});
