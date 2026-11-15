// The loop's record of when a turn of Shiori's ends (the turn-end plan, §8): a reload and an open in the middle of a turn, in real engines,
// with the model stand-in. A turn cut at its work is taken up once, with the hand-over it carried, so Undo takes back what she did before the
// cut and after; a turn that ended is not taken up again; her card waiting is let go; Try again after "Shiori didn't answer" carries the
// hand-over. Nothing of the record reaches the model.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startModelServer, anthropicToolReply, modelSetUp, startTrip } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const MESSAGES = '/b/v1/messages';
const PAUSED = 'Shiori was in the middle of something. She picks it up when you come back.';
const sleep = { name: 'sleep', input: {} };
const write = (/** @type {string} */ name) => ({ name: 'write', input: { path: `/trip/notes/${name}`, content: `Notes ${name}` } });
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
/** A reply the stand-in never sends: the request stays open until the page goes or the turn is cut. */
const held = () => ({ ...sse(anthropicToolReply([speak('Never said.'), sleep])), until: new Promise(() => {}) });

/** Hands Shiori the flight PDF from the type box, with words. @param {import('@playwright/test').Page} page @param {string} words */
async function handOver(page, words) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Give Shiori photos or files').setInputFiles({ name: 'flight.pdf', mimeType: 'application/pdf', buffer: await readFile(new URL('../fixtures/bookings/flight.pdf', import.meta.url)) });
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(1);
  await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Her writes in a trip, with the hand-over each carries, and which of her notes are still there. @param {import('@playwright/test').Page} page @param {string} trip */
const filed = (page, trip) => page.evaluate(async (trip) => {
  const load = (/** @type {string} */ url) => import(url);
  const { createIdbStore } = await load('/src/core/store-idb.js');
  const { Workspace } = await load('/src/core/workspace.js');
  const store = await createIdbStore();
  const ws = new Workspace(store);
  const events = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['file.write'] }));
  const writes = events.filter((/** @type {any} */ e) => e.actor === 'shiori').map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]);
  const there = [];
  for (const path of ['/notes/a.md', '/notes/b.md', '/notes/f.md']) if (await ws.read(trip, path)) there.push(path);
  store.close();
  return { writes, there };
}, trip);

/** Undo of the hand-over, from its line, and what is left of her notes. @param {import('@playwright/test').Page} page @param {string} trip */
async function undo(page, trip) {
  await page.getByRole('button', { name: 'Undo what Shiori did with these files' }).click();
  await expect(page.getByText('Undone.', { exact: true })).toBeVisible();
  return (await filed(page, trip)).there;
}

/** The text of a request's last user message. @param {any} body */
const lastUser = (body) => JSON.stringify([...(body?.messages ?? [])].reverse().find((/** @type {any} */ m) => m.role === 'user')?.content ?? '');
/** A request's messages without the cache marks, which move from one request to the next. @param {any[]} messages */
const plain = (messages) => JSON.parse(JSON.stringify(messages, (k, v) => (k === 'cache_control' ? undefined : v)));

/**
 * Big Sur, with Kyoto made too, on Big Sur's conversation. @param {import('@playwright/test').Page} page @param {string} origin
 * @returns {Promise<{ bigSur: string, kyoto: string }>} the trips' ids
 */
async function twoTrips(page, origin) {
  await modelSetUp(page, origin, 'Big Sur');
  const bigSur = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.goto('/#/trips');
  const kyoto = await startTrip(page, 'Kyoto');
  await page.goto(`/#/trip/${encodeURIComponent(bigSur)}/talk`);
  await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
  return { bigSur, kyoto };
}

/** Nothing of the record is in any request. @param {any[]} bodies */
function noRecord(bodies) {
  for (const b of bodies) {
    expect(JSON.stringify(b)).not.toContain('turn.end');
    expect(JSON.stringify(b)).not.toContain('endLogged');
  }
}

for (const how of ['reload', 'crash']) {
  test(`a ${how === 'reload' ? 'reload' : 'kill (the page crashes)'} while she works on a hand-over: one restart, her reply shown once, and Undo takes back what she filed before and after`, async ({ page, context, browserName }) => {
    test.skip(how === 'crash' && browserName !== 'chromium', 'a page crash is a Chromium DevTools command');
    const llm = await startModelServer({ [MESSAGES]: [
      sse(anthropicToolReply([write('a.md')])),
      held(),
      sse(anthropicToolReply([write('b.md'), speak('Filed both.'), sleep])),
    ] });
    try {
      await modelSetUp(page, llm.origin, 'Big Sur');
      const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
      await handOver(page, 'File this');
      await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(2);
      let p = page;
      if (how === 'reload') await page.reload();
      else {
        const cdp = await context.newCDPSession(page);
        const crashed = page.waitForEvent('crash');
        void cdp.send('Page.crash').catch(() => {}); // the page is gone before it answers
        await crashed;
        p = await context.newPage();
        await p.goto(`/#/trip/${encodeURIComponent(trip)}/talk`);
      }
      await expect(p.locator('.convo').getByText('Filed both.')).toHaveCount(1, { timeout: 30_000 });
      const bodies = llm.bodies(MESSAGES);
      expect(bodies.length).toBe(3);
      expect(lastUser(bodies[2])).toContain('in the middle of your turn');
      // What she is sent: the restart's request is the held one's, and then its own line.
      expect(plain(bodies[2].messages.slice(0, bodies[1].messages.length - 1))).toEqual(plain(bodies[1].messages.slice(0, -1)));
      noRecord(bodies);
      await p.waitForTimeout(1000); // nothing more is asked
      expect(llm.bodies(MESSAGES).length).toBe(3);
      expect((await filed(p, trip)).writes).toEqual([['/notes/a.md', expect.any(String)], ['/notes/b.md', expect.any(String)]]);
      const [[, h1], [, h2]] = (await filed(p, trip)).writes;
      expect(h2).toBe(h1);
      expect(await undo(p, trip)).toEqual([]);
    } finally {
      await llm.stop();
    }
  });
}

