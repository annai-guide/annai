// The writes nobody waits on that still failed quietly on a full phone say so (quiet-writes-next; the Deferred entry "Some writes still fail quietly
// on a full phone"): each refused the way a full phone refuses (the kit's store: refusing), one card says so, "Something for Shiori wasn't saved", with
// the error (main.js shows the storage card in its place); a refusal of annai's own record of itself shows nothing of its own; with room, nothing new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, hear, raw, idleAtOnce } from './agent-kit.js';
import { liveKit, soon, tone, blocks, say as sayClip } from './koe-live-kit.js';
import { hum, quiet, cat } from './voice-kit.js';
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
/**
 * Each refused write told once, with a full phone's error. Counted after a short wait (nothing on the test's clock, 20 ms on a real one): a card a route
 * doesn't await would land after the route's own promise, and a count taken at once would miss it. @param {any[]} cards @param {number} n @param {string} what
 */
async function toldOnce(cards, n, what, { read = false } = {}) {
  await new Promise((r) => setTimeout(r, 20));
  const t = told(cards);
  assert.equal(t.length, n, `${what}: ${JSON.stringify(cards.map((c) => c.title))}`);
  // A refused read (Chromium at no byte free) isn't a full phone's write: no storage card, and the error stays the read's. The body is annai's keys note ("annai
  // couldn't check this message for keys, so it is not shown."): with reads refused the keys can't be read, so a card's body is withheld (the keys-unknown rule).
  if (read) assert.ok(t.every((c) => c.error?.name === 'UnknownError'), `${what}: the read's error, no storage card`);
  else assert.ok(t.every((c) => c.error instanceof StorageFullError), `${what}: the storage card in its place`);
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
    await toldOnce(cards, full ? 1 : 0, 'the chatter line');
    assert.deepEqual((await k.events(['heard'])).map((/** @type {any} */ e) => Boolean(e.data.dismissed)), full ? [false, false] : [false, false, true]);
  });
}

// loop.js #writeChatter at a step's boundary: chatter heard while she thinks is written in before her next step. A line refused is told, the next line is
// still written, and the next step goes on (it ended the turn before: "Shiori stopped"); the model's third call still runs and she says her answer.
for (const full of [false, true]) {
  test(`two chatter lines heard while she thinks, written in before her next step: ${full ? 'the first refused: one card says so, the second is written, and her next step still runs' : 'with room: written, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[
      { toolCalls: [{ name: 'speak', input: { text: 'Want tacos?' } }] },
      { delayMs: 120, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] },
      say('Tacos, noted.'),
    ]], { voice: { decide: [choose('A'), choose('B'), choose('B')], speechIn: ['m-hear'], hears: ['yes please', 'did you lock the car', 'is the pump free'] } });
    const cards = raw(k);
    const store = refusing(k);
    let lines = 0;
    if (full) store.full((ev) => ev.type === 'heard' && ev.data?.meanwhile === true && lines++ === 0); // the first only
    const mine = () => k.requests.filter((/** @type {any} */ r) => !String(r.system ?? '').startsWith('You make one quick decision'));
    k.agent.send('Lunch?');
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'first-one');
    await until(() => mine().length === 2);
    await hear(k, 'gas-station'); // chatter while the second call runs
    await hear(k, 'thanks');
    await k.agent.idle();
    await toldOnce(cards, full ? 1 : 0, 'the chatter line');
    assert.equal(mine().length, 3, 'her next step ran');
    // Written in before her next step: the third request holds the chatter line(s) written by then (the refused one is in no request).
    const third = JSON.stringify(mine()[2]);
    assert.equal(third.includes('did you lock the car'), !full, 'the first line: in her next step with room, gone when refused');
    assert.ok(third.includes('is the pump free'), 'the second line, written either way');
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Want tacos?', 'Tacos, noted.']);
    assert.equal((await k.events(['heard'])).filter((/** @type {any} */ e) => e.data.meanwhile).length, full ? 1 : 2, 'the refused line is gone, the other is written');
    assert.ok(!cards.some((n) => /stopped/i.test(n.title)), 'her turn was not stopped');
  });
}

// loop.js #cutSpeech at an immediate note (cutIn): her words cut while the call that holds them is still being written are written marked cut, inside the turn. A line refused is told and the turn
// goes on (it ended the turn before: "Shiori stopped"): her next call still runs.
for (const full of [false, true]) {
  test(`cutIn while her speak is still streaming in: her cut line ${full ? 'refused: one card says so, and the turn goes on' : 'written with room: no card'}`, async () => {
    // A half as Halves makes one, without Halves (agent-half.test.js).
    const half = { name: 'kokoro', tag: 'talk', role: 'main', registryTools: true, voice: () => true, logVoice: true, housekeeping: true, mark: (/** @type {string} */ type) => (type === 'msg.user' ? {} : { half: 'kokoro' }) };
    const k = await agentKit([[
      { stream: true, pieceMs: 30, toolCalls: [{ name: 'speak', input: { text: 'First sentence here. Second one is never finished, as the note cuts in.' } }] },
      sleep,
    ]], { voice: { playMs: 60, speechIn: ['m-hear'] }, agent: { half } });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'out.speak' && ev.data?.cut === true);
    k.agent.send('What is ahead?');
    await until(() => k.platform.log.some((/** @type {string} */ l) => l.startsWith('play ')));
    k.agent.cutIn();
    await k.agent.idle();
    await toldOnce(cards, full ? 1 : 0, 'the cut line');
    assert.equal(k.requests.length, full ? 3 : 2, 'the turn went on: her next call ran'); // refused, nothing in the log says she answered, so she is asked once more (a third call)
    assert.ok(!cards.some((n) => /stopped/i.test(n.title)), 'the turn was not stopped');
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => Boolean(e.data.cut)), full ? [] : [true]);
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
    await toldOnce(cards, full ? 1 : 0, 'the cut line');
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => [e.data.text, Boolean(e.data.cut)]), [...(full ? [] : [['First sentence here.', true]]), ['Said whole.', false]]);
  });
}

// loop.js #afterTurn: what was heard is written down after a turn that worked (heard.text).
for (const full of [false, true]) {
  test(`what was heard, written down after the turn, ${full ? 'refused: one card says so, the sound is kept and the next turn that works writes the words' : 'with room: written, no card'}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Tacos are close.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'heard.text');
    k.agent.tap();
    await until(() => k.agent.state.name === 'listening');
    await hear(k, 'where-eat');
    await k.agent.idle();
    await toldOnce(cards, full ? 1 : 0, 'the words written down');
    assert.equal((await k.events(['heard.text'])).length, full ? 0 : 1);
    assert.equal((await k.events(['out.speak'])).length, 1, 'her turn worked');
    if (!full) return;
    // Refused, the sound stays for the next turn that works, which writes the words down.
    const [line] = await k.events(['heard']);
    assert.ok(k.voice.memory.get(line.data.id), 'the sound is kept');
    store.full(null);
    k.agent.send('Thanks');
    await k.agent.idle();
    assert.deepEqual((await k.events(['heard.text'])).map((/** @type {any} */ e) => e.data.of), [line.data.id], 'written down by the next turn');
    assert.ok(!k.voice.memory.get(line.data.id), 'and the sound let go');
  });
}

