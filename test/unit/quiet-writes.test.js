// The writes nobody waits on that still failed quietly on a full phone say so (quiet-writes-next; the Deferred entry "Some writes still fail quietly
// on a full phone"): each refused the way a full phone refuses (the kit's store: refusing), one card says so, "Something for Shiori wasn't saved", with
// the error (main.js shows the storage card in its place); a refusal of annai's own record of itself shows nothing of its own; with room, nothing new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, hear, raw, idleAtOnce } from './agent-kit.js';
import { liveKit, soon, tone } from './koe-live-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip } from '../../src/core/scopes.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { record, KOE_TAG } from '../../src/core/agent/log.js';

const NOT_SAVED = "Something for Shiori wasn't saved";
const LEAVE = 'Leave for the airport by 14:10';
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** @param {...[string, any]} list */
const calls = (...list) => ({ toolCalls: [...list.map(([name, input]) => ({ name, input })), { name: 'sleep', input: {} }] });
const choose = (/** @type {'A' | 'B'} */ letter) => ({ toolCalls: [{ name: 'decide', input: { option: letter } }] });
/** The cards that say a write wasn't saved. @param {any[]} cards */
const told = (cards) => cards.filter((n) => n.title === NOT_SAVED);
/** Each refused write told once, with a full phone's error. @param {any[]} cards @param {number} n @param {string} what */
function toldOnce(cards, n, what) {
  const t = told(cards);
  assert.equal(t.length, n, `${what}: ${JSON.stringify(cards.map((c) => c.title))}`);
  assert.ok(t.every((c) => c.error instanceof StorageFullError), `${what}: the storage card in its place`);
}

// loop.js #heard: the spoken line's route. Chatter heard in the window after her turn, nobody busy: written there as set aside.
for (const full of [false, true]) {
  test(`chatter heard in the window after her turn, ${full ? 'its write refused: one card says so' : 'with room: written, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Let me check.' } }] }, { text: 'done' }]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat', 'yes', 'did you lock the car'], decide: [choose('A'), choose('B')] } });
    await updateAppSettings(k.ws, { voice: { silenceSeconds: 100 } });
    const cards = raw(k);
    const store = refusing(k);
    k.agent.tap();
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'where-eat');
    await until(() => k.agent.state.name === 'listening'); // she spoke, and listens
    await hear(k, 'gas-station'); // the answer
    await until(() => k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision')).length === 2);
    while (k.agent.busy) await new Promise((r) => setTimeout(r, 5));
    assert.equal(k.platform.mic.isOpen(), true, 'it listens after the turn');
    if (full) store.full((ev) => ev.type === 'heard');
    await hear(k, 'first-one');
    if (full) await until(() => told(cards).length > 0);
    else while ((await k.events(['heard'])).length < 3) await new Promise((r) => setTimeout(r, 5));
    await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, 'the chatter line');
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => Boolean(e.data.dismissed)), full ? [false, false] : [false, false, true]);
  });
}

// loop.js #streamed's #cutSpeech: her words said aloud on a call that broke off, which the next call starts over; written marked cut, nobody waiting.
for (const full of [false, true]) {
  test(`what she said on a call that broke off and started over, ${full ? 'its cut line refused: one card says so' : 'with room: written cut, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[{ stream: true, breakAt: 4, pieceMs: 20, toolCalls: [{ name: 'speak', input: { text: 'First sentence here. Second one never comes.' } }] }, say('Said whole.')]], { voice: {} });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'out.speak' && ev.data?.cut === true);
    k.agent.send('Hi');
    await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, 'the cut line');
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]), [...(full ? [] : [['First sentence here.', true]]), ['Said whole.', false]]);
  });
}

