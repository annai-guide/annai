import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConversation } from '../../src/ui/plus.js';

/** @param {{ ready?: string | null, tap?: string, dock?: any, voice?: boolean, whenReady?: () => Promise<string> }} [o] */
function kit(o = {}) {
  /** @type {string[]} */
  const log = [];
  const g = /** @type {any} */ (globalThis);
  g.location = { hash: '#/trips' };
  const ctx = {
    chats: { ready: 'ready' in o ? o.ready : 'trip-d', whenReady: o.whenReady ?? (() => Promise.resolve('trip-d')) },
    agent: { open: (/** @type {string} */ id) => { log.push(`open ${id}`); return Promise.resolve(); }, tap: () => { log.push('tap'); return o.tap ?? 'listening'; } },
    voice: { on: o.voice ?? true },
    ws: { update: () => Promise.resolve(), readJSON: () => Promise.resolve({}), write: () => Promise.resolve() },
    notices: { card: (/** @type {any} */ c) => log.push(`card ${c.title}`) },
    dock: 'dock' in o ? o.dock : { openTyping: () => log.push('typing') },
  };
  return { ctx, log, location: g.location };
}

test('+ opens the draft and taps with nothing awaited between: the gesture holds', () => {
  const { ctx, log, location } = kit();
  newConversation(ctx);
  assert.deepEqual(log, ['open trip-d', 'tap']); // synchronously, before this line
  assert.equal(location.hash, '#/trip/trip-d/talk');
});

test('voice off: no tap (it would hold voice on), the box opens; voice on with no microphone here: tap says typing, so the box opens', () => {
  const off = kit({ voice: false });
  newConversation(off.ctx);
  assert.deepEqual(off.log, ['open trip-d', 'typing']);
  const none = kit({ tap: 'typing' });
  newConversation(none.ctx);
  assert.deepEqual(none.log, ['open trip-d', 'tap', 'typing']);
});

test("a plugin's dock, which has no openTyping: nothing throws", () => {
  for (const dock of [{}, null]) {
    const { ctx, log } = kit({ voice: false, dock });
    newConversation(ctx);
    assert.deepEqual(log, ['open trip-d']);
  }
});

test('no draft ready yet (the first moments): it waits for one, then goes', async () => {
  /** @type {(id: string) => void} */
  let ready = () => {};
  const { ctx, log, location } = kit({ ready: null, whenReady: () => new Promise((r) => { ready = (id) => { ctx.chats.ready = id; r(id); }; }) });
  newConversation(ctx);
  assert.deepEqual(log, []);
  ready('trip-late');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ['open trip-late', 'tap']);
  assert.equal(location.hash, '#/trip/trip-late/talk');
});
