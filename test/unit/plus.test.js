import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConversation, openReadyDraft } from '../../src/ui/plus.js';

/** @param {{ ready?: string | null, tap?: string, dock?: any, voice?: boolean, whenReady?: () => Promise<string> }} [o] */
function kit(o = {}) {
  /** @type {string[]} */
  const log = [];
  const g = /** @type {any} */ (globalThis);
  g.location = { hash: '#/trips' };
  const ctx = {
    chats: { ready: 'ready' in o ? o.ready : 'trip-d', whenReady: o.whenReady ?? (() => Promise.resolve('trip-d')) },
    agent: { target: /** @type {string | null} */ (null), open(/** @type {string} */ id) { log.push(`open ${id}`); this.target = id; return Promise.resolve(); }, tap: () => { log.push('tap'); return o.tap ?? 'listening'; } },
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

test('no draft ready yet (the first moments): it waits for one, opens it, then goes (openDraft)', async () => {
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

test("no draft could be made: the card says so, and a + tapped meanwhile fires nothing later", async () => {
  /** @type {(e: Error) => void} */
  let fail = () => {};
  const made = new Promise((_, no) => { fail = no; }); // one make, shared by every tap, as Chats' is
  const { ctx, log, location } = kit({ ready: null, whenReady: () => /** @type {Promise<string>} */ (made) });
  newConversation(ctx);
  newConversation(ctx);
  fail(new Error('the disk is full'));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ["card That conversation didn't open", "card That conversation didn't open"]);
  assert.equal(location.hash, '#/trips');
  ctx.chats.ready = 'trip-late'; // a later try works: nothing tapped before goes now
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(log.length, 2);
  assert.equal(location.hash, '#/trips');
});

test('the dock\'s tap with nothing open: a ready draft opens with nothing awaited, so what the tap does next stays inside the gesture; none ready, nothing opens and the caller waits (openReadyDraft)', () => {
  const ready = kit();
  assert.equal(openReadyDraft(ready.ctx), true);
  assert.deepEqual(ready.log, ['open trip-d']); // synchronously, before this line: the dock taps right after
  assert.equal(ready.ctx.agent.target, 'trip-d');
  assert.equal(openReadyDraft(ready.ctx), true);
  assert.deepEqual(ready.log, ['open trip-d'], 'already open: not opened again');
  const none = kit({ ready: null });
  assert.equal(openReadyDraft(none.ctx), false);
  assert.deepEqual(none.log, []);
});
