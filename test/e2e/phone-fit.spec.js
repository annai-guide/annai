import { test, expect } from '@playwright/test';
import { openApp, turnOnSwipes, waitForServiceWorker, pickFile, zipOf, writeRecords } from './helpers.js';

// In headless WebKit no tap unlocks sound, so every tap, a swipe's pointerup too, starts the silent clip again; and a
// page that goes away while one starts can wedge WebKit's process on Linux (the Erase hang, 2026-10-18). A swipe test
// ends right after a swipe, and once hung in WebKit under load: each test here ends once the clips it started have.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    /** @type {Promise<unknown>[]} */
    const started = [];
    Object.defineProperty(window, 'testClips', { value: started });
    HTMLMediaElement.prototype.play = function () {
      const p = play.call(this);
      started.push(p.catch(() => {}));
      return p;
    };
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => Promise.race([Promise.allSettled(/** @type {any} */ (window).testClips ?? []), new Promise((r) => setTimeout(r, 5000))]));
});

// What the user saw on an iPhone (2026-10-18): the page scrolled sideways, a date box stuck out of
// its card, Shiori sat over the camera button in a corner, and the top bar hid that it scrolls.
const SCREENS = ['#/trips', '#/now', '#/talk', '#/plan', '#/trace', '#/settings', '#/models', '#/voice', '#/tools', '#/plugins', '#/add', '#/backups', '#/notifications', '#/shiori',
  '#/languages', '#/about', '#/experimental', '#/welcome'];

// In English, and in Japanese and both Chinese (localization L6; Traditional, l10n-zh-Hant): short words, tall glyphs and no spaces to break at.
for (const [ui, width] of /** @type {const} */ ([['', 320], ['', 420], ['ja', 320], ['ja', 420], ['zh-Hans', 320], ['zh-Hans', 420], ['zh-Hant', 320], ['zh-Hant', 420]])) {
  test(`every screen fits a phone ${width} px wide: nothing scrolls sideways${ui ? `, in ${ui}` : ''}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    if (ui) await page.addInitScript((tag) => { try { localStorage.setItem('annai.ui', tag); } catch { /* storage blocked */ } }, ui);
    await openApp(page);
    if (ui) await expect(page.locator('html')).toHaveAttribute('lang', ui);
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
}

for (const width of [320, 420]) {
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

// A plugin's own words can hold one long word: a URL, a token, a host (the user saw a page scroll sideways, 2026-10-18).
test("a plugin with a long word in its description, its name and keyword, and from a long host, fits a phone 320 px wide: its install screen, Add and Plugins", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openApp(page, '#/plugins');
  await waitForServiceWorker(page);
  const host = `${'h'.repeat(60)}.example`;
  const manifest = {
    id: 'long-words', name: `Long${'n'.repeat(70)}`, version: '1.0.0', api: 1, keywords: ['k'.repeat(40)], requires: [{ id: 'chat-completions', version: '^0' }],
    description: `See ${'x'.repeat(120)} or https://very.long.example/${'a'.repeat(80)}`,
    provider: { baseUrl: `https://${host}/v1`, key: 'required', abilities: { chat: { kind: 'chat', type: 'chat-completions' } } },
  };
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await pickFile(page, { name: 'long.zip', mimeType: 'application/zip', buffer: await zipOf({ 'annai-plugin.json': Buffer.from(JSON.stringify(manifest)) }) });
  await expect(page.getByRole('heading', { name: /^Install Long/ })).toBeVisible();
  expect(await over(), 'the install screen').toBe(0);
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible({ timeout: 30_000 });
  // As if it came from an address on a long host: Add and Plugins say where it came from.
  await page.evaluate(async (url) => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const state = await ws.readJSON('sys:plugins', '/installed.json');
    await ws.write('sys:plugins', '/installed.json', { ...state, 'long-words': { ...state['long-words'], source: 'url', url } }, { author: 'system' });
    store.close();
  }, `https://${host}/kits/${'p'.repeat(60)}/annai-plugin.json`);
  await page.reload();
  for (const hash of ['#/plugins', '#/add', '#/add?kind=providers&from=models']) {
    await page.goto(`/${hash}`);
    await expect(page.locator('.found .card', { hasText: /^Long/ })).toBeVisible();
    expect(await over(), hash).toBe(0);
  }
  await page.getByLabel('Search the catalog').fill('kkkk');
  await expect(page.locator('.found .card')).toContainText(`Also for: ${'k'.repeat(40)}`);
  expect(await over(), 'a long keyword').toBe(0);
});

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

