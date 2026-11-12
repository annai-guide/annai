import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addProvider, anthropicToolReply, startTrip, writeRecords, writeEvent, goToHash } from './helpers.js';

// "do you think we should have some way to let the user compact or clear the transcript / session manually?" (the user, 2026-10-23):
// a menu on the Conversation screen, Summarize now and Start fresh (spec §6.5, §16.2).
const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const speak = (/** @type {string} */ text) => sse(anthropicToolReply([{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }]));

/** A trip, and Shiori's main model on a stand-in Anthropic endpoint. @param {import('@playwright/test').Page} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  await page.getByLabel('Trip name').fill('Big Sur');
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
}

/** Types one message and waits for her answer to it. @param {import('@playwright/test').Page} page @param {string} text @param {number} n her lines so far, after this one */
async function say(page, text, n) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  await expect(page.locator('.convo .shiori p')).toHaveCount(n, { timeout: 20_000 });
  await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
}

test('the Conversation has a menu with Summarize now and Start fresh; Start fresh asks first, and leaves a divider with every earlier line still there and out of her next request', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('Pelicans nest on the cliffs.'), speak('A fresh answer.')] });
  try {
    await setUp(page, llm.origin);
    await say(page, 'Tell me about pelicans', 1);
    const toggle = page.getByRole('button', { name: 'Conversation menu', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('group', { name: 'Conversation menu' });
    await expect(menu.getByRole('button')).toHaveText(['Summarize now', 'Start fresh']);
    // Cancel changes nothing.
    await menu.getByRole('button', { name: 'Start fresh' }).click();
    const dialog = page.getByRole('dialog', { name: 'Start fresh?' });
    await expect(dialog).toContainText('nothing is deleted');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.convo .fresh-divider')).toHaveCount(0);
    // Confirmed: the divider, and the earlier lines still in the conversation.
    await toggle.click();
    await menu.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('dialog', { name: 'Start fresh?' }).getByRole('button', { name: 'Start fresh' }).click();
    await expect(page.locator('.convo .fresh-divider')).toHaveText('Started fresh');
    await expect(page.locator('.convo .you p').first()).toHaveText('Tell me about pelicans');
    await expect(page.locator('.convo .shiori p').first()).toContainText('Pelicans nest on the cliffs.');
    // Her next request holds none of the earlier lines.
    await say(page, 'And the weather?', 2);
    const sent = JSON.stringify(llm.bodies('/b/v1/messages').at(-1).messages);
    expect(sent).toContain('And the weather?');
    expect(sent).not.toContain('pelicans');
    expect(sent).not.toContain('Pelicans nest');
    // The divider stays between the old lines and the new, and is still there on a reload.
    await page.reload();
    await expect(page.locator('.convo .fresh-divider')).toHaveText('Started fresh');
    await expect(page.locator('.convo .you:not(.quiet) p')).toHaveText(['Tell me about pelicans', 'And the weather?']);
  } finally {
    await llm.stop();
  }
});

test('Summarize now: with too little said it says so; after a few exchanges it summarizes, keeping only the last exchange word for word, and the lines stay in the conversation', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('One.'), speak('Two.'), speak('Three.'), speak('Four.'), sse(anthropicToolReply([], 'They talked about numbers.')), speak('Five.')] });
  try {
    await setUp(page, llm.origin);
    await say(page, 'First', 1);
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('button', { name: 'Summarize now' }).click();
    await expect(page.getByText('There is not enough yet to summarize.')).toBeVisible();
    await say(page, 'Second', 2);
    await say(page, 'Third', 3);
    await say(page, 'Fourth', 4);
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('button', { name: 'Summarize now' }).click();
    await expect(page.locator('.convo .system-line', { hasText: 'Earlier conversation summarized.' })).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.convo .you:not(.quiet) p')).toHaveText(['First', 'Second', 'Third', 'Fourth']);
    await expect(page.locator('.convo .fresh-divider')).toHaveCount(0);
    // Her next request: the summary, then only the last exchange word for word (spec §6.5).
    await say(page, 'Fifth', 5);
    const sent = JSON.stringify(llm.bodies('/b/v1/messages').at(-1).messages);
    expect(sent).toContain('They talked about numbers.');
    for (const gone of ['Second', 'Third', 'Two.', 'Three.']) expect(sent).not.toContain(gone);
    for (const kept of ['Fourth', 'Four.', 'Fifth']) expect(sent).toContain(kept);
  } finally {
    await llm.stop();
  }
});

