import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newConversation, openReadyDraft, tapShiori } from '../../src/ui/plus.js';
import { pluginUi } from '../../src/ui/slots.js';
import { mediaKeys } from '../../src/ui/media-keys.js';

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

test("+ asks the browser to keep annai's storage, first and inside the tap, as the Start a trip form's tap did", () => {
  const { ctx, log } = kit();
  const nav = /** @type {any} */ (globalThis.navigator);
  Object.defineProperty(nav, 'storage', { value: { persist: () => { log.push('persist'); return Promise.resolve(true); } }, configurable: true });
  try {
    newConversation(ctx);
    assert.deepEqual(log, ['persist', 'open trip-d', 'tap']); // synchronously, before this line, and before the draft opens
  } finally {
    delete nav.storage;
  }
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

// key-next: with nothing open, a headset or car key and a plugin's ui.shiori.tap() do what the dock's Shiori button does (the Deferred entry that closed:
// they called agent.tap() directly, which opens no microphone with nothing open). All three call tapShiori; the dock's own button is pinned in the
// ui-slots browser suite, which draws it.

/** A headset or car key's press (play), as main.js wires the keys: to the shell's tap, which is tapShiori; voice is on. @param {any} ctx */
function pressKey(ctx) {
  /** @type {Record<string, (() => void) | null>} */
  const handlers = {};
  mediaKeys({ session: { setActionHandler: (/** @type {string} */ k, /** @type {any} */ fn) => { handlers[k] = fn; } }, tap: () => tapShiori(ctx), voice: { on: true, onChange: () => () => {} } });
  return handlers.play?.();
}
/** Each caller of a tap on Shiori but the dock's button, and what it returns (a key's handler returns nothing). @type {Record<string, (ctx: any) => unknown>} */
const CALLERS = { key: pressKey, plugin: (ctx) => pluginUi(ctx, 'trail').shiori.tap(), tapShiori: (ctx) => tapShiori(ctx) };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('nothing open, a draft ready: a key, a plugin\'s tap and tapShiori open it and tap with nothing awaited between (the gesture holds), and say what the tap said', () => {
  for (const [how, call] of Object.entries(CALLERS)) {
    const { ctx, log } = kit();
    const did = call(ctx);
    assert.deepEqual(log, ['open trip-d', 'tap'], how); // synchronously, before this line
    assert.equal(ctx.agent.target, 'trip-d', how);
    if (how !== 'key') assert.equal(did, 'listening', how);
  }
});

test('nothing open, no draft ready yet (the first moments): the tap waits for one, opens it, then taps; what it returns is a promise of what the tap said', async () => {
  for (const [how, call] of Object.entries(CALLERS)) {
    /** @type {(id: string) => void} */
    let ready = () => {};
    const { ctx, log } = kit({ ready: null, whenReady: () => new Promise((r) => { ready = (id) => { ctx.chats.ready = id; r(id); }; }) });
    const did = call(ctx);
    assert.deepEqual(log, [], how);
    ready('trip-late');
    await tick();
    assert.deepEqual(log, ['open trip-late', 'tap'], how);
    if (how !== 'key') assert.equal(await did, 'listening', how);
  }
});

test('nothing open and no draft can be made: the card says so, nothing opens and no tap is made (so no microphone); what it returns is a promise of nothing', async () => {
  for (const [how, call] of Object.entries(CALLERS)) {
    const { ctx, log } = kit({ ready: null, whenReady: () => Promise.reject(new Error('the disk is full')) });
    const did = call(ctx);
    await tick();
    assert.deepEqual(log, ["card That conversation didn't open"], how);
    assert.equal(ctx.agent.target, null, how);
    if (how !== 'key') assert.equal(await did, undefined, how);
  }
});

test('a conversation open: every caller taps at once and opens nothing, and a plugin gets what the tap said, as before; a plugin with no Shiori gets nothing', () => {
  for (const said of ['cut', 'stopped', 'listening', 'typing']) {
    for (const [how, call] of Object.entries(CALLERS)) {
      const { ctx, log } = kit({ tap: said });
      ctx.agent.target = 'trip-1';
      const did = call(ctx);
      assert.deepEqual(log, ['tap'], how);
      if (how !== 'key') assert.equal(did, said, how); // the word itself, not a promise of it
    }
  }
  const { ctx } = kit();
  assert.equal(pluginUi({ ...ctx, agent: undefined }, 'trail').shiori.tap(), undefined);
});
