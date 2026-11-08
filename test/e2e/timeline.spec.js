import { test, expect } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
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
 * in days from today, and what her last line there says. @param {import('@playwright/test').Page} page
 * @param {{ chats?: Record<string, number>, trips?: Record<string, { from: number, to?: number, plan?: string, said?: string }> }} c @returns {Promise<Record<string, string>>} ids by name
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
