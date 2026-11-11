import { test, expect } from '@playwright/test';
import { openApp, startTrip, goToHash } from './helpers.js';

// "For the real on device test, I cannot find how to enter a trip detail... (including deleting a misc one) I assume it to in be the ...
// but it does not show...." (the user, from the live version, 2026-11-10); with a screenshot: "... is there, I just only see these" (Summarize now,
// Start fresh, What each half sees). The conversation's ⋯ is the conversation's menu: Details first, the same place the name goes.

/** Makes conversations as the app makes them (an undated one is a chat), each with lines to scroll, and draws the app again to see them. @param {import('@playwright/test').Page} page @param {{ title: string, start?: string, end?: string, lines?: number }[]} trips @returns {Promise<string[]>} their ids */
async function makeConversations(page, trips) {
  const ids = await page.evaluate(async (trips) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    /** @type {string[]} */
    const made = [];
    for (const trip of trips) {
      const { lines = 12, ...dates } = trip;
      const id = await createTrip(ws, dates);
      for (let i = 0; i < lines; i++) await logEvent(store, id, { type: 'out.speak', actor: 'system', data: { id: `s${i}`, text: `Line ${i} of a conversation, long enough to fill a line or two on a phone.` } });
      made.push(id);
    }
    store.close();
    return made;
  }, trips);
  await page.reload();
  return ids;
}

/**
 * What is wrong with the open menu's controls (Details, Summarize now, Start fresh, What each half sees): each scrolled to inside the menu, as a finger does,
 * it must be inside the menu, above the dock, on screen, and what a tap lands on. @param {import('@playwright/test').Page} page @returns {Promise<string[]>}
 */
async function controlsProblems(page) {
  const controls = page.locator('.tidy-menu').locator('a.btn, button.btn');
  const n = await controls.count();
  /** @type {string[]} */
  const problems = n === 4 ? [] : [`${n} controls, not 4`];
  for (let i = 0; i < n; i++) {
    await controls.nth(i).evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    const at = await controls.nth(i).evaluate((el) => {
      const b = el.getBoundingClientRect();
      const m = /** @type {HTMLElement} */ (el.closest('.tidy-menu')).getBoundingClientRect();
      const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
      const over = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { hit: over === el || el.contains(over), inside: b.top >= m.top - 1 && b.bottom <= m.bottom + 1, aboveDock: m.bottom <= dock.top + 1 && b.bottom <= dock.top + 1, onScreen: b.top >= 0 && b.left >= 0 && b.right <= innerWidth };
    });
    for (const [what, ok] of Object.entries(at)) if (!ok) problems.push(`control ${i}: not ${what}`);
  }
  return problems;
}

const SIZES = /** @type {const} */ ([[320, 568], [360, 640], [393, 659], [430, 932]]);
// A name that fills any phone's width, in each language: the ⋯ is never pushed out by it.
const LONG = 'A very long conversation name that goes on and on past any phone width, about the pelicans and the cliffs and the long road south to Big Sur and back';
const LONG_JA = 'とても長い会話の名前がずっと続いて、どんな電話の幅も越えてしまう、ペリカンと崖と南へ続く長い道のこと、ビッグサーまで行って帰ってくる話';
const LANGS = /** @type {const} */ ([
  { tag: 'en', start: '#/trips', names: ['Big Sur', LONG] },
  { tag: 'ja', start: '#/trips', names: ['短い', LONG_JA] },
  { tag: 'en-XA', start: '?l10n=en-XA#/trips', names: ['Big Sur', LONG] }, // the pseudo-locale: every word about a third longer, as a long language's would be
]);

