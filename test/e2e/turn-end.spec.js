// The loop's record of when a turn of Shiori's ends (the turn-end plan, §8): a reload and an open in the middle of a turn, in real engines,
// with the model stand-in. A turn cut at its work is taken up once, with the hand-over it carried, so Undo takes back what she did before the
// cut and after; a turn that ended is not taken up again; her card waiting is let go; Try again after "Shiori didn't answer" carries the
// hand-over. Nothing of the record reaches the model.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startModelServer, anthropicToolReply, modelSetUp, startTrip, openApp } from './helpers.js';

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

/** How many of her turns in a trip have ended (their turn.end records), as the page's store has them. @param {import('@playwright/test').Page} page @param {string} trip */
const ends = (page, trip) => page.evaluate(async (trip) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const n = (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['turn.end'] }))).length;
  store.close();
  return n;
}, trip);

/** The words (or with `part` 'strong', the title; 'a', a link's words) of the line just above the hand-over's Undo line. @param {import('@playwright/test').Page} page @param {'p' | 'strong' | 'a'} [part] */
const above = (page, part = 'p') => page.locator('.convo li.undo-line').evaluate((li, part) => li.previousElementSibling?.querySelector(part)?.textContent ?? null, part);

/** The text of a request's last user message. @param {any} body */
const lastUser = (body) => JSON.stringify([...(body?.messages ?? [])].reverse().find((/** @type {any} */ m) => m.role === 'user')?.content ?? '');
/** A request's messages without the cache marks, which move from one request to the next. @param {any[]} messages */
const plain = (messages) => JSON.parse(JSON.stringify(messages, (k, v) => (k === 'cache_control' ? undefined : v)));
/**
 * The restart's request is the held one's, and then its own line: every message before the held one's last, and that last one's results,
 * which the restart line follows in the same message. @param {any} held @param {any} restart
 */
function sameBefore(held, restart) {
  const n = held.messages.length;
  expect(plain(restart.messages.slice(0, n - 1))).toEqual(plain(held.messages.slice(0, -1)));
  const results = (/** @type {any} */ m) => (Array.isArray(m?.content) ? m.content.filter((/** @type {any} */ b) => b.type === 'tool_result') : []);
  expect(results(held.messages.at(-1)).length).toBeGreaterThan(0);
  expect(plain(results(restart.messages[n - 1]))).toEqual(plain(results(held.messages.at(-1))));
}

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
      sameBefore(bodies[1], bodies[2]);
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
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('What is Big Sur?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Big Sur is a coast.')).toBeVisible({ timeout: 30_000 });
    // Her line shows before her sleep's result and her turn.end are written: a reload before them cuts her turn, which is then taken up.
    await expect.poll(() => ends(page, trip), { timeout: 30_000 }).toBe(1);
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
    sameBefore(bodies[1], bodies[2]);
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
    // Her next turn carries the hand-over, so the Undo line follows it: under what she did, with no reload.
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    expect(await above(page)).toBe('Filed.');
    expect(await undo(page, bigSur)).toEqual([]);
  } finally {
    await llm.stop();
  }
});

test('her question card first, the user taps Yes, and she files: the Undo line shows under what she said she did, with no reload and after one, and Undo takes back what she filed', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([{ name: 'ask', input: { question: 'File it in your notes?', options: ['Yes', 'No'] } }, sleep])),
    sse(anthropicToolReply([write('f.md'), speak('Filed.'), sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await handOver(page, 'Here is my flight');
    await expect(page.locator('.convo').getByText('File it in your notes?')).toBeVisible({ timeout: 30_000 });
    await page.locator('.convo').getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(page.locator('.convo').getByText('Filed.')).toBeVisible({ timeout: 30_000 });
    const { writes } = await filed(page, trip);
    expect(writes).toEqual([['/notes/f.md', expect.any(String)]]);
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    expect(await above(page)).toBe('Filed.');
    // Drawn again, the line is where it was.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible({ timeout: 30_000 });
    expect(await above(page)).toBe('Filed.');
    expect(await undo(page, trip)).toEqual([]);
    expect(llm.bodies(MESSAGES).length).toBe(2);
  } finally {
    await llm.stop();
  }
});

