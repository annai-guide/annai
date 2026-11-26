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
  // fileTrip's Anchorage is dated Nov 20-27, 2026, its flight home fixed at 13:00 on the 27th: while its reminder is due, annai's cards
  // (the reminder, and that she can't reach a model) stick over the heading. The page's clock runs from before the trip.
  await page.clock.install({ time: new Date('2026-11-16T12:00:00Z') });
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

/**
 * The page's colours as the browser computed them, in OKLab and as linear sRGB, so a test reads what the screen paints: rgb(), color(srgb …), and
 * oklab() or oklch(), which a color-mix() in OKLab computes to. Added to the page by evaluate as an expression (the page's own rules allow no eval).
 */
const COLOURS = `(window.colourOf = (css) => {
    const nums = (s) => s.trim().split(/[\\s,/]+/).filter(Boolean).map((v) => (v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : Number(v)));
    const toLin = (c) => (Math.abs(c) <= 0.04045 ? c / 12.92 : Math.sign(c) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4);
    const linOfLab = ([L, a, b]) => {
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    };
    const labOfLin = ([r, g, b]) => {
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
    };
    let m;
    let lab;
    if ((m = /^rgba?\\((.*)\\)$/.exec(css))) lab = labOfLin(nums(m[1]).slice(0, 3).map((v) => toLin(v / 255)));
    else if ((m = /^color\\(srgb (.*)\\)$/.exec(css))) lab = labOfLin(nums(m[1]).slice(0, 3).map(toLin));
    else if ((m = /^oklab\\((.*)\\)$/.exec(css))) lab = nums(m[1]).slice(0, 3);
    else if ((m = /^oklch\\((.*)\\)$/.exec(css))) {
      const [L, C, h] = nums(m[1]);
      lab = [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
    } else throw new Error('a colour this test cannot read: ' + css);
    const lin = linOfLab(lab);
    const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // A screen shows a colour outside sRGB either as it is (an iPhone's P3 screen) or clipped (an sRGB one): both luminances are kept.
    return { lab, Y: Y(lin), clippedY: Y(lin.map((v) => Math.min(1, Math.max(0, v)))) };
  }, true)`;

