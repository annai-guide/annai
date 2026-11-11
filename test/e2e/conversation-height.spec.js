import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp, startTrip, writeRecords, goToHash, modelSetUp, startModelServer, anthropicToolReply } from './helpers.js';

// A line that records what happened ("Shiori set the dates", the hand-over's Undo line) keeps one height in every state: with its Undo
// button (44 px) and without it, so the lines above it don't move under the user's finger when it changes. Nothing keeps the page's place
// itself (overflow-anchor is off), so what moves is measured on the screen: a line above, in the viewport, before and after.
test.use({ viewport: { width: 360, height: 640 } });

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const START = '2031-05-10';
const END = '2031-05-12';
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');

/**
 * n lines of hers in a conversation's log: nothing in them is owed an answer, so a reload wakes no turn.
 * @param {import('@playwright/test').Page} page @param {string} scope @param {string} tag @param {number} n
 */
async function lines(page, scope, tag, n) {
  await page.evaluate(async ({ scope, tag, n }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    for (let i = 0; i < n; i++) await logEvent(store, scope, { type: 'out.speak', actor: 'shiori', data: { id: `${tag}-${i}`, text: `${tag} ${i}` } });
    store.close();
  }, { scope, tag, n });
}

/** Where a line is on the screen (px from the viewport's top), as the user sees it: the line n places from the record line, above (-1) or below. @param {import('@playwright/test').Page} page @param {string} line its selector @param {number} n */
const where = (page, line, n) => page.evaluate(([line, n]) => {
  let el = document.querySelector(/** @type {string} */ (line));
  for (let i = 0; i < Math.abs(/** @type {number} */ (n)); i++) el = el ? (/** @type {number} */ (n) < 0 ? el.previousElementSibling : el.nextElementSibling) : null;
  return el ? Math.round(el.getBoundingClientRect().top * 10) / 10 : null;
}, /** @type {[string, number]} */ ([line, n]));

/** Waits until a value stops changing: a redraw has settled. @param {() => Promise<unknown>} read */
async function settled(read) {
  let last = await read();
  await expect.poll(async () => { const now = await read(); const same = JSON.stringify(now) === JSON.stringify(last); last = now; return same; }, { intervals: [150], timeout: 10_000 }).toBe(true);
}

test('Shiori set the dates keeps its height with and without its Undo: a tap on Undo at the end of a long conversation moves nothing above it', async ({ page }) => {
  await openApp(page, '#/trips');
  const id = await startTrip(page, 'Testville');
  await lines(page, id, 'Earlier', 20);
  await writeRecords(page, id, { patch: { '/trip.json': { start: START, end: END } }, author: 'shiori' });
  await goToHash(page, `#/trip/${id}/talk`);
  await page.reload();
  const line = page.locator('.dates-line');
  await expect(line.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.locator('.convo > li')).toHaveCount(21);
  // The page is longer than the screen, and at its end.
  await expect.poll(() => page.evaluate(() => [document.documentElement.scrollHeight > 2 * innerHeight, innerHeight + scrollY >= document.documentElement.scrollHeight - 1])).toEqual([true, true]);
  await settled(() => where(page, '.dates-line', -1));
  const before = await where(page, '.dates-line', -1);
  await line.getByRole('button', { name: 'Undo' }).click();
  await expect(line).toHaveText('Shiori set the dates Undone');
  await settled(() => where(page, '.dates-line', -1));
  expect(await where(page, '.dates-line', -1)).toBe(before);
});