test('her turn silent twice after a hand-over, and the user writes again instead of Try again: that turn carries the hand-over, and the Undo line shows under what she did', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Please file it');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('Filed.')).toBeVisible({ timeout: 30_000 });
    const { writes } = await filed(page, trip);
    expect(writes).toEqual([['/notes/f.md', expect.any(String)]]);
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    expect(await above(page)).toBe('Filed.');
    expect(await undo(page, trip)).toEqual([]);
  } finally {
    await llm.stop();
  }
});

/** What a model that can't be reached answers. */
const refused = { status: 401, type: 'application/json', body: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}' };

// Her last line, or the card that ends her turn, comes before her last write: the Undo line is there to tap anyway (it is looked at again where her turn ends
// or its card shows), with no reload and after one, where her turn ended, and Undo takes back exactly what she did.
for (const shape of [
  { name: 'her card, the user taps Yes, then she speaks, writes and sleeps', ask: true, replies: [[{ name: 'ask', input: { question: 'File it in your notes?', options: ['Yes', 'No'] } }, sleep], [speak('Filing it.'), write('f.md'), sleep]], under: ['p', 'Filing it.'] },
  { name: 'she speaks, writes and sleeps (no question)', replies: [[speak('I will file it now.'), write('f.md'), sleep]], under: ['p', 'I will file it now.'] },
  { name: 'a reply that only speaks, then one that writes and sleeps', replies: [[speak('Looking at it.')], [write('f.md'), sleep]], under: ['p', 'Looking at it.'] },
  { name: 'she writes and sleeps, then sleeps again ("Her turn ended", with no line of hers)', replies: [[write('f.md'), sleep], [sleep]], under: ['strong', 'Her turn ended'] },
  { name: "she writes, then her model can't be reached (no line of hers)", replies: [[write('f.md')], refused], under: ['strong', "Shiori can't reach her model"] },
  { name: "she speaks and writes, then her model can't be reached", replies: [[speak('Filing it.'), write('f.md')], refused], under: ['strong', "Shiori can't reach her model"] },
  { name: 'she writes, then the user stops her (no card, no turn end)', stop: true, replies: [[write('f.md')], held()], under: ['p', 'Here is my flight'] },
]) {
  test(`the Undo line shows where her turn ended, though her last line came before her last write: ${shape.name}`, async ({ page }) => {
    const llm = await startModelServer({ [MESSAGES]: shape.replies.map((r) => (Array.isArray(r) ? sse(anthropicToolReply(r)) : r)) });
    try {
      await modelSetUp(page, llm.origin, 'Big Sur');
      const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
      await handOver(page, 'Here is my flight');
      if (shape.ask) {
        await expect(page.locator('.convo').getByText('File it in your notes?')).toBeVisible({ timeout: 30_000 });
        await page.locator('.convo').getByRole('button', { name: 'Yes', exact: true }).click();
      }
      const button = page.getByRole('button', { name: 'Undo what Shiori did with these files' });
      if (shape.stop) {
        await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(2); // the write is made, the next request is held
        await page.getByRole('button', { name: 'Shiori', exact: true }).click();
      }
      await expect(button).toBeVisible({ timeout: 30_000 });
      expect((await filed(page, trip)).writes).toEqual([['/notes/f.md', expect.any(String)]]);
      expect(await above(page, /** @type {'p' | 'strong'} */ (shape.under[0]))).toBe(shape.under[1]);
      // Drawn again from the log, the line is where it was.
      await page.reload();
      await expect(button).toBeVisible({ timeout: 30_000 });
      expect(await above(page, /** @type {'p' | 'strong'} */ (shape.under[0]))).toBe(shape.under[1]);
      expect(await undo(page, trip)).toEqual([]);
    } finally {
      await llm.stop();
    }
  });
}