for (const [width, height] of SIZES) {
  for (const lang of LANGS) {
    test(`the ⋯ is on screen and tappable, and its menu, with Details first, fits between the bar and the dock, at ${width}x${height} in ${lang.tag}, for a chat and a dated trip, with a short and a very long name`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (lang.tag === 'ja') await page.addInitScript(() => { try { localStorage.setItem('annai.ui', 'ja'); } catch { /* storage blocked */ } });
      await openApp(page, lang.start);
      const [short, long] = lang.names;
      const ids = await makeConversations(page, [
        { title: short }, { title: long }, { title: short, start: '2099-03-03', end: '2099-03-05' }, { title: long, start: '2099-03-03', end: '2099-03-05' },
      ]);
      for (const id of ids) {
        await goToHash(page, `#/trip/${id}/talk`);
        const toggle = page.locator('.talk-head .tidy-toggle');
        await expect(toggle).toBeVisible();
        // It opens at the end of the conversation: the head sticks under the bar. On screen whole, under no other box, and at least a finger's size.
        await expect(toggle).toBeInViewport({ ratio: 1 });
        // A card that has just landed makes the screen ignore taps for a moment (notices.js): the hit is waited for, never assumed.
        await expect.poll(() => page.evaluate(() => {
          const el = /** @type {HTMLElement} */ (document.querySelector('.talk-head .tidy-toggle'));
          const b = el.getBoundingClientRect();
          const over = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          const bar = /** @type {HTMLElement} */ (document.querySelector('header.topbar')).getBoundingClientRect();
          const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
          return { hit: over === el || el.contains(over), fingerSize: Math.min(b.width, b.height) >= 44, clear: b.top >= bar.bottom - 1 && b.bottom <= dock.top && b.right <= innerWidth };
        })).toEqual({ hit: true, fingerSize: true, clear: true });
        await toggle.click(); // a tap that would land on another box does not click: it waits, then fails
        const menu = page.locator('.tidy-menu');
        await expect(menu).toBeVisible();
        // The menu never goes under the dock: what is more than it holds scrolls inside it, and every control can be scrolled to and tapped.
        expect(await controlsProblems(page)).toEqual([]);
        const controls = menu.locator('a.btn, button.btn');
        // Details is the first of them, and goes where the name goes.
        await menu.evaluate((el) => { el.scrollTop = 0; });
        await expect(controls.first()).toHaveAttribute('href', `#/trip/${encodeURIComponent(id)}`);
        await expect(page.locator('.talk-head .talk-name')).toHaveAttribute('href', `#/trip/${encodeURIComponent(id)}`);
        await controls.first().click();
        await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${encodeURIComponent(id)}`);
        await expect(page.locator('.trip-edit')).toBeVisible(); // Details drew
      }
    });
  }
}

// A short conversation's page can't scroll: the title sits where the cards and banner above it leave it, low on a tall phone, and the menu under it must
// still end above the dock, with every control reachable (the page can't lift the title under the bar).
for (const [width, height] of /** @type {const} */ ([[360, 640], [390, 844], [430, 932]])) {
  test(`a short conversation, its title low on the page: the menu ends above the dock and every control can be reached, at ${width}x${height}, chat and dated trip`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openApp(page);
    const ids = await makeConversations(page, [{ title: 'Pelican chat', lines: 1 }, { title: 'Big Sur', start: '2099-03-03', end: '2099-03-05', lines: 1 }]);
    for (const id of ids) {
      await goToHash(page, `#/trip/${id}/talk`);
      const toggle = page.locator('.talk-head .tidy-toggle');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(page.locator('.tidy-menu')).toBeVisible();
      expect(await controlsProblems(page)).toEqual([]);
    }
  });
}

test('the ⋯ is the conversation\'s menu: Details first, with a line saying what is there, then Summarize now, Start fresh and What each half sees; the name is still a link to the same Details', async ({ page }) => {
  await openApp(page);
  const [chat, trip] = await makeConversations(page, [{ title: 'Pelican chat' }, { title: 'Big Sur', start: '2099-03-03', end: '2099-03-05' }]);
  for (const [id, title, line] of /** @type {const} */ ([
    [chat, 'Pelican chat', "Details: the chat's name and dates, Export, Archive and Remove."],
    [trip, 'Big Sur', "Details: the trip's name and dates, Export, Archive and Remove."],
  ])) {
    await goToHash(page, `#/trip/${id}/talk`);
    const toggle = page.getByRole('button', { name: 'Conversation menu', exact: true });
    await expect(toggle).toHaveText('⋯');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('group', { name: 'Conversation menu' });
    await expect(menu.locator('a.btn, button.btn')).toHaveText(['Details', 'Summarize now', 'Start fresh', 'What each half sees']);
    const details = menu.getByRole('link', { name: 'Details', exact: true });
    await expect(details).toHaveAttribute('href', `#/trip/${encodeURIComponent(id)}`);
    await expect(details).toHaveAccessibleDescription(line);
    await expect(page.getByRole('link', { name: title })).toHaveAttribute('href', `#/trip/${encodeURIComponent(id)}`); // the name still goes there
    await details.click();
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${encodeURIComponent(id)}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove trip' })).toBeAttached();
  }
});

