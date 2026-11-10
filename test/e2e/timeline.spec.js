import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { openApp, FIRST_DRAW, startModelServer, modelSetUp, anthropicToolReply, fakeMicrophone, waitForServiceWorker, addProvider } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Timeline stage 4: home is a timeline of trips and chats, and a + drops you into a new conversation with no naming step.

// Installed, unless a test says otherwise: a fresh home opens at the now line only then (in a browser tab it opens at its top, the data-safety banner first).
test.beforeEach(async ({ page }) => { await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })); });

const plus = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'New conversation', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');
/** The page's own store, through annai's modules. @param {import('@playwright/test').Page} page @param {string} id */
const record = (page, id) => page.evaluate(async (id) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const rec = await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  store.close();
  return rec;
}, id);
const draftOf = (/** @type {string} */ url) => decodeURIComponent(new URL(url).hash.split('/')[2]);

test('+ on home, voice off: the draft opens with the box ready; the first line names it, and the next + opens another', async ({ page }) => {
  await openApp(page, '#/trips');
  await expect(plus(page)).toBeVisible();
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  await expect(box(page)).toBeVisible();
  await expect(box(page)).toBeFocused();
  const first = draftOf(page.url());
  expect((await record(page, first))?.draft).toBe(true);
  await expect(plus(page)).toBeHidden(); // home only
  await box(page).fill('Where should we eat tonight? Somewhere quiet.');
  await box(page).press('Enter');
  await expect.poll(async () => (await record(page, first))?.title).toBe('Where should we eat tonight?');
  expect((await record(page, first))?.draft).toBeUndefined();
  await page.goto('/#/trips');
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  expect(draftOf(page.url())).not.toBe(first);
});

/**
 * Trips and chats made as the app makes them, then the page loads again. chats: name → minutes ago it was last talked in; trips: name → [start, end]
 * in days from today, and what her last line there says; items: plan items today, by name → minutes from now they start (each lasts the default half hour). @param {import('@playwright/test').Page} page
 * @param {{ chats?: Record<string, number>, trips?: Record<string, { from: number, to?: number, plan?: string, items?: Record<string, number>, said?: string }> }} c @returns {Promise<Record<string, string>>} ids by name
 */
async function seed(page, { chats = {}, trips = {} }) {
  const ids = await page.evaluate(async ({ chats, trips }) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const { dayIn, deviceZone, isoInZone } = await load('/src/core/time.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const zone = deviceZone();
    const dayFrom = (/** @type {number} */ n) => dayIn(Date.now() + n * 86_400_000, zone);
    /** @type {Record<string, string>} */
    const out = {};
    for (const [title, ago] of Object.entries(chats)) {
      const id = await createTrip(ws, { title });
      await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', title]], now: Date.now() - ago * 60_000 });
      out[title] = id;
    }
    for (const [title, t] of Object.entries(trips)) {
      const id = await createTrip(ws, { title, start: dayFrom(t.from), ...(t.to !== undefined ? { end: dayFrom(t.to) } : {}) });
      if (t.plan) await ws.write(id, '/plan/next.json', { id: 'next', title: t.plan, fixed: true, start: { at: isoInZone(Date.now() + 86_400_000, zone), tz: zone } }, { author: 'user' });
      for (const [name, min] of Object.entries(t.items ?? {})) await ws.write(id, `/plan/${name}.json`, { id: name, title: name, fixed: true, start: { at: isoInZone(Date.now() + min * 60_000, zone), tz: zone } }, { author: 'user' });
      if (t.said) await record(store, id, { type: 'out.speak', actor: 'shiori', data: { text: t.said } });
      out[title] = id;
    }
    store.close();
    return out;
  }, { chats, trips });
  await page.reload();
  await expect(page.locator('main.view > *')).toBeVisible(FIRST_DRAW);
  return ids;
}
const row = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) => page.locator('.trip-card', { has: page.locator('.name', { hasText: name }) });

test('a chat is one line, a dated trip a card; a tap opens its conversation', async ({ page }) => {
  await openApp(page, '#/trips');
  const ids = await seed(page, { chats: { Ramen: 30 }, trips: { Testville: { from: -20, to: -18 } } });
  await expect(row(page, 'Ramen')).toHaveClass(/\bline\b/);
  await expect(row(page, 'Testville')).not.toHaveClass(/\bline\b/);
  await expect(row(page, 'Testville').locator('.sub').first()).toContainText(/–|-/); // its dates
  await expect(page.locator('.rows .trip-card')).toHaveCount(2);
  // Old to new: the past trip, then the chat, both above the now line.
  expect(await page.locator('.past .trip-card .name').allTextContents()).toEqual(['Testville', 'Ramen']);
  await row(page, 'Ramen').click();
  await expect(page).toHaveURL(new RegExp(`#/trip/${ids.Ramen}/talk$`));
  await page.goBack();
  await row(page, 'Testville').click();
  await expect(page).toHaveURL(new RegExp(`#/trip/${ids.Testville}/talk$`));
});

test('happening: tinted, "Day 3 of 8", Next; future: "in 2 weeks", her last line', async ({ page }) => {
  await openApp(page, '#/trips');
  await seed(page, { trips: { Testville: { from: -2, to: 5, plan: 'Lunch at the pier' }, Laterton: { from: 14, to: 16, said: 'See you at the station.' } } });
  const now = row(page, 'Testville');
  await expect(now).toHaveClass(/\bhappening\b/);
  await expect(now.locator('.day-of')).toHaveText('Day 3 of 8');
  await expect(now.locator('.next')).toContainText('Lunch at the pier');
  const later = row(page, 'Laterton');
  await expect(later.locator('.soon')).toHaveText(/in 2 weeks/i);
  await expect(later.locator('.her-last')).toHaveText('See you at the station.');
  // The happening trip and the one ahead sit below the now line, in that order.
  expect(await page.locator('.ahead .trip-card .name').allTextContents()).toEqual(['Testville', 'Laterton']);
});

test('her long last line is cut inside its card: home never scrolls sideways', async ({ page }) => {
  await openApp(page, '#/trips');
  await seed(page, { trips: { Laterton: { from: 14, to: 16, said: 'See you at the station, by the east gate. '.repeat(8) } } });
  const last = row(page, 'Laterton').locator('.her-last');
  await expect(last).toBeVisible();
  const box = await last.evaluate((el) => {
    const card = /** @type {HTMLElement} */ (el.closest('.trip-card')).getBoundingClientRect();
    const root = document.documentElement;
    return { line: el.getBoundingClientRect().right, card: card.right, page: root.scrollWidth, room: root.clientWidth, cut: el.scrollWidth > el.clientWidth };
  });
  expect(box.line).toBeLessThanOrEqual(box.card);
  expect(box.page).toBeLessThanOrEqual(box.room);
  expect(box.cut).toBe(true); // one line, ended with an ellipsis
});

/** Home with a long past, opened fresh, in a browser tab (the data-safety banner shows) or installed (it doesn't). @param {import('@playwright/test').Page} page @param {boolean} installed */
async function freshHome(page, installed) {
  await page.addInitScript((standalone) => Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true }), installed);
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeAttached();
}

test("while annai isn't installed, a fresh home opens at its top, the data-safety banner in view", async ({ page }) => {
  await freshHome(page, false);
  await expect(page.locator('section.risk')).toBeInViewport();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await expect(page.locator('.now-line')).not.toBeInViewport();
});

test('installed, a fresh home opens at the now line, as always', async ({ page }) => {
  await freshHome(page, true);
  await expect(page.locator('section.risk')).toHaveCount(0); // no banner once installed
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await expect(page.locator('.now-line')).toBeInViewport();
});

test("desktop Chrome's Install moves the tab into an app window: the data-safety banner goes, and a fresh home then opens at the now line", async ({ page }) => {
  // The browser's own display mode, which a test can't change: a stand-in that says "browser tab" until the test moves it into an app window.
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    const real = matchMedia.bind(window);
    const mode = Object.assign(new EventTarget(), { matches: false, media: '(display-mode: standalone)' });
    w.matchMedia = (/** @type {string} */ q) => (q.includes('display-mode: standalone') ? mode : real(q));
    w.toAppWindow = () => { mode.matches = true; mode.dispatchEvent(new Event('change')); };
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: undefined, configurable: true })); // not an iPhone's Home Screen app
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats });
  await expect(page.locator('section.risk')).toBeVisible();
  await page.evaluate(() => /** @type {any} */ (window).toAppWindow());
  await expect(page.locator('section.risk')).toHaveCount(0);
  await page.goto('/#/trips');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await expect(page.locator('.now-line')).toBeInViewport();
});

test('home opens with the now line 40% down; Back restores your place', async ({ page }) => {
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats, trips: { Laterton: { from: 3, to: 4 } } });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  const at = () => page.locator('.now-line').evaluate((n) => n.getBoundingClientRect().top / innerHeight);
  await expect.poll(at).toBeGreaterThan(0.35);
  expect(await at()).toBeLessThan(0.45);
  await page.evaluate(() => scrollTo(0, 120));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(120);
  await row(page, 'Chat 20').click();
  await expect(page).toHaveURL(/\/talk$/);
  await page.goBack();
  await expect(page.locator('.now-line')).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(120);
});

test('home with nothing yet: the now line, "Tap + to talk to Shiori", Open a file', async ({ page }) => {
  await openApp(page, '#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await expect(page.getByText('Tap + to talk to Shiori.')).toBeVisible();
  await expect(page.locator('.rows .trip-card')).toHaveCount(0);
  await expect(page.locator('main label.btn', { hasText: 'Open a trip someone sent you' })).toBeVisible();
  await expect(plus(page)).toBeVisible();
});

test('home at rest shows the chips and +; while she works, the whole dock with "In Testville ›", which opens that conversation; ← leaves her turn running', async ({ page }) => {
  const speak = anthropicToolReply([{ name: 'speak', input: { text: 'The pier is a short walk.' } }, { name: 'sleep', input: {} }]);
  const llm = await startModelServer({ '/b/v1/messages': { status: 200, type: 'text/event-stream', body: speak, delayMs: 3000 } });
  try {
    await modelSetUp(page, llm.origin, 'Testville');
    const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.goto('/#/trips');
    const rowOf = page.locator('.dock .dock-row');
    await expect(rowOf).toBeHidden();
    await expect(page.locator('.dock .voice-row')).toBeVisible();
    await expect(plus(page)).toBeVisible();
    await page.goto(`/#/trip/${id}/talk`);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await box(page).fill('Where is the pier?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0); // her turn waits on the model
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await expect(rowOf).toBeVisible();
    const inConvo = page.locator('.dock .in-convo');
    await expect(inConvo).toHaveText('In Testville ›');
    // Home is a screen, not a state: her turn goes on, and its answer lands in its conversation.
    await expect(rowOf).toBeHidden({ timeout: 15_000 });
    await expect(inConvo).toBeHidden();
    await page.goto(`/#/trip/${id}/talk`);
    await expect(page.locator('.convo')).toContainText('The pier is a short walk.');
    // Once more, to follow the link while she works.
    await box(page).isVisible() || await page.getByRole('button', { name: 'Type', exact: true }).click();
    await box(page).fill('And the market?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(1);
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await inConvo.click();
    await expect(page).toHaveURL(new RegExp(`#/trip/${id}/talk$`));
  } finally {
    await llm.stop();
  }
});

test('voice on: an open mic can be stopped from home, and ← leaves voice on', async ({ page }) => {
  const silent = join(tmpdir(), 'annai-e2e-silent.wav');
  await writeFile(silent, encodeWav(new Float32Array(16_000 * 3), 16_000));
  const server = await startModelServer({
    '/b/v1/messages': { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'sleep', input: {} }]) },
    '/ears/audio/transcriptions': { status: 200, type: 'application/json', body: JSON.stringify({ text: '' }) },
  });
  try {
    await fakeMicrophone(page, [silent]);
    await openApp(page, '#/models');
    await waitForServiceWorker(page);
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${server.origin}/b`, key: 'sk-chat-test', model: 'b-model' });
    await addProvider(page, 'Custom provider', { ability: 'Transcription', name: 'Ears', url: `${server.origin}/ears`, key: 'sk-ears-test', model: 'ears' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await expect(page.getByText('1. b-model')).toBeVisible();
    await page.getByLabel('Add a model to speech-in').selectOption({ label: 'ears' });
    await page.getByRole('button', { name: 'Add to speech-in' }).click();
    await expect(page.getByText('2. ears')).toBeVisible();
    await page.goto('/#/voice');
    await page.getByRole('radio', { name: 'On', exact: true }).check();
    await expect(page.getByText('Voice is on.')).toBeVisible();
    await page.goto('/#/trips');
    await plus(page).click(); // with voice on, + listens at once
    await expect(page).toHaveURL(/\/talk$/);
    const label = page.locator('.talk-label');
    await expect(label).toHaveText('Listening');
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    await expect(page.locator('.dock .dock-row')).toBeVisible();
    await expect(page.locator('.dock .in-convo')).toHaveText('In New conversation ›');
    await page.getByRole('button', { name: 'Shiori', exact: true }).click();
    await expect(label).toHaveText('Tap to talk');
    await expect(page.locator('.dock .dock-row')).toBeHidden();
    await expect(page.locator('.voice-chip')).toHaveText(/^Voice on/);
  } finally {
    await server.stop();
  }
});

test("Shiori's patch dates the open chat: its row becomes a card below now, and the conversation says so with Undo; Undo takes the dates back, so it is a line again, named as she named it, after a reload too; a date set in Details says nothing", async ({ page }) => {
  await openApp(page, '#/trips');
  const [start, end] = await page.evaluate(async () => {
    const { dayIn, deviceZone } = await import(/** @type {string} */ ('/src/core/time.js'));
    return [10, 12].map((n) => dayIn(Date.now() + n * 86_400_000, deviceZone()));
  });
  const reply = [
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes: { title: 'Testville', start, end } } }]) },
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'I set it for the 10th to the 12th.' } }, { name: 'sleep', input: {} }]) },
  ];
  const llm = await startModelServer({ '/b/v1/messages': reply });
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await plus(page).click();
    const id = draftOf(page.url());
    await box(page).fill('Plan our weekend in Testville');
    await box(page).press('Enter');
    const line = page.locator('.dates-line');
    await expect(line).toContainText('Shiori set the dates');
    await expect(page.locator('.convo')).toContainText('I set it for the 10th to the 12th.');
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(row(page, 'Testville')).not.toHaveClass(/\bline\b/);
    await expect(page.locator('.ahead').locator('.trip-card .name')).toContainText(['Testville']);
    await row(page, 'Testville').click();
    await expect(page).toHaveURL(new RegExp(`#/trip/${id}/talk$`));
    await line.getByRole('button', { name: 'Undo' }).click();
    await expect(line).toBeHidden();
    await expect(page.locator('.toasts').getByText('Undone.', { exact: true })).toBeVisible(); // said, as the hand-over's Undo is
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(row(page, 'Testville')).toHaveClass(/\bline\b/); // her title stays: Undo takes back the dates
    await page.reload();
    await expect(row(page, 'Testville')).toHaveClass(/\bline\b/);
    await row(page, 'Testville').click();
    await expect(page.locator('.convo')).toContainText('I set it for the 10th to the 12th.');
    await expect(line).toBeHidden();
    // The user's own dates, from Details: no such line.
    await page.goto(`/#/trip/${id}`);
    await page.getByLabel('Starts').fill(start);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.goto(`/#/trip/${id}/talk`);
    await expect(page.locator('.convo')).toContainText('I set it for the 10th to the 12th.');
    await expect(line).toBeHidden();
  } finally {
    await llm.stop();
  }
});