/**
 * The controls of the screen (main) whose middle is on screen, above the dock, but under something else: a card, say.
 * @param {import('@playwright/test').Page} page
 */
const coveredControls = (page) => page.evaluate(() => {
  const dockTop = document.querySelector('nav.dock')?.getBoundingClientRect().top ?? innerHeight;
  const barBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
  return [...document.querySelectorAll('main.view :is(a[href], button, input, select, textarea, summary)')].flatMap((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (!r.width || !r.height || y <= barBottom || y >= dockTop || x < 0 || x > innerWidth) return [];
    const hit = document.elementFromPoint(x, y);
    return hit && (el === hit || el.contains(hit) || [.../** @type {any} */ (el).labels ?? []].some((l) => l.contains(hit))) ? [] : [`${el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName} under ${hit?.closest('.notice, .toast') ? 'a card' : hit?.tagName}`];
  });
});

test("a system card never covers the screen's controls: it comes in at the top and moves the screen down, and the screen scrolls clear of it (the emulator pass)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect(await coveredControls(page)).toEqual([]);
  // The dock's camera with no trip open: a card says to open one.
  await page.locator('#dock-camera').setInputFiles({ name: 'gate.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') });
  const card = page.locator('.notice', { hasText: 'Open a trip first' });
  await expect(card).toBeVisible();
  await expect(page.locator('.notices')).not.toHaveClass(/landed/); // the moment that ignores taps on what it moved is over
  expect(await coveredControls(page)).toEqual([]);
  // Each control can be scrolled clear of the card and the dock, the last ones too.
  expect(await page.evaluate(() => [...document.querySelectorAll('main.view :is(a[href], button:not([disabled]), input, select, textarea, summary)')].flatMap((el) => {
    if (!el.getClientRects().length) return [];
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (hit === el || el.contains(hit) || [.../** @type {any} */ (el).labels ?? []].some((l) => l.contains(hit))) ? [] : [`${el.textContent?.trim() || el.tagName} under ${hit?.closest('.notice, nav.dock')?.className ?? hit?.tagName}`];
  }))).toEqual([]);
  // In the page's flow, not stuck to the top: scrolled down, the card has gone up with the page.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect(card).not.toBeInViewport();
  await page.evaluate(() => scrollTo(0, 0));
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
});

const PNG1 = { name: 'gate.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') };
/** A system card, as annai raises one: the dock's camera with no trip open. @param {import('@playwright/test').Page} page */
const raiseCard = (page) => page.locator('#dock-camera').setInputFiles(PNG1);

test('review S1: scrolled down, a card coming or going keeps the screen where it was, measured, not left to the browser (Safari before 18 has no scroll anchoring)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 400));
  const mark = () => page.evaluate(() => {
    const el = [...document.querySelectorAll('main.view a[href]')].find((e) => e.getBoundingClientRect().top > 200);
    el?.setAttribute('data-mark', '');
    return el?.getBoundingClientRect().top ?? -1;
  });
  const at = () => page.evaluate(() => document.querySelector('[data-mark]')?.getBoundingClientRect().top ?? -1);
  const was = await mark();
  await raiseCard(page);
  await expect(page.locator('.notice')).toHaveCount(1);
  expect(Math.abs(await at() - was)).toBeLessThanOrEqual(1);
  await page.evaluate(() => /** @type {HTMLButtonElement} */ ([...document.querySelectorAll('.notice .btn.ghost')].find((b) => b.textContent === 'Dismiss')).click()); // Dismiss, from up there
  await expect(page.locator('.notice')).toHaveCount(0);
  expect(Math.abs(await at() - was)).toBeLessThanOrEqual(1);
});

