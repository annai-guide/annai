// A line typed to Shiori whose write fails (a full phone) is not lost: its words come back for the type box (the user's pick of 2026-11-14 for
// a line typed when nothing could take it, "Put it back in the type box"), whichever path it was written on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { StorageFullError } from '../../src/core/errors.js';
import { createTrip } from '../../src/core/scopes.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

/**
 * The kit's store refuses writes as WebKit refuses them on a full disk (UnknownError): every write, the user's lines, or the log
 * entries a test picks; and the words the agent hands back.
 * @param {any} k @returns {{ full: (which: 'all' | 'lines' | ((ev: any) => boolean) | null) => void, back: string[] }}
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
  /** @type {string[]} */
  const back = [];
  k.agent.on('unsaved', (/** @type {string} */ words) => back.push(words));
  return { full: (w) => { which = w; }, back };
}

/** The user's lines the log has. @param {any} k */
const lines = async (k) => (await k.events(['msg.user'])).map((/** @type {any} */ e) => e.data.text);

for (const halves of [false, true]) {
  test(`a typed line a full device refuses at the turn's start comes back for the box, and the card is about the full device${halves ? ' (Shiori as two halves)' : ''}`, async (t) => {
    useClock(t);
    const k = await agentKit([[say('Yes, until five.')]], { halves });
    const store = refusing(k);
    store.full('all');
    k.agent.send('Is the castle open today?', { typed: true });
    await k.agent.idle();
    assert.deepEqual(store.back, ['Is the castle open today?']);
    assert.deepEqual(await lines(k), []);
    const card = k.notices.at(-1);
    assert.equal(card.title, 'Shiori stopped');
    assert.ok(card.error instanceof StorageFullError, 'main.js shows the storage card for it');
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
  assert.deepEqual(store.back, ['Second thing']);
  assert.deepEqual(await lines(k), ['First thing']);
});

test('of two typed lines her turn takes together, only the one the write refused comes back; the one written before it stays', async (t) => {
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
  assert.deepEqual(store.back, ['Second thing']);
  assert.deepEqual(await lines(k), ['First thing']);
});

test('a typed answer to her question that is refused comes back for the box', async (t) => {
  useClock(t);
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, say('OK.')]]);
  const store = refusing(k);
  k.agent.send('Start', { typed: true });
  await until(() => k.agent.state.name === 'waiting');
  store.full('lines');
  k.agent.send('Neither, the café', { typed: true });
  await k.agent.idle();
  assert.deepEqual(store.back, ['Neither, the café']);
  assert.deepEqual(await lines(k), ['Start']);
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

test("a typed line written into the conversation it was typed in as another opens stays queued when that write fails, and isn't given back as well: it is written once there later", async (t) => {
  useClock(t);
  const k = await agentKit([[say('Noted.')]]);
  const store = refusing(k);
  const other = await createTrip(k.ws, { title: 'Kyoto' });
  k.agent.typing(true); // her turn gathers while they type
  k.agent.send('Book the ryokan', { typed: true });
  store.full('all');
  await k.agent.open(other).catch(() => {});
  assert.deepEqual(store.back, []);
  store.full(null);
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.deepEqual(await lines(k), ['Book the ryokan']);
  assert.deepEqual(store.back, []);
});