test('Share offers the dated trips and New conversation, never every chat: New conversation adds the photo to the draft, which is named by it and opens', async ({ page }) => {
  await openApp(page, '#/settings');
  await waitForServiceWorker(page);
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 40; i++) chats[`Chat ${i}`] = 60 * i + 5;
  await seed(page, { chats, trips: { Testville: { from: -1, to: 2 }, Laterton: { from: 20, to: 24 } } });
  const png = await readFile(new URL('../fixtures/photos/screenshot.png', import.meta.url));
  await page.evaluate(async (bytes) => {
    const form = new FormData();
    form.append('files', new File([new Uint8Array(bytes)], 'screenshot.png', { type: 'image/png' }));
    await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
  }, [...png]);
  await page.goto('/#/import?inbox=1');
  await expect(page.getByRole('heading', { name: 'Add 1 photo' })).toBeVisible();
  const acts = page.getByRole('main').locator('.acts').last();
  await expect(acts.getByRole('button')).toHaveCount(3);
  expect((await acts.getByRole('button').allTextContents()).sort()).toEqual(['Add to Laterton', 'Add to Testville', 'New conversation']);
  await expect(page.getByText(/Start a trip first/)).toHaveCount(0);
  await acts.getByRole('button', { name: 'New conversation' }).click();
  await expect(page).toHaveURL(/\/talk$/);
  const id = draftOf(page.url());
  await expect(page.locator('.talk-head .talk-name')).toHaveText(/^Photo · /);
  const rec = await record(page, id);
  expect(rec.draft).toBeUndefined();
  await page.goto('/#/trips');
  await expect(row(page, 'Photo · ')).toHaveCount(1);
});

test("500 chats: home's reads don't follow the chats, and + stays instant", async ({ page }) => {
  await openApp(page, '#/settings');
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const { dayIn, deviceZone } = await load('/src/core/time.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    for (let i = 0; i < 500; i++) {
      const id = await createTrip(ws, { title: `Chat ${i}` });
      await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', `Line ${i}`]], now: Date.now() - i * 17 * 3_600_000 });
    }
    for (const [title, n] of /** @type {[string, number][]} */ ([['Testville', -40], ['Laterton', 20]])) await createTrip(ws, { title, start: dayIn(Date.now() + n * 86_400_000, deviceZone()) });
    store.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  // Every transaction the page opens from here, counted at IndexedDB itself.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__tx = 0;
    const real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (/** @type {any[]} */ ...a) { w.__tx++; return /** @type {any} */ (real).apply(this, a); };
  });
  await page.evaluate(() => { location.hash = '#/trips'; });
  await expect(page.locator('.rows .trip-card')).toHaveCount(502);
  const reads = await page.evaluate(() => /** @type {any} */ (window).__tx);
  // Measured 13 (2026-11-08): the list, then 5 for each card. A read per chat would be over 500; 50 leaves room for a backup's or live
  // mode's read landing while home draws, and still fails at one read for every ten chats.
  expect(reads, `home drew 500 chats and 2 trips in ${reads} transactions`).toBeLessThanOrEqual(50);
  const started = await page.evaluate(() => performance.now());
  await plus(page).click();
  await expect(page).toHaveURL(/\/talk$/);
  await expect(box(page)).toBeFocused();
  const took = await page.evaluate((t) => performance.now() - t, started);
  // The draft is made ahead, so + is an open and a focus whatever the chats: measured 247 ms here (2026-11-08). 2 s leaves room for a
  // loaded test machine and still fails a + that waits seconds.
  expect(took).toBeLessThan(2000);
});

test("← from a conversation comes back to where you were on home, as Back does; a month's fold you opened stays open", async ({ page }) => {
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 6; i++) chats[`Old ${i}`] = 60 * 24 * (60 + i); // one month before the last 30 days: a fold
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats, trips: { Laterton: { from: 3, to: 4 } } });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0); // the now line, 40% down
  const fold = page.locator('.rows > .fold details');
  await fold.locator('summary').click();
  await expect(fold).toHaveAttribute('open', '');
  await row(page, 'Chat 20').evaluate((el) => el.scrollIntoView({ block: 'center' })); // in the past, well above the now line; mid-screen, so the tap below scrolls nothing
  const at = await page.evaluate(() => scrollY);
  // Each seeded chat's line is owed a turn, which fails here (no model is set): its card must land while the conversation shows, not on home in
  // the middle of the test, where the card keeps what is seen in place by moving scrollY, and home ignores taps for a moment (.landed).
  const settled = async () => {
    await expect(page.locator('.convo').getByText("Shiori can't reach her model")).toBeVisible();
    await expect(page.locator('.notices.landed')).toHaveCount(0);
  };
  await row(page, 'Chat 20').click();
  await expect(page).toHaveURL(/\/talk$/);
  await settled();
  await page.getByRole('link', { name: 'Back to Trips' }).click(); // the conversation's ←: a new entry, home's
  await expect(page.locator('.now-line')).toBeVisible();
  await expect(fold).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(at);
  // The card stays on home, stuck under the top bar over the rows; this test is about the place, so it goes (the sticky box has its own test), and a row is not
  // under it when the test's click scrolls to it.
  await page.locator('.notices .notice .acts button', { hasText: 'Dismiss' }).click();
  await expect(page.locator('.notices .notice')).toHaveCount(0);
  await row(page, 'Old 3').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const y = await page.evaluate(() => scrollY);
  await row(page, 'Old 3').click();
  await expect(page).toHaveURL(/\/talk$/);
  await settled();
  await page.goBack(); // Back to the open fold, at the row tapped
  await expect(fold).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(y);
});

test("home opened at the now line: a card that arrives sticks under the top bar, in view; once it goes, the first row is not covered, and nothing jumped", async ({ page }) => {
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5; // a long past: home opens scrolled to the now line
  await seed(page, { chats, trips: { Laterton: { from: 3, to: 4 } } });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  /** What is at the top of the screen, just under the top bar: the box (and its card), or home's own. */
  const under = () => page.evaluate(() => {
    const bar = /** @type {HTMLElement} */ (document.querySelector('.topbar')).getBoundingClientRect();
    const hit = document.elementFromPoint(innerWidth / 2, bar.bottom + 4);
    const card = document.querySelector('.notices:not(:empty)')?.getBoundingClientRect(); // the box: its card sits in its padding
    return { barTop: bar.top, barBottom: bar.bottom, onBar: document.elementFromPoint(innerWidth / 2, bar.top + 4)?.closest('.topbar') !== null,
      card: card ? { top: card.top, bottom: card.bottom } : null, hitCard: hit?.closest('.notices') !== null, onHome: hit?.closest('main') !== null,
      kept: Math.round(document.querySelector('.now-line')?.getBoundingClientRect().top ?? NaN) };
  });
  const before = await under();
  expect(before.onBar).toBe(true);
  expect(before.hitCard).toBe(false);
  await page.evaluate(() => dispatchEvent(new ErrorEvent('error', { error: new Error('A test card') })));
  const card = page.locator('.notices .notice');
  await expect(card).toBeVisible();
  await expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0); // the moment that ignores taps is over
  const shown = await under();
  expect(shown.card?.top).toBeGreaterThanOrEqual(shown.barBottom - 1); // under the bar, not over it
  expect(shown.card?.top).toBeLessThanOrEqual(shown.barBottom + 1); // and sticking to it
  expect(shown.card?.bottom).toBeLessThan(await page.evaluate(() => innerHeight)); // in view
  expect(shown.hitCard).toBe(true);
  expect(shown.onBar).toBe(true); // the top bar is not hidden
  expect(Math.abs(shown.kept - before.kept)).toBeLessThanOrEqual(1); // the rows stayed where they were
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
  const gone = await under();
  expect(gone.hitCard).toBe(false); // an empty box takes no room and covers nothing: a row is under the bar
  expect(gone.onHome).toBe(true);
  expect(Math.abs(gone.kept - before.kept)).toBeLessThanOrEqual(1); // nothing jumped
  expect(await page.evaluate(() => document.querySelector('.notices')?.getBoundingClientRect().height)).toBe(0);
});

/** Home with a long past, opened at the now line, its box replaced by one the test fills (createNotices). @param {import('@playwright/test').Page} page */
async function scrolledHome(page) {
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats, trips: { Laterton: { from: 3, to: 4 } } });
  await page.goto('/#/trips');
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300);
  await page.evaluate(async () => {
    const { createNotices } = await import(/** @type {string} */ ('/src/ui/notices.js'));
    const n = createNotices();
    document.querySelector('.notices')?.replaceWith(n.el);
    /** @type {any} */ (window).__n = n;
  });
}
const placeOf = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => ({ y: Math.round(scrollY), now: Math.round(/** @type {Element} */ (document.querySelector('.now-line')).getBoundingClientRect().top),
  pos: getComputedStyle(/** @type {Element} */ (document.querySelector('.notices'))).position }));
