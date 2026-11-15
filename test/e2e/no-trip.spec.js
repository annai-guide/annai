import { test, expect } from '@playwright/test';
import { openApp, FIRST_DRAW, startTrip } from './helpers.js';

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
];

test('#/talk/me shows the old lines and no type box; no button on them does anything; + from there starts a new chat (Review Focus 6)', async ({ page }) => {
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