test('a conversation with no trip open has the menu without Details: it has none', async ({ page }) => {
  await openApp(page, '#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  const menu = page.getByRole('group', { name: 'Conversation menu' });
  await expect(menu.locator('a.btn, button.btn')).toHaveText(['Summarize now', 'Start fresh', 'What each half sees']);
});

test('the line under Details follows the dates the conversation gets while it shows: chat, then trip', async ({ page }) => {
  await openApp(page);
  const [id] = await makeConversations(page, [{ title: 'Pelican chat' }]);
  // The page's own workspace, caught as the conversation listens to it: a write from it is announced as Shiori's patch is (another connection's is not).
  await page.evaluate(async () => {
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const was = Workspace.prototype.onChange;
    Workspace.prototype.onChange = function (/** @type {any} */ fn) {
      /** @type {any} */ (window).appWs = this;
      return was.call(this, fn);
    };
  });
  await goToHash(page, `#/trip/${id}/talk`);
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  const details = page.getByRole('group', { name: 'Conversation menu' }).getByRole('link', { name: 'Details', exact: true });
  await expect(details).toHaveAccessibleDescription("Details: the chat's name and dates, Export, Archive and Remove.");
  await page.evaluate((id) => /** @type {any} */ (window).appWs.patch(id, '/trip.json', { start: '2099-03-03', end: '2099-03-05' }, { author: 'shiori' }), id);
  await expect(details).toHaveAccessibleDescription("Details: the trip's name and dates, Export, Archive and Remove.");
});

// "(including deleting a misc one)": a chat is taken off the phone from its own conversation, by its Details.
test('removing a chat end to end at 360x640: home, tap the chat, ⋯, Details, scroll to Remove, confirm: back on home without it, the other chat still there', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  await startTrip(page, 'Misc chat');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await startTrip(page, 'Keep this chat');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  const rows = page.locator('.timeline .rows');
  await expect(rows.getByRole('link', { name: /Misc chat/ })).toBeVisible();
  await rows.getByRole('link', { name: /Misc chat/ }).click();
  await expect(page.locator('.talk-head .talk-name')).toHaveText('Misc chat');
  await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
  await page.getByRole('group', { name: 'Conversation menu' }).getByRole('link', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Misc chat' })).toBeVisible();
  // Remove is below the name and dates and the other buttons: one scroll, as a person makes it, and then nothing covers it.
  const remove = page.getByRole('button', { name: 'Remove trip' });
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeInViewport({ ratio: 1 });
  expect(await remove.evaluate((el) => {
    const b = el.getBoundingClientRect();
    const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
    const over = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return (over === el || el.contains(over)) && b.bottom <= dock.top;
  })).toBe(true);
  await remove.click();
  await page.getByRole('dialog', { name: 'Misc chat' }).getByRole('button', { name: 'Remove' }).click();
  // One question, and it was the only one: the chat is gone and home is back (spec §4.9).
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe('#/trips');
  await expect(rows.getByRole('link', { name: /Keep this chat/ })).toBeVisible();
  await expect(rows.getByRole('link', { name: /Misc chat/ })).toHaveCount(0);
});

/**
 * What is wrong with the first control (Details) of the open menu, as it is, with the menu not scrolled by this check: it must be whole inside the menu's own box, above the dock,
 * on screen, and what a tap at its centre lands on. @param {import('@playwright/test').Page} page @returns {Promise<string[]>}
 */
async function detailsProblems(page) {
  const at = await page.locator('.tidy-menu').locator('a.btn, button.btn').first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    const menu = /** @type {HTMLElement} */ (el.closest('.tidy-menu'));
    const m = menu.getBoundingClientRect();
    const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
    const over = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return {
      first: el.getAttribute('href') === `#/trip/${new URL(location.href).hash.split('/')[2]}`,
      hit: over === el || el.contains(over),
      inside: b.top >= m.top - 1 && b.bottom <= m.bottom + 1,
      aboveDock: m.bottom <= dock.top + 1 && b.bottom <= dock.top + 1,
      onScreen: b.top >= 0 && b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
    };
  });
  return Object.entries(at).filter(([, ok]) => !ok).map(([what]) => `Details: not ${what}`);
}

