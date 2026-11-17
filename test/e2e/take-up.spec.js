// A turn of hers that takes a hand-over up partway (loop.js join: files handed over while it runs, or an owed hand-over the user's words take
// up into a reminder's turn) writes a wake record of the turn that names it, where it takes it up. The Undo line follows that turn from there as
// it follows one that began with the hand-over: shown wherever the turn ends (its card, a Stop, a silent end, a move to another trip), live and
// after a reload, never put back above what was drawn since. The real loop with the model stand-in, then logs written by hand.
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startModelServer, anthropicToolReply, modelSetUp, startTrip, openApp } from './helpers.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const MESSAGES = '/b/v1/messages';
const sleep = { name: 'sleep', input: {} };
const write = { name: 'write', input: { path: '/trip/notes/f.md', content: 'Notes' } };
const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
/** A reply the stand-in never sends: the request stays open until the turn is cut. */
const held = () => ({ ...sse(anthropicToolReply([speak('Never said.'), sleep])), until: new Promise(() => {}) });
const refused = { status: 401, type: 'application/json', body: '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}' };
const UNDO = 'Undo what Shiori did with these files';

/** Hands Shiori the flight PDF from the type box, with words. @param {import('@playwright/test').Page} page @param {string} words */
async function handOver(page, words) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Give Shiori photos or files').setInputFiles({ name: 'flight.pdf', mimeType: 'application/pdf', buffer: await readFile(new URL('../fixtures/bookings/flight.pdf', import.meta.url)) });
  await expect(page.locator('.type-sheet .attach-chip')).toHaveCount(1);
  await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.type-sheet')).toBeHidden(); // kept and sent: it joins her turn at its next step
}

/** Types a line to Shiori. @param {import('@playwright/test').Page} page @param {string} words */
async function type(page, words) {
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.getByLabel('Message to Shiori').fill(words);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.type-sheet')).toBeHidden();
}

/** Her writes in a trip, with the hand-over each carries. @param {import('@playwright/test').Page} page @param {string} trip */
const filed = (page, trip) => page.evaluate(async (trip) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const store = await createIdbStore();
  const events = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(trip, { types: ['file.write'] }));
  store.close();
  return events.filter((/** @type {any} */ e) => e.actor === 'shiori').map((/** @type {any} */ e) => [e.data.path, e.data.handover ?? null]);
}, trip);

/** Whether her note is still in a trip. @param {import('@playwright/test').Page} page @param {string} trip */
const kept = (page, trip) => page.evaluate(async (trip) => {
  const { createIdbStore } = await import(/** @type {string} */ ('/src/core/store-idb.js'));
  const { Workspace } = await import(/** @type {string} */ ('/src/core/workspace.js'));
  const store = await createIdbStore();
  const there = Boolean(await new Workspace(store).read(trip, '/notes/f.md'));
  store.close();
  return there;
}, trip);

/** The words (or with `part` 'strong', the title; 'a', a link's words) of the line just above the hand-over's Undo line. @param {import('@playwright/test').Page} page @param {'p' | 'strong' | 'a'} [part] */
const above = (page, part = 'p') => page.locator('.convo li.undo-line').evaluate((li, part) => li.previousElementSibling?.querySelector(part)?.textContent ?? null, part);

/**
 * Where the Undo line is, now and drawn again from the log, then Undo, which takes her note back. @param {import('@playwright/test').Page} page
 * @param {string} trip @param {['p' | 'strong', string]} under
 */
