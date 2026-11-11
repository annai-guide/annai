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
