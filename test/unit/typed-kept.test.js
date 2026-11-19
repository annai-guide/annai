// A line typed to Shiori whose write fails (a full phone) is not lost, and never held: its words are handed back with the conversation they
// were for and the error (the user's pick of 2026-11-14 for a line typed when nothing could take it, "Put it back in the type box"),
// whichever path it was written on. The dock puts them in the box when that conversation is the open one, else the card shows them
// (test/e2e/dock-text.spec.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip, ME } from '../../src/core/scopes.js';
import { liveKit } from './koe-live-kit.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

/**
 * The kit's store refuses writes as WebKit refuses them on a full disk (UnknownError): every write, the user's lines, or the log
 * entries a test picks; and what the agent hands back.
 * @param {any} k @returns {{ full: (which: 'all' | 'lines' | ((ev: any) => boolean) | null) => void, back: { words: string, scope: string, error: unknown }[] }}
 */
function refusing(k) {
  /** @type {'all' | 'lines' | ((ev: any) => boolean) | null} */
  let which = null;
  const refuse = () => Promise.reject(new DOMException('Unable to store record in object store', 'UnknownError'));
  const real = k.store.tx.bind(k.store);
  k.store.tx = (/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => real(stores, mode, (/** @type {any} */ t) => {
    if (mode !== 'readwrite' || !which) return fn(t);
    if (which === 'all') return refuse();
    const refused = which === 'lines' ? (/** @type {any} */ ev) => ev.type === 'msg.user' : which;
    return fn({ ...t, appendEvent: (/** @type {string} */ scope, /** @type {any} */ ev) => (refused(ev) ? refuse() : t.appendEvent(scope, ev)) });
  });
  /** @type {{ words: string, scope: string, error: unknown }[]} */
  const back = [];
  k.agent.on('unsaved', (/** @type {any} */ x) => back.push(x));
  return { full: (w) => { which = w; }, back };
}

/** The user's lines the log has. @param {any} k */
const lines = async (k) => (await k.events(['msg.user'])).map((/** @type {any} */ e) => e.data.text);

/** Shiori as two halves with Koe on a chat model: the typed line goes to Koe, whose turn writes it. */
const KOE_ON = { halves: true, koe: { talk: [say('Yes, until five.')], type: [say('Yes, until five.')] } };

for (const [how, o] of /** @type {const} */ ([['', {}], [' (Shiori as two halves, Kokoro only)', { halves: true }], [' (Shiori as two halves, Koe on)', KOE_ON]])) {
  test(`a typed line a full device refuses at the turn's start comes back with its conversation and the error, and the failure reaches the card${how}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Yes, until five.')]], o);
    if (o.koe) assert.equal(k.agent.koeState, 'text', 'Koe is on, and writes the line');
    const store = refusing(k);
    store.full('all');
    k.agent.send('Is the castle open today?', { typed: true });
    await k.agent.idle();
    assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Is the castle open today?', k.trip]]);
    assert.ok(store.back[0].error instanceof StorageFullError, 'the dock shows the storage card for it, with the words');
    assert.deepEqual(await lines(k), []);
    const card = k.notices.at(-1);
    assert.equal(card.title, 'Shiori stopped');
    assert.equal(card.error, store.back[0].error, 'the same error: the storage card shows once');
    // Room again: sent again, it is written once, and nothing more comes back.
    store.full(null);
    k.agent.send('Is the castle open today?', { typed: true });
    await k.agent.idle();
    assert.deepEqual(await lines(k), ['Is the castle open today?']);
    assert.equal(store.back.length, 1);
  });
}

test('a typed line that came while she worked, refused at her next call, comes back; the line before it stays written', async (t) => {
  useClock(t);
  const k = await agentKit([[{ delayMs: 40, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Both noted.')]]);
  const store = refusing(k);
  k.agent.send('First thing', { typed: true });
  await new Promise((r) => setTimeout(r, 10));
  store.full('lines');
  k.agent.send('Second thing', { typed: true });
  await k.agent.idle();
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
  await k.agent.idle();
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
  await k.agent.idle();
  assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Neither, the café', k.trip]]);
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
  await k.agent.idle();
  k.agent.send('From a plugin');
  await k.agent.idle();
  k.agent.send('', { typed: true, photos: [{ path: '/trip/files/a.jpg' }] });
  await k.agent.idle();
  assert.deepEqual(store.back, []);
});

test("a typed line queued for the conversation it was typed in as another opens, whose write fails, goes back with that conversation: it is not held in the queue, so it is never written there later", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.typing(true); // her turn gathers while they type
  k.agent.send('Book the ryokan', { typed: true });
  store.full('all');
  const opened = await k.agent.open(other).then(() => null, (/** @type {unknown} */ e) => e);
  assert.ok(opened instanceof StorageFullError, 'the open fails with the full phone');
  assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Book the ryokan', k.trip]], 'for the conversation it was typed in, which is not the one opening');
  store.full(null);
  k.agent.typing(false);
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.deepEqual(await lines(k), [], 'nothing is written later: the words are in the traveller\'s hands');
  assert.equal(store.back.length, 1);
});

test('a typed line sent on to another conversation than the open one (a hand-over typed while its files were kept) and refused there comes back with that conversation', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  store.full('all');
  await k.agent.wake({ kind: 'user', text: 'Is the temple open?', scope: other, typed: true });
  assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Is the temple open?', other]]);
  await k.agent.wake({ kind: 'user', text: 'A plugin said this', scope: other });
  assert.equal(store.back.length, 1, "words that weren't typed in the box aren't given back");
});

test('a typed line she is still gathering when the user stops her, refused, comes back', async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  k.agent.typing(true);
  k.agent.send('Hold on a moment', { typed: true });
  store.full('all');
  k.agent.interrupt();
  await k.agent.idle();
  assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Hold on a moment', k.trip]]);
  assert.ok(store.back[0].error instanceof StorageFullError);
});

test("a typed line with nothing open (a race the dock's draft normally prevents), refused, comes back with `me` and is not kept to be written there later", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  await k.agent.open(null);
  store.full('all');
  k.agent.send('Is the bus late?', { typed: true });
  await k.agent.idle(); // it settles: the line isn't left queued, keeping her busy
  assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Is the bus late?', ME]]);
  store.full(null);
  k.agent.send('A second line', { typed: true });
  await k.agent.idle();
  const inMe = await k.store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(ME, { types: ['msg.user'] }));
  assert.deepEqual(inMe.map((/** @type {any} */ e) => e.data.text), ['A second line'], 'only the second line was written into me: the first was handed back, not kept');
});

test("a typed line while Koe is live, whose write a full device refuses: Shiori goes on as one half, and her turn's refusal gives the words back; the card for the failed pass carries its error", async () => {
  const k = await liveKit([], { koe: { type: { rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] } } });
  try {
    assert.equal(k.agent.koeState, 'live');
    const store = refusing(k);
    store.full('all');
    k.agent.send('Is the castle open today?', { typed: true });
    await until(() => store.back.length === 1);
    assert.deepEqual(store.back.map((x) => [x.words, x.scope]), [['Is the castle open today?', k.trip]]);
    assert.ok(store.back[0].error instanceof StorageFullError);
    const half = k.notices.find((n) => n.title === 'Shiori answers as one half for now');
    assert.ok(half?.error instanceof StorageFullError, 'main.js shows the storage card in its place, with the title first');
  } finally {
    await k.done();
  }
});

test("a photo a full device keeps the message from carrying: the notice carries its error, for the storage card in its place (its title first); the message goes without it", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  await k.ws.write(k.trip, '/files/a.jpg', new Uint8Array([1, 2, 3]), { author: 'user', type: 'image/jpeg', meta: { width: 600, height: 400 } });
  const read = k.ws.read.bind(k.ws);
  k.ws.read = (/** @type {string} */ scope, /** @type {string} */ path) => (path === '/files/a.jpg' ? Promise.reject(new StorageFullError()) : read(scope, path));
  k.agent.send('Here is the photo', { typed: true, photos: [{ path: '/trip/files/a.jpg' }] });
  await k.agent.idle();
  const card = k.notices.find((n) => n.title === "A photo wasn't sent to Shiori");
  assert.ok(card?.error instanceof StorageFullError);
  assert.deepEqual(await lines(k), ['Here is the photo'], 'the words went');
});