test("one card taller than the box a quarter of the screen high shows its title and Dismiss, its words behind More (SE size, landscape; the second emulator re-check; the second review of phone-fixes-1: a card shows its title and every button)", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await raiseCard(page);
  const card = page.locator('.notice', { hasText: 'Open a trip first' });
  await expect(card).toBeVisible();
  // One card that says a lot: far taller than a quarter of 375 px; looked at again (a turn of the phone).
  await card.locator('p').evaluate((p) => { p.textContent = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of what this card has to say.`).join('\n'); });
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  /** Whether a part lies wholly in sight, and nothing covers it. @param {import('@playwright/test').Locator} part */
  const inSight = (part) => part.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + 4, b.top + b.height / 2);
    return b.top >= 0 && b.bottom <= innerHeight && b.height > 20 && Boolean(top && el.contains(top));
  });
  expect(await inSight(card.locator('strong')), 'the title').toBe(true);
  expect(await inSight(card.getByRole('button', { name: 'Dismiss' })), 'Dismiss').toBe(true);
  expect(await inSight(card.getByRole('button', { name: 'More' })), 'More, for the words').toBe(true);
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
});

test("a back link has a tap area 44 px tall, and the screen's layout is where it was (the second emulator re-check: 23 px)", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  for (const [route, heading] of [['#/models', 'Models'], ['#/voice', 'Voice'], ['#/plugins', 'Plugins'], ['#/notifications', 'Notifications']]) {
    await openApp(page, route);
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
    const link = page.locator('.crumbs a').first();
    await expect(link).toBeVisible();
    await expect.poll(async () => (await link.boundingBox())?.height ?? 0, { message: route }).toBeGreaterThanOrEqual(44);
    const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await link.boundingBox());
    // The words did not move: the paragraph holding the link is still one line high.
    expect(await page.locator('p.crumbs').first().evaluate((p) => p.getBoundingClientRect().height), route).toBeLessThan(30);
    // A tap at the edge of the 44 px, above and below the words, follows the link.
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.crumbs a') !== null, [box.x + 4, box.y + 4]);
    expect(hit, route).toBe(true);
  }
});

test('cards of one kind fold into one card that shows each when opened, with one Dismiss all, and each can be dismissed alone (the user, 2026-10-21: "stack them")', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await raiseCard(page);
  await expect(page.locator('.notices .notice-stack')).toHaveCount(0); // one card is a card
  await raiseCard(page);
  const stack = page.locator('.notices .notice-stack');
  await expect(stack).toHaveCount(1);
  await expect(stack.getByText('Open a trip first (2)')).toBeVisible();
  await raiseCard(page);
  await expect(stack.getByText('Open a trip first (3)')).toBeVisible();
  await expect(stack.locator('.stack-list')).toBeHidden();
  await stack.getByRole('button', { name: 'Show' }).click();
  await expect(stack.locator('.stack-list .notice')).toHaveCount(3);
  // One alone: the stack counts down, and at one it is the card again.
  await stack.locator('.stack-list .notice').first().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(stack.getByText('Open a trip first (2)')).toBeVisible();
  await stack.locator('.stack-list .notice').first().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.notices .notice-stack')).toHaveCount(0);
  await expect(page.locator('.notices .notice')).toHaveCount(1);
  // Dismiss all.
  await raiseCard(page);
  await raiseCard(page);
  await page.locator('.notices .notice-stack').getByRole('button', { name: 'Dismiss all' }).click();
  await expect(page.locator('.notices .notice')).toHaveCount(0);
});

test('a card with anything to do but Dismiss is never folded into a stack; a stack is announced, named, and its buttons say what they act on (the verification)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // Two cards that each offer Try again stay two cards, each with its button in sight.
  await page.evaluate(async () => {
    const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
    const n = createNotices();
    n.el.id = 'probe-notices';
    document.querySelector('main')?.before(n.el);
    for (const why of ['one', 'two']) n.card({ title: "Shiori didn't answer", body: `Because ${why}.`, actions: [{ label: 'Try again', run() {} }] });
  });
  const probe = page.locator('#probe-notices');
  await expect(probe.locator('.notice-stack')).toHaveCount(0);
  await expect(probe.getByRole('button', { name: 'Try again' })).toHaveCount(2);
  await page.evaluate(() => document.getElementById('probe-notices')?.remove());
  // A stack of plain cards: named, controlled, labelled, announced.
  for (let i = 0; i < 3; i++) await raiseCard(page);
  const stack = page.locator('.notices .notice-stack');
  await expect(stack).toHaveAttribute('aria-label', 'Open a trip first, 3 cards');
  const show = stack.getByRole('button', { name: 'Show the 3 cards: Open a trip first' });
  await expect(show).toHaveAttribute('aria-controls', /^stack-\d+$/);
  const list = /** @type {string} */ (await show.getAttribute('aria-controls'));
  expect(await page.locator(`#${list}`).count()).toBe(1);
  await expect(stack.getByRole('button', { name: 'Dismiss all 3 cards: Open a trip first' })).toBeVisible();
  // A card joining is announced by its own words, though it sits folded away.
  await expect(stack.locator('.visually-hidden[role="status"]')).toContainText('Open a trip first');
  await show.click();
  await expect(stack.getByRole('button', { name: 'Hide the 3 cards: Open a trip first' })).toHaveAttribute('aria-expanded', 'true');
});

test('review S2: a card that lands while the screen is at its top moves it down, and for a moment a tap on what slid under the finger does nothing', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.clock.install();
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // The install warning's Show me how, the first button under the cards.
  const how = page.getByRole('region', { name: 'Install annai' }).getByRole('button', { name: 'Show me how' });
  const steps = page.getByRole('region', { name: 'Install annai' }).locator('ol.steps');
  const was = /** @type {{ x: number, y: number, width: number, height: number }} */ (await how.boundingBox());
  await raiseCard(page);
  await expect(page.locator('.notice')).toHaveCount(1);
  const now = /** @type {{ x: number, y: number, width: number, height: number }} */ (await how.boundingBox());
  expect(now.y).toBeGreaterThan(was.y); // it slid down
  await page.mouse.click(now.x + now.width / 2, now.y + now.height / 2);
  await page.clock.runFor(50);
  await expect(steps).toBeHidden();
  await page.clock.runFor(500);
  await page.mouse.click(now.x + now.width / 2, now.y + now.height / 2);
  await expect(steps).toBeVisible();
});