// loop.js #afterTurn: what was heard is written down after a turn that worked (heard.text).
for (const full of [false, true]) {
  test(`what was heard, written down after the turn, ${full ? 'refused: one card says so' : 'with room: written, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Tacos are close.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'heard.text');
    k.agent.tap();
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'where-eat');
    await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, 'the words written down');
    assert.equal((await k.events(['heard.text'])).length, full ? 0 : 1);
    assert.equal((await k.events(['out.speak'])).length, 1, 'her turn worked');
  });
}

// halves.js #note: annai's note from Kokoro to Koe ("Kokoro was stopped"), written, then handed to Koe.
for (const full of [false, true]) {
  test(`the user's Stop on Kokoro while Koe waits: the note telling Koe so ${full ? 'refused: one card says so' : 'written with room: no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: { delayMs: 2000, toolCalls: [{ name: 'sleep', input: {} }] } }] }], { koe: { type: { rules: [
      { match: 'the user wrote', reply: { toolCalls: [{ name: 'speak', input: { text: 'Let me see.' } }, { name: 'wait', input: { seconds: 60 } }] }, then: sleep },
    ] } } });
    const cards = raw(k);
    const store = refusing(k);
    k.agent.send('Anything to see here?');
    await until(() => k.agent.koe.waiting && k.agent.kokoro.busy);
    if (full) store.full((ev) => ev.type === 'note');
    k.agent.stopKokoro();
    if (full) await until(() => told(cards).length > 0);
    else await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, 'the note');
    assert.deepEqual((await k.events(['note'])).map((/** @type {any} */ e) => e.data.text), full ? [] : ['Kokoro was stopped.']);
    if (full) k.agent.koe.interrupt(); // Koe never heard: its wait is let go here, as the user's next words would
    await k.agent.idle();
  });
}

// halves.js #settleAside: Koe's note Kokoro doesn't take up, as she had told Koe, written as settled (a quiet "answered" record her transcript reads).
for (const full of [false, true]) {
  test(`Koe's note Kokoro had answered already: its settled record ${full ? 'refused: one card says so' : 'written with room: no card'}`, async (t) => {
    useClock(t);
    let koeCalls = 0;
    const k = await agentKit([{ rules: [
      { match: 'the user wrote', times: 1, reply: calls(['tell_koe', { text: 'Check-in is at 3.' }]) },
      { match: '.', reply: calls(['tell_koe', { text: 'Again: check-in is at 3.' }]) },
    ] }], {
      koe: { type: { rules: [
        { match: 'the user wrote', reply: calls(['speak', { text: 'On it.' }]) },
        { match: 'a note from Kokoro', times: 1, reply: calls(['speak', { text: 'Check-in is at 3.' }], ['tell_kokoro', { text: 'Anything more about check-in?' }]) },
        { match: '.', reply: sleep },
      ] } },
      // Koe answers her note once her turn is over.
      hold: async (c) => { if (c.model.providerId === 'model-koe' && ++koeCalls === 2) await new Promise((r) => setTimeout(r, 50)); },
    });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'error' && ev.data?.kind === 'answered');
    k.agent.send('When is check-in?');
    await new Promise((r) => setTimeout(r, 200));
    await k.agent.idle();
    assert.equal((k.sent['model-0'] ?? []).length, 1, 'Koe\'s question took no turn of Kokoro\'s');
    toldOnce(cards, full ? 1 : 0, 'the settled record');
    assert.deepEqual((await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'answered').length, full ? 0 : 1);
  });
}