// A refusal that isn't a full phone's (a bug of ours, a TypeError) is told as itself: the plain card with that error's words, and no storage card.
test("what was heard, written down after the turn, refused with an error that isn't a full phone's: a plain card with that error, no storage card", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Tacos are close.')]], { voice: { speechIn: ['m-hear'], hears: ['where should we eat'] } });
  const cards = raw(k);
  const store = refusing(k, { error: () => new TypeError('a bug of ours') });
  store.full((ev) => ev.type === 'heard.text');
  k.agent.tap();
  await until(() => k.agent.state.name === 'listening');
  await hear(k, 'where-eat');
  await k.agent.idle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(told(cards).length, 1, JSON.stringify(cards.map((c) => c.title)));
  assert.ok(told(cards)[0].error instanceof TypeError, 'its own error, not a StorageFullError');
  assert.equal(told(cards)[0].body, 'a bug of ours');
});

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
    await toldOnce(cards, full ? 1 : 0, 'the note');
    assert.deepEqual((await k.events(['note'])).map((/** @type {any} */ e) => e.data.text), full ? [] : ['Kokoro was stopped.']);
    if (full) k.agent.koe.interrupt(); // Koe never heard: its wait is let go here, as the user's next words would
    await k.agent.idle();
  });
}

// halves.js #nothingToAdd: Koe waits on a Kokoro that ends with nothing for it. The note saying so, refused, was never heard: a card says so, and the
// next look at Koe's wait (its second wait, 60 s later on the test's clock) sends it again. The first note only is refused.
test("Koe waits on a Kokoro with nothing to add, the first note refused: a card says so, and the next wait of Koe's is told", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: 'the user wrote', reply: sleep }] }], { koe: { type: { rules: [
    { match: 'the user wrote', reply: calls(['speak', { text: 'Let me see.' }], ['wait', { seconds: 60 }], ['wait', { seconds: 60 }]), then: sleep },
  ] } } });
  const cards = raw(k);
  const store = refusing(k);
  let notes = 0;
  store.full((ev) => ev.type === 'note' && notes++ === 0);
  k.agent.send('Anything to see here?');
  await k.agent.idle();
  await toldOnce(cards, 1, 'the first note');
  const waits = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.name === 'wait').map((/** @type {any} */ e) => e.data.content);
  assert.equal(waits.length, 2);
  assert.equal(waits[1], 'Kokoro: see the note below.', 'the second wait heard it');
  assert.deepEqual((await k.events(['note'])).map((/** @type {any} */ e) => [e.data.from, e.data.why]), [['kokoro', 'nothing-to-add']]);
});

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
    await toldOnce(cards, full ? 1 : 0, 'the settled record');
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
    await toldOnce(cards, full ? 1 : 0, "Koe's open");
    assert.equal(k.agent.koe.target, full ? null : k.trip, full ? 'Koe stays out of it' : 'Koe opened it');
    assert.equal(k.agent.kokoro.trip, k.trip, 'Kokoro opened it either way');
    const repairs = (await k.events(['tool.result'])).filter((/** @type {any} */ e) => e.data.id === 'k-cut');
    assert.equal(repairs.length, full ? 0 : 1, full ? 'the repair of the cut call was refused' : 'the cut call got its result');
  });
}