/** The box as the user sees it: under the bar, at most half the room under it (the page's own height, as notices.js measures it), and what scrolls inside it. @param {import('@playwright/test').Page} page */
const boxOf = (page) => page.evaluate(() => {
  const box = /** @type {HTMLElement} */ (document.querySelector('.notices'));
  const r = box.getBoundingClientRect();
  const bar = /** @type {HTMLElement} */ (document.querySelector('.topbar')).getBoundingClientRect().bottom;
  return { top: r.top, bottom: r.bottom, bar, half: (document.documentElement.clientHeight - bar) / 2, inside: box.scrollHeight - box.clientHeight };
});
/** The box is stuck under the bar, in view, at most half the room under it. @param {import('@playwright/test').Page} page */
const stuckInHalf = async (page) => {
  expect((await placeOf(page)).pos).toBe('sticky');
  const b = await boxOf(page);
  expect(Math.abs(b.top - b.bar)).toBeLessThanOrEqual(1);
  expect(b.bottom - b.top).toBeLessThanOrEqual(b.half + 1);
};
/** The rows are where they were: the now line within 1 px. @param {import('@playwright/test').Page} page @param {{ now: number }} before */
const rowsStayed = async (page, before) => expect(Math.abs((await placeOf(page)).now - before.now)).toBeLessThanOrEqual(1);
/** The moment a card that came over the rows ignores taps (.landed, .over) is over. @param {import('@playwright/test').Page} page */
const settled = (page) => expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0);
const PHONES = [[320, 568], [360, 640], [393, 659]];

/** Home scrolled on a phone this size, a long card stuck (with the dismiss Shiori's code would hold: her model card is taken down when a later turn works), opened with More inside its box. @param {import('@playwright/test').Page} page @param {number[]} size @param {{ actions?: boolean }} [o] */
async function openedLongCard(page, [width, height], { actions = true } = {}) {
  await page.setViewportSize({ width, height });
  await scrolledHome(page);
  await page.evaluate((a) => { const w = /** @type {any} */ (window); w.gone = w.__n.card({ title: 'A long card', body: 'These are many words, and more of them. '.repeat(30), actions: a ? [{ label: 'Go on', run() {} }] : [] }); }, actions);
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
  await settled(page);
  const before = await placeOf(page);
  const card = page.locator('.notices .notice', { hasText: 'A long card' });
  await card.getByRole('button', { name: 'More' }).click();
  await expect(card.getByRole('button', { name: 'Less' })).toBeVisible();
  await stuckInHalf(page); // opened inside the box, which keeps sticking
  await rowsStayed(page, before); // the page didn't move
  await settled(page);
  return { before, card };
}

for (const size of PHONES) {
  test(`home scrolled, More on a stuck card opens it inside the box, at most half the room under the bar; its end is reached by scrolling inside the box; Less closes it; the page never moves (${size.join(' x ')})`, async ({ page }) => {
    const { before, card } = await openedLongCard(page, size);
    expect((await boxOf(page)).inside).toBeGreaterThan(0); // the open card needs more: the box scrolls inside itself
    await page.locator('.notices').evaluate((el) => { el.scrollTop = el.scrollHeight; }); // to the card's end, inside the box
    await expect(card.getByRole('button', { name: 'Less' })).toBeInViewport();
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeInViewport();
    await rowsStayed(page, before);
    await card.getByRole('button', { name: 'Less' }).click();
    await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
    await stuckInHalf(page);
    expect(Math.abs((await placeOf(page)).y - before.y)).toBeLessThanOrEqual(1); // closed: the page as it was (WebKit rounds a px)
    await rowsStayed(page, before);
  });

  test(`home scrolled, Show on a stuck stack opens it inside the box, each card reached there; Hide folds it; the page never moves (${size.join(' x ')})`, async ({ page }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    await page.evaluate(() => { for (let i = 0; i < 3; i++) /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A photo was kept as it is', body: `Photo ${i} is kept as it is.` }); });
    await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
    await settled(page);
    const before = await placeOf(page);
    await page.locator('.notice-stack').getByRole('button', { name: /^Show/ }).click();
    await expect(page.locator('.stack-list > .notice')).toHaveCount(3);
    await stuckInHalf(page);
    await rowsStayed(page, before);
    for (const member of await page.locator('.stack-list > .notice').all()) {
      await member.evaluate((m) => m.scrollIntoView({ block: 'nearest' })); // inside the box: the page is not what scrolls
      await expect(member.locator('strong')).toBeInViewport();
      await rowsStayed(page, before);
    }
    await settled(page);
    await page.locator('.notice-stack').getByRole('button', { name: /^Hide/ }).click();
    await expect(page.locator('.stack-list')).toBeHidden();
    await stuckInHalf(page);
    expect(Math.abs((await placeOf(page)).y - before.y)).toBeLessThanOrEqual(1);
    await rowsStayed(page, before);
  });

  for (const by of ['the user', 'code']) {
    test(`an opened stuck card dismissed by ${by} closes inside the box: the box empties, and the rows don't move (${size.join(' x ')})`, async ({ page }) => {
      const { before, card } = await openedLongCard(page, size);
      if (by === 'the user') {
        await page.locator('.notices').evaluate((el) => { el.scrollTop = el.scrollHeight; }); // its Dismiss, at the card's foot, inside the box
        await card.getByRole('button', { name: 'Dismiss' }).click();
      } else await page.evaluate(() => /** @type {any} */ (window).gone());
      await expect(page.locator('.notices .notice')).toHaveCount(0);
      await rowsStayed(page, before);
    });
  }

  test(`a card opened (More) inside the stuck box, then one of its kind that folds it into a stack: the stack sticks, and the rows don't move (${size.join(' x ')})`, async ({ page }) => {
    const { before } = await openedLongCard(page, size, { actions: false });
    await page.evaluate(() => /** @type {any} */ (window).__n.card({ title: 'A long card', body: 'And another one of its kind.' }));
    await expect(page.locator('.notice-stack')).toHaveCount(1);
    await stuckInHalf(page);
    await rowsStayed(page, before);
  });

  test(`a stack shown (Show) inside the stuck box, one of its two cards taken down by code: the one left is a card in the box, and the rows don't move (${size.join(' x ')})`, async ({ page }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    await page.evaluate(() => { const w = /** @type {any} */ (window); w.gone = w.__n.card({ tone: 'warn', title: 'A photo was kept as it is', body: 'Photo 0 is kept as it is.' }); w.__n.card({ tone: 'warn', title: 'A photo was kept as it is', body: 'Photo 1 is kept as it is.' }); });
    await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
    await settled(page);
    const before = await placeOf(page);
    await page.locator('.notice-stack').getByRole('button', { name: /^Show/ }).click();
    await stuckInHalf(page);
    await rowsStayed(page, before);
    await page.evaluate(() => /** @type {any} */ (window).gone());
    await expect(page.locator('.notice-stack')).toHaveCount(0);
    await expect(page.locator('.notices > .notice')).toHaveCount(1);
    await stuckInHalf(page);
    await rowsStayed(page, before);
  });
}

test("home scrolled on a small phone, a card that needs more than the box's quarter, arriving while another is stuck: the box grows to its cap, and home stays where it was", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }));
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
  const before = await placeOf(page);
  // Two buttons that wrap at 320 px: its title and buttons need more than the box's quarter of the screen (.grow).
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A newer backup is on Test place', body: 'A backup made on another phone is newer than this one. Import it as a copy, or back this phone up over it.',
    actions: [{ label: 'Import it as a copy', primary: true, run() {} }, { label: 'Back up this phone over it', run() {} }] }));
  await expect(page.locator('.notices .notice.grow')).toHaveCount(1);
  const after = await placeOf(page);
  expect(after.y).toBeGreaterThan(before.y); // not to the top: the page took the box's new height
  expect(Math.abs(after.now - before.now)).toBeLessThanOrEqual(1); // the rows stayed: no jump to the top
});

for (const [width, height] of [[320, 568], [360, 640]]) {
  test(`a card whose buttons need more than a quarter of the screen sticks while it fits in half the screen under the bar (${width} x ${height}): in view, the rows stay, nothing stays covered`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await scrolledHome(page);
    const state = () => page.evaluate(() => {
      const box = /** @type {HTMLElement} */ (document.querySelector('.notices'));
      const bar = /** @type {HTMLElement} */ (document.querySelector('.topbar')).getBoundingClientRect();
      const hit = document.elementFromPoint(innerWidth / 2, bar.bottom + 4);
      const r = box.getBoundingClientRect();
      return { y: Math.round(scrollY), now: Math.round(/** @type {Element} */ (document.querySelector('.now-line')).getBoundingClientRect().top), pos: getComputedStyle(box).position,
        top: r.top, bottom: r.bottom, barBottom: bar.bottom, room: innerHeight - bar.bottom, hitBox: hit?.closest('.notices') !== null, grow: box.querySelectorAll('.notice.grow').length };
    });
    const before = await state();
    await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A newer backup is on Test place', body: 'A backup made on another phone is newer than this one. Import it as a copy, or back this phone up over it.',
      actions: [{ label: 'Import it as a copy', primary: true, run() {} }, { label: 'Back up this phone over it', run() {} }] }));
    await expect(page.locator('.notices .notice.grow')).toHaveCount(1); // it needs more than the box's quarter
    await expect.poll(async () => (await state()).pos).toBe('sticky');
    await expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0);
    const shown = await state();
    expect(shown.bottom - shown.top).toBeLessThanOrEqual(shown.room / 2 + 1); // half the screen under the bar, at most
    expect(Math.abs(shown.top - shown.barBottom)).toBeLessThanOrEqual(1); // under the bar
    expect(shown.bottom).toBeLessThan(height); // in view
    expect(shown.hitBox).toBe(true);
    expect(Math.abs(shown.now - before.now)).toBeLessThanOrEqual(1); // the rows stayed
    await page.locator('.notices .notice').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.notices .notice')).toHaveCount(0);
    const gone = await state();
    expect(gone.hitBox).toBe(false); // nothing stays covered
    expect(Math.abs(gone.now - before.now)).toBeLessThanOrEqual(1);
  });
}

test("in a browser tab, its bars hiding and showing as home scrolls (innerHeight changes, the page's height doesn't) leave the box stuck at its cap", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 }); // an iPhone 15 in Safari, its bars shown
  await scrolledHome(page);
  // 331 px together: more than half of 659 under the bar (301.5), less than half of 750 (347), about Safari's height with its bars hidden.
  await page.evaluate(() => {
    const n = /** @type {any} */ (window).__n;
    n.card({ title: 'A large backup is waiting', body: 'This backup uploads 812 MB to Test place. It waits for Wi-Fi.', actions: [{ label: 'Back up now', primary: true, run() {} }, { label: 'Open Backups', run() {} }] });
    n.card({ title: 'An update is ready', body: 'It will be used the next time annai starts.', actions: [{ label: 'Restart now', primary: true, run() {} }] });
  });
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
  const capped = await boxOf(page);
  for (const tall of [750, 659, 750]) {
    await page.evaluate((h) => { Object.defineProperty(window, 'innerHeight', { value: h, configurable: true }); dispatchEvent(new Event('resize')); }, tall);
    expect((await placeOf(page)).pos).toBe('sticky');
    const b = await boxOf(page);
    expect(Math.abs((b.bottom - b.top) - (capped.bottom - capped.top))).toBeLessThanOrEqual(1);
  }
});

/** A "newer backup" hold card, two buttons: more than the box's quarter at every phone size. @param {import('@playwright/test').Page} page @param {string} [place] */
const addBackup = (page, place = 'Test place') => page.evaluate((p) => { /** @type {any} */ (window).__n.card({ tone: 'warn', title: `A newer backup is on ${p}`,
  body: 'A backup made on another phone is newer than this one. Import it as a copy, or back this phone up over it.',
  actions: [{ label: 'Import it as a copy', primary: true, run() {} }, { label: 'Back up this phone over it', run() {} }] }); }, place);
/** A finger's swipe, as a phone's touch events (CDP, Chromium only): dy < 0 reads on. @param {import('@playwright/test').Page} page */
const fingerOf = async (page) => {
  const cdp = await page.context().newCDPSession(page);
  /** @param {number} x @param {number} y @param {number} dy */
  return async (x, y, dy) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / 8 }] });
      await page.waitForTimeout(12);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(700); // the fling ends
  };
};
const SIZES = [...PHONES, [740, 360]];

/**
 * The innerHeight and visual viewport a phone shows become `by` px taller and then are back, each with its resize events: the page's own height doesn't
 * change. @param {import('@playwright/test').Page} page @param {number} by
 */