test("each trip card is its own colour, lit by the lines the traveller said: happening, ahead and used past trips lit; an unused past trip, one only chatter was heard in, an archived one and a chat plain", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip, setTripStatus } = await import(at('/src/core/scopes.js'));
    const { record } = await import(at('/src/core/agent/log.js'));
    const { dayIn, deviceZone } = await import(at('/src/core/time.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const day = (/** @type {number} */ n) => dayIn(Date.now() + n * 86_400_000, deviceZone());
    /** Lines in a trip: typed, heard, and some of the heard set aside as chatter (the first ones), which are nobody's line. @param {string} id @param {number} typed @param {number} heard @param {number} [aside] */
    const said = (id, typed, heard, aside = 0) => store.tx(['events'], 'readwrite', async (/** @type {any} */ t) => {
      for (let i = 0; i < typed; i++) await t.appendEvent(id, { ts: Date.now(), type: 'msg.user', actor: 'user', data: {} });
      for (let i = 0; i < heard; i++) await t.appendEvent(id, { ts: Date.now(), type: 'heard', actor: 'user', data: i < aside ? { dismissed: true } : {} });
      for (let i = 0; i < 30; i++) await t.appendEvent(id, { ts: Date.now(), type: 'out.speak', actor: 'shiori', data: {} }); // hers never light a card
    });
    const chat = await createTrip(ws, { title: 'Ramen' });
    await record(store, chat, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Ramen']], now: Date.now() - 30 * 60_000 });
    await said(chat, 90, 0);
    await said(await createTrip(ws, { title: 'Pastville', start: day(-40), end: day(-38) }), 0, 0); // unused: plain
    await said(await createTrip(ws, { title: 'Quietville', start: day(-30), end: day(-28) }), 2, 1); // 3 lines: step 1, 1/8
    await said(await createTrip(ws, { title: 'Hushville', start: day(-35), end: day(-33) }), 0, 3, 3); // 3 heard, all chatter: nobody talked, plain
    await said(await createTrip(ws, { title: 'Busyville', start: day(-20), end: day(-18) }), 50, 35, 5); // 85 entries, 5 chatter at the start of the heard: 80 lines, the top step, 1/2
    await said(await createTrip(ws, { title: 'Nowville', start: day(0), end: day(2) }), 0, 0); // happening: 3/4 at the least
    await said(await createTrip(ws, { title: 'Laterton', start: day(10), end: day(12) }), 0, 0); // ahead: 1/4 at the least
    await said(await createTrip(ws, { title: 'Aheadville', start: day(20), end: day(22) }), 15, 5); // ahead, 20 lines: step 3, half of 3/4: 3/8
    await said(await createTrip(ws, { title: 'Rushville', start: day(0), end: day(1) }), 80, 0); // happening, 80 lines: the top step, 1
    const old = await createTrip(ws, { title: 'Oldtown', start: day(-60), end: day(-58) });
    await said(old, 100, 0);
    await setTripStatus(store, old, 'archived');
    store.close();
  });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  await page.getByText('Archived (1)').click();
  const row = (/** @type {string} */ name) => page.locator('.trip-card', { has: page.locator('.name', { hasText: name }) });
  for (const name of ['Nowville', 'Rushville', 'Laterton', 'Aheadville', 'Busyville', 'Quietville']) await expect(row(name)).toHaveClass(/\blit\b/);
  for (const name of ['Pastville', 'Hushville', 'Oldtown', 'Ramen']) await expect(row(name)).not.toHaveClass(/\blit\b/);
  await page.evaluate(COLOURS);
  const paint = () => page.evaluate(async () => {
    const { HUES, hueOf } = await import(/** @type {string} */ ('/src/ui/screens/trips.js'));
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const records = await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.listScopes());
    store.close();
    const colourOf = /** @type {any} */ (window).colourOf;
    /** @param {string} name */
    const card = (name) => /** @type {HTMLElement} */ ([...document.querySelectorAll('.trip-card')].find((c) => c.querySelector('.name')?.textContent === name));
    const plain = getComputedStyle(card('Pastville'));
    const sheet = colourOf(plain.backgroundColor).lab, line = colourOf(plain.borderTopColor).lab;
    /** The card's colour as its own tokens give it: `--trip-full` or `--trip-edge` (OKLCH lightness and chroma) in its `--hue`, mixed `--lit` of the way from the plain colour, in OKLab. */
    const mix = (/** @type {HTMLElement} */ el, /** @type {string} */ token, /** @type {number[]} */ from) => {
      const [L, C] = getComputedStyle(el).getPropertyValue(token).trim().split(/\s+/).map(Number);
      const hue = (Number(el.style.getPropertyValue('--hue')) * Math.PI) / 180;
      const lit = parseFloat(el.style.getPropertyValue('--lit')) / 100;
      return [L, C * Math.cos(hue), C * Math.sin(hue)].map((v, i) => lit * v + (1 - lit) * from[i]);
    };
    /** How far a computed colour is from a colour, in OKLab. */
    const gap = (/** @type {string} */ css, /** @type {number[]} */ want) => Math.hypot(...colourOf(css).lab.map((/** @type {number} */ v, /** @type {number} */ i) => v - want[i]));
    /** @param {string} name */
    const of = (name) => {
      const el = card(name);
      const css = getComputedStyle(el);
      // Its own hue is the one its record's `created` gives, never its id's (an import or a restore mints a new id) or anything a change moves.
      const own = hueOf(records.find((/** @type {any} */ r) => r.title === name).created);
      const lit = el.style.getPropertyValue('--lit');
      const gaps = lit ? { bgGap: gap(css.backgroundColor, mix(el, '--trip-full', sheet)), edgeGap: gap(css.borderTopColor, mix(el, '--trip-edge', line)) } : {};
      return { lit, hue: el.style.getPropertyValue('--hue'), own, bg: css.backgroundColor, edge: css.borderTopColor, lab: colourOf(css.backgroundColor).lab, ...gaps };
    };
    return { hues: HUES, cards: Object.fromEntries(['Nowville', 'Rushville', 'Laterton', 'Aheadville', 'Busyville', 'Quietville', 'Pastville', 'Hushville', 'Oldtown', 'Ramen'].map((n) => [n, of(n)])) };
  });
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    await page.emulateMedia({ colorScheme: scheme });
    const { hues, cards } = await paint();
    const { Nowville: now, Rushville: rush, Laterton: ahead, Aheadville: soon, Busyville: busy, Quietville: quiet, Pastville: unused, Hushville: hushed, Oldtown: archived, Ramen: chat } = cards;
    // How lit: happening at its floor with no lines, and at the top step with 80; ahead at its floor with none, and at half its step with 20 (step 3);
    // past at half its step (80 lines, 5 more set aside: the top step; 3 lines: the first).
    expect([now.lit, rush.lit, ahead.lit, soon.lit, busy.lit, quiet.lit]).toEqual(['75%', '100%', '25%', '37.5%', '50%', '12.5%']);
    // Plain: exactly the chat's plain card, its sheet and its line.
    for (const c of [unused, hushed, archived]) expect([c.lit, c.bg, c.edge]).toEqual(['', chat.bg, chat.edge]);
    // Lit: each its own hue, one of the ten, and exactly the mix its own tokens give, of its colour and of its edge, in OKLab (to 1e-3, which is
    // below what an eye tells apart): in light and in dark, so a rule that drops the hue or the strength in either theme is seen.
    const sheet = /** @type {[number, number, number]} */ (unused.lab);
    const depth = (/** @type {{ lab: number[] }} */ c) => Math.hypot(...c.lab.map((v, i) => v - sheet[i]));
    for (const c of [now, rush, ahead, soon, busy, quiet]) {
      expect(hues).toContain(Number(c.hue));
      expect(Number(c.hue)).toBe(c.own);
      expect(c.bg).not.toBe(chat.bg);
      expect(c.edge).not.toBe(chat.edge);
      expect(c.bgGap, `${scheme}: ${c.bg} against its tokens' mix`).toBeLessThan(1e-3);
      expect(c.edgeGap, `${scheme}: ${c.edge} against its tokens' mix`).toBeLessThan(1e-3);
    }
    // The busier the deeper (the further from the plain sheet, in OKLab), the busiest trip of now the deepest.
    expect(depth(quiet)).toBeGreaterThan(0.005);
    expect(depth(busy)).toBeGreaterThan(depth(quiet) * 2);
    expect(depth(now)).toBeGreaterThan(depth(busy));
    expect(depth(rush)).toBeGreaterThan(depth(now));
  }
});