test('a reload after her turn ended takes nothing up: the next request is the user\'s line, with no restart', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([speak('Big Sur is a coast.'), sleep])),
    sse(anthropicToolReply([speak('You are welcome.'), sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('What is Big Sur?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Big Sur is a coast.')).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(page.locator('.convo').getByText('Big Sur is a coast.')).toBeVisible({ timeout: 30_000 });
    // A restart would be queued at the open, ahead of the line: the line's request shows it.
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Thanks');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('You are welcome.')).toBeVisible({ timeout: 30_000 });
    const bodies = llm.bodies(MESSAGES);
    expect(bodies.length).toBe(2);
    expect(lastUser(bodies[1])).toContain('Thanks');
    expect(lastUser(bodies[1])).not.toContain('restarted');
    noRecord(bodies);
  } finally {
    await llm.stop();
  }
});

test('another trip opened while she works on a hand-over: the conversation left says she picks it up, coming back takes it up once, and Undo takes back both files', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([write('a.md')])),
    held(),
    sse(anthropicToolReply([write('b.md'), speak('Filed both.'), sleep])),
  ] });
  try {
    const { bigSur, kyoto } = await twoTrips(page, llm.origin);
    await handOver(page, 'File this');
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(2);
    await page.goto(`/#/trip/${encodeURIComponent(kyoto)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto');
    await page.goto(`/#/trip/${encodeURIComponent(bigSur)}/talk`);
    await expect(page.locator('.convo').getByText(PAUSED)).toBeVisible();
    await expect(page.locator('.convo').getByText('Filed both.')).toHaveCount(1, { timeout: 30_000 });
    const bodies = llm.bodies(MESSAGES);
    expect(bodies.length).toBe(3);
    expect(lastUser(bodies[2])).toContain('Another conversation was opened in the middle of your turn');
    expect(plain(bodies[2].messages.slice(0, bodies[1].messages.length - 1))).toEqual(plain(bodies[1].messages.slice(0, -1)));
    noRecord(bodies);
    const { writes } = await filed(page, bigSur);
    expect(writes.map(([path]) => path)).toEqual(['/notes/a.md', '/notes/b.md']);
    expect(writes[0][1]).toBeTruthy();
    expect(writes[1][1]).toBe(writes[0][1]);
    expect(await undo(page, bigSur)).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test('another trip opened while her card waits: let go, no line and no request on return; the user\'s "Yes" carries the hand-over, and Undo takes it back', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'ask', input: { question: 'File it in your notes?', options: ['Yes', 'No'] } }, sleep])),
    sse(anthropicToolReply([write('f.md'), speak('Filed.'), sleep])),
  ] });
  try {
    const { bigSur, kyoto } = await twoTrips(page, llm.origin);
    await handOver(page, 'Here is my flight');
    await expect(page.locator('.convo').getByText('File it in your notes?')).toBeVisible({ timeout: 30_000 });
    await page.goto(`/#/trip/${encodeURIComponent(kyoto)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto');
    await page.goto(`/#/trip/${encodeURIComponent(bigSur)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
    await page.waitForTimeout(1000); // a restart would have asked by now
    await expect(page.locator('.convo').getByText(PAUSED)).toHaveCount(0);
    expect(llm.bodies(MESSAGES).length).toBe(1);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Yes');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Filed.')).toBeVisible({ timeout: 30_000 });
    const { writes } = await filed(page, bigSur);
    expect(writes).toEqual([['/notes/f.md', expect.any(String)]]);
    // The Undo line stays where it was when the user wrote (under her question), drawn as it was then: the conversation drawn again shows it.
    await page.reload();
    await expect(page.locator('.convo').getByText('Filed.')).toBeVisible({ timeout: 30_000 });
    expect(await undo(page, bigSur)).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test('her reply silent twice after a hand-over ("Shiori didn\'t answer"): Try again carries the hand-over, and Undo takes back what she files', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([sleep])),
    sse(anthropicToolReply([sleep])),
    sse(anthropicToolReply([write('f.md'), speak('Filed.'), sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await handOver(page, 'Here is my flight');
    await expect(page.getByText("Shiori didn't answer").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Try again' }).first().click();
    await expect(page.locator('.convo').getByText('Filed.')).toBeVisible({ timeout: 30_000 });
    const { writes } = await filed(page, trip);
    expect(writes).toEqual([['/notes/f.md', expect.any(String)]]);
    expect(await undo(page, trip)).toEqual([]);
    noRecord(llm.bodies(MESSAGES));
  } finally {
    await llm.stop();
  }
});