// A reopened menu is at its top: Details, the first entry, is in view whatever the user scrolled to inside it before. (The review of details-menu, finding 1: both
// engines keep a scroll box's scrollTop across hidden.) At 360x640 with a short conversation the menu has less room than its four entries, so it scrolls inside.
test('a menu that scrolls inside opens at its top each time: scrolled to its end, closed and opened again, Details is in view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  const [id] = await makeConversations(page, [{ title: 'Pelican chat', lines: 1 }]);
  await goToHash(page, `#/trip/${id}/talk`);
  const toggle = page.locator('.talk-head .tidy-toggle');
  const menu = page.locator('.tidy-menu');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true); // it is shorter than its entries
  await menu.evaluate((el) => { el.scrollTop = el.scrollHeight; }); // as a finger takes it to What each half sees
  expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await toggle.click();
  await expect(menu).toBeHidden();
  await toggle.click();
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await detailsProblems(page)).toEqual([]);
});

// The menu's clean-up used to watch the ⋯'s own parent, whose child list never changes when the shell replaces the whole screen, so it never ran: each visit
// to a conversation left the menu's scroll, resize, keydown and tap listeners on window and document, each holding the old screen (the review of details-menu,
// finding 2). Now the screen's own clean-up takes them off. Every listener added to window or document is counted as it is added and taken off.
test('visiting a conversation leaves no listener on window or document once it is replaced', async ({ page }) => {
  await page.addInitScript(() => {
    /** @type {{ on: EventTarget, type: string, fn: unknown, capture: boolean }[]} */
    const live = [];
    const capture = (/** @type {any} */ o) => typeof o === 'boolean' ? o : Boolean(o?.capture);
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const same = (/** @type {any} */ e, /** @type {any} */ on, /** @type {any} */ type, /** @type {any} */ fn, /** @type {any} */ o) => e.on === on && e.type === type && e.fn === fn && e.capture === capture(o);
    EventTarget.prototype.addEventListener = function (type, fn, o) {
      if ((this === window || this === document) && fn && !live.some((e) => same(e, this, type, fn, o))) live.push({ on: this, type, fn, capture: capture(o) });
      return add.call(this, type, fn, o);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, o) {
      const i = live.findIndex((e) => same(e, this, type, fn, o));
      if (i >= 0) live.splice(i, 1);
      return remove.call(this, type, fn, o);
    };
    /** What is on window and document now, by kind: how many of each. */
    Object.defineProperty(window, 'liveListeners', { value: () => {
      /** @type {Record<string, number>} */
      const out = {};
      for (const e of live) out[`${e.on === window ? 'window' : 'document'} ${e.type}${e.capture ? ' (capture)' : ''}`] = (out[`${e.on === window ? 'window' : 'document'} ${e.type}${e.capture ? ' (capture)' : ''}`] ?? 0) + 1;
      return out;
    } });
  });
  await openApp(page);
  const [id] = await makeConversations(page, [{ title: 'Pelican chat', lines: 2 }]);
  const visit = async () => {
    await goToHash(page, `#/trip/${id}/talk`);
    await expect(page.locator('.talk-head .tidy-toggle')).toBeVisible();
    await page.locator('.talk-head .tidy-toggle').click(); // open, so what its fit would run on is live
    await expect(page.locator('.tidy-menu')).toBeVisible();
    await goToHash(page, '#/trips');
    await expect(page.locator('.talk-head')).toHaveCount(0);
  };
  // Once to see what the app keeps for good (a listener of the shell's, added on a first visit); then what each further visit leaves.
  await visit();
  await page.waitForTimeout(300); // a screen's clean-up runs a frame after it is replaced
  const kept = await page.evaluate(() => /** @type {any} */ (window).liveListeners());
  for (let i = 0; i < 3; i++) await visit();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).liveListeners())).toEqual(kept);
});

/** How far above the dock the open menu ends (px, rounded): the menu keeps 16 px from it, whatever it holds. @param {import('@playwright/test').Page} page */
const gapAboveDock = (page) => page.evaluate(() => {
  const m = /** @type {HTMLElement} */ (document.querySelector('.tidy-menu')).getBoundingClientRect();
  const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect();
  return Math.round(dock.top - m.bottom);
});