// halves.js #leftUnsaid: Kokoro's card that Koe · Classic still owed, shown in the conversation left as another opens.
for (const full of [false, true]) {
  test(`opening another conversation while Koe owes Kokoro's card and a note after it: ${full ? 'the card refused: one card says so, the note after it still shown in the one left' : 'both shown in the one left, no card'}`, async (t) => {
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
    await k.agent.channel.send('kokoro', 'Say: The pump takes cards.', 'append', 'tool', undefined, undefined, false, 'The pump takes cards.'); // a note after it, with words for the user
    await until(() => koeCalls === 2 && !k.agent.kokoro.busy);
    const left = k.trip;
    const other = await createTrip(k.ws, { title: 'Carmel' });
    if (full) store.full((ev) => ev.type === 'out.show');
    await k.agent.open(other);
    release();
    await k.agent.idle();
    await toldOnce(cards, full ? 1 : 0, 'the card shown in the conversation left');
    const shows = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(left, { types: ['out.show'] }));
    assert.equal(shows.length, full ? 0 : 1);
    // The refused card is gone, said; the note after it is still shown, and its reminder written, in the conversation left and not in the one opened.
    assert.deepEqual(cards.filter((n) => n.title === "Shiori's answer").map((n) => n.body), ['The pump takes cards.']);
    const reminders = (/** @type {string} */ scope) => k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['reminder'] }));
    assert.deepEqual((await reminders(left)).map((/** @type {any} */ e) => e.data.text), ['The pump takes cards.'], 'in the conversation left');
    assert.equal((await reminders(other)).length, 0, 'and not in the one opened');
  });
}

// halves.js #koeFailed's route: Koe's list failed whole; Kokoro is told to talk directly (its block for Koe down, then its wake). The block is annai's own
// record of Koe's state, so a refused one shows nothing of its own and doesn't stop the route: Kokoro answers all the same, and the block is written
// again by the next refresh once the store takes writes (#tell).
for (const full of [false, true]) {
  test(`Koe's list failing whole while the user waits: Kokoro's block that Koe is down ${full ? 'refused: Kokoro answers all the same, no card, and the block is written once the store takes writes' : 'written with room: Kokoro answers, no card'}`, async (t) => {
    useClock(t);
    // `then`: with the block refused the wake comes with no words after Kokoro's last results, which the scripted model reads as a follow-up
    const k = await agentKit([{ rules: [{ match: "Koe can't speak", reply: say('Nepenthe is open till 10.'), then: say('Nepenthe is open till 10.') }, { match: '.', reply: sleep }] }], { halves: true, koe: { type: [{ delayMs: 60, error: 'auth', message: 'bad key' }] } });
    const cards = raw(k);
    const store = refusing(k);
    if (full) store.full((ev) => ev.type === 'halves');
    k.agent.send('Is Nepenthe open?');
    await idleAtOnce(k);
    assert.equal(k.agent.koeState, 'down');
    await toldOnce(cards, 0, "Kokoro's block");
    assert.deepEqual((await k.events(['out.speak'])).map((/** @type {any} */ e) => e.data.text), ['Nepenthe is open till 10.']);
    const states = async () => (await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state);
    assert.deepEqual(await states(), full ? [] : ['koe-down']);
    if (full) {
      store.full(null); // room again: the next line's refresh writes what Kokoro wasn't told
      k.agent.send('And until when?');
      await idleAtOnce(k);
      assert.deepEqual(await states(), ['koe-down']);
    }
  });
}