test('review S1: three cards fold into one, which takes at most a quarter of a 320 × 544 screen; opened, the box grows and each card shows whole (the third review of phone-fixes-1)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  for (let i = 0; i < 3; i++) await raiseCard(page);
  const box = () => page.evaluate(() => { const n = /** @type {HTMLElement} */ (document.querySelector('.notices')); return { h: n.offsetHeight, scroll: n.scrollHeight }; });
  expect((await box()).h).toBeLessThanOrEqual(Math.ceil(544 / 4) + 1);
  await page.locator('.notice-stack').getByRole('button', { name: 'Show' }).click(); // the three fold into one card; opened, each shows
  await expect(page.locator('.notice')).toHaveCount(4);
  // The box's cap is lifted while the stack is open, as for an opened card: no card's sticky Dismiss over another's title.
  const opened = await box();
  expect(opened.scroll).toBeLessThanOrEqual(opened.h + 1);
  await page.locator('.notice-stack').getByRole('button', { name: 'Hide' }).click();
  expect((await box()).h).toBeLessThanOrEqual(Math.ceil(544 / 4) + 1);
});

for (const [width, height] of [[360, 760], [320, 544]]) {
  test(`on a phone ${width} × ${height}, every control scrolls clear of the dock: an install's Install and Cancel, Settings, Trips (the emulator pass)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page, '#/plugins');
    await waitForServiceWorker(page);
    /** The controls that can't be brought above the dock, scrolling as far as the screen goes. */
    const underDock = () => page.evaluate(() => [...document.querySelectorAll('main.view :is(a[href], button:not([disabled]), input, select, textarea, summary)')].flatMap((el) => {
      // Not shown: hidden, or folded in a closed <details> (its summary shows; Chromium still gives what it folds a box).
      if (!el.getClientRects().length || el.closest('details:not([open]) > :not(summary)')) return [];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit && (hit === el || el.contains(hit) || [.../** @type {any} */ (el).labels ?? []].some((l) => l.contains(hit))) ? [] : [`${el.textContent?.trim() || el.tagName} under ${hit?.closest('nav.dock') ? 'the dock' : hit?.tagName}`];
    }));
    const manifest = { id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js', description: "Test plugin: today's tides as a tool." };
    await pickFile(page, { name: 'tides.zip', mimeType: 'application/zip', buffer: await zipOf({ 'annai-plugin.json': Buffer.from(JSON.stringify(manifest)), 'index.js': Buffer.from('export function activate() {}') }) });
    await expect(page.getByRole('heading', { name: 'Install Tides?' })).toBeVisible();
    expect(await underDock()).toEqual([]);
    for (const hash of ['#/settings', '#/trips']) {
      await page.evaluate((x) => { location.hash = x; }, hash);
      await expect(page.locator('main.view h1').first()).toBeVisible();
      expect(await underDock(), hash).toEqual([]);
    }
  });
}

test('on a short screen (an iPhone SE, 320 × 544) the dock is compact: under a fifth of the height; voice still enlarges it, at the bottom (spec §16.2)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 544 });
  await openApp(page);
  const dock = page.locator('nav.dock');
  const quiet = /** @type {{ y: number, height: number }} */ (await dock.boundingBox());
  expect(quiet.height).toBeLessThan(544 / 5);
  expect(Math.round(quiet.y + quiet.height)).toBe(544);
  await expect(page.getByRole('button', { name: 'Shiori' })).toContainText('Tap to talk'); // her state still shows
  await page.locator('.voice-chip').click();
  await page.getByRole('group', { name: 'Voice' }).getByRole('button', { name: 'On' }).click();
  await expect(dock).toHaveClass(/\bvoice\b/);
  const voice = /** @type {{ y: number, height: number }} */ (await dock.boundingBox());
  expect(voice.height).toBeGreaterThan(quiet.height);
  expect(Math.round(voice.y + voice.height)).toBe(544);
});

// A long caption is a few lines and an ellipsis, so it never pushes the dock up over the page (fix pass 4).
for (const [w, h] of [[320, 544], [568, 296]]) {
  test(`a long caption stays a few lines on a ${w} × ${h} screen: the dock stays under about half of it, the bubble's tail still shows`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openApp(page, '#/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const dock = page.locator('nav.dock');
    const before = /** @type {{ height: number }} */ (await dock.boundingBox());
    await page.evaluate(() => {
      const caption = /** @type {HTMLElement} */ (document.querySelector('.dock .caption'));
      /** @type {HTMLElement} */ (caption.querySelector('.caption-text')).textContent = 'A very long answer, said word after word, that goes on and on. '.repeat(30);
      caption.hidden = false;
    });
    const caption = page.locator('.dock .caption');
    await expect(caption).toBeVisible();
    const after = /** @type {{ y: number, height: number }} */ (await dock.boundingBox());
    // At most four lines (two on a short screen) of the bubble's text were added.
    const line = await caption.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight) || Number.parseFloat(getComputedStyle(el).fontSize) * 1.4);
    const lines = h < 420 ? 1 : h < 600 ? 2 : 4;
    expect(after.height - before.height).toBeLessThanOrEqual(lines * line + 40);
    expect(after.height).toBeLessThanOrEqual(h * 0.55);
    // The page keeps about a third of the height, as with the text box open.
    expect(after.y).toBeGreaterThanOrEqual(h * 0.32);
    const tail = await caption.evaluate((el) => getComputedStyle(el, '::after').content);
    expect(tail).toBe('""');
    expect(await caption.evaluate((el) => getComputedStyle(el).overflow)).toBe('visible');
  });
}