// Haiku's finding on undo-card's round 2: the move records carried no wake, so the turn's end put the line back under her earlier line, above the move.
test('a hand-over that joins her running turn, which ends on her moving its file to another trip: the Undo line shows under the move, with no reload and after one, and Undo takes it back', async ({ page }) => {
  /** @type {(v?: unknown) => void} */
  let go = () => {};
  const gate = new Promise((r) => { go = r; });
  let kyoto = '';
  const llm = await startModelServer({ [MESSAGES]: [
    { ...sse(anthropicToolReply([speak('Looking it up.')])), until: gate }, // her turn for the user's question, answered once the files are handed over
    () => sse(anthropicToolReply([speak('Let me look at those.'), { name: 'move_file', input: { path: '/trip/files/flight.pdf', trip: kyoto } }, sleep])),
  ] });
  try {
    const trips = await twoTrips(page, llm.origin);
    kyoto = trips.kyoto;
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('What is Big Sur?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(1); // her turn runs, its first request waiting
    await handOver(page, 'This is for Kyoto');
    await expect(page.locator('.type-sheet')).toBeHidden(); // kept and sent: it joins her turn at its next step
    go();
    await expect(page.getByRole('link', { name: 'Shiori took 1 file to Kyoto.' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => ends(page, trips.bigSur), { timeout: 30_000 }).toBe(1);
    expect(lastUser(llm.bodies(MESSAGES)[1])).toContain('This is for Kyoto'); // the hand-over joined that turn: no turn of its own
    const button = page.getByRole('button', { name: 'Undo what Shiori did with these files' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    expect(await above(page, 'a')).toBe('Shiori took 1 file to Kyoto.');
    // Drawn again from the log, the line is where it was.
    await page.reload();
    await expect(button).toBeVisible({ timeout: 30_000 });
    expect(await above(page, 'a')).toBe('Shiori took 1 file to Kyoto.');
    await button.click();
    await expect(page.getByText('Undone. Your files are back in Big Sur.')).toBeVisible();
    expect(llm.bodies(MESSAGES).length).toBe(2);
  } finally {
    await llm.stop();
  }
});

test('drawn from the log: while she is two halves, Kokoro\'s turns place the Undo line (words to Koe while Kokoro files don\'t stop it, the next ones after Kokoro\'s turn ended do, nor does a turn that carries no hand-over); a turn that took the hand-over up partway ends with the line, and ends on a move of the files without lifting it above Koe\'s words or a card; a log from before wakes named their hand-over keeps the user\'s words as the stop', async ({ page }) => {
  await openApp(page, '#/trips');
  // No model is set, so opening a conversation wakes nothing. Each log is written by hand, with only the records the Undo line goes by, in the order the loop writes them (a
  // real two-halves turn: Koe's wake, the user's line, Koe's words, Kokoro's wake naming the hand-over, her write, her turn.end naming it, then Koe's "Filed."; left out are
  // Koe's turn ends, Kokoro's note and Koe's wake for it, which it doesn't go by; the first log adds words to Koe while Kokoro files, "Thanks" and its answer; the partway
  // turn's order is the one agent-handover.test.js reads from the loop), with a write of hers under the hand-over so Undo has something to take back.
  const [halves, older, gap, partway, koeFirst, card, reminded] = await page.evaluate(async () => {
    const load = (/** @type {string} */ u) => import(u);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
    /** @param {string} trip @param {string} type @param {any} data @param {string} [text] */
    const put = (trip, type, data, text) => record(store, trip, { type, actor: type === 'msg.user' ? 'user' : type.startsWith('out.') || type.endsWith('.moved') ? 'shiori' : 'system', data, ...(text ? { texts: [['text', text]] } : {}) });
    /** A Stop's record (quiet, no line of its own) settles all before it, so that opening the conversation takes nothing up. @param {string} trip */
    const stopped = (trip) => put(trip, 'error', { kind: 'stopped', wake: 'stop', message: 'Stopped.', quiet: true });
    const a = await createTrip(ws, { title: 'Big Sur' });
    await put(a, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(a, 'msg.user', { wake: 'w1', handed, handover: 'h-1', split: true }, '(files)');
    await put(a, 'out.speak', { id: 's1', half: 'koe', wake: 'w1' }, 'Let me look.');
    await put(a, 'wake', { id: 'w2', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(a, 'wake', { id: 'w3', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
    await put(a, 'msg.user', { wake: 'w3', split: true }, 'Thanks');
    await put(a, 'out.speak', { id: 's2', half: 'koe', wake: 'w3' }, 'You are welcome.');
    await ws.write(a, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(a, 'turn.end', { half: 'kokoro', wake: 'w2', handover: 'h-1' });
    await put(a, 'out.speak', { id: 's3', half: 'koe', wake: 'w4' }, 'Filed it in your notes.');
    // A turn of Kokoro's that carries no hand-over (a cue), then Koe's line from it: the line stays under "Filed it in your notes."
    await put(a, 'wake', { id: 'w7', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Koe answered the user' }], handover: null });
    await put(a, 'out.speak', { id: 's5', half: 'koe', wake: 'w7' }, 'Reminder: leave for the airport.');
    await put(a, 'wake', { id: 'w5', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
    await put(a, 'msg.user', { wake: 'w5', split: true }, 'What time is the flight?');
    await put(a, 'out.speak', { id: 's4', half: 'koe', wake: 'w5' }, 'At nine.');
    await put(a, 'wake', { id: 'w6', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Koe answered the user' }], handover: null });
    await stopped(a);
    const b = await createTrip(ws, { title: 'Kyoto' });
    await put(b, 'wake', { id: 'w1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-2' }] });
    await put(b, 'msg.user', { wake: 'w1', handed, handover: 'h-2' }, '(files)');
    await put(b, 'out.ask', { id: 'q', wake: 'w1', question: 'File it?', options: ['Yes'] });
    await put(b, 'msg.user', { wake: 'w1', answer: 'q' }, 'Yes');
    await ws.write(b, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-2' });
    await put(b, 'out.speak', { id: 's1', wake: 'w1' }, 'Filed.');
    await stopped(b);
    // Two halves, the user speaking after Kokoro's turn ended and before Koe says what she filed: the line sits under what was last when Kokoro's turn ended, not under Koe's "Filed it"
    // (a finished log has every write in the store already, so this pins the place; that the turn's end shows the line when her write came after her last line is the live shapes above).
    const c = await createTrip(ws, { title: 'Lisbon' });
    await put(c, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-3' }], handover: 'h-3' });
    await put(c, 'msg.user', { wake: 'w1', handed, handover: 'h-3', split: true }, '(files)');
    await put(c, 'out.speak', { id: 's1', half: 'koe', wake: 'w1' }, 'Let me look.');
    await put(c, 'wake', { id: 'w2', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-3' }], handover: 'h-3' });
    await ws.write(c, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-3' });
    await put(c, 'turn.end', { half: 'kokoro', wake: 'w2', handover: 'h-3' });
    await put(c, 'wake', { id: 'w3', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
    await put(c, 'msg.user', { wake: 'w3', split: true }, 'Thanks');
    await put(c, 'out.speak', { id: 's2', half: 'koe', wake: 'w3' }, 'Filed it in your notes.');
    await stopped(c);
    // Her hand-over turn ended silent (its card), a reminder's turn (it carries none) took it up partway when the user typed meanwhile and wrote under it: its turn.end names it.
    const d = await createTrip(ws, { title: 'Oslo' });
    await put(d, 'wake', { id: 'w1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-4' }], handover: 'h-4' });
    await put(d, 'msg.user', { wake: 'w1', handed, handover: 'h-4' }, '(files)');
    await put(d, 'error', { kind: 'silent', wake: 'w1', message: 'Her model finished without saying anything to you.' });
    await put(d, 'wake', { id: 'w2', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
    await put(d, 'out.speak', { id: 's1', wake: 'w2' }, 'Reminder: leave at 9.');
    await put(d, 'msg.user', { wake: 'w2', meanwhile: true }, 'Please file it');
    await ws.write(d, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-4' });
    await put(d, 'out.speak', { id: 's2', wake: 'w2' }, 'Filed.');
    await put(d, 'turn.end', { wake: 'w2', handover: 'h-4' });
    await stopped(d);
    // Two halves, a hand-over joins Kokoro's running turn (a reminder's), which moves its file to Kyoto (b) and tells Koe: Koe says so, or annai shows Kokoro's card, before
    // Kokoro's turn ends. The move record carries Kokoro's wake, so that turn's end would put the line back under it, above what came after: it stays under the last line.
    /** @param {string} title @param {string} handover @param {(trip: string) => Promise<unknown>} after what is drawn after the move, before Kokoro's turn ends */
    const joined = async (title, handover, after) => {
      const id = await createTrip(ws, { title });
      await put(id, 'wake', { id: 'k0', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
      await put(id, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover }], handover });
      await put(id, 'msg.user', { wake: 'w1', handed, handover, split: true }, '(files)');
      await put(id, 'out.speak', { id: 's1', half: 'koe', wake: 'w1' }, 'Let me look.');
      await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover });
      await put(id, 'handover.moved', { handover, wake: 'k0', half: 'kokoro', to: b, started: false, count: 1 });
      await after(id);
      await put(id, 'turn.end', { half: 'kokoro', wake: 'k0', handover });
      await stopped(id);
      return id;
    };
    const e = await joined('Nara', 'h-5', (id) => put(id, 'out.speak', { id: 's2', half: 'koe', wake: 'w2' }, 'I took it to Kyoto.'));
    const f = await joined('Kobe', 'h-6', (id) => put(id, 'out.show', { id: 'c1', card: { title: 'Flight', text: 'AN 123' }, by: null }));
    // One Shiori: a hand-over's turn ended silent, a reminder's turn took it up partway when the user typed, spoke and moved its file (to Nagoya: its line is the one this page
    // waits for): the line follows the move, not her line before it.
    const nagoya = await createTrip(ws, { title: 'Nagoya' });
    const g = await createTrip(ws, { title: 'Sapporo' });
    await put(g, 'wake', { id: 'w1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-7' }], handover: 'h-7' });
    await put(g, 'msg.user', { wake: 'w1', handed, handover: 'h-7' }, '(files)');
    await put(g, 'error', { kind: 'silent', wake: 'w1', message: 'Her model finished without saying anything to you.' });
    await put(g, 'wake', { id: 'w2', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
    await put(g, 'out.speak', { id: 's1', wake: 'w2' }, 'Reminder: leave at 9.');
    await put(g, 'msg.user', { wake: 'w2', meanwhile: true }, 'Please file it');
    await put(g, 'out.speak', { id: 's2', wake: 'w2' }, 'Let me look.');
    await ws.write(g, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-7' });
    await put(g, 'handover.moved', { handover: 'h-7', wake: 'w2', to: nagoya, started: false, count: 1 });
    await put(g, 'turn.end', { wake: 'w2', handover: 'h-7' });
    await stopped(g);
    store.close();
    return [a, b, c, d, e, f, g];
  });
  for (const [trip, last, under, part] of [
    [halves, 'At nine.', 'Filed it in your notes.', 'p'], [older, 'Filed.', 'File it?', 'p'], [gap, 'Filed it in your notes.', 'Let me look.', 'p'], [partway, 'Filed.', 'Filed.', 'p'],
    [koeFirst, 'I took it to Kyoto.', 'I took it to Kyoto.', 'p'], [card, 'Flight', 'Flight', 'strong'], [reminded, 'Shiori took 1 file to Nagoya.', 'Shiori took 1 file to Nagoya.', 'a'],
  ]) {
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/talk`);
    await expect(page.locator('.convo').getByText(last, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    expect.soft(await above(page, /** @type {'p' | 'strong' | 'a'} */ (part)), last).toBe(under);
  }
});

test('drawn from the log: only the records of her turn that carries the hand-over move the Undo line, not another job\'s card, the user\'s words before her turn ends, Koe\'s answer after Kokoro was stopped, or the next turn\'s tidy-up card; after a turn of Kokoro\'s that took it up partway, Koe\'s line moves it', async ({ page }) => {
  await openApp(page, '#/trips');
  // Written by hand as the loop writes them, as in the test above; each log ends with a Stop's record, so opening it takes nothing up.
  const logs = await page.evaluate(async () => {
    const load = (/** @type {string} */ u) => import(u);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
    /** @param {string} trip @param {string} type @param {any} data @param {string} [text] */
    const put = (trip, type, data, text) => record(store, trip, { type, actor: type === 'msg.user' ? 'user' : type.startsWith('out.') ? 'shiori' : 'system', data, ...(text ? { texts: [['text', text]] } : {}) });
    const stopped = (/** @type {string} */ trip) => put(trip, 'error', { kind: 'stopped', wake: 'stop', message: 'Stopped.', quiet: true });
    /** One Shiori's hand-over and her line in its turn. @param {string} title */
    const start = async (title) => {
      const id = await createTrip(ws, { title });
      await put(id, 'wake', { id: 'w1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
      await put(id, 'msg.user', { wake: 'w1', handed, handover: 'h-1' }, '(files)');
      await put(id, 'out.speak', { id: 's1', wake: 'w1' }, 'Filing it.');
      return id;
    };
    // Another job's card while her turn runs (a watch that can't be checked, live.js): it names no turn of hers.
    const a = await start('Big Sur');
    await ws.write(a, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(a, 'error', { kind: 'trigger', message: "A watch can't be checked." });
    await stopped(a);
    // The user's words while her turn runs, then her turn ends after her write: the line stays under her line, not under their words.
    const b = await start('Kyoto');
    await put(b, 'msg.user', { wake: 'w1', meanwhile: true }, 'Thanks');
    await ws.write(b, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(b, 'turn.end', { wake: 'w1', handover: 'h-1' });
    await stopped(b);
    // Two halves: the user stops Kokoro after its write (no turn.end), then asks Koe something else: Koe's answer doesn't move the line.
    const c = await createTrip(ws, { title: 'Lisbon' });
    await put(c, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(c, 'msg.user', { wake: 'w1', handed, handover: 'h-1', split: true }, '(files)');
    await put(c, 'out.speak', { id: 's1', half: 'koe', wake: 'w1' }, 'Let me look.');
    await put(c, 'wake', { id: 'w2', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await ws.write(c, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(c, 'error', { kind: 'stopped', half: 'kokoro', wake: 'w2', message: 'Stopped.', quiet: true });
    await put(c, 'wake', { id: 'w3', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
    await put(c, 'msg.user', { wake: 'w3', split: true }, 'What about the hotel?');
    await put(c, 'out.speak', { id: 's2', half: 'koe', wake: 'w3' }, 'It is on Main Street.');
    await stopped(c);
    // Her "Filed.", her turn's end, then a reminder's turn whose tidy-up failed (its card): the line stays under "Filed.".
    const d = await start('Oslo');
    await ws.write(d, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(d, 'out.speak', { id: 's2', wake: 'w1' }, 'Filed.');
    await put(d, 'turn.end', { wake: 'w1', handover: 'h-1' });
    await put(d, 'wake', { id: 'w2', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
    await put(d, 'error', { kind: 'compaction', wake: 'w2', why: 'server', message: "Shiori couldn't tidy up the conversation." });
    await stopped(d);
    // Two halves: Kokoro's turn for the hand-over ended silent; a reminder's turn of Kokoro's took it up partway when the user typed, and filed: Koe's "Filed" after it tells of it.
    const e = await createTrip(ws, { title: 'Nara' });
    await put(e, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(e, 'msg.user', { wake: 'w1', handed, handover: 'h-1', split: true }, '(files)');
    await put(e, 'wake', { id: 'w2', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(e, 'error', { kind: 'silent', half: 'kokoro', aside: true, wake: 'w2', message: 'Her model finished without saying anything to you.' });
    await put(e, 'wake', { id: 'w3', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
    await put(e, 'wake', { id: 'w4', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
    await put(e, 'msg.user', { wake: 'w4', split: true }, 'Please file it');
    await put(e, 'out.speak', { id: 's1', half: 'koe', wake: 'w4' }, 'Let me ask Kokoro.');
    await ws.write(e, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(e, 'turn.end', { half: 'kokoro', wake: 'w3', handover: 'h-1' });
    await put(e, 'out.speak', { id: 's2', half: 'koe', wake: 'w5' }, 'Filed it in your notes.');
    await stopped(e);
    store.close();
    return [[a, "A watch can't be checked.", 'Filing it.'], [b, 'Thanks', 'Filing it.'], [c, 'It is on Main Street.', 'Let me look.'], [d, "Shiori couldn't tidy up the conversation", 'Filed.'], [e, 'Filed it in your notes.', 'Filed it in your notes.']];
  });
  for (const [trip, last, under] of logs) {
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/talk`);
    await expect(page.locator('.convo').getByText(last, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
    expect.soft(await above(page), last).toBe(under);
  }
});

test('Undo tapped while she works, with more files handed over and waiting: the newer hand-over keeps its own Undo line, which takes back what she filed for it', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([write('a.md'), speak('Filed.')])),
    held(),
    sse(anthropicToolReply([write('b.md'), speak('Filed the second.'), sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await handOver(page, 'File this');
    const button = page.getByRole('button', { name: 'Undo what Shiori did with these files' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(2); // her turn goes on: the next request is held
    await handOver(page, 'And this');
    await expect(page.locator('.type-sheet')).toBeHidden(); // the box closes once the files are kept and sent: they wait for her turn
    // Undo stops her turn and waits for her to be done: the waiting hand-over's turn runs first, and its line is drawn before Undo goes on.
    await button.click();
    await expect(page.locator('.convo').getByText('Filed the second.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Undone.', { exact: true })).toBeVisible({ timeout: 30_000 }); // the first hand-over's
    expect((await filed(page, trip)).there).toEqual(['/notes/b.md']);
    // The newer hand-over's line still offers its Undo, under what she said she filed for it.
    await expect(button).toBeVisible();
    expect(await above(page)).toBe('Filed the second.');
    await button.click();
    await expect(page.locator('.convo li.undo-line')).toHaveText('Undone');
    expect((await filed(page, trip)).there).toEqual([]);
  } finally {
    await llm.stop();
  }
});

// Undo stops her turn as Kokoro's Stop does (talk.js settled). While she is one Shiori, Koe has no model: a note to it ran a turn of Koe's that wrote a
// false "can't reach her model" card, whose Try again answered the hand-over again (undo-card's re-review 2, P1 and P3).
test('Undo tapped while one Shiori works: her turn stops, and nothing follows it: no note between halves, no "can\'t reach her model" card, and her next request is the user\'s next line', async ({ page }) => {
  const llm = await startModelServer({ [MESSAGES]: [
    sse(anthropicToolReply([write('a.md'), speak('Filed the first.')])),
    held(),
    sse(anthropicToolReply([speak('You are welcome.'), sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await handOver(page, 'File this');
    const button = page.getByRole('button', { name: 'Undo what Shiori did with these files' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(2); // her turn goes on: the next request is held
    await button.click();
    await expect(page.getByText('Undone.', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await filed(page, trip)).there).toEqual([]);
    // Undo waited for both halves to be done (their notes sent included), so a note would be in the log by now.
    const notes = await page.evaluate(async (trip) => {
      const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
      const store = await createIdbStore();
      const n = (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['note'] }))).length;
      store.close();
      return n;
    }, trip);
    expect(notes).toBe(0);
    // The user writes again: by her answer, a turn the Stop set off (Koe's, a restart) would have run and shown its card.
    await page.getByRole('button', { name: 'Type', exact: true }).click();
    await page.getByLabel('Message to Shiori').fill('Thanks');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.convo').getByText('You are welcome.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("can't reach her model")).toHaveCount(0);
    await expect(page.locator('.convo .halves-note')).toHaveCount(0);
    await expect(page.locator('.convo').getByText('Shiori woke to pick up where she left off.')).toHaveCount(0);
    const bodies = llm.bodies(MESSAGES);
    expect(bodies.length).toBe(3);
    expect(lastUser(bodies[2])).toContain('Thanks');
    expect(lastUser(bodies[2])).not.toContain('restarted');
    await expect(page.locator('.convo li.undo-line')).toHaveText('Undone');
  } finally {
    await llm.stop();
  }
});

test('a long conversation draws as many lines as before turn ends were read: the newest 400 records it draws, her turns\' ends read apart, and the Undo line of a hand-over at the end still follows them', async ({ page }) => {
  await openApp(page, '#/trips');
  // 200 exchanges of wake, the user's line and hers (three records the screen draws, two of them lines), each with its turn.end, then a hand-over she files with her line before her write.
  const trip = await page.evaluate(async () => {
    const load = (/** @type {string} */ u) => import(u);
    const { createIdbStore } = await load('/src/core/store-idb.js');
    const { Workspace } = await load('/src/core/workspace.js');
    const { createTrip } = await load('/src/core/scopes.js');
    const { record } = await load('/src/core/agent/log.js');
    const store = await createIdbStore();
    const ws = new Workspace(store);
    /** @param {string} trip @param {string} type @param {any} data @param {string} [text] */
    const put = (trip, type, data, text) => record(store, trip, { type, actor: type === 'msg.user' ? 'user' : type.startsWith('out.') ? 'shiori' : 'system', data, ...(text ? { texts: [['text', text]] } : {}) });
    const id = await createTrip(ws, { title: 'Big Sur' });
    for (let i = 0; i < 200; i++) {
      await put(id, 'wake', { id: `w${i}`, reasons: [{ kind: 'user', text: 'typed' }], handover: null });
      await put(id, 'msg.user', { wake: `w${i}` }, `Question ${i}`);
      await put(id, 'out.speak', { id: `s${i}`, wake: `w${i}` }, `Answer ${i}`);
      await put(id, 'turn.end', { wake: `w${i}`, handover: null });
    }
    await put(id, 'wake', { id: 'wh', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
    await put(id, 'msg.user', { wake: 'wh', handed: [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }], handover: 'h-1' }, '(files)');
    await put(id, 'out.speak', { id: 'sh', wake: 'wh' }, 'Filing it.');
    await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
    await put(id, 'turn.end', { wake: 'wh', handover: 'h-1' });
    await put(id, 'error', { kind: 'stopped', wake: 'stop', message: 'Stopped.', quiet: true }); // settles all before it: opening takes nothing up
    store.close();
    return id;
  });
  await page.goto(`/#/trip/${encodeURIComponent(trip)}/talk`);
  await expect(page.locator('.convo').getByText('Filing it.', { exact: true })).toBeVisible();
  // The newest 400 of the 604 records it draws (with the Stop's): that one, the 3 of the hand-over's exchange and 132 whole exchanges before them, 2 lines each; with turn.end among
  // the 400 there would be about 200 lines.
  await expect(page.locator('.convo > li:not(.undo-line)')).toHaveCount(2 * 133);
  await expect(page.getByRole('button', { name: 'Undo what Shiori did with these files' })).toBeVisible();
  expect(await above(page)).toBe('Filing it.');
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