// Fix pass 2, items 5, 7 and 8, and the menu's nits: the disclosure pattern, each action tied to what it does, focus kept, the divider named.
test('the conversation menu (⋯) is a disclosure whose buttons say what they do; Start fresh says it is working, keeps the focus on the ⋯ when cancelled or done, and its divider is a list item that reads "Started fresh"', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [speak('Pelicans nest on the cliffs.')] });
  try {
    await setUp(page, llm.origin);
    await say(page, 'Tell me about pelicans', 1);
    const toggle = page.getByRole('button', { name: 'Conversation menu', exact: true });
    expect(await toggle.getAttribute('aria-haspopup')).toBeNull();
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Summarize now' })).toHaveAccessibleDescription(/sums up/);
    await expect(page.getByRole('button', { name: 'Start fresh' })).toHaveAccessibleDescription(/divider/);
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('dialog', { name: 'Start fresh?' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toggle).toBeFocused();
    // Its busy state, as it runs, whatever the speed.
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.busy = [];
      new MutationObserver(() => { const t = document.querySelector('.tidy-toggle'); const s = /** @type {HTMLElement | null} */ (document.querySelector('.tidy-status')); if (t?.getAttribute('aria-busy') === 'true') w.busy.push(t.getAttribute('aria-label'), s && !s.hidden ? s.textContent : 'no visible line'); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['aria-busy'] });
    });
    await toggle.click();
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('dialog', { name: 'Start fresh?' }).getByRole('button', { name: 'Start fresh' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Started fresh' })).toHaveCount(1);
    await expect(page.getByRole('separator')).toHaveCount(0);
    expect(await page.evaluate(() => /** @type {any} */ (window).busy)).toEqual(['Starting fresh…', 'Starting fresh…']);
    await expect(page.getByRole('button', { name: 'Conversation menu', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Conversation menu', exact: true })).not.toHaveAttribute('aria-busy', 'true');
    // Again at once: nothing has been said since, which it says, rather than that there is nothing at all.
    await page.getByRole('button', { name: 'Conversation menu', exact: true }).click();
    await page.getByRole('button', { name: 'Start fresh' }).click();
    await page.getByRole('dialog', { name: 'Start fresh?' }).getByRole('button', { name: 'Start fresh' }).click();
    await expect(page.getByText('Already fresh: nothing has been said since.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conversation menu', exact: true })).toBeFocused();
  } finally {
    await llm.stop();
  }
});

test('the menu closes on Escape and on a tap elsewhere', async ({ page }) => {
  await openApp(page, '#/talk');
  await expect(page.getByRole('heading', { name: 'Conversation' })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Conversation menu', exact: true });
  const menu = page.getByRole('group', { name: 'Conversation menu' });
  await toggle.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await toggle.click();
  await page.locator('main').click({ position: { x: 5, y: 300 }, force: true });
  await expect(menu).toBeHidden();
  // At the click, never at the press: nothing moves under a finger still down (as the dock's box, fix pass 2).
  await toggle.click();
  const at = /** @type {{ x: number, y: number }} */ (await page.getByRole('heading', { name: 'Conversation' }).boundingBox());
  await page.mouse.move(at.x + 5, at.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await expect(menu).toBeVisible();
  await page.mouse.up();
  await expect(menu).toBeHidden();
  // A press that brings no click (iOS, on plain content) closes it a moment after it ends (fix pass 3).
  await toggle.click();
  await page.evaluate(() => {
    const el = /** @type {HTMLElement} */ (document.querySelector('main h1'));
    for (const type of ['pointerdown', 'pointerup']) el.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, pointerType: 'touch' }));
  });
  await expect(menu).toBeHidden({ timeout: 2000 });
});

