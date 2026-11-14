import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { record, INLINE_MAX, TALK_TAG } from '../../src/core/agent/log.js';
import { Transcript, resolveEvent, repair } from '../../src/core/agent/transcript.js';
import { utf8 } from '../../src/core/bytes.js';
import { sha256Hex } from '../../src/core/hash.js';

const SCOPE = 'trip-1';
const info = { role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-1' };

/** Logs a small conversation the way the agent does, applying each event to a live transcript too. */
async function converse(store) {
  const live = new Transcript();
  const add = async (/** @type {any} */ ev) => live.apply(ev, await resolveEvent(store, ev));
  await add(await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } }));
  await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1' }, texts: [['text', 'Where can we eat?']] }));
  /** @type {any[]} */
  const parts = [{ type: 'reasoning', text: 'Look it up.', signature: 's', model: 'a-1' }, { type: 'tool_call', id: 'c1', name: 'fetch', input: { url: 'https://x' } }];
  await modelTrace(store, SCOPE).turn(info, '', 'Look it up.', parts);
  const [turn] = (await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] })));
  await add(turn);
  const page = 'Menu '.repeat(INLINE_MAX);
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'fetch', ok: true, ms: 5, wake: 'w-1' }, texts: [['content', page]] }));
  return { live, page };
}

test('the transcript rebuilt from the log equals the one built as it happened', async () => {
  const store = createMemoryStore();
  const { live, page } = await converse(store);
  const loaded = await Transcript.load(store, SCOPE);
  assert.deepEqual(loaded.messages, live.messages);
  assert.deepEqual(loaded.messages.map((m) => [m.role, m.parts.map((p) => p.type)]), [
    ['user', ['text']],
    ['assistant', ['reasoning', 'tool_call']],
    ['user', ['tool_result']],
  ]);
  assert.equal(/** @type {any} */ (loaded.messages[2].parts[0]).content, page);
  assert.deepEqual(loaded.open(), []);
  assert.ok(loaded.from >= 1 && loaded.to > loaded.from);
});

test("only Shiori's own turns count, and results only for her calls", async () => {
  const store = createMemoryStore();
  await converse(store);
  await modelTrace(store, SCOPE).turn({ ...info, tag: 'decide' }, 'B', '', [{ type: 'text', text: 'B' }]);
  await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'not-hers', name: 'x', ok: true, ms: 1, content: 'no' } });
  const loaded = await Transcript.load(store, SCOPE);
  assert.equal(loaded.messages.length, 3);
});

test('a photo in a result follows its tool result, and the event keeps the file’s blob named', async () => {
  const store = createMemoryStore();
  const bytes = utf8('webp');
  const hash = await sha256Hex(bytes);
  // The trip's own photo: a file of its scope names it, so its log can point at it by its hash (reach.js).
  await store.tx(['blobs', 'files'], 'readwrite', async (t) => {
    await t.putBlob({ hash, type: 'image/webp', size: 4, data: /** @type {ArrayBuffer} */ (bytes.buffer) });
    await t.putFile({ scope: SCOPE, path: '/files/a.webp', hash, size: 4, type: 'image/webp', author: 'user', created: 1, modified: 1 });
  });
  const t = new Transcript();
  t.apply({ seq: 1, type: 'model.turn', data: { tag: TALK_TAG } }, { texts: { parts: JSON.stringify([{ type: 'tool_call', id: 'r1', name: 'read', input: { path: '/trip/files/a.webp' } }]) }, images: [] });
  const ev = await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'r1', name: 'read', ok: true, ms: 1, images: [{ hash, mediaType: 'image/webp', path: '/trip/files/a.webp' }] }, texts: [['content', 'The photo /trip/files/a.webp']], blobs: [{ hash, type: 'image/webp' }] });
  assert.deepEqual(ev.refs, [hash]);
  t.apply(ev, await resolveEvent(store, ev));
  assert.deepEqual(t.messages[1].parts.map((p) => p.type), ['tool_result', 'image']);
  assert.equal(/** @type {any} */ (t.messages[1].parts[1]).data, btoa('webp'));
});

test('after a crash, every open tool call is answered "interrupted by app restart", once (spec §6.7)', async () => {
  const store = createMemoryStore();
  await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { text: 'Hi', wake: 'w-1' } });
  await modelTrace(store, SCOPE).turn(info, '', '', [{ type: 'tool_call', id: 's1', name: 'speak', input: { text: 'Hello!' } }, { type: 'tool_call', id: 'z1', name: 'sleep', input: {} }]);
  const t = await Transcript.load(store, SCOPE);
  assert.deepEqual(t.open().map((c) => c.id), ['s1', 'z1']);
  assert.equal(await repair(store, SCOPE, t), 2);
  assert.deepEqual(t.open(), []);
  assert.equal(await repair(store, SCOPE, await Transcript.load(store, SCOPE)), 0);
  const results = await store.tx(['events'], 'readonly', (x) => x.listEvents(SCOPE, { types: ['tool.result'] }));
  assert.deepEqual(results.map((e) => [e.data.id, e.data.ok, e.data.content]), [['s1', false, 'interrupted by app restart'], ['z1', false, 'interrupted by app restart']]);
});