// halves.js #tell's in-flight guard: Kokoro's block for Koe's state is marked told before its write, so a second refresh while the write is out (#refresh has callers
// outside the route's chain: split(), #live, #liveTapFailed) doesn't write the same block twice. The write is held here, a second refresh runs, and one is written.
test("Kokoro's block that Koe is down, its write still out when a second refresh finds the same state: written once", async (t) => {
  useClock(t);
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { halves: true, koe: { type: [{ delayMs: 60, error: 'auth', message: 'bad key' }] } });
  /** @type {() => void} */
  let release = () => {};
  const door = new Promise((r) => { release = () => r(undefined); });
  const log = k.agent.kokoro.log.bind(k.agent.kokoro);
  let writes = 0;
  k.agent.kokoro.log = (/** @type {any} */ ev, /** @type {any} */ o) => (ev.type === 'halves' && writes++ === 0 ? door.then(() => log(ev, o)) : log(ev, o));
  k.agent.send('Is Nepenthe open?');
  await until(() => writes === 1);
  await k.agent.split(); // a second refresh, the first's write still out
  assert.equal(writes, 1, 'the second refresh wrote nothing');
  release();
  await idleAtOnce(k);
  assert.deepEqual((await k.events(['halves'])).map((/** @type {any} */ e) => e.data.state), ['koe-down'], 'one block');
});