// halves.js #koeOpen: Koe's own open, whose repair of a call its cut turn left open is a write.
for (const full of [false, true]) {
  test(`Koe's own open, a call of its cut turn still open: ${full ? 'its repair refused, one card says so' : 'with room, repaired, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { koe: { type: { rules: [{ match: '.', reply: sleep }] } }, open: false });
    // Koe's turn was cut in the middle of a call (annai was closed): its reply is in the log, the call's result never came.
    await record(k.store, k.trip, { type: 'model.turn', actor: 'shiori', data: { tag: KOE_TAG, wake: 'w-cut', half: 'koe', endLogged: true }, texts: [['parts', JSON.stringify([{ type: 'tool_call', id: 'k-cut', name: 'speak', input: { text: 'Hello.' } }])]] });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full('all');
    await k.agent.open(k.trip);
    if (full) await until(() => told(cards).length > 0);
    await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, "Koe's open");
    assert.equal(k.agent.koe.target, full ? null : k.trip, full ? 'Koe stays out of it' : 'Koe opened it');
    assert.equal(k.agent.kokoro.trip, k.trip, 'Kokoro opened it either way');
  });
}

// halves.js #leftUnsaid: Kokoro's card that Koe · Classic still owed, shown in the conversation left as another opens.
for (const full of [false, true]) {
  test(`opening another conversation while Koe owes Kokoro's card: shown in the one left, ${full ? 'refused: one card says so' : 'with room: no card'}`, async (t) => {
    useClock(t);
    /** @type {() => void} */
    let release = () => {};
    const go = new Promise((r) => { release = () => r(undefined); });
    let koeCalls = 0;
    const card = { title: 'Fuel', text: 'Open until ten tonight.' };
    const KOE = { rules: [
      { match: 'the user wrote', reply: { toolCalls: [{ name: 'speak', input: { text: 'Let me look.' } }, { name: 'tell_kokoro', input: { text: 'Where is fuel?' } }, { name: 'wait', input: { seconds: 60 } }] } },
      { match: '.', reply: calls(['show', { card }]) },
    ] };
    // Koe's call that holds the note is held while the other conversation opens.
    const k = await agentKit([[sleep, sleep, sleep]], { koe: { type: KOE }, hold: async (/** @type {any} */ c) => { if (c.model.providerId === 'model-koe' && ++koeCalls === 2) await go; } });
    const cards = raw(k);
    const store = refusing(k);
    k.agent.send('Where is fuel?');
    await until(() => k.agent.koe.waiting);
    await k.agent.channel.send('kokoro', 'Kokoro wants to show: Fuel: Open until ten tonight.', 'append', 'gated:show', undefined, { name: 'show', input: { card } }, false, '');
    await until(() => koeCalls === 2 && !k.agent.kokoro.busy);
    const left = k.trip;
    const other = await createTrip(k.ws, { title: 'Carmel' });
    if (full) store.full((ev) => ev.type === 'out.show');
    await k.agent.open(other);
    release();
    await k.agent.idle();
    toldOnce(cards, full ? 1 : 0, 'the card shown in the conversation left');
    const shows = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(left, { types: ['out.show'] }));
    assert.equal(shows.length, full ? 0 : 1);
  });
}