async function shownUnder(page, trip, [part, words]) {
  const button = page.getByRole('button', { name: UNDO });
  // The button can show under an earlier line of hers before the card or line it belongs under is drawn: the place is read once that is drawn.
  const drawn = () => expect(page.locator('.convo').getByText(words, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeVisible({ timeout: 30_000 });
  await drawn();
  expect(await filed(page, trip)).toEqual([['/notes/f.md', expect.any(String)]]);
  expect(await above(page, part)).toBe(words);
  await page.reload();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await drawn();
  expect(await above(page, part)).toBe(words);
  await button.click();
  await expect(page.getByText('Undone.', { exact: true })).toBeVisible();
  expect(await kept(page, trip)).toBe(false);
}

// Files handed over while her turn for the user's question runs: the turn takes the hand-over up at its next step, and then ends in each way a turn can.
for (const shape of [
  { name: 'she speaks and writes, then the user taps Stop', replies: [[speak('Let me look at those.'), write], held()], stop: true, under: ['p', 'Let me look at those.'] },
  { name: 'she writes, then the user taps Stop (no line of hers since the hand-over)', replies: [[write], held()], stop: true, under: ['p', 'Here is my flight'] },
  { name: "she speaks and writes, then her model can't be reached", replies: [[speak('Let me look at those.'), write], refused], under: ['strong', "Shiori can't reach her model"] },
  { name: 'she writes and sleeps, then sleeps again ("Her turn ended")', replies: [[write, sleep], [sleep]], under: ['strong', 'Her turn ended'] },
]) {
  test(`a hand-over joins her running turn, and ${shape.name}: the Undo line shows where the turn ended, with no reload and after one, and Undo takes back what she filed`, async ({ page }) => {
    /** @type {(v?: unknown) => void} */
    let go = () => {};
    const gate = new Promise((r) => { go = r; });
    const llm = await startModelServer({ [MESSAGES]: [
      { ...sse(anthropicToolReply([speak('Looking it up.')])), until: gate }, // her turn for the user's question, answered once the files are handed over
      ...shape.replies.map((r) => (Array.isArray(r) ? sse(anthropicToolReply(r)) : r)),
    ] });
    try {
      await modelSetUp(page, llm.origin, 'Big Sur');
      const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
      await type(page, 'What is Big Sur?');
      await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(1);
      await handOver(page, 'Here is my flight');
      go();
      if (shape.stop) {
        await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(3); // the write is made, the next request is held
        await page.getByRole('button', { name: 'Shiori', exact: true }).click();
      }
      await shownUnder(page, trip, /** @type {['p' | 'strong', string]} */ (shape.under));
      expect(JSON.stringify(llm.bodies(MESSAGES)[1].messages)).toContain('Here is my flight'); // it joined that turn: her next request has it
    } finally {
      await llm.stop();
    }
  });
}

test('a hand-over joins her running turn, and she asks to carry on in Kyoto: Open lets the turn go there, and back in the first conversation the Undo line is last, under where she took the user, and Undo brings the file back', async ({ page }) => {
  /** @type {(v?: unknown) => void} */
  let go = () => {};
  const gate = new Promise((r) => { go = r; });
  let kyoto = '';
  const llm = await startModelServer({ [MESSAGES]: [
    { ...sse(anthropicToolReply([speak('Looking it up.')])), until: gate },
    () => sse(anthropicToolReply([speak('Let me look at those.'), { name: 'open_trip', input: { trip: kyoto, recap: 'They handed a flight for Kyoto.' } }])),
    sse(anthropicToolReply([speak('Here we are.'), sleep])), // in Kyoto
    sse(anthropicToolReply([sleep])),
  ] });
  try {
    await modelSetUp(page, llm.origin, 'Big Sur');
    const bigSur = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
    await page.goto('/#/trips');
    kyoto = await startTrip(page, 'Kyoto', { start: '2027-04-01', end: '2027-04-08' });
    await page.goto(`/#/trip/${encodeURIComponent(bigSur)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
    await type(page, 'What is Big Sur?');
    await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(1);
    await handOver(page, 'This is for Kyoto');
    go();
    await page.locator('.convo').getByRole('button', { name: 'Open', exact: true }).click({ timeout: 30_000 });
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Kyoto', { timeout: 30_000 });
    await page.goto(`/#/trip/${encodeURIComponent(bigSur)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText('Big Sur');
    const button = page.getByRole('button', { name: UNDO });
    await expect(button).toBeVisible({ timeout: 30_000 });
    expect(await above(page, 'a')).toBe('Shiori moved this to Kyoto.');
    expect(await page.locator('.convo li').last().evaluate((li) => li.classList.contains('undo-line'))).toBe(true);
    await button.click();
    await expect(page.getByText('Undone. Your files are back in Big Sur.')).toBeVisible();
  } finally {
    await llm.stop();
  }
});

// The hand-over's own turn ends silent, so it is still owed; a reminder's turn runs when the user types, and takes it up (the turn carried none).
for (const end of ['card', 'stop']) {
  test(`an owed hand-over taken up by a reminder's turn as the user types, which speaks and writes, then ${end === 'card' ? "can't reach her model" : 'the user taps Stop'}: the Undo line shows under ${end === 'card' ? 'its card' : 'her last line'}, with no reload and after one`, async ({ page }) => {
    /** @type {(v?: unknown) => void} */
    let go = () => {};
    const gate = new Promise((r) => { go = r; });
    const llm = await startModelServer({ [MESSAGES]: [
      sse(anthropicToolReply([sleep])), sse(anthropicToolReply([sleep])), // the hand-over's turn ends silent: owed
      { ...sse(anthropicToolReply([speak('Reminder: leave at 9.')])), until: gate }, // the reminder's turn, its first reply held until the user has typed
      sse(anthropicToolReply([speak('Let me look.'), write])),
      end === 'card' ? refused : held(),
    ] });
    try {
      await modelSetUp(page, llm.origin, 'Big Sur');
      const trip = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
      // The page's agent, kept from the next send on, so the test can wake her for a reminder.
      await page.evaluate(async () => {
        const { Halves } = await import(/** @type {string} */ ('/src/core/agent/halves.js'));
        const send = Halves.prototype.send;
        Halves.prototype.send = function (/** @type {any[]} */ ...a) {
          /** @type {any} */ (window).agent = this;
          return send.apply(this, a);
        };
      });
      await handOver(page, 'Here is my flight');
      await expect(page.locator('.convo').getByText('Her turn ended').first()).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => { const a = /** @type {any} */ (window).agent; a.wake({ kind: 'cue', text: 'Reminder: leave for the airport at 9.', scope: a.scope }); });
      await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(3);
      await type(page, 'Please file it');
      go();
      await expect(page.locator('.convo').getByText('Let me look.')).toBeVisible({ timeout: 30_000 });
      if (end === 'stop') {
        await expect.poll(() => llm.bodies(MESSAGES).length, { timeout: 30_000 }).toBe(5);
        await page.getByRole('button', { name: 'Shiori', exact: true }).click();
      }
      await shownUnder(page, trip, end === 'card' ? ['strong', "Shiori can't reach her model"] : ['p', 'Let me look.']);
    } finally {
      await llm.stop();
    }
  });
}

test('drawn from the log: a turn that took the hand-over up partway places the Undo line from its take-up on, under its last line, never back above what was drawn since; one from before the take-up was written still shows it', async ({ page }) => {
  await openApp(page, '#/trips');
  // No model is set, so opening a conversation wakes nothing. Each log is written by hand, in the order the real loop writes it (agent-handover.test.js), with a
  // write of hers under the hand-over so Undo has something to take back, and ends with a Stop's record, so opening it takes nothing up.
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
    const put = (trip, type, data, text) => record(store, trip, { type, actor: type === 'msg.user' ? 'user' : type.startsWith('out.') || type.endsWith('.moved') ? 'shiori' : 'system', data, ...(text ? { texts: [['text', text]] } : {}) });
    const stopped = (/** @type {string} */ trip) => put(trip, 'error', { kind: 'stopped', wake: 'stop', message: 'Stopped.', quiet: true });
    /** The turn takes the hand-over up (loop.js join). @param {string} trip @param {string} id @param {string} handover @param {string} [half] */
    const took = (trip, id, handover, half) => put(trip, 'wake', { id, meanwhile: true, reasons: [], handover, ...(half ? { half } : {}) });
    const SILENT = 'Her model finished without saying anything to you.';
    const kyoto = await createTrip(ws, { title: 'Kyoto' });
    /** @type {[string, string, string, string][]} the trip, its name, the line drawn last, the line the Undo line is under */
    const out = [];
    // Two halves: a hand-over joins Kokoro's running turn (a reminder's); the user says something else; Koe tells of the move before Kokoro's turn ends.
    {
      const id = await createTrip(ws, { title: 'Nara' });
      await put(id, 'wake', { id: 'k0', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
      await put(id, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
      await put(id, 'msg.user', { wake: 'w1', handed, handover: 'h-1', split: true }, '(files)');
      await put(id, 'out.speak', { id: 's1', half: 'koe', wake: 'w1' }, 'Let me look.');
      await took(id, 'k0', 'h-1', 'kokoro');
      await put(id, 'wake', { id: 'w3', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
      await put(id, 'msg.user', { wake: 'w3', split: true }, 'Thanks');
      await put(id, 'out.speak', { id: 's3', half: 'koe', wake: 'w3' }, 'Sure.');
      await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-1' });
      await put(id, 'handover.moved', { handover: 'h-1', wake: 'k0', half: 'kokoro', to: kyoto, started: false, count: 1 });
      await put(id, 'out.speak', { id: 's4', half: 'koe', wake: 'w4' }, 'I took it to Kyoto.');
      await put(id, 'turn.end', { half: 'kokoro', wake: 'k0', handover: 'h-1' });
      await stopped(id);
      out.push([id, 'Nara', 'I took it to Kyoto.', 'I took it to Kyoto.']);
    }
    // Two halves: the hand-over's turn of Kokoro's ended silent (owed); Kokoro's reminder turn takes it up when the user types, before or after Koe's first line.
    for (const early of [true, false]) {
      const title = early ? 'Kobe' : 'Osaka';
      const id = await createTrip(ws, { title });
      await put(id, 'wake', { id: 'w1', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-2' }], handover: 'h-2' });
      await put(id, 'msg.user', { wake: 'w1', handed, handover: 'h-2', split: true }, '(files)');
      await put(id, 'wake', { id: 'k1', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-2' }], handover: 'h-2' });
      await put(id, 'error', { kind: 'silent', half: 'kokoro', wake: 'k1', message: SILENT });
      await put(id, 'wake', { id: 'k2', half: 'kokoro', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
      await put(id, 'wake', { id: 'w5', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
      await put(id, 'msg.user', { wake: 'w5', split: true }, 'Please file it');
      if (early) await took(id, 'k2', 'h-2', 'kokoro');
      await put(id, 'out.speak', { id: 's5', half: 'koe', wake: 'w5' }, 'Let me look.');
      if (!early) await took(id, 'k2', 'h-2', 'kokoro');
      await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-2' });
      await put(id, 'handover.moved', { handover: 'h-2', wake: 'k2', half: 'kokoro', to: kyoto, started: false, count: 1 });
      await put(id, 'out.speak', { id: 's6', half: 'koe', wake: 'w6' }, 'I took it to Kyoto.');
      await put(id, 'turn.end', { half: 'kokoro', wake: 'k2', handover: 'h-2' });
      await stopped(id);
      out.push([id, title, 'I took it to Kyoto.', 'I took it to Kyoto.']);
    }
    // One Shiori: a hand-over joins her reminder's turn; the user says something meanwhile; she speaks, moves the file and says so.
    {
      const id = await createTrip(ws, { title: 'Nagoya' });
      await put(id, 'wake', { id: 'k0', reasons: [{ kind: 'cue', text: 'Reminder: leave for the airport at 9.' }], handover: null });
      await put(id, 'msg.user', { wake: 'k0', handed, handover: 'h-3', meanwhile: true }, '(files)');
      await took(id, 'k0', 'h-3');
      await put(id, 'out.speak', { id: 's1', wake: 'k0' }, 'Let me look.');
      await put(id, 'msg.user', { wake: 'k0', meanwhile: true }, 'Thanks');
      await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-3' });
      await put(id, 'handover.moved', { handover: 'h-3', wake: 'k0', to: kyoto, started: false, count: 1 });
      await put(id, 'out.speak', { id: 's2', wake: 'k0' }, 'I took it to Kyoto.');
      await put(id, 'turn.end', { wake: 'k0', handover: 'h-3' });
      await stopped(id);
      out.push([id, 'Nagoya', 'I took it to Kyoto.', 'I took it to Kyoto.']);
    }
    // One Shiori: her turn spoke before the hand-over joined it; the user says something else; she writes, with no line after: the line stays under the hand-over's
    // own line, not under her line before it. The same log from before the take-up was written: its turn.end names the hand-over, and the line shows there too.
    for (const old of [false, true]) {
      const title = old ? 'Sendai' : 'Sapporo';
      const id = await createTrip(ws, { title });
      await put(id, 'wake', { id: 'k0', reasons: [{ kind: 'user', text: 'typed' }], handover: null });
      await put(id, 'msg.user', { wake: 'k0' }, 'What is Big Sur?');
      await put(id, 'out.speak', { id: 's1', wake: 'k0' }, 'Looking it up.');
      await put(id, 'msg.user', { wake: 'k0', handed, handover: 'h-5', meanwhile: true }, 'Here is my flight');
      if (!old) await took(id, 'k0', 'h-5');
      await put(id, 'msg.user', { wake: 'k0', meanwhile: true }, 'Thanks');
      await ws.write(id, '/notes/flight.md', 'AN 123', { author: 'shiori', handover: 'h-5' });
      await put(id, 'turn.end', { wake: 'k0', handover: 'h-5' });
      await stopped(id);
      out.push([id, title, 'Thanks', 'Here is my flight']);
    }
    store.close();
    return out;
  });
  for (const [trip, title, last, under] of logs) {
    await page.goto(`/#/trip/${encodeURIComponent(trip)}/talk`);
    await expect(page.locator('.talk-head .talk-name')).toHaveText(title);
    await expect(page.locator('.convo').getByText(last, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: UNDO })).toBeVisible();
    expect.soft(await above(page), title).toBe(under);
  }
});