test('Shiori set the dates keeps its height when she changes the dates she set while the user is reading above it: the lines in view stay where they are', async ({ page }) => {
  await openApp(page, '#/trips');
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const patch = (/** @type {Record<string, unknown>} */ changes, /** @type {Promise<unknown> | undefined} */ until = undefined) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes } }]), until });
  const speak = (/** @type {string} */ text) => ({ status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }]) });
  const llm = await startModelServer({ '/b/v1/messages': [
    patch({ title: 'Testville', start: START, end: END }), speak('I set it for the 10th to the 12th.'),
    speak('Dinner is at seven.'),
    patch({ start: '2031-05-11', end: '2031-05-13' }, gate), speak('Moved to the 11th.'), // the third turn's change waits for the test
  ] });
  const say = async (/** @type {string} */ text) => {
    await box(page).isVisible() || await page.getByRole('button', { name: 'Type', exact: true }).click();
    await box(page).fill(text);
    await box(page).press('Enter');
  };
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await say('Plan our weekend in Testville');
    const line = page.locator('.dates-line');
    await expect(line.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(page.locator('.convo')).toContainText('I set it for the 10th to the 12th.');
    await say('And dinner?');
    await expect(page.locator('.convo')).toContainText('Dinner is at seven.');
    await lines(page, id, 'Later', 14); // after her turn: the conversation is long below the record line
    await page.reload();
    await expect(page.locator('.convo')).toContainText('Later 13');
    await expect(line.getByRole('button', { name: 'Undo' })).toBeVisible();
    await say('Make it the 11th to the 13th.'); // she is asked for a change, and the model waits
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(4);
    await expect(page.locator('.convo .you').last()).toContainText('Make it the 11th to the 13th.');
    await expect.poll(() => page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 1)).toBe(true);
    await settled(() => page.evaluate(() => [scrollY, document.documentElement.scrollHeight]));
    // The user scrolls up (a touch drag stops the conversation following its end) to just below the record line, which is above the screen.
    await page.evaluate(() => {
      dispatchEvent(new Event('touchmove'));
      const at = /** @type {HTMLElement} */ (document.querySelector('.dates-line')).getBoundingClientRect();
      scrollTo(0, scrollY + at.bottom + 20);
    });
    await expect.poll(() => page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.dates-line')).getBoundingClientRect().bottom < 0)).toBe(true);
    await settled(() => where(page, '.dates-line', 2));
    const before = await where(page, '.dates-line', 2);
    expect(before).toBeGreaterThan(0);
    release(); // her change of the dates she set
    await expect(line.getByRole('button')).toHaveCount(0);
    await expect(line).toHaveText('Shiori set the dates');
    await expect(page.locator('.convo')).toContainText('Moved to the 11th.');
    await settled(() => where(page, '.dates-line', 2));
    expect(await where(page, '.dates-line', 2)).toBe(before);
  } finally {
    release();
    await llm.stop();
  }
});

test("the hand-over's Undo line keeps its height with and without its Undo: a tap on Undo at the end of a long conversation moves nothing above it", async ({ page }) => {
  const flight = { name: 'flight.pdf', mimeType: 'application/pdf', buffer: await readFile(new URL('../fixtures/bookings/flight.pdf', import.meta.url)) };
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'list_trips', input: {} }])),
    (/** @type {any} */ body) => sse(anthropicToolReply([{ name: 'move_file', input: { path: '/trip/files/flight.pdf', trip: /(trip-[a-z0-9]+)\\tKyoto/.exec(JSON.stringify(body ?? {}))?.[1] ?? 'none' } }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'That one is for Kyoto: I moved it there.' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const bigSur = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.goto('/#/trips');
    await startTrip(page, 'Kyoto');
    await lines(page, bigSur, 'Earlier', 20);
    await goToHash(page, `#/trip/${bigSur}/talk`);
    await page.reload();
    await expect(page.locator('.convo > li')).toHaveCount(20);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Give Shiori photos or files').setInputFiles([flight]);
    await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(1);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('That one is for Kyoto: I moved it there.')).toBeVisible({ timeout: 60_000 });
    const undo = page.getByRole('button', { name: 'Undo what Shiori did with these files' });
    await expect(undo).toBeVisible();
    await expect.poll(() => page.evaluate(() => [document.documentElement.scrollHeight > 2 * innerHeight, innerHeight + scrollY >= document.documentElement.scrollHeight - 1])).toEqual([true, true]);
    await settled(() => where(page, '.undo-line', -1));
    const before = await where(page, '.undo-line', -1);
    await undo.click();
    await expect(page.getByText('Undone. Your files are back in Big Sur.')).toBeVisible();
    await expect(page.locator('.undo-line')).toHaveText('Undone');
    await settled(() => where(page, '.undo-line', -1));
    expect(await where(page, '.undo-line', -1)).toBe(before);
  } finally {
    await llm.stop();
  }
});