test("a trip card's box is the same size lit or not: only its colours change", async ({ page }) => {
  await openApp(page);
  await happeningTrip(page, 'Nowville');
  const card = page.locator('.trip-card.lit', { has: page.locator('.name', { hasText: 'Nowville' }) });
  await expect(card).toBeVisible(FIRST_DRAW);
  const boxes = await card.evaluate((el) => {
    const box = () => {
      const r = el.getBoundingClientRect();
      const css = getComputedStyle(el);
      return { x: r.x, y: r.y, width: r.width, height: r.height, border: css.borderTopWidth, padding: css.padding, bg: css.backgroundColor };
    };
    const lit = box();
    el.classList.remove('lit');
    const plain = box();
    el.classList.add('lit');
    return { lit, plain };
  });
  expect(boxes.lit.bg).not.toBe(boxes.plain.bg);
  expect({ ...boxes.lit, bg: '' }).toEqual({ ...boxes.plain, bg: '' });
});

test('every secondary line on every lit trip card keeps WCAG AA contrast on all ten hues at every strength the rules give, in light and dark', async ({ page }) => {
  await openApp(page);
  // The lines a card can have: a happening trip with its day and a Next item, one ahead with how soon and her last line there; both have their facts.
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { record } = await import(at('/src/core/agent/log.js'));
    const { dayIn, deviceZone, isoInZone } = await import(at('/src/core/time.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const zone = deviceZone();
    const day = (/** @type {number} */ n) => dayIn(Date.now() + n * 86_400_000, zone);
    const now = await createTrip(ws, { title: 'Nowville', start: day(0), end: day(2) });
    await ws.write(now, '/plan/next.json', { id: 'next', title: 'Lunch at the pier', fixed: true, start: { at: isoInZone(Date.now() + 86_400_000, zone), tz: zone } }, { author: 'user' });
    const later = await createTrip(ws, { title: 'Laterton', start: day(10), end: day(12) });
    await record(store, later, { type: 'out.speak', actor: 'shiori', data: { text: 'See you at the station.' } });
    store.close();
  });
  await page.reload();
  await expect(page.locator('.trip-card.lit .sub').first()).toBeVisible(FIRST_DRAW);
  await expect(page.locator('.trip-card.lit .sub.next')).toBeVisible();
  await expect(page.locator('.trip-card.lit .sub.her-last')).toBeVisible();
  await page.evaluate(COLOURS);
  const worst = () => page.evaluate(async () => {
    const { HUES, litOf } = await import(/** @type {string} */ ('/src/ui/screens/trips.js'));
    const colourOf = /** @type {any} */ (window).colourOf;
    const strengths = [...new Set(['happening', 'future', 'past'].flatMap((p) => [0, 1, 2, 3, 4].map((s) => litOf(p, s))))].filter((s) => s > 0).sort((a, b) => a - b);
    const cards = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.trip-card.lit')]);
    const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    let out = { ratio: Infinity, hue: 0, lit: 0, bg: '', ink: '', inks: /** @type {string[]} */ ([]), kinds: /** @type {string[]} */ ([]), cards: cards.length, strengths };
    for (const card of cards) {
      const subs = /** @type {HTMLElement[]} */ ([...card.querySelectorAll('.sub')]);
      for (const sub of subs) if (!out.kinds.includes(sub.className)) out.kinds.push(sub.className);
      for (const hue of HUES) {
        for (const lit of strengths) {
          card.style.setProperty('--hue', String(hue));
          card.style.setProperty('--lit', `${lit * 100}%`);
          const bg = getComputedStyle(card).backgroundColor;
          const b = colourOf(bg);
          // Every line the card sets in --ink-2 (its facts, the day, the next item, how soon, her last line; a sent trip's From line too, the
          // same --ink-2, not seeded): the worst of them is the card's.
          for (const sub of subs) {
            const ink = getComputedStyle(sub).color;
            const i = colourOf(ink);
            const r = Math.min(ratio(b.Y, i.Y), ratio(b.clippedY, i.clippedY));
            if (r < out.ratio) out = { ...out, ratio: r, hue, lit, bg, ink };
            if (!out.inks.includes(ink)) out.inks.push(ink);
          }
        }
      }
    }
    return out;
  });
  const light = await worst();
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await worst();
  test.info().annotations.push({ type: 'contrast', description: `light ${light.ratio.toFixed(2)}:1 (hue ${light.hue}, ${light.lit}); dark ${dark.ratio.toFixed(2)}:1 (hue ${dark.hue}, ${dark.lit})` });
  console.log(`worst --ink-2 contrast: light ${light.ratio.toFixed(3)}:1 at hue ${light.hue}, ${light.lit} (${light.bg} under ${light.ink}); dark ${dark.ratio.toFixed(3)}:1 at hue ${dark.hue}, ${dark.lit} (${dark.bg} under ${dark.ink})`);
  expect(light.strengths).toEqual([1 / 8, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1]);
  expect(light.cards).toBe(2); // the happening trip and the one ahead
  // The lines it measures: the facts of each card, the happening one's day and Next, the one ahead's how soon and her last line.
  expect([...light.kinds].sort()).toEqual(['sub', 'sub day-of', 'sub her-last', 'sub next', 'sub soon']);
  expect(light.inks).toEqual(['rgb(91, 96, 117)']); // --ink-2, light, on every one
  expect(dark.inks).toEqual(['rgb(162, 167, 184)']); // --ink-2, dark
  expect(light.ratio).toBeGreaterThanOrEqual(4.5);
  expect(dark.ratio).toBeGreaterThanOrEqual(4.5);
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

test("a move made while a cold #/now waits for live mode's read of the trips stands: the stale redirect doesn't replace it", async ({ page }) => {
  // The real shell with a real store, its live mode a stand-in whose read of the trips ends when the test says, with a trip in play to be sent to.
  await page.route('**/probe.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>' }));
  await page.goto('/probe.html#/now');
  await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const at = (/** @type {string} */ p) => p; // an address the browser loads, not a module the checker follows
    const { startShell } = await import(at('/src/ui/shell.js'));
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { deviceZone } = await import(at('/src/core/time.js'));
    const { realClock } = await import(at('/src/core/live/clock.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const play = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-27' });
    const tripsRead = new Promise((done) => { w.readTrips = () => done(undefined); });
    const live = { tripsRead, play, clock: realClock(), timeZone: deviceZone, onChange() {}, onReminders() {} };
    const registry = { entries: () => [], onChange: () => () => {}, fail: () => {}, threw: () => {}, succeeded: () => {}, isDisabled: () => false, clashes: () => [] };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    startShell(root, { store, ws, registry, live, plugins: { langOf: () => 'en' }, updates: { restart: async () => {}, waiting: false, plugins: async () => [] }, version: 'probe' });
  });
  // Nothing is drawn while the read is out. The traveller moves on, to Trips, which is drawn by its own render.
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible(FIRST_DRAW);
  // The read ends: the render that waited for it finds the address moved and leaves it be, where it would have sent them to the trip in play.
  await page.evaluate(() => new Promise((done) => { /** @type {any} */ (window).readTrips(); setTimeout(done, 100); }));
  expect(new URL(page.url()).hash).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips', exact: true })).toBeVisible();
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