// The menu's height was measured as it opened and on a scroll or a resize, so what moved the ⋯ or the dock with neither left it as it was, under the dock (the review
// of details-menu, finding 3): (a) a card that lands above a short conversation, at the top of its page, (b) a dock that grows or shrinks (voice on, her words in a
// bubble, a plugin's dock), (c) a phone turned back upright, where the shell's observers update the dock's and the bar's heights a frame after the resize.
test.describe('the open menu is measured again when what is under or above it moves, and stays 16 px above the dock', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await openApp(page);
    const [id] = await makeConversations(page, [{ title: 'Pelican chat', lines: 1 }]);
    await goToHash(page, `#/trip/${id}/talk`);
    await expect(page.locator('.talk-head .tidy-toggle')).toBeVisible();
    await page.evaluate(() => scrollTo(0, 0)); // a short conversation at the top of its page: the ⋯ sits as low as what is above it leaves it
    await page.locator('.talk-head .tidy-toggle').click();
    await expect(page.locator('.tidy-menu')).toBeVisible();
    expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  });

  test('(a) a card lands above the conversation while the menu is open, and no scroll or resize comes', async ({ page }) => {
    const y = await page.evaluate(() => scrollY);
    await page.evaluate(() => {
      const card = document.createElement('div');
      card.className = 'notice';
      card.style.cssText = 'min-height: 60px; width: 100%; border: 1px solid #888';
      document.querySelector('.notices')?.append(card); // as a card does: the box grows, and the page under it moves down
    });
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    expect(await page.evaluate(() => scrollY)).toBe(y); // nothing moved the page
  });

  /** A bubble over the dock's controls, as her words in one (or a voice's meter) are: the dock's own content grows, and the shell's observer sets --dock-h from its size. @param {import('@playwright/test').Page} page @param {number | null} px */
  const bubble = (page, px) => page.evaluate((px) => {
    document.querySelector('#test-bubble')?.remove();
    if (px === null) return;
    const el = document.createElement('div');
    el.id = 'test-bubble';
    el.style.height = `${px}px`;
    /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).prepend(el);
  }, px);

  test('(b) the dock grows and shrinks while the menu is open', async ({ page }) => {
    const y = await page.evaluate(() => scrollY);
    await bubble(page, 48);
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await bubble(page, 12);
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await bubble(page, null);
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    expect(await page.evaluate(() => scrollY)).toBe(y); // nothing moved the page
  });

  // A menu that has more than its room holds scrolls inside, and scrolled to its end it would shift under a finger when it grew: the finger would be on another entry.
  test('(d) a finger already down on the menu keeps it as it is: it takes the room the dock gave up once the finger is up', async ({ page }) => {
    const menu = page.locator('.tidy-menu');
    await bubble(page, 48);
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await menu.evaluate((el) => { el.scrollTop = el.scrollHeight; }); // at its end, as a finger leaves it on What each half sees
    const shown = () => menu.evaluate((el) => ({ height: Math.round(el.getBoundingClientRect().height), scrolled: Math.round(el.scrollTop) }));
    const held = await shown();
    expect(held.scrolled).toBeGreaterThan(0);
    // A finger's touch events, as the engine sends them to the menu: `touches` is what is on the screen now. (WebKit's build here cannot construct a Touch.)
    /** @param {'touchstart' | 'touchend'} type */
    const finger = (type) => menu.evaluate((el, type) => {
      const on = /** @type {HTMLElement} */ (el.querySelector('a.btn:last-of-type'));
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [{ identifier: 7, target: on }] : [] });
      on.dispatchEvent(event);
    }, type);
    await finger('touchstart');
    await bubble(page, null); // the dock is 48 px shorter: the menu has 48 px more room
    await page.waitForTimeout(400);
    expect(await shown()).toEqual(held); // not a pixel of it moved under the finger
    await finger('touchend');
    await expect.poll(async () => (await shown()).height).toBeGreaterThan(held.height + 40);
    expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  });

  // The shell sets --dock-h and --topbar-h from observers, which run after the frame's resize event: a menu measured by that event read last frame's heights.
  test('(c) the dock grows in the frame a resize comes in, which is before the shell has updated --dock-h', async ({ page }) => {
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.height = '48px';
      /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).prepend(el);
      dispatchEvent(new Event('resize'));
    });
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await page.waitForTimeout(300); // and it stays so
    expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  });

  test('(c) the phone is turned on its side and back upright with the menu open', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 360 });
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await page.setViewportSize({ width: 360, height: 640 });
    await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
    await page.waitForTimeout(500); // and it stays so: not right for a frame only
    expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  });
});