// The same route when the store then refuses reads (Chromium at no byte free): Koe's way can't be read again, so Kokoro is never told to talk directly (never
// woken: no request of hers), and a card says so. Beside it, Koe's own failed turn shows "Shiori stopped".
test("Koe's list failing whole while the user waits, the store then refusing reads: Kokoro is never woken to answer, and a card says so", async (t) => {
  useClock(t);
  /** @type {() => void} */
  let refuse = () => {};
  const k = await agentKit([{ rules: [{ match: '.', reply: sleep }] }], { halves: true, koe: { type: [{ delayMs: 60, error: 'auth', message: 'bad key' }] }, hold: async (/** @type {any} */ c) => { if (c.model.providerId === 'model-koe') refuse(); } });
  const cards = raw(k);
  const store = refusing(k);
  refuse = () => store.full('reads'); // from Koe's call on
  k.agent.send('Is Nepenthe open?');
  await idleAtOnce(k);
  store.full(null);
  await toldOnce(cards, 1, 'the route that talks directly', { read: true });
  assert.equal((k.sent['model-0'] ?? []).length, 0, 'Kokoro was never woken to answer');
  assert.equal(cards.filter((n) => n.title === 'Shiori stopped').length, 1, "only Koe's own failed turn stopped");
});

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
      await toldOnce(cards, full ? 1 : 0, 'her line');
      assert.equal((await k.events(['out.speak'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// koe/live.js #write: a live session's records for the Trace alone (the turn's numbers, live.turn) are annai's own record of itself: refused, nothing shows of
// its own. A sound at the open microphone that is no line (a door): its turn's end is the one write, and nothing of the traveller's or Shiori's is lost.
for (const full of [false, true]) {
  test(`a sound at a live session's open microphone that is no line: its turn's numbers ${full ? 'refused: nothing of their own' : 'written with room: no card'}`, async () => {
    const k = await liveKit([{}]);
    try {
      const cards = raw(k);
      const store = refusing(k);
      let tried = 0;
      store.full((ev) => { if (ev.type === 'live.turn' && full) tried++; return full && ev.type === 'live.turn'; });
      k.agent.tap();
      await until(() => k.agent.live.listening, 3000);
      k.platform.mic.feed(quiet(1.5, 0.006), 16_000);
      k.platform.mic.feed(cat(hum(0.6, 0.5), quiet(1, 0.006)), 16_000);
      if (full) await soon(async () => tried > 0, 3000);
      else await soon(async () => (await k.events(['live.turn'])).length === 1, 3000);
      await k.agent.live.written();
      await k.agent.idle();
      await toldOnce(cards, 0, "the turn's numbers");
      assert.equal((await k.events(['live.turn'])).length, full ? 0 : 1);
      assert.deepEqual((await k.events(['heard', 'out.speak'])).map((/** @type {any} */ e) => e.type), [], 'no line, no answer');
    } finally {
      await k.done();
    }
  });
}

// koe/live.js #write, the other records for the Trace alone: a turn the model gave nothing back for and the session let go (the live-silent note of #silent's "taken
// as let go"; its four other notes pass the same flag and aren't reached here), and the numbers of how her reply played (live.reply), refused with the turn's own:
// nothing of their own, and her line, written beside them, stays.
test("a live session's Trace records refused (a turn taken as let go, her reply's numbers, the turns'): nothing of their own, and her answer is written", async () => {
  const k = await liveKit([{ heardFirst: true, heard: 'la la', silent: true }, { heard: 'where to', said: 'Tacos ahead.', audio: tone(0.1) }]);
  try {
    const cards = raw(k);
    const store = refusing(k);
    /** @type {Set<string>} */
    const tried = new Set();
    store.full((ev) => {
      const trace = ev.type === 'live.turn' || ev.type === 'live.reply' || (ev.type === 'error' && ev.data?.kind === 'live-silent');
      if (trace) tried.add(ev.type === 'error' ? ev.data.kind : ev.type);
      return trace;
    });
    await k.voice.unlock();
    k.agent.tap();
    await until(() => k.agent.live.listening, 3000);
    await sayClip(k, 'where-eat');
    await soon(async () => tried.has('live-silent'), 5000);
    await k.agent.live.idle();
    await sayClip(k, 'where-eat');
    await soon(async () => (await k.events(['out.speak'])).length === 1 && tried.has('live.reply'), 5000);
    await k.agent.live.written();
    await k.agent.idle();
    assert.deepEqual([...tried].sort(), ['live-silent', 'live.reply', 'live.turn']);
    await toldOnce(cards, 0, "the Trace's records");
    assert.deepEqual((await k.events(['live.turn', 'live.reply'])).map((/** @type {any} */ e) => e.type), [], 'refused');
    assert.equal((await k.events(['out.speak'])).length, 1, 'her answer is written');
  } finally {
    await k.done();
  }
});

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
      await toldOnce(cards, full ? 1 : 0, 'the card annai shows');
      assert.equal((await k.events(['out.show'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// halves.js #live, a note no live session takes while Koe's way stays live (today's spend reached): annai shows Kokoro's card itself (#backstop), and a card refused
// is told there.
for (const full of [false, true]) {
  test(`Kokoro's gated card to a live Koe when today's spend is reached and Koe stays live: annai shows it, ${full ? 'refused: one card says so' : 'with room: no card'}`, async () => {
    const usage = { promptTokenCount: 1_000_000, responseTokenCount: 0, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 1_000_000 }] };
    const k = await liveKit([{ said: 'Sure.', audio: tone(0.1), usage }]);
    try {
      await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
      k.agent.send('Hi');
      await soon(async () => (await k.events(['live.session'])).some((/** @type {any} */ e) => e.data.state === 'closed'));
      await k.agent.idle();
      const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' };
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'out.show');
      await k.agent.channel.send('kokoro', 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', 'append', 'gated:show', undefined, { name: 'show', input: { card } }, false, '');
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.show'])).length === 1, 10_000);
      await k.agent.idle();
      assert.equal(k.agent.koeState, 'live', 'Koe stays live: no session could open, none failed');
      await toldOnce(cards, full ? 1 : 0, 'the card annai shows');
      assert.equal((await k.events(['out.show'])).length, full ? 0 : 1);
    } finally {
      await k.done();
    }
  });
}

// halves.js #alongside, a wake's way to a live session that can't open (Chromium at no byte free: the failed open leaves the store refusing reads, C130's
// shape): Koe's way can't be read again, so the wake is gone before any hand-on: its reminder is shown (wakeFailed), and the failure told (the card's body is
// annai's keys note, as for any refused read: the keys can't be read either).
test("a watch's wake with a reminder while Koe is live, when its session can't open and the store then refuses reads: the reminder shown once, and one card for the failed open", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
  try {
    const cards = raw(k);
    const store = refusing(k);
    k.llm.live = async () => { store.full('reads'); throw new Error('the connection was refused'); };
    k.agent.wake({ kind: 'trigger', text: 'Your watch fired.', fallbacks: [{ watch: 'w1', text: LEAVE }] });
    await soon(async () => told(cards).length > 0, 10_000);
    store.full(null);
    await k.agent.idle();
    assert.deepEqual(cards.filter((n) => n.title === 'Reminder').map((n) => n.body), [LEAVE], 'shown once');
    await toldOnce(cards, 1, "the wake's way to a session", { read: true });
    assert.ok(cards.findIndex((n) => n.title === 'Reminder') < cards.findIndex((n) => n.title === NOT_SAVED), 'shown before the failure is told');
  } finally {
    await k.done();
  }
});

// halves.js #alongside, a typed line's way to a live session that can't open, with Classic resting: Koe is down, and Kokoro's block says so before she
// is told to answer it. The block is annai's own record (Kokoro's request tail says so on every request): refused, nothing shows of its own, and she answers
// the line (written already) all the same.
for (const full of [false, true]) {
  test(`a typed line to a live Koe when no session can open and Classic rests: ${full ? "Kokoro's block refused: she answers it all the same, no card" : 'Kokoro answers it, no card'}`, async () => {
    const k = await liveKit([], { kokoro: [{ rules: [{ match: "Koe can't speak", reply: say('Nepenthe is open till 10.') }, { match: '.', reply: sleep }] }], koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      k.llm.bench.bench('m-koe', 60_000);
      k.llm.live = async () => { throw new Error('the connection was refused'); };
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'halves');
      k.agent.send('Is Nepenthe open?');
      await soon(async () => (await k.events(['out.speak'])).length === 1, 10_000);
      await k.agent.idle();
      assert.equal((await k.events(['out.speak'])).length, 1, 'she answered it once');
      await toldOnce(cards, 0, "the line's way to a session");
      assert.equal((await k.events(['msg.user'])).length, 1, 'the line itself is kept');
      assert.deepEqual(await blocks(k), full ? [] : ['koe-down']);
    } finally {
      await k.done();
    }
  });
}

// halves.js #tapFollow: a tap whose live session couldn't open is handed on (#liveTapFailed: Koe's way read again, Kokoro's block). The block is annai's own
// record: refused, the tap goes on to Kokoro with nothing shown of its own. A refused read (Chromium at no byte free) can't read Koe's way: the tap is gone, said.
for (const reads of [false, true]) {
  test(`a tap whose live session can't open, with Classic resting, ${reads ? 'the store then refusing reads: a card says the tap is gone' : "Kokoro's block refused: the tap goes on, no card"}`, async () => {
    const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      k.llm.bench.bench('m-koe', 60_000);
      const cards = raw(k);
      const store = refusing(k);
      k.llm.live = async () => { store.full(reads ? 'reads' : (ev) => ev.type === 'halves'); throw new Error('the connection was refused'); };
      assert.equal(k.agent.tap(), 'listening');
      if (reads) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => k.notices.some((n) => n.title === "Koe's live voice couldn't start"), 10_000);
      await k.agent.idle();
      store.full(null);
      await toldOnce(cards, reads ? 1 : 0, 'the tap', { read: reads });
      if (reads) return;
      assert.ok(store.tried.some((/** @type {any} */ e) => e.data?.state === 'koe-down'), 'the block was tried, and refused');
      assert.deepEqual(await blocks(k), [], 'and never written');
      assert.equal(k.platform.mic.isOpen(), true, 'the tap went on: her microphone is open');
    } finally {
      await k.done();
    }
  });
}

// halves.js deliver.koe: a note of Kokoro's to a live Koe whose session can't open (no catch at all before: a rejection nobody handled). With Kokoro's block
// refused (annai's own record, quiet) she is woken to talk directly all the same, and the block is written by the next refresh with what she owed
// ("What you last told Koe didn't reach the user"); a refused read is told.
for (const reads of [false, true]) {
  test(`Kokoro's note to a live Koe when no session can open and Classic rests: ${reads ? 'the store then refusing reads: a card says so' : 'its block refused: nothing of its own, written by the next refresh with what she owed'}`, async () => {
    const k = await liveKit([], { kokoro: [{ rules: [{ match: "Koe can't speak", reply: say('Nepenthe is open till 10.') }, { match: '.', reply: sleep }] }], koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
    try {
      k.llm.bench.bench('m-koe', 60_000);
      const cards = raw(k);
      const store = refusing(k);
      k.llm.live = async () => { store.full(reads ? 'reads' : (ev) => ev.type === 'halves'); throw new Error('the connection was refused'); };
      await k.agent.channel.send('kokoro', 'Say: Nepenthe is open until 10 PM tonight.', 'append', 'tool', undefined, undefined, false, 'Nepenthe is open until 10 tonight.');
      if (reads) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => k.agent.koeState === 'down', 10_000);
      await k.agent.idle();
      store.full(null); // only now: the block's write is refused first
      await toldOnce(cards, reads ? 1 : 0, 'the note', { read: reads });
      if (reads) return;
      assert.ok(store.tried.some((/** @type {any} */ e) => e.data?.state === 'koe-down'), 'the block was tried, and refused');
      assert.deepEqual(await blocks(k), [], 'and never written');
      assert.equal((await k.events(['out.speak'])).length, 1, 'Kokoro was woken to talk directly all the same, and did');
      k.agent.send('Anything else?'); // the next refresh writes it
      await k.agent.idle();
      const written = await k.events(['halves']);
      assert.deepEqual(written.map((/** @type {any} */ e) => e.data.state), ['koe-down']);
      assert.match(JSON.stringify(written[0]), /didn't reach the user/, 'with what she owed');
    } finally {
      await k.done();
    }
  });
}

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
    assert.ok(store.tried.some((/** @type {any} */ e) => e.data?.state === 'live-open'), 'the block was tried, and refused');
    assert.equal((await k.events(['halves'])).length, 0, 'and never written');
    await toldOnce(cards, 0, "annai's own record");
  } finally {
    await k.done();
  }
});

// halves.js #handOn's route: Kokoro's note for the user a closing session never passed on, with Koe still live and no session: annai shows it (#backstop).
for (const full of [false, true]) {
  test(`Kokoro's gated card and a note after it, a closing session hands on, shown by annai: ${full ? 'the card refused, one card says so, the note still shown' : 'with room, shown, no card'}`, async () => {
    const card = { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' };
    const k = await liveKit([]);
    try {
      const cards = raw(k);
      const store = refusing(k);
      if (full) store.full((ev) => ev.type === 'out.show');
      const note = { kind: 'note', logged: true, from: 'kokoro', note: 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', mode: 'append', why: 'gated:show', call: { name: 'show', input: { card } }, text: 'a note from Kokoro' };
      const words = { kind: 'note', logged: true, from: 'kokoro', note: 'Say: Nepenthe takes cards.', mode: 'append', why: 'tool', forUser: 'Nepenthe takes cards.', text: 'a note from Kokoro' };
      k.agent.live.c.owed([note, words]); // a session that held them, closing
      if (full) await soon(async () => told(cards).length > 0, 10_000);
      else await soon(async () => (await k.events(['out.show'])).length === 1, 10_000);
      await k.agent.idle();
      await toldOnce(cards, full ? 1 : 0, 'the card handed on');
      assert.equal((await k.events(['out.show'])).length, full ? 0 : 1);
      // The refused card is gone, said; the note after it is still shown.
      assert.deepEqual(cards.filter((n) => n.title === "Shiori's answer").map((n) => n.body), ['Nepenthe takes cards.']);
    } finally {
      await k.done();
    }
  });
}

// halves.js's "unshown" records (#unshown): a line for the Trace alone when annai had nothing to show of Kokoro's, so refused it shows no card, as a live session's
// Trace records show none. Here what a closing session hands on (#backstop, #present): a note with no words for the user, already retold once; a gated speak with no
// words; a gated card or question too broken to show, with no words to give instead.
for (const [what, note, said] of /** @type {[string, any, RegExp][]} */ ([
  ["a note of Kokoro's with no words for the user, retold once,", { note: 'Say: it is nothing.', why: 'tool', retold: true, forUser: '' }, /note wasn't passed on/],
  ["Kokoro's gated speak with no words", { note: '', why: 'gated:speak', call: { name: 'speak', input: { text: '' } } }, /speak wasn't shown/],
  ["Kokoro's gated card too broken to show, with no words,", { note: '', why: 'gated:show', call: { name: 'show', input: { card: {} } } }, /card wasn't shown/],
  ["Kokoro's gated question too broken to show, with no words,", { note: '', why: 'gated:ask', call: { name: 'ask', input: { options: [] } } }, /question wasn't shown/],
])) {
  for (const full of [false, true]) {
    test(`${what} that a closing session hands on: its Trace line ${full ? 'refused: no card' : 'written with room: no card'}`, async () => {
      const k = await liveKit([]);
      try {
        const cards = raw(k);
        const store = refusing(k);
        if (full) store.full((ev) => ev.type === 'error' && ev.data?.kind === 'unshown');
        k.agent.live.c.owed([{ kind: 'note', logged: true, from: 'kokoro', mode: 'append', text: 'a note from Kokoro', ...note }]); // a session that held it, closing
        const unshown = async () => (await k.events(['error'])).filter((/** @type {any} */ e) => e.data.kind === 'unshown');
        if (full) await soon(async () => store.tried.some((/** @type {any} */ e) => e.data?.kind === 'unshown'), 10_000);
        else await soon(async () => (await unshown()).length === 1, 10_000);
        await k.agent.idle();
        await toldOnce(cards, 0, "the Trace's line");
        const lines = full ? store.tried.filter((/** @type {any} */ e) => e.data?.kind === 'unshown') : await unshown();
        assert.equal(lines.length, 1);
        assert.match(lines[0].data.message, said);
        assert.equal((await unshown()).length, full ? 0 : 1);
      } finally {
        await k.done();
      }
    });
  }
}

// halves.js #leftUnsaid's "unshown" record: Kokoro's question that Koe · Classic still owed, let go as another conversation opens. A line for the Trace alone,
// in the conversation left: refused, no card.
for (const full of [false, true]) {
  test(`opening another conversation while Koe owes Kokoro's question: its Trace line ${full ? 'refused: no card' : 'written with room in the conversation left, no card'}`, async (t) => {
    useClock(t);
    /** @type {() => void} */
    let release = () => {};
    const go = new Promise((r) => { release = () => r(undefined); });
    let koeCalls = 0;
    const ask = { question: 'Diesel or petrol?', options: ['Diesel', 'Petrol'] };
    const KOE = { rules: [
      { match: 'the user wrote', reply: { toolCalls: [{ name: 'speak', input: { text: 'Let me look.' } }, { name: 'tell_kokoro', input: { text: 'Which fuel?' } }, { name: 'wait', input: { seconds: 60 } }] } },
      { match: '.', reply: calls(['ask', ask]) },
    ] };
    // Koe's call that holds the note is held while the other conversation opens.
    const k = await agentKit([[sleep, sleep, sleep]], { koe: { type: KOE }, hold: async (/** @type {any} */ c) => { if (c.model.providerId === 'model-koe' && ++koeCalls === 2) await go; } });
    const cards = raw(k);
    const store = refusing(k);
    k.agent.send('Which fuel?');
    await until(() => k.agent.koe.waiting);
    await k.agent.channel.send('kokoro', 'Kokoro wants to ask: Diesel or petrol? (Diesel, Petrol)', 'append', 'gated:ask', undefined, { name: 'ask', input: ask }, false, '');
    await until(() => koeCalls === 2 && !k.agent.kokoro.busy);
    const left = k.trip;
    const other = await createTrip(k.ws, { title: 'Carmel' });
    if (full) store.full((ev) => ev.type === 'error' && ev.data?.kind === 'unshown');
    await k.agent.open(other);
    release();
    await k.agent.idle();
    await toldOnce(cards, 0, "the Trace's line");
    const unshown = async (/** @type {string} */ scope) => (await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(scope, { types: ['error'] }))).filter((/** @type {any} */ e) => e.data.kind === 'unshown');
    const lines = full ? store.tried.filter((/** @type {any} */ e) => e.data?.kind === 'unshown') : await unshown(left);
    assert.equal(lines.length, 1, full ? 'the line was tried' : 'in the conversation left');
    assert.match(lines[0].data.message, /question wasn't shown/);
    assert.equal((await unshown(left)).length, full ? 0 : 1);
    assert.equal((await unshown(other)).length, 0, 'and not in the one opened');
  });
}

// The same hand-on when the store refuses reads (Chromium at no byte free): Koe's way can't be read again, so none of the notes is shown, and a card says so.
test("Kokoro's gated card a closing session hands on, the store refusing reads: a card says so (the note isn't shown)", async () => {
  const k = await liveKit([]);
  try {
    const cards = raw(k);
    const store = refusing(k);
    store.full('reads');
    const note = { kind: 'note', logged: true, from: 'kokoro', note: 'Kokoro wants to show: Nepenthe: Open 11:30–22:00 today.', mode: 'append', why: 'gated:show', call: { name: 'show', input: { card: { title: 'Nepenthe', text: 'Open 11:30–22:00 today.' } } }, text: 'a note from Kokoro' };
    k.agent.live.c.owed([note]);
    await soon(async () => told(cards).length > 0, 10_000);
    await k.agent.idle();
    store.full(null);
    await toldOnce(cards, 1, 'the hand-on', { read: true });
    assert.equal((await k.events(['out.show'])).length, 0, 'nothing was shown');
  } finally {
    await k.done();
  }
});

// halves.js #dropped's route: a session dropped and couldn't resume, Classic resting: Koe is down (Kokoro's block). Cut mid-answer, Kokoro finishes it
// (#talkDirectly), so a route that fails there is told; not cut, the route only reads Koe's way again and carries nothing, so it stays quiet. Kokoro's
// block refused is annai's own record, quiet either way: the route goes on, and Kokoro finishes a cut answer all the same.
for (const cut of [true, false]) {
  for (const reads of [false, true]) {
    test(`a live session dropped ${cut ? 'mid-answer' : 'between answers'} with Classic resting, ${reads ? `the store refusing reads: ${cut ? 'one card says so (Kokoro would never finish it)' : 'nothing of its own'}` : `Kokoro's blocks refused: ${cut ? 'nothing of their own, Kokoro finishes it all the same' : 'nothing of their own'}`}`, async () => {
      const finish = say('Nepenthe is open till 10.'); // the scripted model reads a wake after her last results as a follow-up: its `then`
      const k = await liveKit([], { kokoro: [{ rules: [{ match: "Koe can't speak", reply: finish, then: finish }, { match: '.', reply: sleep }] }], koe: { type: { rules: [{ match: '.', reply: sleep }] } } });
      try {
        k.llm.bench.bench('m-koe', 60_000);
        const cards = raw(k);
        const store = refusing(k);
        store.full(reads ? 'reads' : (ev) => ev.type === 'halves');
        k.agent.live.c.dropped(cut);
        if (reads && cut) await soon(async () => told(cards).length > 0, 10_000);
        await k.agent.idle();
        store.full(null);
        await toldOnce(cards, reads && cut ? 1 : 0, 'the drop', { read: reads });
        if (reads) return assert.equal((await k.events(['out.speak'])).length, 0, 'nobody finished the answer: the route was gone');
        assert.equal(k.agent.koeState, 'down');
        assert.ok(store.tried.some((/** @type {any} */ e) => e.data?.state === 'koe-down'), 'the block for Koe down was tried, and refused');
        assert.deepEqual(await blocks(k), [], 'and the blocks never written');
        assert.equal((await k.events(['out.speak'])).length, cut ? 1 : 0, cut ? 'Kokoro finished the answer' : 'nothing to finish');
      } finally {
        await k.done();
      }
    });
  }
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
  await toldOnce(cards, 1, 'the tap', { read: true });
  assert.equal(k.platform.mic.isOpen(), false, 'the tap went nowhere: the microphone is closed');
  assert.deepEqual(k.platform.log, [], 'and nothing reached the phone: no unlock, no microphone');
});