test('the transcript starts at the latest compaction, with its summary; non-user wakes and "meanwhile" are marked', async () => {
  const store = createMemoryStore();
  await converse(store);
  const last = await store.tx(['events'], 'readonly', (t) => t.lastSeq(SCOPE));
  await record(store, SCOPE, { type: 'compaction', actor: 'system', data: { from: 1, to: last, mode: 'cold' }, texts: [['summary', 'They asked where to eat; Shiori looked it up.']] });
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-2', reasons: [{ kind: 'file', text: 'A new file: /trip/files/booking.pdf' }] } });
  await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { text: 'Also, rain?', wake: 'w-2', meanwhile: true } });
  const t = await Transcript.load(store, SCOPE);
  assert.equal(t.messages.length, 1);
  assert.deepEqual(t.messages[0].parts.map((p) => /** @type {any} */ (p).text), [
    `[Earlier conversation, summarized (events 1–${last}); recall brings back the exact words]\nThey asked where to eat; Shiori looked it up.`,
    '[annai] A new file: /trip/files/booking.pdf',
    '[meanwhile, the user wrote] Also, rain?',
  ]);
  assert.ok(t.compaction > last);
});

test("a msg.user with handed reads as the user's words, then annai's line; Transcript.handover is its id until a reply answers it", async () => {
  const store = createMemoryStore();
  const live = new Transcript();
  const add = async (/** @type {any} */ ev) => live.apply(ev, await resolveEvent(store, ev));
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await add(await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } }));
  await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] }));
  assert.deepEqual(live.messages.at(-1).parts.map((/** @type {any} */ p) => p.text.slice(0, 40)), ['Our trip', '[annai] The user handed you a file: "/tr']);
  assert.equal(live.handover, 'h-1');
  // A reply with tool calls hasn't answered it yet; one that sleeps has.
  await modelTrace(store, SCOPE).turn(info, '', '', [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: '/trip/files/flight.pdf' } }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, ms: 1, wake: 'w-1' }, texts: [['content', 'The PDF.']] }));
  assert.equal(live.handover, 'h-1');
  assert.equal((await Transcript.load(store, SCOPE)).handover, 'h-1');
  await modelTrace(store, SCOPE).turn(info, '', '', [{ type: 'tool_call', id: 'c2', name: 'sleep', input: {} }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  assert.equal(live.handover, null);
  assert.deepEqual((await Transcript.load(store, SCOPE)).messages, live.messages);
});

/** A hand-over, then her reply [ask, sleep]; what its results say next is the test's. @param {{ gaveWay: boolean, between?: (add: (ev: any) => Promise<void>, store: any) => Promise<void> }} o */
async function askAndSleep({ gaveWay, between }) {
  const store = createMemoryStore();
  const live = new Transcript();
  const add = async (/** @type {any} */ ev) => live.apply(ev, await resolveEvent(store, ev));
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await add(await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } }));
  await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] }));
  await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, handover: 'h-1' }), '', '', [{ type: 'tool_call', id: 'q', name: 'ask', input: { question: 'File it?', options: ['Yes'] } }, { type: 'tool_call', id: 's', name: 'sleep', input: {} }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  await between?.(add, store);
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'q', name: 'ask', ok: true, ms: 1, wake: 'w-1' }, texts: [['content', 'The user chose: Yes']] }));
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 's', name: 'sleep', ok: true, ms: 0, wake: 'w-1', cut: false, ...(gaveWay ? { awake: true } : {}) }, texts: [['content', gaveWay ? 'Not asleep: your question came back answered or closed (its result is above), so your turn goes on.' : 'asleep']] }));
  const loaded = await Transcript.load(store, SCOPE);
  assert.deepEqual([loaded.handover, loaded.owedHandover, loaded.unanswered], [live.handover, live.owedHandover, live.unanswered], 'a reload reads what the live one did');
  return live;
}

test("a reply's sleep settles the hand-over only when its results say her turn ended: one that gave way (her question came back) leaves it owed, for a restart and for Try again", async () => {
  const gave = await askAndSleep({ gaveWay: true });
  assert.deepEqual([gave.handover, gave.owedHandover, gave.unanswered], ['h-1', 'h-1', true]);
  const slept = await askAndSleep({ gaveWay: false });
  assert.deepEqual([slept.handover, slept.owedHandover, slept.unanswered], [null, null, false], 'a sleep that ran answered it');
});