const viewportBy = (page, by) => page.evaluate(async (by) => {
  const was = innerHeight;
  for (const h of [was + by, was]) {
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    if (visualViewport) Object.defineProperty(visualViewport, 'height', { value: h, configurable: true });
    visualViewport?.dispatchEvent(new Event('resize'));
    dispatchEvent(new Event('resize'));
    await new Promise((r) => requestAnimationFrame(r));
  }
}, by);
/** What fits the box's cards again on a phone (notices.js's refit), each as the page sees it. @type {Record<string, (page: import('@playwright/test').Page, size: number[]) => Promise<unknown>>} */
const REFITS = {
  'a bare resize event, as when a Chrome tab hides its URL bar': (page) => page.evaluate(() => dispatchEvent(new Event('resize'))),
  'the window 1 px taller, and back': async (page, [width, height]) => {
    await page.setViewportSize({ width, height: height + 1 });
    await page.setViewportSize({ width, height });
  },
  'the keyboard up and down': (page) => viewportBy(page, -300), // a phone's keyboard: about 290 to 340 px
  "Safari's bars hiding and showing": (page) => viewportBy(page, 91), // an iPhone 15's Safari: 659 px with its bars, about 750 without
  'a web font swapping in': (page) => page.evaluate(async () => {
    const face = new FontFace('Probe Mono', 'url(/assets/fonts/ibm-plex-mono-400.woff2)');
    document.fonts.add(face);
    await face.load();
    await document.fonts.ready;
  }),
};
// A fit measures a card from the start, cut back to the box's quarter: were the box to follow it for that moment, the page under it would rise by the
// card's excess and come back, and the browsers keep such a moment (measured on 80100343 with these tests): Chromium's scroll anchoring holds what it
// saw then, 72 px at 360 x 640 with one trip ahead of the now line; WebKit keeps the page's end clamped short, 59 to 89 px at the three sizes.
for (const [how, refit] of Object.entries(REFITS)) {
  for (const where of ['at the now line', 'at its end']) {
    for (const size of PHONES) {
      test(`home ${where}, a short page, a card that needs more than the box's quarter stuck, then ${how}: the rows don't move (${size.join(' x ')})`, async ({ page }) => {
        await page.setViewportSize({ width: size[0], height: size[1] });
        await scrolledHome(page); // one trip ahead of the now line: the page ends soon under it
        await addBackup(page);
        await expect(page.locator('.notices .notice.grow')).toHaveCount(1);
        await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
        await settled(page);
        if (where === 'at its end') await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        const before = await placeOf(page);
        await refit(page, size);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await rowsStayed(page, before);
      });
    }
  }
}

for (const where of ['at the now line', 'at its end']) {
  test(`home ${where}, a short page, a folded stack whose title and buttons need more than the box's quarter stuck, then a resize: the rows don't move (320 x 568)`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await scrolledHome(page);
    await page.evaluate(() => { for (let i = 0; i < 2; i++) /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'The photos of this long trip were kept as they are', body: `Photo ${i} is kept as it is.` }); });
    await expect(page.locator('.notices > .notice-stack.grow')).toHaveCount(1); // its title takes two lines
    await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
    await settled(page);
    if (where === 'at its end') await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const before = await placeOf(page);
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await rowsStayed(page, before);
    await expect(page.locator('.notices > .notice-stack.grow')).toHaveCount(1); // fitted as before
  });
}

test("a card that goes from a box over half: the one left stays stuck under the bar, and the rows stay", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await scrolledHome(page);
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.gone = w.__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }); }); // as Shiori's named card
  await addBackup(page);
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky'); // the two are taller than half: stuck, at its cap
  await stuckInHalf(page);
  await settled(page);
  const before = await placeOf(page);
  await page.evaluate(() => /** @type {any} */ (window).gone());
  await stuckInHalf(page);
  await rowsStayed(page, before);
});

for (const size of SIZES) {
  test(`two cards together over half on a scrolled home: the box sticks under the bar, at most half, and scrolls inside; the rows don't move (${size.join(' x ')})`, async ({ page }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    const before = await placeOf(page);
    await addBackup(page, 'Place 0');
    await addBackup(page, 'Place 1');
    await expect(page.locator('.notices > .notice')).toHaveCount(2);
    await stuckInHalf(page);
    expect((await boxOf(page)).inside).toBeGreaterThan(0); // more than its cap: it scrolls inside
    await rowsStayed(page, before);
    await page.locator('.notices').evaluate((el) => { el.scrollTop = el.scrollHeight; }); // the second card's buttons, inside the box
    await expect(page.locator('.notices > .notice').nth(1).getByRole('button', { name: 'Dismiss' })).toBeInViewport();
    await rowsStayed(page, before);
  });

  test(`a card that arrives while one is open lands in the box; Less leaves both there, stuck: nothing leaves the screen, and the rows don't move (${size.join(' x ')})`, async ({ page }) => {
    const { before, card } = await openedLongCard(page, size);
    await addBackup(page);
    await expect(page.locator('.notices > .notice')).toHaveCount(2);
    await stuckInHalf(page);
    await rowsStayed(page, before);
    await settled(page);
    await page.locator('.notices').evaluate((el) => { el.scrollTop = 0; });
    await card.getByRole('button', { name: 'Less' }).click();
    await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
    await stuckInHalf(page); // closed, the two stay in the stuck box: neither goes into the page above
    await rowsStayed(page, before);
    await expect(card.locator('strong')).toBeInViewport(); // the card the user read is still in view
    await page.locator('.notices').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.notices > .notice', { hasText: 'A newer backup' }).getByRole('button', { name: 'Dismiss' })).toBeInViewport(); // and the one that came
    await page.evaluate(() => /** @type {any} */ (window).gone()); // the long card taken down by code
    await stuckInHalf(page);
    await rowsStayed(page, before);
  });

  test(`More on a two-button card: its buttons stay at the box's edge, whole, and a tap at Less's centre closes it (${size.join(' x ')})`, async ({ page }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    await addBackup(page);
    await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
    await settled(page);
    const before = await placeOf(page);
    const card = page.locator('.notices > .notice');
    await card.getByRole('button', { name: 'More' }).click();
    await settled(page);
    const less = card.getByRole('button', { name: 'Less' });
    const b = await boxOf(page);
    for (const button of [less, card.getByRole('button', { name: 'Dismiss' })]) {
      const r = /** @type {{ x: number, y: number, width: number, height: number }} */ (await button.boundingBox());
      expect(r.y).toBeGreaterThanOrEqual(b.top - 1); // whole, inside the box
      expect(r.y + r.height).toBeLessThanOrEqual(b.bottom + 1);
    }
    const r = /** @type {{ x: number, y: number, width: number, height: number }} */ (await less.boundingBox());
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await expect(card).not.toHaveClass(/\bopen\b/); // the tap ran Less
    await rowsStayed(page, before);
  });

  test(`a swipe on a stuck box that holds less than its cap scrolls home; on one that holds more, it stays in the box (${size.join(' x ')})`, async ({ page, browserName }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    // A title and Dismiss: well inside its cap.
    await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card' }));
    await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
    await settled(page);
    const box = page.locator('.notices');
    const rule = () => box.evaluate((el) => getComputedStyle(el).overscrollBehaviorY);
    if (browserName !== 'chromium') {
      // Playwright's WebKit has neither touch scrolling nor a wheel: there, the rule itself (Safari 16 and later keep a contained swipe in the box).
      expect(await rule()).toBe('auto');
      await addBackup(page, 'Place 0');
      await addBackup(page, 'Place 1');
      await expect(page.locator('.notices > .notice')).toHaveCount(3);
      expect(await rule()).toBe('contain');
      return;
    }
    expect(await rule()).toBe('auto');
    const swipe = await fingerOf(page);
    let before = await placeOf(page);
    let b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box.boundingBox());
    const x = Math.round(b.x + b.width / 2);
    await swipe(x, Math.round(b.y + b.height / 2), -80); // on a box with nothing past its edge: home scrolls
    expect((await placeOf(page)).y).toBeGreaterThan(before.y + 30);
    await addBackup(page, 'Place 0');
    await addBackup(page, 'Place 1');
    await expect(page.locator('.notices > .notice')).toHaveCount(3);
    await settled(page);
    before = await placeOf(page);
    b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box.boundingBox());
    for (let i = 0; i < 6; i++) await swipe(x, Math.round(b.y + b.height - 30), -200); // to the box's end, and past it
    expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await rowsStayed(page, before);
    for (let i = 0; i < 6; i++) await swipe(x, Math.round(b.y + 30), 200); // back to its top, and past it
    expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
    await rowsStayed(page, before);
  });
}

for (const size of SIZES) {
  test(`a card that arrives below what is read in the box shows a sign at its bottom edge, which goes once the card's title is in view there; the rows don't move (${size.join(' x ')})`, async ({ page }) => {
    const { before } = await openedLongCard(page, size);
    const box = page.locator('.notices');
    await expect(box).not.toHaveClass(/\bbelow\b/);
    await addBackup(page); // under the opened card, out of sight in the box
    await expect(page.locator('.notices > .notice')).toHaveCount(2);
    await expect(box).toHaveClass(/\bbelow\b/);
    // The sign is at the box's bottom edge, inside it, and takes no room.
    const sign = await box.evaluate((el) => {
      const s = getComputedStyle(el, '::after');
      return { content: s.content, position: s.position, inside: el.scrollHeight - el.clientHeight };
    });
    expect(sign.content).not.toBe('none');
    expect(sign.position).toBe('sticky');
    await rowsStayed(page, before);
    const room = sign.inside;
    await settled(page);
    // Read on inside the box to the card that came: the sign goes, and what the box holds is as tall as with it.
    await page.locator('.notices > .notice', { hasText: 'A newer backup' }).locator('strong').evaluate((t) => t.scrollIntoView({ block: 'nearest' }));
    await expect(box).not.toHaveClass(/\bbelow\b/);
    expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(room);
    await rowsStayed(page, before);
  });
}

test("a card that arrives where it is seen shows no sign: alone in the box, or folded into a stack that shows", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A photo was kept as it is', body: 'Photo 0 is kept as it is.' }));
  await expect(page.locator('.notices > .notice')).toHaveCount(1);
  await expect(page.locator('.notices')).not.toHaveClass(/\bbelow\b/);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A photo was kept as it is', body: 'Photo 1 is kept as it is.' }));
  await expect(page.locator('.notice-stack')).toHaveCount(1); // it joins the first: the stack's title, in view, says two
  await expect(page.locator('.notices')).not.toHaveClass(/\bbelow\b/);
});

test("a card that arrives below what is read, then goes by code before it is seen: the sign goes with it", async ({ page }) => {
  const { before } = await openedLongCard(page, [360, 640]);
  await page.evaluate(() => { const w = /** @type {any} */ (window); w.later = w.__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }); });
  await expect(page.locator('.notices')).toHaveClass(/\bbelow\b/);
  await page.evaluate(() => /** @type {any} */ (window).later());
  await expect(page.locator('.notices')).not.toHaveClass(/\bbelow\b/);
  await rowsStayed(page, before);
});

test("a swipe on a stuck card within a px of its own cap scrolls home (360 x 640, a one-line warn card)", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }));
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
  await settled(page);
  const card = page.locator('.notices > .notice');
  if (browserName !== 'chromium') {
    // Playwright's WebKit has neither touch scrolling nor a wheel: there, the rule. However its fit rounds, no card is scrolled by a finger: what it can't
    // show whole grows, and the box scrolls instead.
    expect(await card.evaluate((c) => getComputedStyle(c).overflowY)).not.toMatch(/auto|scroll/);
    return;
  }
  const before = await placeOf(page);
  const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await card.boundingBox());
  const swipe = await fingerOf(page);
  await swipe(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), -80);
  expect((await placeOf(page)).y).toBeGreaterThan(before.y + 30);
});

test("a web font that swaps in after a card was fitted fits it again: its words that no longer show go behind More", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ title: 'An update is ready', body: 'It is used at the next start.' }));
  await settled(page);
  const card = page.locator('.notices > .notice');
  await expect(card.getByRole('button', { name: 'More' })).toBeHidden(); // its words show whole
  // A web font swaps in late and its words take more room (here, larger: two lines where there was one); the browser says a font has loaded.
  await page.evaluate(async () => {
    /** @type {HTMLElement} */ (document.querySelector('.notices .notice p')).style.fontSize = '30px';
    const face = new FontFace('Probe Mono', 'url(/assets/fonts/ibm-plex-mono-400.woff2)');
    document.fonts.add(face);
    await face.load();
  });
  await expect(card.getByRole('button', { name: 'More' })).toBeVisible();
});