// Timeline stage 3: the conversation's header, sticky (←, the name, ⋯), and the Next line.
test('the header: ← goes home, the name goes to Details, the ⋯ is there', async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.getByRole('heading', { level: 1, name: 'Conversation' })).toBeVisible(); // hidden, for stage 8
  const head = page.locator('.talk-head');
  await expect(head.getByRole('button', { name: 'Conversation menu', exact: true })).toBeVisible();
  await head.getByRole('link', { name: 'Big Sur' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}`);
  await page.goBack();
  await head.getByRole('link', { name: 'Back to Trips' }).click();
  await expect.poll(() => new URL(page.url()).hash).toBe('#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
});

test('a trip with plan rows shows "Next: 13:00 Lunch", which opens the Itinerary; none, no line', async ({ page }) => {
  await openApp(page);
  const none = await startTrip(page, 'Nothing planned');
  await goToHash(page, `#/trip/${none}/talk`);
  await expect(page.locator('.talk-head')).toBeVisible();
  await expect(page.locator('.next-line')).toHaveCount(0);
  await page.getByRole('link', { name: 'Trips', exact: true }).first().click();
  const id = await startTrip(page, 'Big Sur');
  await writeRecords(page, id, { write: {
    '/plan/lunch.json': { id: 'lunch', title: 'Lunch', fixed: true, start: { at: '2099-03-03T13:00:00Z', tz: 'UTC' } },
    '/plan/dinner.json': { id: 'dinner', title: 'Dinner', fixed: true, start: { at: '2099-03-03T19:00:00Z', tz: 'UTC' } },
    '/plan/gone.json': { id: 'gone', title: 'Breakfast long ago', fixed: true, start: { at: '2020-03-03T08:00:00Z', tz: 'UTC' } },
  } });
  await goToHash(page, `#/trip/${id}/talk`);
  const next = page.locator('.next-line').getByRole('link');
  await expect(next).toHaveText('Next: Tue, Mar 3 13:00 Lunch'); // not today: its day too
  await next.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/trip/${id}/plan`);
  // Today's says only its time.
  const soon = new Date(Date.now() + 90 * 60_000);
  const hm = soon.toISOString().slice(11, 16);
  await writeRecords(page, id, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea', fixed: true, start: { at: soon.toISOString().replace(/\.\d+Z$/, 'Z'), tz: 'UTC' } } } });
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(next).toHaveText(new RegExp(`^Next: (\\w+, \\w+ \\d+ )?${hm} Tea$`)); // a day only when UTC's date isn't the phone's
});

test('the header stays in view as the conversation scrolls', async ({ page }) => {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  for (let i = 0; i < 40; i++) await writeEvent(page, id, { type: 'out.speak', data: { id: `s${i}`, text: `Line ${i} of a long conversation, long enough to fill the screen.` } });
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.locator('.convo > li')).toHaveCount(40);
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(400);
  const head = page.locator('.talk-head');
  await expect(head.getByRole('link', { name: 'Back to Trips' })).toBeInViewport();
  const top = await head.evaluate((el) => el.getBoundingClientRect().top);
  const bar = await page.locator('header.topbar').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(Math.abs(top - bar)).toBeLessThanOrEqual(2);
});

/**
 * A conversation of three lines, with a plan item Tea, opened and scrolled to the top, where the page stays: a wheel turn (as the user's) stops
 * the conversation following its last line down. At the bottom a shrinking page only clamps the scroll, and nothing would show.
 * @param {import('@playwright/test').Page} page @param {(now: number) => { start: string, end: string }} tea its times, from the page's clock
 * @returns {Promise<() => Promise<number>>} where the conversation's first line is now, from the top of the page
 */
async function conversationWithTea(page, tea) {
  await openApp(page);
  const id = await startTrip(page, 'Big Sur');
  for (let i = 0; i < 3; i++) await writeEvent(page, id, { type: 'out.speak', data: { id: `s${i}`, text: `Line ${i}.` } });
  const { start, end } = tea(await page.evaluate(() => Date.now()));
  await writeRecords(page, id, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea', fixed: true, start: { at: start, tz: 'UTC' }, end: { at: end, tz: 'UTC' } } } });
  await goToHash(page, `#/trip/${id}/talk`);
  await expect(page.locator('.next-line a')).toHaveText(/^Next: (\w+, \w+ \d+ )?\d\d:\d\d Tea$/); // a day only when UTC's date isn't the phone's
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { // after it first goes to the end
    dispatchEvent(new Event('wheel'));
    scrollTo(0, 0);
    done(undefined);
  }))));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  return () => page.locator('.convo > li').first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
}

const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

// The test sets the page's clock, never the day's: an item ending after midnight (in its zone) is two rows, the first of which outlasts a short
// item (the next test), so with the real clock this one failed in CI whenever it ran in the ten minutes after midnight UTC (2026-11-12, 00:09).
test("the Next line keeps its place when the trip's last row ends, so the conversation doesn't move", async ({ page }) => {
  await page.clock.install({ time: new Date('2030-11-27T12:00:00Z') });
  // Ends in 8 s: room to measure first, even on a cold start.
  const top = await conversationWithTea(page, (now) => ({ start: iso(now - 10 * 60_000), end: iso(now + 8_000) }));
  const was = await top();
  await expect(page.locator('.next-line a')).toBeVisible(); // measured before the row ended
  await expect(page.locator('.next-line a')).toBeHidden({ timeout: 15_000 }); // over: the line says nothing
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await top()).toBe(was);
});

test('an item that ends after midnight is on the Next line from its start, and the line keeps its place when it is over', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-11-28T00:05:00Z') });
  // Tea from 23:55 to 00:09: two rows, its start (which lasts half an hour, as any row with no end) and its end, a row of its own.
  const top = await conversationWithTea(page, () => ({ start: '2030-11-27T23:55:00Z', end: '2030-11-28T00:09:00Z' }));
  await expect(page.locator('.next-line a')).toHaveText(/^Next: (\w+, \w+ \d+ )?23:55 Tea$/);
  const was = await top();
  await page.clock.fastForward('01:00:00'); // an hour on: both rows are over
  await expect(page.locator('.next-line a')).toBeHidden();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(await top()).toBe(was);
});