test('landscape at SE size (568 × 296) with the dock\'s text box open: the page keeps about a third of the height (a third less 5 px), and the box and its send arrow are on screen, and tapping the keyboard button again closes it (the third emulator pass: 11 px)', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 296 });
  await openApp(page, '#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Type' }).click();
  const box = page.getByLabel('Message to Shiori');
  await expect(box).toBeVisible();
  const room = () => page.evaluate(() => {
    const bar = document.querySelector('header, .topbar, nav[aria-label="Main"]')?.getBoundingClientRect();
    const dock = /** @type {HTMLElement} */ (document.querySelector('nav.dock')).getBoundingClientRect();
    return { dock: dock.height, page: dock.top - (bar?.bottom ?? 0), barBottom: bar?.bottom ?? 0 };
  });
  const open = await room();
  expect(open.page).toBeGreaterThanOrEqual(296 * 0.32);
  // Everything in the panel is on screen and can be tapped.
  for (const b of [box, page.getByRole('button', { name: 'Send' })]) {
    const r = /** @type {{ y: number, height: number }} */ (await b.boundingBox());
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(296);
  }
  expect((/** @type {{ height: number }} */ (await box.boundingBox())).height).toBeGreaterThanOrEqual(30);
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await expect(box).toBeHidden();
});

