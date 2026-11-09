import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { openApp, startModelServer, modelSetUp, anthropicToolReply, fakeMicrophone, waitForServiceWorker, addProvider } from './helpers.js';
import { encodeWav } from '../../src/core/voice/pcm.js';

// Timeline stage 4: home is a timeline of trips and chats, and a + drops you into a new conversation with no naming step.

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
  await expect(page.locator('main.view > *')).toBeVisible();
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
  await row(page, 'Chat 20').scrollIntoViewIfNeeded(); // in the past, well above the now line
  const at = await page.evaluate(() => scrollY);
  await row(page, 'Chat 20').click();
  await expect(page).toHaveURL(/\/talk$/);
  await page.getByRole('link', { name: 'Back to Trips' }).click(); // the conversation's ←: a new entry, home's
  await expect(page.locator('.now-line')).toBeVisible();
  await expect(fold).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(at);
  await row(page, 'Old 3').scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  await row(page, 'Old 3').click();
  await expect(page).toHaveURL(/\/talk$/);
  await page.goBack(); // Back to the open fold, at the row tapped
  await expect(fold).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(y);
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

test("a trip card follows the clock when annai comes back to the front after a while, and leaves a half-typed trip name alone", async ({ page }) => {
  await morning(page);
  const card = row(page, 'Testville');
  await expect(card.locator('.next')).toContainText('Museum');
  const back = async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  };
  await page.getByLabel('Trip name').fill('Tokyo');
  const noon = new Date();
  noon.setHours(11, 0, 0, 0);
  await page.clock.setSystemTime(noon); // the phone was locked: no timer ran
  await back();
  await page.waitForTimeout(300);
  await expect(card.locator('.next')).toContainText('Museum'); // not redrawn over the typing
  await expect(page.getByLabel('Trip name')).toHaveValue('Tokyo');
  await page.getByLabel('Trip name').fill('');
  await page.getByLabel('Trip name').blur(); // done with the form: the keyboard goes
  await back();
  await expect(card.locator('.next')).toContainText('Lunch');
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

test("a redraw skipped over typing comes once the typing is gone: the card is right when the name is cleared and left, with no lock and unlock", async ({ page }) => {
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
  await name.fill('');
  await name.blur();
  await expect(card.locator('.next')).toContainText('Lunch');
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

test("a trip ahead says how soon, and the words follow the clock between midnights", async ({ page }) => {
  await morning(page, { Laterton: { from: 1, to: 2 } });
  const soon = row(page, 'Laterton').locator('.soon');
  await expect(soon).toHaveText('tomorrow'); // noon tomorrow, from 09:00: 27 hours
  await page.clock.fastForward('05:00:00'); // 14:00: 22 hours, said in hours; the other timers (Museum, Lunch) ended earlier, so only this one says so
  await expect(soon).toHaveText('in 22 hours');
  await page.clock.fastForward('01:00:00');
  await expect(soon).toHaveText('in 21 hours');
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

test("Shiori set the dates goes when the user writes again, and stays gone after a reload", async ({ page }) => {
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
    await expect(line).toBeHidden();
    await expect(page.locator('.convo')).toContainText('Dinner is at seven.');
    await page.reload();
    await expect(page.locator('.convo')).toContainText('Dinner is at seven.');
    await expect(line).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`#/trip/${id}/talk$`));
  } finally {
    await llm.stop();
  }
});