// halves.js #koeFailed's route: Koe's list failed whole; Kokoro is told to talk directly (its block for Koe down, then its wake).
for (const full of [false, true]) {
  test(`Koe's list failing whole while the user waits: Kokoro's block that Koe is down ${full ? 'refused: one card says so (nobody would answer)' : 'written with room: Kokoro answers, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([{ rules: [{ match: "Koe can't speak", reply: say('Nepenthe is open till 10.') }, { match: '.', reply: sleep }] }], { halves: true, koe: { type: [{ delayMs: 60, error: 'auth', message: 'bad key' }] } });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'halves');
    k.agent.send('Is Nepenthe open?');
    await idleAtOnce(k);
    assert.equal(k.agent.koeState, 'down');
    toldOnce(cards, full ? 1 : 0, "Kokoro's block");
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), full ? [] : ['Nepenthe is open till 10.']);
  });
}

// koe/live.js #write: a live session's lines (here, her answer).
for (const full of [false, true]) {
  test(`a live session's answer ${full ? 'refused: one card says so' : 'written with room: no card'}`, async () => {
    const k = await liveKit([{ said: 'A taco stand, two minutes ahead.', audio: tone(0.2) }], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'out.speak');
      k.agent.send('Where can we eat?');
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.speak'])).length === 1);
      await k.agent.live.written();
      await k.agent.idle();
      toldOnce(cards, full ? 1 : 0, 'her line');
      assert.equal((await k.events(['out.speak'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// halves.js #route for #backstop (the session's unsaid): Kokoro's gated card a live Koe never showed, shown by annai.
for (const full of [false, true]) {
  test(`a live Koe silent on Kokoro's gated card: annai shows the card, ${full ? 'refused: one card says so' : 'with room: no card'}`, async () => {
    const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' };
    const k = await liveKit([{ said: 'Let me check.', audio: tone(0.2) }, {}]);
    try {
      const cards = raw(k);
      const store = refusing(k);
      k.agent.send('Is Nepenthe open tonight?');
      await soon(async () => (await k.events(['out.speak'])).length === 1);
      await k.agent.idle();
      if (full) store.full((ev) => ev.type === 'out.show');
      await k.agent.channel.send('kokoro', 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', 'append', 'gated:show', undefined, { name: 'show', input: { card } }, false, '');
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.show'])).length === 1);
      await k.agent.idle();
      toldOnce(cards, full ? 1 : 0, 'the card annai shows');
      assert.equal((await k.events(['out.show'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// halves.js #alongside, a wake's way to a live session that can't open, with Classic resting: Koe is down, and Kokoro's block says so. Refused, the
// wake is gone before any hand-on: its reminder is shown (wakeFailed), and the failure told.
test("a watch's wake with a reminder while Koe is live, no session can open and Classic rests, on a full phone: the reminder shown once, and a card says what failed", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    k.llm.bench.bench('m-koe', 60_000);
    k.llm.live = async () => { throw new Error('the connection was refused'); };
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await soon(async () => told(cards).length > 0, 10_000);
    await k.agent.idle();
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE], 'shown once');
    toldOnce(cards, 2, "the wake's way to a session (Kokoro's block), and the reminder's own entry");
    assert.ok(cards.findIndex((n) => n.title === 'Reminder') < cards.findIndex((n) => n.title === NOT_SAVED), 'shown before the failure is told');
  } finally {
    await k.done();
  }
});

// halves.js #alongside, a typed line's way to a live session that can't open, with Classic resting: Koe is down, and Kokoro's block says so before she
// is told to answer it. That block refused, the line (written already) would go unanswered: a card says so.
for (const full of [false, true]) {
  test(`a typed line to a live Koe when no session can open and Classic rests: ${full ? "Kokoro's block refused, one card says so" : 'Kokoro answers it, no card'}`, async () => {
    const k = await liveKit([], { kokoro: [{ rules: [{ match: "Koe can't speak", reply: say('Nepenthe is open till 10.') }, { match: '.', reply: sleep }] }], koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      k.llm.bench.bench('m-koe', 60_000);
      k.llm.live = async () => { throw new Error('the connection was refused'); };
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'halves');
      k.agent.send('Is Nepenthe open?');
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.speak'])).length === 1, 10_000);
      await k.agent.idle();
      toldOnce(cards, full ? 1 : 0, "the line's way to a session");
      assert.equal((await k.events(['msg.user'])).length, 1, 'the line itself is kept');
    } finally {
      await k.done();
    }
  });
}

// halves.js #tapFollow: a tap whose live session couldn't open is handed on (#liveTapFailed: Koe's way read again, Kokoro's block).
test("a tap whose live session can't open, with Classic resting, on a full phone: Kokoro's block refused, a card says so", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    k.llm.bench.bench('m-koe', 60_000);
    k.llm.live = async () => { throw new Error('the connection was refused'); };
    const cards = raw(k);
    const store = refusing(k);
    store.full('all');
    assert.equal(k.agent.tap(), 'listening');
    await soon(async () => told(cards).length > 0, 10_000);
    await k.agent.idle();
    toldOnce(cards, 1, 'the tap');
  } finally {
    await k.done();
  }
});

// halves.js deliver.koe: a note of Kokoro's to a live Koe whose session can't open (no catch at all before: a rejection nobody handled).
test("Kokoro's note to a live Koe when no session can open and Classic rests: its block refused, a card says so", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    k.llm.bench.bench('m-koe', 60_000);
    k.llm.live = async () => { throw new Error('the connection was refused'); };
    const cards = raw(k);
    const store = refusing(k);
    store.full((ev) => ev.type === 'halves');
    await k.agent.channel.send('kokoro', 'Say: Nepenthe is open until 10 PM tonight.', 'append', 'tool', undefined, undefined, false, 'Nepenthe is open until 10 tonight.');
    await soon(async () => told(cards).length > 0, 10_000);
    await k.agent.idle();
    toldOnce(cards, 1, 'the note');
  } finally {
    await k.done();
  }
});

// annai's own records of itself stay quiet: Kokoro's block for a live session's state (#block), refused, shows nothing of its own.
test("Kokoro's block that a live session opened, refused: nothing of its own", async () => {
  const k = await liveKit([{ said: 'A taco stand, two minutes ahead.', audio: tone(0.2) }], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    const cards = raw(k);
    const store = refusing(k);
    store.full((ev) => ev.type === 'halves');
    k.agent.send('Where can we eat?');
    await soon(async () => (await k.events(['out.speak'])).length === 1);
    await k.agent.idle();
    assert.equal((await k.events(['halves'])).length, 0, 'the block was refused');
    toldOnce(cards, 0, "annai's own record");
  } finally {
    await k.done();
  }
});

// halves.js #handOn's route: Kokoro's note for the user a closing session never passed on, with Koe still live and no session: annai shows it (#backstop).
for (const full of [false, true]) {
  test(`Kokoro's gated card a closing session hands on, shown by annai: ${full ? 'refused, one card says so' : 'with room, shown, no card'}`, async () => {
    const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' };
    const k = await liveKit([]);
    try {
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'out.show');
      const note = { kind: 'note', logged: true, from: 'kokoro', note: 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', mode: 'append', why: 'gated:show', call: { name: 'show', input: { card } }, text: 'a note from Kokoro' };
      k.agent.live.c.owed([note]); // a session that held it, closing
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.show'])).length === 1, 10_000);
      await k.agent.idle();
      toldOnce(cards, full ? 1 : 0, 'the card handed on');
      assert.equal((await k.events(['out.show'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// halves.js #dropped's route: a session dropped and couldn't resume, Classic resting: Koe is down (Kokoro's block). Cut mid-answer, Kokoro finishes it
// (#talkDirectly), so a refused block is told; not cut, the route only reads Koe's way again, and stays quiet (as #block does).
for (const cut of [true, false]) {
  test(`a live session dropped ${cut ? 'mid-answer' : 'between answers'} with Classic resting, Kokoro's blocks refused: ${cut ? 'one card says so (Kokoro would never finish it)' : 'nothing of their own'}`, async () => {
    const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      k.llm.bench.bench('m-koe', 60_000);
      const cards = raw(k);
      const store = refusing(k);
      store.full((ev) => ev.type === 'halves');
      k.agent.live.c.dropped(cut);
      if (cut) await soon(async () => told(cards).length > 0, 10_000);
      await k.agent.idle();
      assert.equal(k.agent.koeState, 'down');
      assert.equal((await k.events(['halves'])).length, 0, 'the blocks were refused');
      toldOnce(cards, cut ? 1 : 0, "Kokoro's block");
    } finally {
      await k.done();
    }
  });
}

// halves.js tap(), its route as annai starts (Koe's way not known yet), the store refusing reads and writes (Chromium at no byte free): Koe's way can't be
// read, so the tap goes nowhere, and a card says so (with room, a test in halves-live.test.js: live opens).
test("a tap as annai starts, before Koe's way is known, on a phone that refuses reads and writes: one card says so (the tap went nowhere)", async (t) => {
  /** @type {() => void} */
  let started = () => {};
  const k = await liveKit([], { open: false, ready: new Promise((resolve) => { started = () => resolve(undefined); }) });
  t.after(k.done);
  const cards = raw(k);
  const store = refusing(k);
  store.full('everything');
  assert.equal(k.agent.tap(), 'listening');
  started();
  await soon(async () => told(cards).length > 0, 10_000);
  await k.agent.idle();
  assert.equal(told(cards).length, 1, JSON.stringify(cards.map((c) => c.title)));
  assert.equal(told(cards)[0].error?.name, 'UnknownError', 'a refused read: its own words, no storage card');
});