for (const size of PHONES) {
  test(`on home, a field focused under the stuck box is scrolled clear of it and of the top bar (${size.join(' x ')})`, async ({ page }) => {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await scrolledHome(page);
    await addBackup(page, 'Place 0');
    await addBackup(page, 'Place 1'); // the box at its cap: half the room under the bar
    await expect(page.locator('.notices > .notice')).toHaveCount(2);
    await settled(page);
    const name = page.getByLabel('Trip name');
    // Scrolled on until Start a trip's name is just under the top bar, under the box.
    await name.evaluate((el) => scrollBy(0, el.getBoundingClientRect().top - /** @type {Element} */ (document.querySelector('.topbar')).getBoundingClientRect().bottom - 20));
    const top = () => name.evaluate((el) => el.getBoundingClientRect().top);
    expect(await top()).toBeLessThan((await boxOf(page)).bottom); // covered
    await name.focus(); // as a keyboard's Tab, or a screen reader, moves to it
    await expect.poll(top).toBeGreaterThanOrEqual((await boxOf(page)).bottom - 1);
    await stuckInHalf(page);
  });
}

test("on home, a button focused inside the stuck box doesn't move the page: what sticks needs no room above it", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await scrolledHome(page);
  await addBackup(page, 'Place 0');
  await addBackup(page, 'Place 1');
  await settled(page);
  const before = await placeOf(page);
  await page.locator('.notices > .notice').first().getByRole('button', { name: 'Dismiss' }).focus();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect((await placeOf(page)).y).toBe(before.y);
});

for (const how of ['two hold cards came on another screen', 'a card opened on home, then one came on another screen']) {
  test(`back on home, a box that holds more than its cap keeps a swipe past its end: ${how}`, async ({ page, browserName }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await scrolledHome(page);
    if (how.startsWith('a card opened')) {
      await page.evaluate(() => /** @type {any} */ (window).__n.card({ title: 'A long card', body: 'These are many words, and more of them. '.repeat(30) }));
      await settled(page);
      await page.getByRole('button', { name: 'More' }).click();
      await expect(page.getByRole('button', { name: 'Less' })).toBeAttached();
    }
    await page.evaluate(() => { location.hash = '#/settings'; }); // there the box has no cap: what it holds is measured as fitting
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    if (how.startsWith('two')) {
      await addBackup(page, 'Place 0');
      await addBackup(page, 'Place 1');
    } else await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }));
    // A visit lasts some frames, as a person's does (WebKit headless can draw none in a few ms, and the box's size changes are seen at frames).
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.goBack();
    await expect(page.locator('.now-line')).toBeVisible();
    const box = page.locator('.notices');
    await expect.poll(() => box.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1); // on home, at its cap: it scrolls inside
    if (browserName !== 'chromium') {
      // Playwright's WebKit has neither touch scrolling nor a wheel: there, the rule itself.
      await expect.poll(() => box.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');
      return;
    }
    await settled(page);
    const before = await placeOf(page);
    const swipe = await fingerOf(page);
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box.boundingBox());
    for (let i = 0; i < 6; i++) await swipe(Math.round(b.x + b.width / 2), Math.round(b.y + b.height - 30), -200); // to the box's end, and past it
    expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await rowsStayed(page, before);
  });
}

for (const by of ['the user, tapping twice', 'code, as the user taps']) {
  for (const [width, height] of PHONES) {
    test(`a card that goes from the stuck box, by ${by}: the hold card that slides into its place ignores the tap meant for the one that went (${width} x ${height})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await scrolledHome(page);
      await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.ran = [];
        w.gone = w.__n.card({ tone: 'warn', title: "Shiori can't reach her model", body: 'The key was refused. Check it in Settings.' }); // taken down when a later turn works
        w.__n.card({ tone: 'warn', title: 'A newer backup is on Test place', body: 'A backup made on another phone is newer than this one. Import it as a copy, or back this phone up over it.',
          actions: [{ label: 'Import it as a copy', primary: true, run() { w.ran.push('import'); } }, { label: 'Back up this phone over it', run() { w.ran.push('over'); } }] });
      });
      await settled(page);
      const d = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('.notices > .notice').first().getByRole('button', { name: 'Dismiss' }).boundingBox());
      const x = d.x + d.width / 2;
      const y = d.y + d.height / 2;
      if (by === 'code, as the user taps') await page.evaluate(() => /** @type {any} */ (window).gone());
      else {
        await page.touchscreen.tap(x, y); // Dismiss
        await page.waitForTimeout(150);
      }
      await page.touchscreen.tap(x, y); // the tap meant for the card that went
      await page.waitForTimeout(450);
      expect(await page.evaluate(() => /** @type {any} */ (window).ran)).toEqual([]);
      await expect(page.locator('.notices > .notice')).toHaveCount(1); // the hold card stays, its buttons untouched
    });
  }
}

test("a stuck card opened on home, then another screen: a card that comes there leaves what is seen where it was", async ({ page }) => {
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ title: 'A long card', body: 'These are many words, and more of them. '.repeat(30) }));
  await expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('button', { name: 'Less' })).toBeVisible();
  await stuckInHalf(page); // opened inside the box, which keeps sticking: home stays where it was
  await page.evaluate(() => { location.hash = '#/settings'; });
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 1600));
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(1200);
  const at = () => page.locator('main h2').first().evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const was = await at();
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' }));
  await expect(page.locator('.notices .notice')).toHaveCount(2);
  expect(Math.abs((await at()) - was)).toBeLessThanOrEqual(1);
});

test("home scrolled, a finger reading an opened stuck card past its end scrolls only the box: the rows behind it stay; a swipe on the rows still scrolls home", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await scrolledHome(page);
  await page.evaluate(() => /** @type {any} */ (window).__n.card({ title: 'A long card', body: 'These are many words, and more of them. '.repeat(30) }));
  await expect.poll(async () => (await placeOf(page)).pos).toBe('sticky');
  await settled(page);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('button', { name: 'Less' })).toBeAttached();
  await settled(page);
  const box = page.locator('.notices');
  if (browserName !== 'chromium') {
    // Playwright's WebKit has neither touch scrolling nor a wheel: there, the rule itself (Safari 16 and later keep a contained swipe in the box).
    expect(await box.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain');
    return;
  }
  const before = await placeOf(page);
  const swipe = await fingerOf(page);
  const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await box.boundingBox());
  const x = Math.round(b.x + b.width / 2);
  for (let i = 0; i < 6; i++) await swipe(x, Math.round(b.y + b.height - 30), -200); // on to the card's end, and past it
  expect(await box.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1); // the card read to its end
  await rowsStayed(page, before);
  for (let i = 0; i < 6; i++) await swipe(x, Math.round(b.y + 30), 200); // back to its top, and past it
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  await rowsStayed(page, before);
  await swipe(x, Math.round(b.y + b.height + 60), -120); // the rows under the box: home scrolls
  expect((await placeOf(page)).y).toBeGreaterThan(before.y + 50);
});

test("a card that lands stuck over the rows ignores taps a moment; the rows it doesn't cover still take them", async ({ page }) => {
  await scrolledHome(page);
  const right = await page.evaluate(() => {
    /** @type {any} */ (window).__n.card({ tone: 'warn', title: 'A test card', body: 'Check the key.' });
    const box = /** @type {HTMLElement} */ (document.querySelector('.notices'));
    return { over: box.classList.contains('over'), card: getComputedStyle(/** @type {Element} */ (box.querySelector('.notice'))).pointerEvents,
      rows: getComputedStyle(/** @type {Element} */ (document.querySelector('main'))).pointerEvents };
  });
  expect(right).toEqual({ over: true, card: 'none', rows: 'auto' });
  await expect(page.locator('.notices.over')).toHaveCount(0); // a moment: 400 ms
});

test("the conversation's name follows its first line while it shows, and Shiori's rename", async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes: { title: 'Quiet dinner' } } }]) },
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'I called it Quiet dinner.' } }, { name: 'sleep', input: {} }]) },
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await plus(page).click();
    const name = page.locator('.talk-head .talk-name');
    await expect(name).toHaveText('New conversation');
    await box(page).fill('Where should we eat tonight? Somewhere quiet.');
    await box(page).press('Enter');
    await expect(name).toHaveText(/^(Where should we eat tonight\?|Quiet dinner)$/); // named by its first line, then hers: the header follows
    await expect(page.locator('.convo')).toContainText('I called it Quiet dinner.');
    await expect(name).toHaveText('Quiet dinner');
  } finally {
    await llm.stop();
  }
});

/** Nine in the morning today, on the page's clock, with a trip happening (Museum at 10:00, Lunch at 12:00), 24 chats, and a month's fold of six old ones. @param {import('@playwright/test').Page} page @param {Record<string, any>} [trips] more trips, as seed takes them */
async function morning(page, trips = {}) {
  const nine = new Date();
  nine.setHours(9, 0, 0, 0);
  await page.clock.install({ time: nine });
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 6; i++) chats[`Old ${i}`] = 60 * 24 * (60 + i);
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats, trips: { Testville: { from: -2, to: 5, items: { Museum: 60, Lunch: 180 } }, ...trips } });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
}

test("home drawn again in place with a card stuck under the top bar: a row that joins under the card doesn't move the rows the user sees", async ({ page }) => {
  await morning(page, { Laterton: { from: 3, to: 4 }, Farville: { from: 10, to: 12 } });
  await page.evaluate(() => dispatchEvent(new ErrorEvent('error', { error: new Error('A test card') })));
  await expect(page.locator('.notices .notice')).toBeVisible();
  await expect(page.locator('.notices.landed, .notices.over')).toHaveCount(0);
  // The user scrolled on to what is ahead: the now line, and the newest chats over it, are under the card.
  await page.evaluate(() => {
    const box = /** @type {Element} */ (document.querySelector('.notices')).getBoundingClientRect();
    scrollBy(0, /** @type {Element} */ (document.querySelector('.now-line')).getBoundingClientRect().top - (box.top + box.height / 2));
  });
  const topOf = () => row(page, 'Testville').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const was = await topOf();
  const box = await page.locator('.notices').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(await row(page, 'Testville').evaluate((el) => el.getBoundingClientRect().bottom)).toBeGreaterThan(box + 40); // in view, under the card
  // A chat talked in just now joins the past's end, under the card; then Next ends and home is drawn again in place.
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const store = await createIdbStore();
    const id = await createTrip(new Workspace(store), { title: 'Just now' });
    await record(store, id, { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Just now']], now: Date.now() });
    store.close();
  });
  await page.clock.fastForward('01:31:00');
  await expect(row(page, 'Just now')).toHaveCount(1);
  expect(Math.abs((await topOf()) - was)).toBeLessThanOrEqual(1);
});

test("a trip card's Next and its day follow the clock while home stays open, with no jump and no fold shut", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  await expect(card.locator('.next')).toContainText('Museum');
  await expect(card.locator('.day-of')).toHaveText('Day 3 of 8');
  await page.locator('.rows > .fold details summary').click();
  await expect(page.locator('.rows > .fold details')).toHaveAttribute('open', '');
  await row(page, 'Chat 20').scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  await page.clock.fastForward('01:31:00'); // Museum (10:00, half an hour) is over
  await expect(card.locator('.next')).toContainText('Lunch');
  await expect(page.locator('.rows > .fold details')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => scrollY)).toBe(y);
  await page.clock.fastForward('15:00:00'); // past midnight
  await expect(card.locator('.day-of')).toHaveText('Day 4 of 8');
  await expect(page.locator('.rows > .fold details')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => scrollY)).toBe(y);
});

test("a trip card follows the clock when annai comes back to the front after a while, though a trip name was left half-typed, which is still there", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  await expect(card.locator('.next')).toContainText('Museum');
  const back = async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };
  await page.getByLabel('Trip name').fill('Tokyo');
  await page.getByLabel('Trip name').blur(); // left half-typed: the keyboard goes
  const noon = new Date();
  noon.setHours(11, 0, 0, 0);
  await page.clock.setSystemTime(noon); // the phone was locked: no timer ran
  await back();
  await expect(card.locator('.next')).toContainText('Lunch'); // a name left in the form holds no fact back: Museum is over
  await expect(page.getByLabel('Trip name')).toHaveValue('Tokyo');
});

test('home while she works: the dock says the name of the conversation as it is now (the first line names it; a rename in Details)', async ({ page }) => {
  const speak = anthropicToolReply([{ name: 'speak', input: { text: 'The pier is a short walk.' } }, { name: 'sleep', input: {} }]);
  const llm = await startModelServer({ '/b/v1/messages': { status: 200, type: 'text/event-stream', body: speak, delayMs: 25_000 } });
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await plus(page).click();
    const id = draftOf(page.url());
    await box(page).fill('Where is the pier?');
    await box(page).press('Enter');
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(0); // her turn waits on the model
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(page.locator('.dock .in-convo')).toHaveText('In Where is the pier? ›');
    await page.goto(`/#/trip/${id}`); // Details, while her turn goes on
    await page.getByLabel('Name', { exact: true }).fill('Harbour');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.goto('/#/trips');
    await expect(page.locator('body')).toHaveClass(/\bdock-busy\b/); // her turn is still on
    await expect(page.locator('.dock .in-convo')).toHaveText('In Harbour ›');
  } finally {
    await llm.stop();
  }
});

