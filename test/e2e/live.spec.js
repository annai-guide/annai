import { test, expect } from '@playwright/test';
import { openApp, waitForServiceWorker, startModelServer, addEndpoint, anthropicToolReply, startTrip, writeRecords, filterTrace } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const sleep = { name: 'sleep', input: {} };
const BIXBY = { name: 'Bixby Creek Bridge', lat: 36.3715, lng: -121.9017 };
/** An ISO time some minutes after t, in UTC. @param {number} t @param {number} min */
const plus = (t, min) => new Date(t + min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');

/** Shiori's main model on a stand-in Anthropic endpoint, and a trip. @param {any} page @param {string} origin */
async function setUp(page, origin) {
  await openApp(page, '#/models');
  await waitForServiceWorker(page);
  await addEndpoint(page, 'Other: Anthropic Messages', { name: 'Stand-in', url: `${origin}/b`, key: 'sk-test-b', model: 'b-model' });
  await page.getByLabel('Add a model to main').selectOption({ label: 'b-model' });
  await page.getByRole('button', { name: 'Add to main' }).click();
  await page.goto('/#/trips');
  return startTrip(page, 'Big Sur');
}

/** Turns live mode on from the chip. @param {any} page */
async function liveOn(page) {
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Turn live mode on' }).click();
}

/** The page as if the phone locked (true) or unlocked (false). @param {any} page @param {boolean} hidden */
async function locked(page, hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('a watch Shiori sets fires on arriving; she is told where you are; the trace shows the road (spec §11.3, §6.3)', async ({ page, context }) => {
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'enter', lat: BIXBY.lat, lng: BIXBY.lng, radius: 200, name: 'Bixby Bridge' }, fallback: 'Bixby Bridge, just ahead.' } }, sleep])),
      sse(anthropicToolReply([{ name: 'speak', input: { text: 'Bixby Bridge is on your right.' } }, sleep])),
    ],
  });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.40, longitude: -121.90, accuracy: 10 });
    const trip = await setUp(page, llm.origin);
    await writeRecords(page, trip, { write: { '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: plus(Date.now(), 60), tz: 'UTC' }, place: BIXBY } } });
    await page.goto('/#/now');
    await page.reload(); // written outside the app's own files layer: live mode reads the plan again as it starts
    await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
    await liveOn(page);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    expect(JSON.stringify(llm.bodies('/b/v1/messages')[0])).toContain('The user turned live mode on');
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    await context.setGeolocation({ latitude: BIXBY.lat, longitude: BIXBY.lng, accuracy: 10 });
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const second = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(second).toContain('fired: you entered Bixby Bridge');
    expect(second).toContain('place: near Bixby Creek Bridge');
    await page.goto('/#/talk');
    await expect(page.locator('.convo .shiori p').last()).toHaveText('Bixby Bridge is on your right.');
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Live' });
    await expect(page.locator('ol.trace .k', { hasText: 'trigger.fired' }).first()).toBeVisible();
    await filterTrace(page, { kind: 'Location' });
    await expect(page.locator('ol.trace .k', { hasText: 'location' }).first()).toBeVisible();
    await filterTrace(page, { kind: 'Everything' });
    await expect(page.locator('ol.trace .k', { hasText: /^location$/ })).toHaveCount(0);
  } finally {
    await llm.stop();
  }
});

test("no model can be reached: annai shows the plan's reminder itself, and the conversation says so (spec §11.3, §17)", async ({ page }) => {
  const refused = { status: 401, type: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) };
  const llm = await startModelServer({ '/b/v1/messages': refused });
  try {
    const start = Date.now();
    await page.clock.install({ time: start });
    const trip = await setUp(page, llm.origin);
    await writeRecords(page, trip, { write: { '/plan/tea.json': { id: 'tea', title: 'Tea at the inn', fixed: true, start: { at: plus(start, 16), tz: 'UTC' } } } });
    await page.reload(); // written outside the app's own files layer: it reads the plan again as it starts
    await expect(page.locator('main.view > *')).toBeVisible();
    await page.clock.fastForward(90_000); // the plan's "coming up" comes 15 minutes before
    await expect(page.locator('.notice', { hasText: 'Reminder' })).toContainText('In 15 min: Tea at the inn at');
    await expect(page.locator('.notice', { hasText: "Shiori can't reach her model" })).toBeVisible();
    await page.goto('/#/talk');
    await expect(page.locator('.convo .system-line', { hasText: 'Reminder' })).toContainText('In 15 min: Tea at the inn at');
  } finally {
    await llm.stop();
  }
});