test("a hand-over undone while her question waited stays undone when the sleep gives way; a newer one is not replaced by the older", async () => {
  const undone = await askAndSleep({ gaveWay: true, between: async (add, store) => { await add(await record(store, SCOPE, { type: 'handover.undo', actor: 'user', data: { handover: 'h-1', undone: 1, kept: [] } })); } });
  assert.equal(undone.owedHandover, null);
  const newer = await askAndSleep({ gaveWay: true, between: async (add, store) => { await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handover: 'h-2' }, texts: [['text', 'More']] })); } });
  assert.equal(newer.owedHandover, 'h-2');
});

test("annai restarted while her question waited: repair() marks the sleep beside it as one that gave way, and the hand-over her reply settled is owed again (the final reviews' F1s)", async () => {
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  /** Her reply [ask, sleep] with a hand-over, her question shown and waiting: what the log holds when annai was killed. */
  const killed = async () => {
    const store = createMemoryStore();
    await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } });
    await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] });
    await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, handover: 'h-1' }), '', '', [{ type: 'tool_call', id: 'q', name: 'ask', input: { question: 'File it?', options: ['Yes'] } }, { type: 'tool_call', id: 's', name: 'sleep', input: {} }]);
    await record(store, SCOPE, { type: 'out.ask', actor: 'shiori', data: { id: 'q', wake: 'w-1', question: 'File it?', options: ['Yes'] } });
    return store;
  };
  const owed = (/** @type {Transcript} */ t) => [t.handover, t.owedHandover, t.unanswered];
  // This page's restart: the sleep never ran, and says her turn goes on.
  const store = await killed();
  const t = await Transcript.load(store, SCOPE);
  assert.deepEqual(owed(t), [null, null, false], 'before the repair the sleeping reply reads as one that ended her turn');
  assert.equal(await repair(store, SCOPE, t), 2);
  const stored = await store.tx(['events'], 'readonly', (x) => x.listEvents(SCOPE, { types: ['tool.result'] }));
  assert.deepEqual(stored.map((e) => [e.data.name, e.data.awake ?? null]), [['ask', null], ['sleep', true]]);
  assert.deepEqual(owed(t), ['h-1', 'h-1', true]);
  assert.deepEqual(owed(await Transcript.load(store, SCOPE)), ['h-1', 'h-1', true], 'a reload reads what the live one did');
  // The re-review's R2: a log an older page wrote (its restart wrote no `awake` for the sleep, and its restart turn ran without the hand-over, answered and
  // slept) is not read as one that still owes it: the hand-over is not given back after the fact, so the user's next line doesn't carry it.
  const older = await killed();
  for (const [id, name] of [['q', 'ask'], ['s', 'sleep']]) await record(older, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: false, cut: true, ms: 0 }, texts: [['content', 'interrupted by app restart']] });
  assert.deepEqual(owed(await Transcript.load(older, SCOPE)), [null, null, false], 'after the older restart');
  await record(older, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-2', reasons: [{ kind: 'restart', text: 'annai restarted while you were working' }] } });
  await modelTrace(older, SCOPE).turn(/** @type {any} */ ({ ...info, wake: 'w-2', handover: null }), '', '', [{ type: 'tool_call', id: 'a', name: 'speak', input: { text: 'We got cut off. File it?' } }, { type: 'tool_call', id: 'b', name: 'sleep', input: {} }]);
  await record(older, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: 'a', wake: 'w-2' }, texts: [['text', 'We got cut off. File it?']] });
  for (const [id, name, c] of [['a', 'speak', 'Said.'], ['b', 'sleep', 'asleep']]) await record(older, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: true, cut: false, ms: 1, wake: 'w-2' }, texts: [['content', c]] });
  assert.deepEqual(owed(await Transcript.load(older, SCOPE)), [null, null, false], 'after the older restart turn ended');
});

test("a hand-over her sleep settled stays answered across a wake of a later turn that joins nothing of hers (a move's recap): the re-review's R1, at the reader", async () => {
  const store = createMemoryStore();
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] });
  await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, wake: 'w-1', handover: 'h-1' }), '', '', [{ type: 'tool_call', id: 'a', name: 'speak', input: { text: 'Filed.' } }, { type: 'tool_call', id: 'b', name: 'sleep', input: {} }]);
  await record(store, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: 'a', wake: 'w-1' }, texts: [['text', 'Filed.']] });
  for (const [id, name, c] of [['a', 'speak', 'Said.'], ['b', 'sleep', 'asleep']]) await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: true, cut: false, ms: 1, wake: 'w-1' }, texts: [['content', c]] });
  assert.equal((await Transcript.load(store, SCOPE)).owedHandover, null, 'her sleep answered it');
  // Later, a move into this trip: the recap is logged below the user's copied line, as a wake that joins the new turn.
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-2', meanwhile: true, reasons: [{ kind: 'move', text: 'We found the ramen place.' }] } });
  const t = await Transcript.load(store, SCOPE);
  assert.deepEqual([t.handover, t.owedHandover], [null, null]);
});