test("the cutoff day of the day headings: its chats all show a time alone, whichever side of the hour they are", async ({ page }) => {
  const three = new Date();
  three.setHours(15, 0, 0, 0);
  await page.clock.install({ time: three });
  await openApp(page, '#/settings');
  // 30 days back is the first day with a heading of its own: one chat before the time of day now (13:00), one after (16:00).
  await seed(page, { chats: { Early: 30 * 1440 + 120, Late: 30 * 1440 - 60 } });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  const subs = await page.locator('.past .trip-card .sub').allTextContents();
  expect(subs).toHaveLength(2);
  for (const sub of subs) expect(sub).not.toContain(','); // no month and day, which the day's heading says
});

test('home drawn again past midnight keeps the row you were looking at, though a day went into its month\'s fold above it', async ({ page }) => {
  const late = new Date();
  late.setHours(23, 58, 30, 0);
  await page.clock.install({ time: late });
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 5; i++) chats[`Edge ${i}`] = 30 * 1440 + 60 + i; // on the last day with a heading of its own: after midnight, in its month's fold
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 1440 * i + 5;
  await seed(page, { chats });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await expect(row(page, 'Edge 0')).toBeVisible();
  const at = () => row(page, 'Chat 3').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await at();
  await page.clock.fastForward('02:00');
  await expect(row(page, 'Edge 0')).toBeHidden(); // in the month's fold, shut
  expect(Math.abs((await at()) - before)).toBeLessThanOrEqual(1); // a device pixel's rounding
});

test('home drawn again past midnight, scrolled to the rows that go into the fold: the rows under them stay where they were', async ({ page }) => {
  const late = new Date();
  late.setHours(23, 58, 30, 0);
  await page.clock.install({ time: late });
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let m = 1; m <= 8; m++) for (let i = 0; i < 4; i++) chats[`Old ${m}-${i}`] = 1440 * (31 + 31 * m + i); // months of folds above: room to scroll back
  for (let i = 0; i < 5; i++) chats[`Edge ${i}`] = 30 * 1440 + 60 + i;
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 1440 * i + 5;
  await seed(page, { chats });
  await page.goto('/#/trips');
  await expect(page.locator('.now-line')).toBeVisible();
  await row(page, 'Edge 4').evaluate((el) => scrollBy(0, el.getBoundingClientRect().top - 60)); // the first row in view is one that folds
  const at = () => row(page, 'Chat 23').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await at();
  await page.clock.fastForward('02:00');
  await expect(row(page, 'Edge 0')).toBeHidden();
  expect(Math.abs((await at()) - before)).toBeLessThanOrEqual(1);
});

test("a redraw skipped over typing comes once the field is left: the card is right, and what was typed is still there, with no lock and unlock", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  const name = page.getByLabel('Trip name');
  await expect(card.locator('.next')).toContainText('Museum');
  await name.click();
  await page.keyboard.type('Tokyo');
  await page.clock.fastForward('01:31:00'); // Museum is over: the redraw waits for the typing
  await page.waitForTimeout(300);
  await expect(card.locator('.next')).toContainText('Museum');
  // Cleared to be typed again: the field keeps its focus and what is typed next.
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  await page.keyboard.type('Kyoto');
  await expect(name).toHaveValue('Kyoto');
  await expect(name).toBeFocused();
  await expect(card.locator('.next')).toContainText('Museum');
  await name.blur();
  await expect(card.locator('.next')).toContainText('Lunch');
  await expect(name).toHaveValue('Kyoto');
});

test("the clock's redraw waits while a field of Start a trip has focus, empty: the keyboard stays up", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  const name = page.getByLabel('Trip name');
  await page.getByText('Add dates (optional)').click();
  await name.focus();
  await page.clock.fastForward('01:31:00');
  await page.waitForTimeout(300);
  await expect(name).toBeFocused();
  await expect(card.locator('.next')).toContainText('Museum');
  await page.getByLabel('Starts').focus(); // on to another field of the form: it waits still
  await page.waitForTimeout(300);
  await expect(page.getByLabel('Starts')).toBeFocused();
  await page.getByLabel('Starts').blur();
  await expect(card.locator('.next')).toContainText('Lunch');
});

test("a row tapped while a redraw waits for the form opens that row's conversation", async ({ page }) => {
  await morning(page);
  await page.getByLabel('Trip name').focus();
  await page.clock.fastForward('01:31:00'); // the redraw waits, for the focus
  await page.waitForTimeout(300);
  await row(page, 'Chat 5').click(); // the focus leaves as the tap moves on
  await expect(page.locator('.talk-name')).toHaveText('Chat 5');
  await page.waitForTimeout(500);
  await expect(page.locator('.talk-name')).toHaveText('Chat 5');
});

test("the Start a trip form's Add dates fold stays open across the clock's redraw", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  await page.getByText('Add dates (optional)').click();
  await expect(page.locator('details.dates')).toHaveAttribute('open', '');
  await page.clock.fastForward('01:31:00');
  await expect(card.locator('.next')).toContainText('Lunch'); // drawn again
  await expect(page.locator('details.dates')).toHaveAttribute('open', '');
});

test("the Start a trip form's error stays across the clock's redraw, until the user types into the form or leaves home", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  const error = page.locator('form.panel p.error');
  await page.getByRole('button', { name: 'Start trip' }).click(); // no name
  await expect(error).toHaveText('Give the trip a name.');
  await page.clock.fastForward('01:31:00');
  await expect(card.locator('.next')).toContainText('Lunch'); // drawn again
  await expect(error).toHaveText('Give the trip a name.'); // not wiped by it
  await page.getByLabel('Trip name').fill('Kyoto');
  await expect(error).toBeHidden(); // the user types: it goes, and a redraw doesn't bring it back
  await page.getByLabel('Trip name').fill('');
  await page.getByLabel('Trip name').blur();
  await page.clock.fastForward('02:00:00');
  await expect(error).toBeHidden();
  // Leaving home takes it too: Start trip with no name, on to Settings and back.
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(error).toHaveText('Give the trip a name.');
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.goBack();
  await expect(page.locator('.now-line')).toBeVisible();
  await expect(error).toBeHidden();
});

test("the Start a trip form's error is a new alert once, when first said: home drawn again with it kept draws it as words, not an alert a screen reader reads out again", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  const error = page.locator('form.panel p.error');
  // What a screen reader would hear: an alert (role) put on the page with words, or words put in one, counted as a change touches one.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.said = 0;
    const alertOf = (/** @type {Node} */ n) => { const el = n instanceof Element ? n : n.parentElement; return el?.closest('[role=alert]') ?? el?.querySelector('[role=alert]') ?? null; };
    new MutationObserver((records) => { for (const r of records) if ([r.target, ...r.addedNodes].some((n) => alertOf(n)?.textContent)) w.said++; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const said = () => page.evaluate(() => /** @type {any} */ (window).said);
  await page.getByRole('button', { name: 'Start trip' }).click(); // no name
  await expect(page.getByRole('alert')).toHaveText('Give the trip a name.'); // first said: an alert
  expect(await said()).toBe(1);
  await page.clock.fastForward('01:31:00');
  await expect(card.locator('.next')).toContainText('Lunch'); // drawn again
  await expect(error).toHaveText('Give the trip a name.'); // kept, in view
  await expect(page.getByRole('alert')).toHaveCount(0); // as words: before, drawn again as a new alert
  expect(await said()).toBe(1);
  // Said again after that (Start trip, still no name): an alert once more.
  await page.getByRole('button', { name: 'Start trip' }).click();
  await expect(page.getByRole('alert')).toHaveText('Give the trip a name.');
  expect(await said()).toBe(2);
});

test("a card's \"backed up … ago\" follows the clock on its own moment, whatever the footer line says", async ({ page }) => {
  await morning(page); // no place, no export: the footer says "No backup yet"
  // A trip marked by a backup whose place has since gone (or a backup that finished out of order): nothing but the card says when.
  await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const store = await createIdbStore();
    await store.tx(['scopes', 'events'], 'readwrite', async (/** @type {any} */ t) => {
      const rec = (await t.listScopes()).find((/** @type {any} */ s) => s.title === 'Testville');
      await t.putScope({ ...rec, backup: { at: Date.now() - 90_000, seq: await t.lastSeq(rec.id) } });
    });
    store.close();
  });
  await page.goto('/#/settings');
  await page.goto('/#/trips');
  const card = row(page, 'Testville');
  await expect(card).toContainText('backed up 2 minutes ago');
  await expect(page.getByText('No backup yet')).toBeVisible();
  await page.clock.fastForward('03:00'); // 4 and a half minutes after it
  await expect(card).toContainText(/backed up [45] minutes ago/);
});

test("home's \"backed up … ago\" and its last export's change their words in place as the clock moves: home isn't drawn again for them", async ({ page }) => {
  await morning(page); // no place: the footer says when the last export was
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { updateAppSettings } = await load('/src/core/settings.js');
    const store = await createIdbStore();
    await store.tx(['scopes', 'events'], 'readwrite', async (/** @type {any} */ t) => {
      const rec = (await t.listScopes()).find((/** @type {any} */ s) => s.title === 'Testville');
      await t.putScope({ ...rec, backup: { at: Date.now() - 90_000, seq: await t.lastSeq(rec.id) } });
    });
    await updateAppSettings(new Workspace(store), { lastExportAt: Date.now() - 90_000 });
    store.close();
  });
  await page.goto('/#/settings');
  await page.goto('/#/trips');
  const card = row(page, 'Testville');
  await expect(card).toContainText('backed up 2 minutes ago');
  await expect(page.getByText('Last export 2 minutes ago.')).toBeVisible();
  await page.locator('.screen.timeline').evaluate((el) => { el.dataset.drawn = 'once'; }); // this drawing of home
  await page.clock.fastForward('03:00');
  await expect(card).toContainText(/backed up [45] minutes ago/);
  await expect(page.getByText(/^Last export [45] minutes ago\.$/)).toBeVisible();
  await expect(page.locator('.screen.timeline[data-drawn=once]')).toHaveCount(1); // the same home: its words changed in place
  await expect(card.locator('.next')).toContainText('Museum'); // and a fact that hasn't changed is still there
});

test("a simulation played at ten times real time: home is drawn again when a Next ends on its clock, not ten times late", async ({ page }) => {
  const nine = new Date();
  nine.setHours(9, 0, 0, 0);
  await page.clock.install({ time: nine });
  // The real shell with a real store, its live mode a stand-in on a simulation's clock at ten times real time.
  await page.route('**/probe.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>' }));
  await page.goto('/probe.html#/trips');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p; // an address the browser loads, not a module the checker follows
    const { startShell } = await import(at('/src/ui/shell.js'));
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { PlayClock } = await import(at('/src/core/live/clock.js'));
    const { dayIn, deviceZone, isoInZone } = await import(at('/src/core/time.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const zone = deviceZone();
    const id = await createTrip(ws, { title: 'Testville', start: dayIn(Date.now() - 2 * 86_400_000, zone), end: dayIn(Date.now() + 5 * 86_400_000, zone) });
    for (const [name, min] of /** @type {[string, number][]} */ ([['Museum', 60], ['Lunch', 180]])) await ws.write(id, `/plan/${name}.json`, { id: name, title: name, fixed: true, start: { at: isoInZone(Date.now() + min * 60_000, zone), tz: zone } }, { author: 'user' });
    const live = { clock: new PlayClock(Date.now(), { speed: 10 }), timeZone: () => zone, onChange() {}, onReminders() {} };
    const registry = { entries: () => [], onChange: () => () => {}, fail: () => {}, succeeded: () => {}, isDisabled: () => false, clashes: () => [] };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    startShell(root, { store, ws, registry, live, plugins: { langOf: () => 'en' }, updates: { restart: async () => {}, waiting: false, plugins: async () => [] }, version: 'probe' });
  });
  const card = row(page, 'Testville');
  await expect(card.locator('.next')).toContainText('Museum');
  await page.clock.fastForward('09:30'); // 95 minutes on the simulation's clock: Museum (10:00, half an hour) is over
  await expect(card.locator('.next')).toContainText('Lunch');
});