test('the phone locked and unlocked: one catch-up wake, with the time away and what came due, late (spec §11.4)', async ({ page, context }) => {
  const start = Date.now();
  const llm = await startModelServer({
    '/b/v1/messages': [
      sse(anthropicToolReply([{ name: 'watch_set', input: { when: { type: 'time', at: plus(start, 10) }, fallback: 'Ten minutes are up.' } }, sleep])),
      sse(anthropicToolReply([sleep])),
    ],
  });
  try {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 36.40, longitude: -121.90, accuracy: 10 });
    await page.clock.install({ time: start });
    await setUp(page, llm.origin);
    await page.goto('/#/now');
    await liveOn(page);
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(1);
    await expect(page.locator('.talk-label')).toHaveText('Tap to talk');
    await locked(page, true);
    await page.clock.fastForward('15:00');
    expect(llm.bodies('/b/v1/messages').length).toBe(1); // nothing while locked
    await locked(page, false);
    await context.setGeolocation({ latitude: 36.41, longitude: -121.90, accuracy: 10 });
    await page.clock.fastForward(16_000); // at most 15 s for a fix
    await expect.poll(() => llm.bodies('/b/v1/messages').length).toBe(2);
    const body = JSON.stringify(llm.bodies('/b/v1/messages')[1]);
    expect(body).toMatch(/Catch-up: annai was off screen for 15 min/);
    expect(body).toMatch(/fired: the time came: [^(]+\(late by 5 min: annai was off screen\)/);
  } finally {
    await llm.stop();
  }
});

test('location refused: a card with steps for this phone, and "Where are you?" with the plan\'s places (spec §17)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: { '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: plus(Date.now(), 60), tz: 'UTC' }, place: BIXBY } } });
  await page.goto('/#/now');
  await page.reload(); // written outside the app's own files layer: live mode reads the plan again as it starts
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  await liveOn(page);
  const card = page.locator('.notice', { hasText: "annai can't see where you are" });
  await expect(card).toContainText(/On (iPhone|Android):/);
  await expect(page.locator('.live-chip')).toHaveText('Live · no location');
  await page.locator('.live-chip').click();
  await page.getByRole('group', { name: 'Live mode' }).getByRole('button', { name: 'Bixby Creek Bridge' }).click();
  await expect(page.locator('.now-place')).toHaveText('At Bixby Creek Bridge');
});

