import { test, expect } from '@playwright/test';
import { openApp, FIRST_DRAW, startTrip, startModelServer, anthropicToolReply, addProvider, waitForServiceWorker, pickFile, fixtureFiles, zipOf } from './helpers.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { record } from '../../src/core/agent/log.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });

// Timeline stage 7: `me`, the old conversation outside any trip, is a read-only row on home (the user, 2026-11-05, "Read-only row (Recommended)": "You
// can read it; talking starts a new chat."), and with nothing else open the standing draft is (2026-11-14, "Open the new conversation (Recommended)").

const plus = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('button', { name: 'New conversation', exact: true });
const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByLabel('Message to Shiori');
const hashOf = (/** @type {import('@playwright/test').Page} */ page) => new URL(page.url()).hash;
const meRow = (/** @type {import('@playwright/test').Page} */ page) => page.locator('.trip-card', { has: page.locator('.name', { hasText: 'Shiori, no trip' }) });

/**
 * Entries written into a scope's log as annai writes them, each `ago` minutes back. @param {import('@playwright/test').Page} page @param {string} scope
 * @param {{ type: string, actor: string, data?: any, text?: string, ago?: number }[]} entries
 */
function writeIn(page, scope, entries) {
  return page.evaluate(async ({ scope, entries }) => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { record } = await import(/** @type {string} */ ('/src/core/agent/log.js'));
    const store = await createIdbStore();
    for (const e of entries) await record(store, scope, { type: e.type, actor: e.actor, data: e.data ?? {}, texts: e.text === undefined ? [] : [['text', e.text]], now: Date.now() - (e.ago ?? 0) * 60_000 });
    store.close();
  }, { scope, entries });
}

/** The user's lines in a scope's log. @param {import('@playwright/test').Page} page @param {string} scope */
const userLines = (page, scope) => page.evaluate(async (scope) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const got = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['msg.user'] }));
  store.close();
  return got.length;
}, scope);

/** A scope's record. @param {import('@playwright/test').Page} page @param {string} id */
const recordOf = (page, id) => page.evaluate(async (id) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const rec = await store.tx(['scopes'], 'readonly', (/** @type {any} */ t) => t.getScope(id));
  store.close();
  return rec;
}, id);

/** `me`'s old lines as an older annai left them: the user's question, her line, her question with options, a card with a choice, a failed turn, a heard line she didn't answer. */
const OLD = [
  { type: 'msg.user', actor: 'user', text: 'Anything near Testville?', ago: 90 },
  { type: 'out.speak', actor: 'shiori', text: 'The Hotel Aurora Test is close.', ago: 89 },
  { type: 'out.ask', actor: 'shiori', data: { id: 'ask-1', question: 'Shall I note it?', options: ['Yes', 'No'] }, ago: 89 },
  { type: 'out.show', actor: 'shiori', data: { card: { title: 'Hotel Aurora Test', text: 'Two nights.', choice: ['Book it'] } }, ago: 88 },
  { type: 'error', actor: 'system', data: { kind: 'model', message: 'The model could not be reached.' }, ago: 87 },
  { type: 'heard', actor: 'user', data: { id: 'hd-1', text: 'Is it far?', dismissed: true }, ago: 86 },
  // A conversation left mid-turn by an older annai: nothing in `me` picks it up any more, so the line that promised it is not shown.
  { type: 'paused', actor: 'system', data: { text: 'Shiori was in the middle of something. She picks it up when you come back.' }, ago: 85 },
];