test("home's Start a trip error doesn't hold back the shell's own redraw (a plugin's screen arrived, Shiori started a trip): home shows the trip, and keeps the dates typed", async ({ page }) => {
  // The real shell with a real store, and a registry the test can change: the shell draws again when what plugins add changes (as when Shiori opens a trip).
  await page.route('**/probe.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>' }));
  await page.goto('/probe.html#/trips');
  await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const at = (/** @type {string} */ p) => p; // an address the browser loads, not a module the checker follows
    const { startShell } = await import(at('/src/ui/shell.js'));
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    w.store = await createIdbStore();
    w.ws = new Workspace(w.store);
    w.screens = [];
    const registry = { entries: (/** @type {string} */ k) => (k === 'ui:screen' ? w.screens : []), onChange: (/** @type {() => void} */ fn) => { w.changed = fn; return () => {}; }, fail: () => {}, succeeded: () => {}, isDisabled: () => false, clashes: () => [] };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    startShell(root, { store: w.store, ws: w.ws, registry, plugins: { langOf: () => 'en' }, updates: { restart: async () => {}, waiting: false, plugins: async () => [] }, version: 'probe' });
  });
  await page.getByText('Add dates (optional)').click();
  await page.getByLabel('Starts').fill('2026-11-20');
  await page.getByLabel('Ends').fill('2026-11-27');
  await page.getByRole('button', { name: 'Start trip' }).click(); // no name
  await expect(page.locator('form.panel p.error')).toHaveText('Give the trip a name.');
  await page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const at = (/** @type {string} */ p) => p;
    const { createTrip } = await import(at('/src/core/scopes.js'));
    await createTrip(w.ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-27' });
    w.screens = [{ pluginId: 'probe', item: { id: 'a', title: 'A', render: (/** @type {any} */ body) => { body.textContent = 'ext A'; } } }];
    w.changed();
  });
  await expect(page.getByText('Testville').first()).toBeVisible({ timeout: 5000 }); // home drawn again, with no keystroke or leaving
  await expect(page.locator('form.panel p.error')).toHaveText('Give the trip a name.'); // the error stays
  // The redraw didn't wait for the form, so it keeps what was typed in it: the user adds a name and starts the trip they meant.
  await expect(page.getByLabel('Starts')).toHaveValue('2026-11-20');
  await expect(page.getByLabel('Ends')).toHaveValue('2026-11-27');
});

test("a trip ahead says how soon in days, as its dates are: one that starts tomorrow says \"tomorrow\" all day, then it is happening", async ({ page }) => {
  await morning(page, { Laterton: { from: 1, to: 2 }, Farville: { from: 3, to: 4 } });
  const soon = row(page, 'Laterton').locator('.soon');
  await expect(soon).toHaveText('tomorrow');
  await expect(row(page, 'Farville').locator('.soon')).toHaveText('in 3 days');
  await page.clock.fastForward('05:00:00'); // 14:00; home was drawn again as Museum and Lunch ended
  await expect(row(page, 'Testville').locator('.next')).toHaveCount(0);
  await expect(soon).toHaveText('tomorrow'); // never "in 22 hours": the trip has a date, not an hour
  await page.clock.fastForward('09:30:00'); // 23:30
  await expect(soon).toHaveText('tomorrow');
  await expect(row(page, 'Farville').locator('.soon')).toHaveText('in 3 days');
  await page.clock.fastForward('01:00:00'); // past midnight: its first day
  await expect(row(page, 'Laterton')).toHaveClass(/\bhappening\b/);
  await expect(row(page, 'Farville').locator('.soon')).toHaveText('in 2 days');
});

test("the dock's name of the open conversation has one source, trip.json: a state change never shows the record's older title", async ({ page }) => {
  const speak = (/** @type {string} */ text) => anthropicToolReply([{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }]);
  const llm = await startModelServer({ '/b/v1/messages': [
    { status: 200, type: 'text/event-stream', body: speak('Down the road.') },
    { status: 200, type: 'text/event-stream', body: speak('The market is open.'), delayMs: 25_000 },
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await plus(page).click();
    const id = draftOf(page.url());
    await box(page).fill('Where is the pier?');
    await box(page).press('Enter');
    await expect(page.locator('.convo')).toContainText('Down the road.');
    await expect(page.locator('.talk-name')).toHaveText('Where is the pier?');
    // The record's mirror of the title lags trip.json's by a moment, as it does while a first line names a chat: made stale by hand here.
    await page.evaluate(async (id) => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const store = await createIdbStore();
      await store.tx(['scopes'], 'readwrite', async (/** @type {any} */ t) => t.putScope({ ...(await t.getScope(id)), title: 'Older name' }));
      store.close();
    }, id);
    await box(page).isVisible() || await page.getByRole('button', { name: 'Type', exact: true }).click();
    await box(page).fill('And the market?');
    await page.getByRole('button', { name: 'Send', exact: true }).click(); // a state change, after the record went stale
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBeGreaterThan(1);
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(page.locator('body')).toHaveClass(/\bdock-busy\b/);
    await expect(page.locator('.dock .in-convo')).toHaveText('In Where is the pier? ›');
  } finally {
    await llm.stop();
  }
});

test("Shiori set the dates stays at its place when the user writes again, and after a reload: its Undo, tapped late, still takes the dates back", async ({ page }) => {
  await openApp(page, '#/trips');
  const [start, end] = await page.evaluate(async () => {
    const { dayIn, deviceZone } = await import(/** @type {string} */ ('/src/core/time.js'));
    return [10, 12].map((n) => dayIn(Date.now() + n * 86_400_000, deviceZone()));
  });
  const reply = [
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'patch', input: { path: '/trip/trip.json', changes: { title: 'Testville', start, end } } }]) },
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'I set it for the 10th to the 12th.' } }, { name: 'sleep', input: {} }]) },
    { status: 200, type: 'text/event-stream', body: anthropicToolReply([{ name: 'speak', input: { text: 'Dinner is at seven.' } }, { name: 'sleep', input: {} }]) },
  ];
  const llm = await startModelServer({ '/b/v1/messages': reply });
  /** The conversation's lines, in order: their words, or a system line's text. */
  const lines = () => page.locator('.convo > li').evaluateAll((els) => els.map((el) => (el.querySelector('p') ?? el).textContent?.replace(/\s+/g, ' ').trim()));
  const placed = ['Plan our weekend in Testville', 'I set it for the 10th to the 12th.', 'Shiori set the dates Undo', 'And dinner?', 'Dinner is at seven.'];
  try {
    await modelSetUp(page, llm.origin, 'Elsewhere');
    await page.goto('/#/trips');
    await plus(page).click();
    const id = draftOf(page.url());
    await box(page).fill('Plan our weekend in Testville');
    await box(page).press('Enter');
    const line = page.locator('.dates-line');
    await expect(line).toContainText('Shiori set the dates');
    await expect(page.locator('.convo')).toContainText('I set it for the 10th to the 12th.');
    await box(page).isVisible() || await page.getByRole('button', { name: 'Type', exact: true }).click();
    await box(page).fill('And dinner?');
    await box(page).press('Enter');
    await expect(page.locator('.convo')).toContainText('Dinner is at seven.');
    await expect(line).toBeVisible();
    await expect.poll(lines).toEqual(placed);
    await page.reload();
    await expect(page.locator('.convo')).toContainText('Dinner is at seven.');
    await expect(page).toHaveURL(new RegExp(`#/trip/${id}/talk$`));
    await expect.poll(lines).toEqual(placed);
    await line.getByRole('button', { name: 'Undo' }).click();
    await expect(line).toBeHidden();
    await expect(page.locator('.toasts').getByText('Undone.', { exact: true })).toBeVisible(); // said, as the hand-over's Undo is
    await page.getByRole('link', { name: 'Back to Trips' }).click();
    await expect(row(page, 'Testville')).toHaveClass(/\bline\b/);
  } finally {
    await llm.stop();
  }
});

