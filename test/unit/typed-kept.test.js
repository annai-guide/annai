// A line typed to Shiori whose write fails (a full phone) is not lost, and never held: its words are handed back with the error (the user's
// pick of 2026-11-14 for a line typed when nothing could take it, "Put it back in the type box"), whichever path it was written on, and each
// once. The dock puts them in the one type box, whichever conversation is open (test/e2e/dock-text.spec.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, refusing, until, idleAtOnce } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip, ME } from '../../src/core/scopes.js';
import { liveKit } from './koe-live-kit.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
/** The card for a write nobody waits on that failed (#notSaved). */
const NOT_SAVED = "Something for Shiori wasn't saved";

/** The user's lines the log has. @param {any} k */
const lines = async (k) => (await k.events(['msg.user'])).map((/** @type {any} */ e) => e.data.text);

/** Shiori as two halves with Koe on a chat model: the typed line goes to Koe, whose turn writes it. */
const KOE_ON = { halves: true, koe: { talk: [say('Yes, until five.')], type: [say('Yes, until five.')] } };

for (const [how, o] of /** @type {const} */ ([['', {}], [' (Shiori as two halves, Kokoro only)', { halves: true }], [' (Shiori as two halves, Koe on)', KOE_ON]])) {
  test(`a typed line a full device refuses at the turn's start comes back with the error, and the failure reaches the card${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Yes, until five.')]], o);
    if (o.koe) assert.equal(k.agent.koeState, 'text', 'Koe is on, and writes the line');
    const store = refusing(k);
    store.full('all');
    k.agent.send('Is the castle open today?', { typed: true });
    await idleAtOnce(k);
    assert.deepEqual(store.back.map((x) => x.words), ['Is the castle open today?'], 'once: the write that failed and the turn that stopped on it both gave it back');
    assert.ok(store.back[0].error instanceof StorageFullError, 'the dock shows the storage card for it');
    assert.deepEqual(await lines(k), []);
    assert.equal(k.agent.busy, false, 'nothing waits for it');
    const card = k.notices.at(-1);
    assert.equal(card.title, 'Shiori stopped');
    assert.equal(card.error, store.back[0].error, 'the same error: the storage card shows once');
    // Room again: sent again, it is written once, and nothing more comes back.
    store.full(null);
    k.agent.send('Is the castle open today?', { typed: true });
    await idleAtOnce(k);
    assert.deepEqual(await lines(k), ['Is the castle open today?']);
    assert.equal(store.back.length, 1);
  });
}

/** A turn that takes a while before it answers: the first line starts it, and a second comes while it runs. */
const SLOW = [{ delayMs: 40, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Both noted.')];
for (const [how, scripts, o] of /** @type {[string, any[], any][]} */ ([
  ['', [SLOW], {}],
  [' (Shiori as two halves, Kokoro only)', [SLOW], { halves: true }],
  [' (Shiori as two halves, Koe on)', [[say('Noted.')]], { halves: true, koe: { talk: [{ delayMs: 40, ...say('Both noted.') }], type: [{ delayMs: 40, ...say('Both noted.') }] } }],
])) {
  test(`a typed line that came while her turn ran, which the full phone stops before it writes the line, comes back too, once; the line her turn took stays written, nothing waits, and a retype is written once${how}`, async (t) => {
    useClock(t);
    const k = await agentKit(scripts, o);
    const store = refusing(k);
    k.agent.send('First thing', { typed: true });
    await new Promise((r) => setTimeout(r, 10));
    store.full('all'); // from now on every write is refused, her turn's own too, before it comes to the second line
    k.agent.send('Second thing', { typed: true });
    await until(() => !k.agent.busy);
    assert.deepEqual(store.back.map((x) => x.words), ['Second thing']);
    assert.ok(store.back[0].error instanceof StorageFullError);
    assert.deepEqual(await lines(k), ['First thing']);
    // Room again: sent again, it is written once, and nothing more comes back.
    store.full(null);
    k.agent.send('Second thing', { typed: true });
    await idleAtOnce(k);
    assert.deepEqual(await lines(k), ['First thing', 'Second thing']);
    assert.equal(store.back.length, 1);
  });
}

test('a typed line whose turn fails before it writes the line, on a read (Chromium at no byte free refuses every transaction; the app always has a voice, whose settings her turn reads first), comes back once, and nothing waits', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Yes, until five.')]], { voice: { speechIn: ['m-hear'] } });
  const store = refusing(k);
  store.full('everything');
  k.agent.send('Is the castle open today?', { typed: true });
  await until(() => !k.agent.busy);
  assert.deepEqual(store.back.map((x) => x.words), ['Is the castle open today?']);
  assert.equal(/** @type {any} */ (store.back[0].error)?.name, 'UnknownError', "a read's own refusal: a lost connection, no full-device error, yet the words are the traveller's");
  assert.equal(k.notices.at(-1).title, 'Shiori stopped');
  store.full(null);
  k.agent.send('Is the castle open today?', { typed: true });
  await idleAtOnce(k);
  assert.deepEqual(await lines(k), ['Is the castle open today?'], 'a retype is written once');
  assert.equal(store.back.length, 1);
});

test('a typed line that came while she worked, refused at her next call, comes back; the line before it stays written', async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 40, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Both noted.')]]);
  const store = refusing(k);
  k.agent.send('First thing', { typed: true });
  await new Promise((r) => setTimeout(r, 10));
  store.full('lines');
  k.agent.send('Second thing', { typed: true });
  await idleAtOnce(k);
  assert.deepEqual(store.back.map((x) => x.words), ['Second thing']);
  assert.deepEqual(await lines(k), ['First thing']);
});

test("of two typed lines her turn takes together, in one wake, only the one the write refused comes back; the one written before it stays", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Both noted.')]]);
  const store = refusing(k);
  k.agent.typing(true); // her turn gathers both
  k.agent.send('First thing', { typed: true });
  k.agent.send('Second thing', { typed: true });
  store.full((ev) => ev.type === 'msg.user' && ev.data?.text === 'Second thing');
  k.agent.typing(false);
  k.agent.poke();
  await idleAtOnce(k);
  assert.deepEqual(store.back.map((x) => x.words), ['Second thing']);
  assert.deepEqual(await lines(k), ['First thing']);
  const wakes = await k.events(['wake']);
  assert.deepEqual(wakes.map((e) => e.data.reasons.map((r) => r.text)), [['First thing', 'Second thing']], 'the two came in one wake: she gathered them');
});

test('a typed answer to her question that is refused comes back, and her turn goes on with the failure as the tool\'s result, as for any failed tool', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, say('OK.')]]);
  const store = refusing(k);
  k.agent.send('Start', { typed: true });
  await until(() => k.agent.state.name === 'waiting');
  store.full('lines');
  k.agent.send('Neither, the café', { typed: true });
  await idleAtOnce(k);
  assert.deepEqual(store.back.map((x) => x.words), ['Neither, the café']);
  assert.ok(store.back[0].error instanceof StorageFullError);
  assert.deepEqual(await lines(k), ['Start']);
  assert.equal(k.notices.some((n) => n.title === 'Shiori stopped'), false, 'the turn went on: the failure was her tool\'s result, so the dock\'s card is the one shown');
  assert.equal(k.requests.length, 2, 'she was asked again, with the failure as the result');
  assert.match(JSON.stringify(k.requests[1]), /no room left/);
});

test("a line that wasn't typed in the box (a card's tap, a plugin's words, a photo alone) never comes back for it", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  store.full('all');
  k.agent.send('Keep it', { chose: true });
  await idleAtOnce(k);
  k.agent.send('From a plugin');
  await idleAtOnce(k);
  k.agent.send('', { typed: true, photos: [{ path: '/trip/files/a.jpg' }] });
  await idleAtOnce(k);
  assert.deepEqual(store.back, []);
});

test("a typed line queued for the conversation it was typed in as another opens, whose write fails, goes back to the box: it is not held in the queue, so it is never written there later", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.typing(true); // her turn gathers while they type
  k.agent.send('Book the ryokan', { typed: true });
  store.full('all');
  await k.agent.open(other); // the refused keep is told, and fails no open
  assert.equal(k.agent.trip, other);
  assert.deepEqual(store.back.map((x) => x.words), ['Book the ryokan'], 'the one type box takes it, whichever conversation is open');
  const told = k.notices.filter((n) => n.title === NOT_SAVED);
  assert.deepEqual(told.map((n) => n.error), [store.back[0].error], 'one card, with the error the line came back with: the storage card shows once');
  assert.equal(k.agent.busy, false, 'nothing waits for it');
  store.full(null);
  k.agent.typing(false);
  await k.agent.open(k.trip);
  await idleAtOnce(k);
  assert.deepEqual(await lines(k), [], 'nothing is written later: the words are in the traveller\'s hands');
  assert.equal(store.back.length, 1);
});

test('a typed line sent on to another conversation than the open one (a hand-over typed while its files were kept) and refused there comes back', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  store.full('all');
  await k.agent.wake({ kind: 'user', text: 'Is the temple open?', scope: other, typed: true });
  assert.deepEqual(store.back.map((x) => x.words), ['Is the temple open?']);
  const told = k.notices.filter((n) => n.title === NOT_SAVED);
  assert.equal(told.length, 1);
  assert.equal(told[0].error, store.back[0].error, 'the same error: the dock shows the storage card for it, and the notice adds none');
  await k.agent.wake({ kind: 'user', text: 'A plugin said this', scope: other });
  assert.equal(store.back.length, 1, "words that weren't typed in the box aren't given back");
  assert.equal(k.notices.filter((n) => n.title === NOT_SAVED).length, 2, 'what has no box to go back to is told on a card');
});

test("a typed line handed to another conversation that fails for a reason other than a full phone (a bug of ours) comes back, and a card says why", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k, { error: () => new TypeError('t.appendEvent is not a function') });
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  store.full('all');
  await k.agent.wake({ kind: 'user', text: 'Is the temple open?', scope: other, typed: true });
  assert.deepEqual(store.back.map((x) => x.words), ['Is the temple open?']);
  assert.ok(store.back[0].error instanceof TypeError, 'no storage card for it in the dock');
  const told = k.notices.filter((n) => n.title === NOT_SAVED);
  assert.deepEqual(told.map((n) => [n.body, n.error]), [['t.appendEvent is not a function', store.back[0].error]], 'the card says what went wrong');
  assert.equal(k.agent.busy, false);
});

test('a typed line she is still gathering when the user stops her, refused, comes back', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  k.agent.typing(true);
  k.agent.send('Hold on a moment', { typed: true });
  store.full('all');
  k.agent.interrupt();
  await idleAtOnce(k);
  assert.deepEqual(store.back.map((x) => x.words), ['Hold on a moment']);
  assert.ok(store.back[0].error instanceof StorageFullError);
  const told = k.notices.filter((n) => n.title === NOT_SAVED);
  assert.equal(told.length, 1);
  assert.equal(told[0].error, store.back[0].error, 'the same error: one storage card');
});

test("a typed line with nothing open (a race the dock's draft normally prevents), refused, comes back and is not kept to be written there later", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  await k.agent.open(null);
  store.full('all');
  k.agent.send('Is the bus late?', { typed: true });
  await idleAtOnce(k); // it settles: the line isn't left queued, keeping her busy
  assert.deepEqual(store.back.map((x) => x.words), ['Is the bus late?']);
  store.full(null);
  k.agent.send('A second line', { typed: true });
  await idleAtOnce(k);
  const inMe = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(ME, { types: ['msg.user'] }));
  assert.deepEqual(inMe.map((/** @type {any} */ e) => e.data.text), ['A second line'], 'only the second line was written into me: the first was handed back, not kept');
});

test("a typed line while Koe is live, whose write a full device refuses: Shiori goes on as one half, her turn's refusal gives the words back, and the pass that failed shows no card of its own (one refusal, one card)", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] } } });
  try {
    assert.equal(k.agent.koeState, 'live');
    const store = refusing(k);
    store.full('all');
    k.agent.send('Is the castle open today?', { typed: true });
    await until(() => store.back.length === 1);
    assert.deepEqual(store.back.map((x) => x.words), ['Is the castle open today?']);
    assert.ok(store.back[0].error instanceof StorageFullError);
    assert.equal(k.notices.some((n) => n.title === 'Shiori answers as one half for now'), false, "her turn's failure on the same full phone shows the storage card");
  } finally {
    await k.done();
  }
});

test("a photo a full device keeps the message from carrying: the notice carries its error, and what the card says first (the photo, and that the message went without it), for the storage card in its place; the message goes without it", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  await k.ws.write(k.trip, '/files/a.jpg', new Uint8Array([1, 2, 3]), { author: 'user', type: 'image/jpeg', meta: { width: 600, height: 400 } });
  const read = k.ws.read.bind(k.ws);
  k.ws.read = (/** @type {string} */ scope, /** @type {string} */ path) => (path === '/files/a.jpg' ? Promise.reject(new StorageFullError()) : read(scope, path));
  k.agent.send('Here is the photo', { typed: true, photos: [{ path: '/trip/files/a.jpg' }] });
  await idleAtOnce(k);
  const card = k.notices.find((n) => n.title === "A photo wasn't sent to Shiori");
  assert.ok(card?.error instanceof StorageFullError);
  assert.equal(card.said, "A photo wasn't sent to Shiori. The message went without it.");
  assert.deepEqual(await lines(k), ['Here is the photo'], 'the words went');
});