test('a plan item Shiori changed can be put back with one tap (spec §11.5)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  const at = plus(Date.parse('2026-11-27T21:45:00Z'), 0);
  await writeRecords(page, trip, { write: { '/plan/mcway.json': { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at, tz: 'UTC' } } } });
  await writeRecords(page, trip, { author: 'shiori', patch: { '/plan/mcway.json': { start: { at: '2026-11-27T22:00:00Z', tz: 'UTC' } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab').first().click();
  await expect(page.locator('.plan-row')).toContainText('22:00');
  await page.getByRole('button', { name: 'Changed by Shiori · Undo' }).click();
  await expect(page.locator('.plan-row')).toContainText('21:45');
  await expect(page.getByRole('button', { name: 'Changed by Shiori · Undo' })).toHaveCount(0);
});

test('Undo puts back the item as it was before all of Shiori\'s changes in a row, and removes one she added, after asking (B3)', async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: { '/plan/mcway.json': { id: 'mcway', title: 'McWay Falls', fixed: false, start: { at: '2026-11-27T21:45:00Z', tz: 'UTC' } } } });
  await writeRecords(page, trip, { author: 'shiori', patch: { '/plan/mcway.json': { start: { at: '2026-11-27T22:00:00Z', tz: 'UTC' } } } });
  await writeRecords(page, trip, { author: 'shiori', patch: { '/plan/mcway.json': { notes: 'Later, for the light.' } } });
  await writeRecords(page, trip, { author: 'shiori', write: { '/plan/pfeiffer.json': { id: 'pfeiffer', title: 'Pfeiffer Beach', fixed: false, start: { at: '2026-11-27T23:00:00Z', tz: 'UTC' } } } });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/plan`);
  await page.getByRole('tab').first().click();
  const mcway = page.locator('.plan-row', { hasText: 'McWay Falls' });
  await expect(mcway).toContainText('22:00');
  await mcway.getByRole('button', { name: 'Changed by Shiori · Undo' }).click();
  await expect(mcway).toContainText('21:45');
  await expect(mcway.getByRole('button', { name: /Undo/ })).toHaveCount(0);
  await page.locator('.plan-row', { hasText: 'Pfeiffer Beach' }).getByRole('button', { name: 'Added by Shiori · Undo' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.plan-row', { hasText: 'Pfeiffer Beach' })).toHaveCount(0);
  await expect(mcway).toBeVisible();
});

test("Trace → Live shows the firings, reminders and switches however many location points came after them; Location shows the points (B5)", async ({ page }) => {
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await page.evaluate(async (scope) => {
    const load = (/** @type {string} */ url) => import(url);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { logEvent } = await load('/src/core/events.js');
    const store = await createIdbStore();
    await logEvent(store, scope, { type: 'trigger.fired', actor: 'system', data: { watch: 'plan:lunch:leave', text: 'Plan: time to leave soon for "Lunch at Nepenthe"' } });
    for (let i = 0; i < 400; i++) await logEvent(store, scope, { type: 'location', actor: 'system', data: { lat: 36.3 + i / 1e4, lng: -121.9, accuracy: 8 } });
    store.close();
  }, trip);
  await page.goto('/#/trace');
  await filterTrace(page, { kind: 'Live' });
  await expect(page.locator('ol.trace .k', { hasText: 'trigger.fired' })).toHaveCount(1);
  await expect(page.locator('ol.trace .k', { hasText: /^location$/ })).toHaveCount(0);
  await filterTrace(page, { kind: 'Location' });
  await expect(page.locator('ol.trace .k', { hasText: /^location$/ })).toHaveCount(300);
  await filterTrace(page, { kind: 'Live', type: 'trigger' });
  await expect(page.locator('ol.trace .k', { hasText: 'trigger.fired' })).toHaveCount(1);
});

test('the live menu fits a narrow phone, says it pops up, closes on a tap elsewhere, and a double tap never opens it twice', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openApp(page);
  const trip = await startTrip(page, 'Big Sur');
  await writeRecords(page, trip, { write: { '/plan/bixby.json': { id: 'bixby', title: 'Bixby Bridge photo stop', fixed: false, start: { at: plus(Date.now(), 60), tz: 'UTC' }, place: BIXBY } } });
  await page.goto('/#/now');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Big Sur' })).toBeVisible();
  const chip = page.locator('.live-chip');
  const menu = page.getByRole('group', { name: 'Live mode' });
  await expect(chip).toHaveAttribute('aria-haspopup', 'true');
  await chip.click();
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 320).toBe(true);
  await page.getByRole('heading', { name: 'Big Sur' }).click();
  await expect(menu).toBeHidden();
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  // With no location, the menu reads the plan's places as it opens: a second tap meanwhile closes it.
  await liveOn(page);
  await expect(chip).toHaveText('Live · no location');
  await chip.dblclick();
  await expect(menu).toBeHidden();
  await chip.click();
  await expect(menu.getByText('Where are you?')).toHaveCount(1);
  await expect(menu.getByRole('button', { name: 'Bixby Creek Bridge' })).toHaveCount(1);
});