test("the draft's Details: a name and dates saved there put it on home; Archive and Remove there leave + opening a new conversation, never one archived or gone", async ({ page }) => {
  await openApp(page, '#/trips');
  const details = async () => {
    await plus(page).click();
    await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
    const id = draftOf(page.url());
    await page.locator('.talk-name').click();
    await expect(page.getByRole('button', { name: 'Remove trip' })).toBeVisible();
    return id;
  };
  // Named and dated in Details, with no line said: a card on home, and no longer the draft.
  const named = await details();
  await page.getByLabel('Name', { exact: true }).fill('Testville in April');
  await page.getByLabel('Starts').fill('2099-04-02');
  await page.getByLabel('Ends').fill('2099-04-09');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(async () => (await record(page, named))?.draft).toBeUndefined();
  await page.goto('/#/trips');
  await expect(row(page, 'Testville in April')).toHaveCount(1);
  await expect(row(page, 'Testville in April')).not.toHaveClass(/\bline\b/);
  // Archived in Details: it is in Archived trips, and + opens another.
  const archived = await details();
  expect(archived).not.toBe(named);
  await page.getByRole('button', { name: 'Archive trip' }).click();
  await page.getByRole('button', { name: 'Tap again to archive' }).click();
  await expect(page.getByText('Archived trips (1)')).toBeVisible();
  // Removed in Details: + opens another, and its first line is a row on home.
  const removed = await details();
  expect(removed).not.toBe(archived);
  await page.getByRole('button', { name: 'Remove trip' }).click();
  await page.getByRole('dialog', { name: 'New conversation' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Not backed up' }).getByRole('button', { name: 'Remove anyway' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await record(page, removed)).toBeUndefined();
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  const fresh = draftOf(page.url());
  expect([named, archived, removed]).not.toContain(fresh);
  expect((await record(page, fresh))?.status).toBe('active');
  await box(page).fill('Where is the ramen place?');
  await box(page).press('Enter');
  await expect.poll(async () => (await record(page, fresh))?.title).toBe('Where is the ramen place?');
  await page.goto('/#/trips');
  await expect(row(page, 'Where is the ramen place?')).toHaveCount(1);
  await expect(page.getByText('Archived trips (1)')).toBeVisible(); // still only the one the user archived
});

test("a trip file whose dates aren't on the calendar (9999-99-99) comes in as a trip with none: home, its conversation, Details and Itinerary open", async ({ page }) => {
  // A hand-made file: its workspace has no schema, as an archive's import has none for the files inside.
  const { createMemoryStore } = await import('../fakes/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes, createTrip } = await import('../../src/core/scopes.js');
  const { exportArchive, PRESETS } = await import('../../src/core/archive.js');
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  await ws.patch(trip, '/trip.json', { start: '9999-99-99', end: '9999-99-99' }, { author: 'user' });
  const { blob } = await exportArchive(store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  await openApp(page, '#/trips');
  await page.getByLabel('Open a trip someone sent you').setInputFiles({ name: 'testville.annai.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(page.getByRole('heading', { name: 'Open a trip' })).toBeVisible();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Imported.')).toBeVisible();
  const couldnt = page.getByText("This screen couldn't open");
  await page.goto('/#/trips');
  await expect(row(page, 'Testville')).toHaveCount(1);
  await expect(couldnt).toHaveCount(0);
  await row(page, 'Testville').click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  await page.locator('.talk-name').click();
  await expect(page.getByRole('button', { name: 'Remove trip' })).toBeVisible();
  const itinerary = page.locator('#view').getByRole('link', { name: 'Itinerary' });
  await expect(itinerary).toBeVisible();
  await expect(page.getByLabel('Starts')).toHaveValue('');
  await itinerary.click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/plan$/);
  await expect(page.locator('#view').getByRole('heading', { level: 1, name: 'Itinerary' })).toBeVisible();
  await expect(couldnt).toHaveCount(0);
});

test("Details of a trip that came in with dates that aren't on the calendar: the dates read blank, and a new name saved there takes them out", async ({ page }) => {
  // A hand-made file, as above: its workspace has no schema.
  const { createMemoryStore } = await import('../fakes/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes, createTrip } = await import('../../src/core/scopes.js');
  const { exportArchive, PRESETS } = await import('../../src/core/archive.js');
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const trip = await createTrip(ws, { title: 'Testville', start: '2026-11-20', end: '2026-11-22' });
  await ws.patch(trip, '/trip.json', { start: '9999-99-99', end: '2026-02-31' }, { author: 'user' });
  const { blob } = await exportArchive(store, { kind: 'trip', scopes: [trip], include: PRESETS.share, app: '0.1.0' });
  await openApp(page, '#/trips');
  await page.getByLabel('Open a trip someone sent you').setInputFiles({ name: 'testville.annai.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Imported.')).toBeVisible();
  await page.goto('/#/trips');
  await row(page, 'Testville').click();
  await page.locator('.talk-name').click();
  await expect(page.getByLabel('Starts')).toHaveValue('');
  await expect(page.getByLabel('Ends')).toHaveValue('');
  await page.getByLabel('Name', { exact: true }).fill('Testville weekend');
  await page.getByRole('button', { name: 'Save' }).click();
  // Saved, not "Use real dates for the start and end." over two blank fields.
  await expect(page.getByRole('heading', { level: 1, name: 'Testville weekend' })).toBeVisible();
  await expect(page.locator('.trip-edit .error')).toBeHidden();
  const id = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  const file = await page.evaluate(async (id) => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const json = await new Workspace(store).readJSON(id, '/trip.json');
    store.close();
    return json;
  }, id);
  expect([file.title, 'start' in file, 'end' in file]).toEqual(['Testville weekend', false, false]);
  await page.goto('/#/trips');
  await expect(row(page, 'Testville weekend')).toHaveCount(1);
});

test("a conversation stored as \"New conversation\" says it in the screens' language on its card, as the heading of its Details, its Export panel's and in its Remove dialog", async ({ page }) => {
  const { accented } = await import('../../src/core/l10n-pseudo.js');
  await openApp(page, '?l10n=en-XA#/settings');
  await seed(page, { trips: { 'New conversation': { from: 3, to: 4 } } }); // one a date in Details left unnamed: dated, so a card
  await page.goto('/?l10n=en-XA#/trips');
  const name = accented('New conversation');
  await expect(row(page, name)).toHaveCount(1);
  await expect(row(page, name).locator('.name')).toHaveText(name);
  await row(page, name).click();
  await page.locator('.talk-name').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await page.getByRole('button', { name: accented('Export trip') }).click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible(); // its Export panel's heading too
  await page.getByRole('button', { name: accented('Remove trip') }).click();
  await expect(page.getByRole('dialog', { name })).toBeVisible();
});

test("Details of a conversation stored as \"New conversation\": its name field is empty with the screens' words as its placeholder, Save with it empty keeps the stored name, and a name typed there is saved", async ({ page }) => {
  const { accented } = await import('../../src/core/l10n-pseudo.js');
  await openApp(page, '?l10n=en-XA#/settings');
  const ids = await seed(page, { trips: { 'New conversation': { from: 3, to: 4 } } }); // dated in Details, never named
  await page.goto('/?l10n=en-XA#/trips');
  const name = accented('New conversation');
  await row(page, name).click();
  await page.locator('.talk-name').click();
  const field = page.locator('#trip-edit-title');
  await expect(field).toHaveValue(''); // before: the stored English words, in an accented screen
  await expect(field).toHaveAttribute('placeholder', name);
  // Dates changed, the name left empty: saved, not "Give the trip a name."; the stored name stays, so it still follows the screens' language.
  await page.getByLabel(accented('Ends')).fill('2099-01-02');
  await page.getByLabel(accented('Starts')).fill('2099-01-01');
  await page.getByRole('button', { name: accented('Save') }).click();
  await expect(page.getByText(accented('Saved.'))).toBeVisible();
  await expect(page.locator('.trip-edit .error')).toBeHidden();
  expect((await record(page, ids['New conversation']))?.title).toBe('New conversation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(field).toHaveValue('');
  // A name typed: saved.
  await field.fill('Kyoto in spring');
  await page.getByRole('button', { name: accented('Save') }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kyoto in spring' })).toBeVisible();
  await expect.poll(async () => (await record(page, ids['New conversation']))?.title).toBe('Kyoto in spring');
  // A trip with a name of its own still can't be saved without one.
  await field.fill('  ');
  await page.getByRole('button', { name: accented('Save') }).click();
  await expect(page.locator('.trip-edit .error')).toHaveText(accented('Give the trip a name.'));
});

/** A trip's last backup, as a backup writes it: ago ms before now, and whether the trip changed since. @param {import('@playwright/test').Page} page @param {string} title @param {number} ago @param {boolean} [changed] */
const backedUpAgo = (page, title, ago, changed = false) => page.evaluate(async ({ title, ago, changed }) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  await store.tx(['scopes', 'events'], 'readwrite', async (/** @type {any} */ t) => {
    const rec = (await t.listScopes()).find((/** @type {any} */ s) => s.title === title);
    await t.putScope({ ...rec, backup: { at: Date.now() - ago, seq: (await t.lastSeq(rec.id)) - (changed ? 1 : 0) } });
  });
  store.close();
}, { title, ago, changed });

test("an export 46 days ago, or a trip backed up 400 days ago: home waits for their words' next change without a timer loop (setTimeout holds 24.8 days)", async ({ page }) => {
  await page.addInitScript(() => {
    const w = /** @type {any} */ (window);
    w.overLong = 0;
    const real = w.setTimeout.bind(w);
    w.setTimeout = (/** @type {any} */ fn, /** @type {number} */ ms, /** @type {any[]} */ ...a) => { if (ms > 2 ** 31 - 1) w.overLong++; return real(fn, ms, ...a); };
  });
  await openApp(page, '#/settings');
  await seed(page, { trips: { Oldtown: { from: -400, to: -398 } } });
  await backedUpAgo(page, 'Oldtown', 400 * 86_400_000);
  await page.evaluate(async () => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { updateAppSettings } = await load('/src/core/settings.js');
    const store = await createIdbStore();
    await updateAppSettings(new Workspace(store), { lastExportAt: Date.now() - 46 * 86_400_000 });
    store.close();
  });
  await page.goto('/#/settings');
  await page.goto('/#/trips');
  await expect(page.getByText('Last export 2 months ago.')).toBeVisible();
  await expect(row(page, 'Oldtown')).toContainText('backed up last year');
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => /** @type {any} */ (window).overLong)).toBe(0); // before: about 120 a second, one after another
});

test("the phone's zone changes while annai is away (a flight): back at the front, home is drawn in the new zone", async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', "the zone of a page that runs is changed through Chromium's DevTools protocol");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Pacific/Honolulu' });
  await openApp(page, '#/settings');
  await seed(page, { chats: { Ramen: 30 } });
  await page.goto('/#/trips');
  const time = () => row(page, 'Ramen').locator('.sub').textContent();
  const was = await time();
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' }); // 19 hours ahead
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
  await expect.poll(time).not.toBe(was);
});

test("a card's \"backed up … ago\" above the rows in view takes another line as its words change: the rows the user sees stay where they were", async ({ page }) => {
  const nine = new Date();
  nine.setHours(9, 0, 0, 0);
  await page.clock.install({ time: nine });
  await openApp(page, '#/settings');
  /** @type {Record<string, number>} */
  const chats = {};
  for (let i = 0; i < 24; i++) chats[`Chat ${i}`] = 60 * 24 * i + 5;
  await seed(page, { chats, trips: { Testville: { from: -2, to: 5, items: { Museum: 300 } }, Laterton: { from: 3, to: 4 }, Farville: { from: 10, to: 12 }, Nexton: { from: 20, to: 22 }, Lastburg: { from: 30, to: 31 } } });
  await backedUpAgo(page, 'Testville', 40_000, true); // "backed up just now, changed since"; "1 minute ago" in 20 s
  await page.goto('/#/settings');
  await page.goto('/#/trips');
  await expect(row(page, 'Testville')).toContainText('backed up just now');
  // A width where "1 minute ago" takes a line more on this card than "just now" (350 to 355 px, as measured).
  let width = 0;
  for (let w = 330; w <= 420 && !width; w++) {
    await page.setViewportSize({ width: w, height: 740 });
    if (await row(page, 'Testville').evaluate((card) => {
      const sub = /** @type {HTMLElement} */ (card.querySelector('.trip-card-text > .sub'));
      const kids = [...sub.childNodes]; // put back as they were: home keeps writing to its own node
      const was = card.getBoundingClientRect().height;
      sub.textContent = String(sub.textContent).replace('just now', '1 minute ago');
      const grows = card.getBoundingClientRect().height > was;
      sub.replaceChildren(...kids);
      return grows;
    })) width = w;
  }
  expect(width).toBeGreaterThan(0);
  await page.setViewportSize({ width, height: 740 });
  // Read on past Testville: it is above the top bar, the trips ahead in view.
  await row(page, 'Testville').evaluate((el) => scrollBy(0, el.getBoundingClientRect().bottom - /** @type {Element} */ (document.querySelector('.topbar')).getBoundingClientRect().bottom + 20));
  const topOf = () => row(page, 'Farville').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await topOf();
  await page.clock.fastForward('00:25');
  await expect(row(page, 'Testville')).toContainText('backed up 1 minute ago');
  expect(Math.abs((await topOf()) - before)).toBeLessThanOrEqual(1); // before: 21 px down, under a finger about to tap
});

test("an automatic backup that ends while home shows: the card says so, not \"changed since\" from the one before", async ({ page }) => {
  // The real shell with a real store, its backups a stand-in that says when one ends.
  await page.route('**/probe.html', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body></body></html>' }));
  await page.goto('/probe.html#/trips');
  await page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p; // an address the browser loads, not a module the checker follows
    const w = /** @type {any} */ (window);
    const { startShell } = await import(at('/src/ui/shell.js'));
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const { Workspace } = await import(at('/src/core/workspace.js'));
    const { createTrip } = await import(at('/src/core/scopes.js'));
    const { dayIn, deviceZone } = await import(at('/src/core/time.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const id = await createTrip(ws, { title: 'Testville', start: dayIn(Date.now() - 2 * 86_400_000, deviceZone()), end: dayIn(Date.now() + 5 * 86_400_000, deviceZone()) });
    await store.tx(['scopes', 'events'], 'readwrite', async (/** @type {any} */ t) => {
      const rec = await t.getScope(id);
      await t.putScope({ ...rec, backup: { at: Date.now() - 50 * 60_000, seq: (await t.lastSeq(id)) - 1 } });
    });
    /** @type {Set<() => void>} */
    const heard = new Set();
    w.ran = async () => { // a backup of the trip ran and ended
      await store.tx(['scopes', 'events'], 'readwrite', async (/** @type {any} */ t) => t.putScope({ ...(await t.getScope(id)), backup: { at: Date.now(), seq: await t.lastSeq(id) } }));
      for (const fn of heard) fn();
    };
    const backups = { list: async () => [{ id: 'place', name: 'Test place', last: null }], progress: () => null, on: (/** @type {() => void} */ fn) => { heard.add(fn); return () => heard.delete(fn); } };
    const registry = { entries: () => [], onChange: () => () => {}, fail: () => {}, succeeded: () => {}, isDisabled: () => false, clashes: () => [] };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    startShell(root, { store, ws, registry, backups, plugins: { langOf: () => 'en' }, updates: { restart: async () => {}, waiting: false, plugins: async () => [] }, version: 'probe' });
  });
  const card = row(page, 'Testville');
  await expect(card).toContainText('backed up 50 minutes ago, changed since');
  await page.evaluate(() => /** @type {any} */ (window).ran());
  await expect(card.locator('.sub').first()).toHaveText(/backed up just now$/); // before: "50 minutes ago, changed since" until midnight
});

for (const size of PHONES) {
  test(`a card that came below an opened one, then the box's cap lifted on another screen: the sign goes, the card in view there (${size.join(' x ')})`, async ({ page }) => {
    await openedLongCard(page, size);
    await addBackup(page);
    await expect(page.locator('.notices')).toHaveClass(/\bbelow\b/);
    await page.evaluate(() => { location.hash = '#/settings'; });
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    // Off home the box has no cap with a card open: it holds both whole, and nothing is below what it shows.
    expect(await page.locator('.notices').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await expect(page.locator('.notices')).not.toHaveClass(/\bbelow\b/); // before: the sign stayed, pointing at Settings
  });
}