test('#/talk/me shows the old lines and no type box; no button on them talks or changes anything; + from there starts a new chat (Review Focus 6)', async ({ page }) => {
  await openApp(page, '#/trips');
  await writeIn(page, 'me', OLD);
  await page.goto('/#/talk/me');
  await expect(page.getByRole('heading', { level: 1, name: 'Shiori, no trip' })).toBeAttached(FIRST_DRAW);
  const convo = page.locator('ol.convo');
  await expect(convo).toContainText('Anything near Testville?');
  await expect(convo).toContainText('The Hotel Aurora Test is close.');
  await expect(convo).toContainText('Shall I note it?');
  await expect(convo).toContainText('Two nights.');
  await expect(convo).toContainText('Is it far?');
  await expect(convo).not.toContainText('She picks it up when you come back');
  // Her options, the card's choice, Try again and "This was for Shiori" are not there, so a tap can't send a bare "Yes" anywhere.
  await expect(convo.locator('button')).toHaveCount(0);
  await expect(page.locator('.talk-head .tidy-toggle')).toHaveCount(0); // no ⋯
  // The dock rests as on home: no type box, the + floats.
  await expect(box(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Type', exact: true })).toBeHidden();
  await expect(plus(page)).toBeVisible();
  await plus(page).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  expect((await recordOf(page, decodeURIComponent(hashOf(page).split('/')[2])))?.draft).toBe(true);
  await box(page).fill('A new question');
  await box(page).press('Enter');
  await expect(page.locator('ol.convo')).toContainText('A new question');
  expect(await userLines(page, 'me')).toBe(1); // nothing went into `me`
});

test('the "Shiori, no trip" row shows only once `me` has a line of the user\'s, sits by it, opens its lines, and Back goes home', async ({ page }) => {
  await openApp(page, '#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(meRow(page)).toHaveCount(0);
  // Her lines alone, and a reminder's wake: nothing of the user's to read back.
  await writeIn(page, 'me', [{ type: 'out.speak', actor: 'shiori', text: 'Hello.', ago: 300 }, { type: 'wake', actor: 'system', data: { id: 'w1', reasons: [{ kind: 'trigger', text: 'A watch fired.' }] }, ago: 200 }]);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible(FIRST_DRAW);
  await expect(meRow(page)).toHaveCount(0);
  const ids = await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { createTrip } = await import(/** @type {string} */ ('/src/core/scopes.js'));
    const { record } = await import(/** @type {string} */ ('/src/core/agent/log.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    /** @type {Record<string, string>} */
    const out = {};
    for (const [title, ago] of /** @type {[string, number][]} */ ([['Earlier chat', 120], ['Later chat', 10]])) {
      out[title] = await createTrip(ws, { title });
      await record(store, out[title], { type: 'msg.user', actor: 'user', data: {}, texts: [['text', title]], now: Date.now() - ago * 60_000 });
    }
    store.close();
    return out;
  });
  await writeIn(page, 'me', [{ type: 'msg.user', actor: 'user', text: 'Anything near Testville?', ago: 60 }]);
  await page.reload();
  await expect(meRow(page)).toBeVisible(FIRST_DRAW);
  expect(await page.locator('.past .trip-card .name').allTextContents()).toEqual(['Earlier chat', 'Shiori, no trip', 'Later chat']);
  const activeTrip = () => page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const { readAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
    const store = await createIdbStore();
    const a = (await readAppSettings(new Workspace(store))).activeTrip;
    store.close();
    return a;
  });
  const open = await activeTrip();
  await meRow(page).click();
  await expect(page).toHaveURL(/#\/talk\/me$/);
  await expect(page.locator('ol.convo')).toContainText('Anything near Testville?');
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  // ← goes home too, and looking opened nothing: the conversation open stays the one it was.
  await meRow(page).click();
  await page.getByRole('link', { name: 'Back to Trips' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(await activeTrip()).toBe(open);
  expect(open).not.toBe('me');
  expect(Object.values(ids)).not.toContain(open);
});

test('with nothing open the new conversation is: at a fresh start, and after the open trip is removed, the Conversation tab shows it, empty', async ({ page }) => {
  await openApp(page, '#/trips');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Conversation' }).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  const first = decodeURIComponent(hashOf(page).split('/')[2]);
  expect((await recordOf(page, first))?.draft).toBe(true);
  await expect(page.getByText('Nothing yet. Tap Shiori or Type below to talk.')).toBeVisible();
  await page.goto('/#/trips');
  await startTrip(page, 'Kyoto');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog', { name: 'Kyoto' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Conversation' }).click();
  await expect(page).toHaveURL(/#\/trip\/trip-[0-9a-z]+\/talk$/);
  const after = decodeURIComponent(hashOf(page).split('/')[2]);
  expect((await recordOf(page, after))?.draft).toBe(true);
  await expect(page.getByText('Nothing yet. Tap Shiori or Type below to talk.')).toBeVisible();
  // Typed there, its first line makes it a chat.
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await box(page).fill('Ramen near the station?');
  await box(page).press('Enter');
  await expect.poll(async () => (await recordOf(page, after))?.draft).toBeUndefined();
});

test('with no conversation possible (the store failing), a typed line stays in the box, the card says so, and nothing goes into `me` (Review Focus 3)', async ({ page }) => {
  await openApp(page, '#/trips');
  await startTrip(page, 'Kyoto');
  await page.evaluate(async () => {
    const { Chats } = await import(/** @type {string} */ ('/src/core/chats.js'));
    Chats.prototype.whenReady = () => Promise.reject(new Error('The store failed.'));
  });
  // Removed while open: nothing else is open, and no draft can be opened.
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog', { name: 'Kyoto' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await box(page).fill('Hello there');
  await box(page).press('Enter');
  await expect(page.locator('.notices')).toContainText("That conversation didn't open");
  await expect(box(page)).toHaveValue('Hello there');
  await expect(box(page)).toBeVisible();
  expect(hashOf(page)).toBe('#/settings');
  expect(await userLines(page, 'me')).toBe(0);
  // The Conversation tab, with nothing open, is home.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Conversation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
});

test('files an older annai left waiting with Shiori are in a conversation of their own, "Waiting with Shiori", at the next start: a row at now, the files in its Details', async ({ page }) => {
  await openApp(page, '#/settings');
  await page.evaluate(async () => {
    const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
    const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
    const store = await createIdbStore();
    const ws = new Workspace(store);
    await ws.write('sys:waiting', '/files/hotel.txt', 'Hotel Aurora Test, Nov 20–27', { author: 'user', type: 'text/plain' });
    await ws.write('sys:waiting', '/names.json', { '/files/hotel.txt': 'Hotel Aurora Test stay' }, { author: 'shiori' });
    store.close();
  });
  await page.goto('/#/trips');
  await page.reload();
  const row = page.locator('.trip-card', { has: page.locator('.name', { hasText: 'Waiting with Shiori' }) });
  await expect(row).toBeVisible(FIRST_DRAW);
  await expect(row).toHaveClass(/\bline\b/);
  const id = decodeURIComponent(String(await row.getAttribute('href')).split('/')[2]);
  await page.goto(`/#/trip/${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Waiting with Shiori' })).toBeVisible();
  await expect(page.getByText('Hotel Aurora Test stay')).toBeVisible();
  // Nothing waits any more: a second start makes no second chat.
  await page.goto('/#/trips');
  await page.reload();
  await expect(page.locator('.trip-card', { has: page.locator('.name', { hasText: 'Waiting with Shiori' }) })).toHaveCount(1, FIRST_DRAW);
});

/** The files a conversation holds, the files still waiting with Shiori, and the conversation's wake texts, as the store has them. @param {import('@playwright/test').Page} page @param {string} scope */
const spaceOf = (page, scope) => page.evaluate(async (scope) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const ws = new Workspace(store);
  const wakes = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(scope, { types: ['wake'] }));
  const out = {
    files: (await ws.list(scope, '/files/')).map((f) => f.path), bookings: (await ws.list(scope, '/bookings/')).map((f) => f.path),
    waiting: (await ws.list('sys:waiting', '/files/')).map((f) => f.path),
    wakes: wakes.flatMap((/** @type {any} */ e) => (e.data.reasons ?? []).map((/** @type {any} */ r) => String(r.text ?? ''))),
  };
  store.close();
  return out;
}, scope);

const waitingRow = (/** @type {import('@playwright/test').Page} */ page) => page.locator('.trip-card', { has: page.locator('.name', { hasText: 'Waiting with Shiori' }) });

test('Undo of a hand-over whose files have nowhere to go back to: the toast says so, home shows a new "Waiting with Shiori" chat holding the file, the draft is open, and she asks what to do first, filing nothing (review probe B)', async ({ page }) => {
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'There is one file here, a flight. What should I do with it?' } }, { name: 'sleep', input: {} }])),
    sse(anthropicToolReply([{ name: 'sleep', input: {} }])),
  ] });
  try {
    await openApp(page, '#/trips');
    // A trip she started for a hand-over, from a trip the user removed since: its file has nowhere to go back to. No model yet, so opening it wakes nothing.
    const started = await page.evaluate(async () => {
      const load = (/** @type {string} */ u) => import(u);
      const { createIdbStore } = await load('/src/core/store-idb.js');
      const { Workspace } = await load('/src/core/workspace.js');
      const { createTrip, removeTrip } = await load('/src/core/scopes.js');
      const { record } = await load('/src/core/agent/log.js');
      const { moveFile } = await load('/src/core/waiting.js');
      const store = await createIdbStore();
      const ws = new Workspace(store);
      const origin = await createTrip(ws, { title: 'Big Sur' });
      await ws.write(origin, '/files/flight.pdf', 'ANNAI AIR AN 123, Testville to Laterton', { author: 'user', type: 'application/pdf', handover: 'h-2' });
      const trip = await createTrip(ws, { title: 'Testville · Mar 12' }, { author: 'shiori', handover: 'h-2' });
      await record(store, trip, { type: 'msg.user', actor: 'user', data: { handed: [], handover: 'h-2', from: origin }, texts: [['text', '(files)']] });
      await record(store, origin, { type: 'handover.moved', actor: 'shiori', data: { handover: 'h-2', to: trip, started: true, count: 1 } });
      await moveFile(ws, { scope: origin, path: '/files/flight.pdf' }, trip, { handover: 'h-2' });
      await record(store, trip, { type: 'out.speak', actor: 'shiori', data: { id: 's-1' }, texts: [['text', 'I started a trip for your flight.']] });
      await removeTrip(store, origin);
      store.close();
      return trip;
    });
    await page.reload();
    await page.goto(`/#/trip/${encodeURIComponent(started)}/talk`);
    await page.getByRole('button', { name: 'Undo what Shiori did with these files' }).click();
    await expect(page.getByText('Undone. Testville · Mar 12 is removed, and your files are waiting with Shiori.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
    // A new chat holds the file; nothing waits; its wake asks her to ask (and files nothing); the draft is open meanwhile.
    await expect(waitingRow(page)).toBeVisible();
    const chat = decodeURIComponent(String(await waitingRow(page).getAttribute('href')).split('/')[2]);
    const held = await spaceOf(page, chat);
    expect(held.files).toEqual(['/files/flight.pdf']);
    expect(held.waiting).toEqual([]);
    expect(held.wakes.join(' ')).toContain('Until they answer, file nothing');
    const activeTrip = () => page.evaluate(async () => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
      const { readAppSettings } = await import(/** @type {string} */ ('/src/core/settings.js'));
      const store = await createIdbStore();
      const a = (await readAppSettings(new Workspace(store))).activeTrip;
      store.close();
      return a;
    });
    await expect.poll(async () => (await recordOf(page, String(await activeTrip())))?.draft).toBe(true);
    // Now she has a model: opening the chat starts her turn, with the wake's words, and she says what is there and asks.
    await waitForServiceWorker(page);
    await page.goto('/#/models');
    await addProvider(page, 'Custom provider', { ability: 'Anthropic Messages', name: 'Stand-in', url: `${llm.origin}/b`, key: 'sk-test-b', model: 'b-model' });
    await page.getByLabel('Add a model to main').selectOption({ label: 'Stand-in / b-model' });
    await page.getByRole('button', { name: 'Add to main' }).click();
    await page.goto('/#/trips');
    await waitingRow(page).click();
    await expect(page.locator('ol.convo')).toContainText('There is one file here, a flight. What should I do with it?', { timeout: 30_000 });
    const sent = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b)).find((b) => b.includes('were waiting with you'));
    expect(sent, 'her first request carries the wake').toBeTruthy();
    expect(sent).toContain('has not just handed them to you and has asked for nothing yet');
    expect(sent).toContain('Until they answer, file nothing');
    // She filed nothing: the file is where it was, and there is no booking.
    const after = await spaceOf(page, chat);
    expect(after.files).toEqual(['/files/flight.pdf']);
    expect(after.bookings).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test('an old backup imported with "Replace my profile and memory": its waiting files are in a "Waiting with Shiori" chat before the results are drawn, and home shows the "Shiori, no trip" row without a reload', async ({ page }) => {
  // The backup of an older annai: a file waiting with Shiori, and a line of the user's in `me`.
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  await ws.write('sys:waiting', '/files/hotel.txt', 'Hotel Aurora Test, Nov 20–27', { author: 'user', type: 'text/plain' });
  await ws.write('sys:waiting', '/names.json', { '/files/hotel.txt': 'Hotel Aurora Test stay' }, { author: 'shiori' });
  await record(store, 'me', { type: 'msg.user', actor: 'user', data: {}, texts: [['text', 'Anything near Testville?']], now: Date.now() - 3_600_000 });
  const { blob } = await exportArchive(store, { kind: 'everything', include: PRESETS.backup, app: '0.1.0' });
  await openApp(page, '#/trips');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  await expect(meRow(page)).toHaveCount(0); // read once, and `me` has no line of the user's yet
  await expect(waitingRow(page)).toHaveCount(0);
  await page.getByLabel('Open an annai file').setInputFiles({ name: 'older-annai.annai.zip', mimeType: 'application/zip', buffer: Buffer.from(await blob.arrayBuffer()) });
  await page.getByLabel('Replace my profile and memory with the ones in this file').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('Imported.')).toBeVisible();
  // The files moved before the results, the wake is in the new chat, and nothing waits; home, drawn again with no reload, shows both rows.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Trips' }).click();
  await expect(waitingRow(page)).toBeVisible(FIRST_DRAW);
  await expect(meRow(page)).toBeVisible();
  const chat = decodeURIComponent(String(await waitingRow(page).getAttribute('href')).split('/')[2]);
  const held = await spaceOf(page, chat);
  expect(held.files).toEqual(['/files/hotel.txt']);
  expect(held.waiting).toEqual([]);
  expect(held.wakes.join(' ')).toContain('Until they answer, file nothing');
  await meRow(page).click();
  await expect(page.locator('ol.convo')).toContainText('Anything near Testville?');
});

test("an old #/waiting/file?path=… address goes home, in place of its entry", async ({ page }) => {
  await openApp(page, '#/trips');
  await page.goto('/#/waiting/file?path=%2Ffiles%2Fa.pdf');
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  expect(hashOf(page)).toBe('#/trips');
});

test("in `me`'s read-only lines a plugin's kind of card is drawn as annai draws its own: its title, and none of the plugin's buttons, which could send a line into the open conversation", async ({ page }) => {
  await openApp(page, '#/trips');
  await pickFile(page, { name: 'trail-send.zip', mimeType: 'application/zip', buffer: await zipOf(await fixtureFiles('trail-send')) });
  await page.getByRole('button', { name: 'Install anyway', exact: true }).click();
  await expect(page.locator('.card', { hasText: 'Trail send' }).getByText('On', { exact: true })).toBeVisible();
  const card = { type: 'trail-send', data: { name: 'Pfeiffer Falls' }, title: 'Pfeiffer Falls trail' };
  await page.goto('/#/trips');
  const kyoto = await startTrip(page, 'Kyoto');
  // A card of a kind with neither title nor text (its data only, or its plugin since turned off) would be an empty box: its kind is its title.
  const bare = { type: 'trail-send', data: { name: 'Mist Trail' } };
  const gone = { type: 'old-kind-of-card', data: {} };
  await writeIn(page, 'me', [{ type: 'msg.user', actor: 'user', text: 'A trail near Testville?', ago: 90 }, { type: 'out.show', actor: 'shiori', data: { card }, ago: 89 },
    { type: 'out.show', actor: 'shiori', data: { card: bare }, ago: 88 }, { type: 'out.show', actor: 'shiori', data: { card: gone }, ago: 87 }]);
  await writeIn(page, kyoto, [{ type: 'out.show', actor: 'shiori', data: { card }, ago: 1 }]);
  // The same card in an open conversation is the plugin's, button and all.
  await page.goto(`/#/trip/${encodeURIComponent(kyoto)}/talk`);
  await expect(page.getByRole('button', { name: 'Ask about Pfeiffer Falls' })).toBeVisible(FIRST_DRAW);
  // In `me`'s old lines it is a title, with nothing to tap.
  await page.goto('/#/talk/me');
  await expect(page.locator('ol.convo')).toContainText('A trail near Testville?', FIRST_DRAW);
  await expect(page.locator('ol.convo')).toContainText('Pfeiffer Falls trail');
  await expect(page.locator('ol.convo .card-title', { hasText: /^Trail send$/ })).toHaveCount(1);
  await expect(page.locator('ol.convo .card-title', { hasText: /^old-kind-of-card$/ })).toHaveCount(1);
  await expect(page.locator('ol.convo button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask about Pfeiffer Falls' })).toHaveCount(0);
});

test("a trip's address whose open fails with nothing open shows `me`'s old lines read-only: no answer button, no Try again, no Undo (the scope drawn decides, not the address)", async ({ page }) => {
  await openApp(page, '#/trips');
  await startTrip(page, 'Osaka');
  await page.goto('/#/trips');
  await startTrip(page, 'Kyoto');
  await writeIn(page, 'me', OLD);
  await page.evaluate(async () => {
    const { Chats } = await import(/** @type {string} */ ('/src/core/chats.js'));
    Chats.prototype.whenReady = () => Promise.reject(new Error('The store failed.'));
  });
  // Removed while open: nothing else is open, and no draft can be opened. Then no conversation opens at all.
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog', { name: 'Kyoto' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Trips' })).toBeVisible();
  const osaka = decodeURIComponent(String(await page.locator('.trip-card', { has: page.locator('.name', { hasText: 'Osaka' }) }).getAttribute('href')).split('/')[2]);
  await page.evaluate(async () => {
    const { Halves } = await import(/** @type {string} */ ('/src/core/agent/halves.js'));
    Halves.prototype.open = () => Promise.reject(new Error('The store failed.'));
  });
  await page.goto(`/#/trip/${encodeURIComponent(osaka)}/talk`);
  await expect(page.locator('ol.convo')).toContainText('Anything near Testville?', FIRST_DRAW);
  await expect(page.locator('ol.convo')).toContainText('Shall I note it?');
  await expect(page.locator('ol.convo button')).toHaveCount(0);
});