// The bar's height is --topbar-h, which the stuck head sits under: a taller bar (the phone upright, the status bar's room) moves the ⋯ down with no scroll.
test('(c) the bar grows while the head is stuck under it and the menu is open: the menu still ends 16 px above the dock', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  const [id] = await makeConversations(page, [{ title: 'Pelican chat', lines: 12 }]);
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.locator('.talk-head .tidy-toggle')).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300); // opened at the end of the conversation: the head is stuck under the bar
  await page.locator('.talk-head .tidy-toggle').click();
  await expect(page.locator('.tidy-menu')).toBeVisible();
  expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  await page.evaluate(() => {
    // The page may scroll itself as the bar grows (it follows the end of the conversation); that scroll is not what this checks: none reaches the menu.
    addEventListener('scroll', (e) => e.stopImmediatePropagation(), true);
    /** @type {HTMLElement} */ (document.querySelector('header.topbar')).style.minHeight = '104px'; // 48 px taller: its content grows, which the shell's observer sees
    dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => page.evaluate(() => Math.round(/** @type {HTMLElement} */ (document.querySelector('.talk-head')).getBoundingClientRect().top - /** @type {HTMLElement} */ (document.querySelector('header.topbar')).getBoundingClientRect().bottom))).toBeLessThanOrEqual(1); // the head followed the bar down
  await expect.poll(() => gapAboveDock(page)).toBeGreaterThanOrEqual(15);
  await page.waitForTimeout(300);
  expect(await gapAboveDock(page)).toBeGreaterThanOrEqual(15);
});

// With the ⋯ as low as it can be tapped (a card and the install banner above a short conversation, or a phone on its side), the room under it, less the dock,
// is less than Details needs: the menu opened with no room at all, or with Details cut off. The page now lifts the ⋯ as far as Details needs as the menu
// opens (a scroll of the page by the missing px, once, before it is drawn), so Details is in view and can be tapped. Measured with the banner shown (a browser
// tab), the room is 1 px or none in Chromium and WebKit at 667x375, 844x390, 740x360 and 932x430, and at 320x568 and 360x640 with one or two cards.
/** Takes the ⋯ to 4 px above the dock's top, where it can still be tapped: by scrolling the page, or, where it is higher than that at the page's top, by room above it (what a card or an open install banner leaves). @param {import('@playwright/test').Page} page */
async function lowerToggle(page) {
  await page.evaluate(() => scrollTo(0, 0));
  const to = await page.evaluate(() => {
    const toggle = /** @type {HTMLElement} */ (document.querySelector('.talk-head .tidy-toggle'));
    const dock = /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)'));
    return dock.getBoundingClientRect().top - 4 - toggle.getBoundingClientRect().bottom;
  });
  if (to > 0) await page.evaluate((px) => {
    const room = document.createElement('div');
    room.style.height = `${px}px`;
    document.querySelector('header.topbar')?.after(room);
  }, to);
  else await page.evaluate((px) => scrollBy(0, px), -to);
  const gap = await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.dock:not(.seat)')).getBoundingClientRect().top - /** @type {HTMLElement} */ (document.querySelector('.talk-head .tidy-toggle')).getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThan(0); // set up: tappable, as low as that
  expect(gap).toBeLessThan(8);
}

for (const [width, height] of /** @type {const} */ ([[320, 568], [667, 375], [844, 390]])) {
  for (const lang of LANGS) {
    test(`the ⋯ as low as it can be tapped: the menu opens with Details in view, above the dock, once the page has lifted it, at ${width}x${height} in ${lang.tag}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (lang.tag === 'ja') await page.addInitScript(() => { try { localStorage.setItem('annai.ui', 'ja'); } catch { /* storage blocked */ } });
      await openApp(page, lang.start);
      const [id] = await makeConversations(page, [{ title: lang.names[0], lines: 1 }]);
      await goToHash(page, `#/trip/${id}/talk`);
      await expect(page.locator('.talk-head .tidy-toggle')).toBeVisible();
      await page.waitForTimeout(500); // the screen is at rest (it scrolls itself to the end of a conversation as it opens)
      await lowerToggle(page);
      await page.locator('.talk-head .tidy-toggle').click();
      await expect(page.locator('.tidy-menu')).toBeVisible();
      expect(await detailsProblems(page)).toEqual([]);
      const opened = await page.evaluate(() => scrollY);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => scrollY)).toBe(opened); // the lift is once, as it opens: nothing moves the page after
      expect(await detailsProblems(page)).toEqual([]);
    });
  }
}

test('a menu that has the room it needs opens without moving the page', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp(page);
  const [id] = await makeConversations(page, [{ title: 'Pelican chat', lines: 1 }]);
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.locator('.talk-head .tidy-toggle')).toBeVisible();
  await page.waitForTimeout(500);
  await page.evaluate(() => scrollTo(0, 0));
  await page.locator('.talk-head .tidy-toggle').click();
  await expect(page.locator('.tidy-menu')).toBeVisible();
  expect(await detailsProblems(page)).toEqual([]);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});