test('the type box with three chips, Trips with files waiting, and a trip without dates fit a phone 320 px wide, in ja', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => { try { localStorage.setItem('annai.ui', 'ja'); } catch { /* storage blocked */ } });
  await openApp(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  const long = 'Your flight is booked- TESTQ1 to Anchorage on 11:20:2026 with a very long confirmation name.pdf';
  await writeRecords(page, 'sys:waiting', { text: { [`/files/${long}`]: 'a', '/files/hotel.txt': 'b', '/files/car.txt': 'c' } });
  // A trip with no dates.
  await page.getByLabel('旅の名前').fill('アンカレッジとその周辺をめぐる長い名前の旅');
  await page.getByRole('button', { name: '旅を始める' }).last().click();
  await expect(page.getByRole('heading', { name: 'アンカレッジとその周辺をめぐる長い名前の旅' })).toBeVisible();
  const wide = async () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await wide()).toBeLessThanOrEqual(0);
  await page.goto('/#/trips');
  await expect(page.locator('.waiting-file')).toHaveCount(3);
  expect(await wide()).toBeLessThanOrEqual(0);
  // Three chips in the type box: a long name, cut, and two short.
  await page.locator('.dock .ib[aria-expanded]').click();
  await page.getByLabel('Shiori に写真やファイルを渡す').setInputFiles([
    { name: long, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    { name: 'hotel.txt', mimeType: 'text/plain', buffer: Buffer.from('hotel') },
    { name: 'car.txt', mimeType: 'text/plain', buffer: Buffer.from('car') },
  ]);
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(3);
  expect(await wide()).toBeLessThanOrEqual(0);
  const out = await page.evaluate(() => [...document.querySelectorAll('.type-sheet .attach-chip')].filter((c) => c.getBoundingClientRect().right > innerWidth + 1).length);
  expect(out).toBe(0);
});
