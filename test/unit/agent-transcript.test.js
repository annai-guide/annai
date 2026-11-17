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

test("a msg.user with handed reads as the user's words, then annai's line; Transcript.handover is its id until her turn's end record answers it", async () => {
  const store = createMemoryStore();
  const live = new Transcript();
  const add = async (/** @type {any} */ ev) => live.apply(ev, await resolveEvent(store, ev));
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await add(await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } }));
  await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] }));
  assert.deepEqual(live.messages.at(-1).parts.map((/** @type {any} */ p) => p.text.slice(0, 40)), ['Our trip', '[annai] The user handed you a file: "/tr']);
  assert.equal(live.handover, 'h-1');
  // Neither a reply with tool calls nor one that sleeps has answered it: the loop's record of her turn's end does, when it names it.
  const replied = { ...info, endLogged: true };
  await modelTrace(store, SCOPE).turn(replied, '', '', [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: '/trip/files/flight.pdf' } }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'c1', name: 'read', ok: true, ms: 1, wake: 'w-1' }, texts: [['content', 'The PDF.']] }));
  assert.equal(live.handover, 'h-1');
  assert.equal((await Transcript.load(store, SCOPE)).handover, 'h-1');
  await modelTrace(store, SCOPE).turn(replied, '', '', [{ type: 'tool_call', id: 'c2', name: 'sleep', input: {} }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'c2', name: 'sleep', ok: true, cut: false, ms: 0, wake: 'w-1' }, texts: [['content', 'asleep']] }));
  assert.deepEqual([live.handover, live.owedHandover, live.unanswered], ['h-1', 'h-1', true], 'a sleep among her calls is only her words');
  await add(await record(store, SCOPE, { type: 'turn.end', actor: 'system', data: { wake: 'w-1', handover: null } }));
  assert.deepEqual([live.handover, live.owedHandover, live.unanswered], [null, 'h-1', false], 'an end that carried no hand-over leaves it owed');
  await add(await record(store, SCOPE, { type: 'turn.end', actor: 'system', data: { wake: 'w-1', handover: 'h-1' } }));
  assert.deepEqual([live.handover, live.owedHandover, live.unanswered], [null, null, false]);
  assert.deepEqual((await Transcript.load(store, SCOPE)).messages, live.messages);
  assert.equal((await Transcript.load(store, SCOPE)).owedHandover, null);
});

/** A hand-over, then her reply [ask, sleep]; what its results say next is the test's, and the loop logs her turn's end unless the sleep gave way. @param {{ gaveWay: boolean, between?: (add: (ev: any) => Promise<void>, store: any) => Promise<void> }} o */
async function askAndSleep({ gaveWay, between }) {
  const store = createMemoryStore();
  const live = new Transcript();
  const add = async (/** @type {any} */ ev) => live.apply(ev, await resolveEvent(store, ev));
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await add(await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } }));
  await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] }));
  await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, handover: 'h-1', endLogged: true }), '', '', [{ type: 'tool_call', id: 'q', name: 'ask', input: { question: 'File it?', options: ['Yes'] } }, { type: 'tool_call', id: 's', name: 'sleep', input: {} }]);
  await add((await store.tx(['events'], 'readonly', (t) => t.listEvents(SCOPE, { types: ['model.turn'] }))).at(-1));
  await between?.(add, store);
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'q', name: 'ask', ok: true, ms: 1, wake: 'w-1' }, texts: [['content', 'The user chose: Yes']] }));
  await add(await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 's', name: 'sleep', ok: true, ms: 0, wake: 'w-1', cut: false, ...(gaveWay ? { awake: true } : {}) }, texts: [['content', gaveWay ? 'Not asleep: your question came back answered or closed (its result is above), so your turn goes on.' : 'asleep']] }));
  if (!gaveWay) await add(await record(store, SCOPE, { type: 'turn.end', actor: 'system', data: { wake: 'w-1', handover: 'h-1' } }));
  const loaded = await Transcript.load(store, SCOPE);
  assert.deepEqual([loaded.handover, loaded.owedHandover, loaded.unanswered], [live.handover, live.owedHandover, live.unanswered], 'a reload reads what the live one did');
  return live;
}

test("the hand-over is answered by her turn's end record, not by a sleep among her calls: one that gave way (her question came back) leaves it owed, for a restart and for Try again", async () => {
  const gave = await askAndSleep({ gaveWay: true });
  assert.deepEqual([gave.handover, gave.owedHandover, gave.unanswered], ['h-1', 'h-1', true]);
  const slept = await askAndSleep({ gaveWay: false });
  assert.deepEqual([slept.handover, slept.owedHandover, slept.unanswered], [null, null, false], 'her turn ended, and its end record answered it');
});

test("a hand-over undone while her question waited stays undone when the sleep gives way; a newer one is not replaced by the older", async () => {
  const undone = await askAndSleep({ gaveWay: true, between: async (add, store) => { await add(await record(store, SCOPE, { type: 'handover.undo', actor: 'user', data: { handover: 'h-1', undone: 1, kept: [] } })); } });
  assert.equal(undone.owedHandover, null);
  const newer = await askAndSleep({ gaveWay: true, between: async (add, store) => { await add(await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handover: 'h-2' }, texts: [['text', 'More']] })); } });
  assert.equal(newer.owedHandover, 'h-2');
});

test("annai restarted while her question waited: no end was logged, so the hand-over is owed before repair() and after; repair() stores no `awake` for the sleep (the final reviews' F1s)", async () => {
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  /** Her reply [ask, sleep] with a hand-over, her question shown and waiting: what the log holds when annai was killed (old: an older page wrote it). */
  const killed = async (old = false) => {
    const store = createMemoryStore();
    await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } });
    await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] });
    await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, handover: 'h-1', ...(old ? {} : { endLogged: true }) }), '', '', [{ type: 'tool_call', id: 'q', name: 'ask', input: { question: 'File it?', options: ['Yes'] } }, { type: 'tool_call', id: 's', name: 'sleep', input: {} }]);
    await record(store, SCOPE, { type: 'out.ask', actor: 'shiori', data: { id: 'q', wake: 'w-1', question: 'File it?', options: ['Yes'] } });
    return store;
  };
  const owed = (/** @type {Transcript} */ t) => [t.handover, t.owedHandover, t.unanswered];
  // This page's restart: the sleep never ran, and says her turn goes on.
  const store = await killed();
  const t = await Transcript.load(store, SCOPE);
  assert.deepEqual(owed(t), ['h-1', 'h-1', true], 'under way: no end was logged');
  assert.equal(await repair(store, SCOPE, t), 2);
  const stored = await store.tx(['events'], 'readonly', (x) => x.listEvents(SCOPE, { types: ['tool.result'] }));
  assert.deepEqual(stored.map((e) => [e.data.name, 'awake' in e.data]), [['ask', false], ['sleep', false]]);
  assert.deepEqual(owed(t), ['h-1', 'h-1', true]);
  assert.deepEqual(owed(await Transcript.load(store, SCOPE)), ['h-1', 'h-1', true], 'a reload reads what the live one did');
  // The re-review's R2: a log an older page wrote (its restart wrote no `awake` for the sleep, and its restart turn ran without the hand-over, answered and
  // slept) is not read as one that still owes it: the hand-over is not given back after the fact, so the user's next line doesn't carry it.
  const older = await killed(true);
  for (const [id, name] of [['q', 'ask'], ['s', 'sleep']]) await record(older, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: false, cut: true, ms: 0 }, texts: [['content', 'interrupted by app restart']] });
  assert.deepEqual(owed(await Transcript.load(older, SCOPE)), [null, null, false], 'after the older restart');
  await record(older, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-2', reasons: [{ kind: 'restart', text: 'annai restarted while you were working' }] } });
  await modelTrace(older, SCOPE).turn(/** @type {any} */ ({ ...info, wake: 'w-2', handover: null }), '', '', [{ type: 'tool_call', id: 'a', name: 'speak', input: { text: 'We got cut off. File it?' } }, { type: 'tool_call', id: 'b', name: 'sleep', input: {} }]);
  await record(older, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: 'a', wake: 'w-2' }, texts: [['text', 'We got cut off. File it?']] });
  for (const [id, name, c] of [['a', 'speak', 'Said.'], ['b', 'sleep', 'asleep']]) await record(older, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: true, cut: false, ms: 1, wake: 'w-2' }, texts: [['content', c]] });
  assert.deepEqual(owed(await Transcript.load(older, SCOPE)), [null, null, false], 'after the older restart turn ended');
});

test("a log the version before this one wrote, with `end` and `awake` on its results, reads exactly as the same log without them: her turn's end is its turn.end record", async () => {
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  /** A hand-over, then her reply: [speak] whose window passed in silence (`end`, then turn.end), or [ask, sleep] whose sleep gave way (`awake`, no end yet). */
  const logged = async (/** @type {'ended' | 'gave way'} */ shape, /** @type {boolean} */ keys, { turnEnd = true } = {}) => {
    const store = createMemoryStore();
    await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' } });
    await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-1' }, texts: [['text', 'Our trip']] });
    /** @type {[string, string, any][]} */
    const calls = shape === 'ended' ? [['a', 'speak', { text: 'Filed.' }]] : [['q', 'ask', { question: 'File it?', options: ['Yes'] }], ['s', 'sleep', {}]];
    await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, handover: 'h-1', endLogged: true }), '', '', /** @type {any} */ (calls.map(([id, name, input]) => ({ type: 'tool_call', id, name, input }))));
    if (shape === 'ended') {
      await record(store, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: 'a', wake: 'w-1' }, texts: [['text', 'Filed.']] });
      await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'a', name: 'speak', ok: true, ms: 1, wake: 'w-1', cut: false, ...(keys ? { end: true } : {}) }, texts: [['content', 'Said aloud. Heard nothing (20 seconds).']] });
      if (turnEnd) await record(store, SCOPE, { type: 'turn.end', actor: 'system', data: { wake: 'w-1', handover: 'h-1' } });
    } else {
      await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'q', name: 'ask', ok: true, ms: 1, wake: 'w-1', cut: false }, texts: [['content', 'The user chose: Yes']] });
      await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 's', name: 'sleep', ok: true, ms: 0, wake: 'w-1', cut: false, ...(keys ? { awake: true } : {}) }, texts: [['content', 'Not asleep: your question came back answered or closed (its result is above), so your turn goes on.']] });
    }
    const t = await Transcript.load(store, SCOPE);
    return { messages: t.messages, read: [t.unanswered, t.unanswered ? t.waiting : '', t.handover, t.owedHandover] };
  };
  for (const shape of /** @type {const} */ (['ended', 'gave way'])) assert.deepEqual(await logged(shape, true), await logged(shape, false), shape);
  assert.deepEqual((await logged('ended', true)).read, [false, '', null, null], 'ended: by its record');
  assert.deepEqual((await logged('gave way', true)).read, [true, 'turn', 'h-1', 'h-1'], 'gave way: under way, the hand-over owed');
  // The `end` on its own is no end: a log with it and no turn.end (the page was killed between the two writes) is a turn still under way.
  assert.deepEqual((await logged('ended', true, { turnEnd: false })).read, [true, 'turn', 'h-1', 'h-1'], 'end: true and no turn.end: under way');
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

test("a hand-over her turn's end record answered stays answered across a wake of a later turn that joins nothing of hers (a move's recap): the re-review's R1, at the reader, with the record", async () => {
  const store = createMemoryStore();
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1', handed, handover: 'h-0' }, texts: [['text', 'Our trip']] });
  await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, wake: 'w-1', handover: 'h-0', endLogged: true }), '', '', [{ type: 'tool_call', id: 'a', name: 'speak', input: { text: 'Filed.' } }, { type: 'tool_call', id: 'b', name: 'sleep', input: {} }]);
  await record(store, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: 'a', wake: 'w-1' }, texts: [['text', 'Filed.']] });
  for (const [id, name, c] of [['a', 'speak', 'Said.'], ['b', 'sleep', 'asleep']]) await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id, name, ok: true, cut: false, ms: 1, wake: 'w-1' }, texts: [['content', c]] });
  assert.deepEqual([(await Transcript.load(store, SCOPE)).owedHandover, (await Transcript.load(store, SCOPE)).unanswered], ['h-0', true], 'no end logged yet: under way, the hand-over owed');
  await record(store, SCOPE, { type: 'turn.end', actor: 'system', data: { wake: 'w-1', handover: 'h-0' } });
  assert.equal((await Transcript.load(store, SCOPE)).owedHandover, null, 'her turn ended, and its end answered it');
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-2', meanwhile: true, reasons: [{ kind: 'move', text: 'We found the ramen place.' }] } });
  const t = await Transcript.load(store, SCOPE);
  assert.deepEqual([t.handover, t.owedHandover], [null, null]);
});

test("what a restart carries is read from the records of what it takes up: a cut turn's own wake records, a wake written while the conversation was closed, and the user's lines; an older hand-over a failed turn left owed only for the user's", async (t) => {
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  /** A log: a hand-over's turn (w-0, h-1) that failed, then what the shape adds. keyed: the turn's wake names its hand-over (since 2026-11-16). */
  const after = async (/** @type {(log: (type: string, data: any, texts?: any) => Promise<void>, store: any) => Promise<void>} */ then, keyed = true) => {
    const store = createMemoryStore();
    const log = async (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ texts = []) => { await record(store, SCOPE, { type, actor: type === 'msg.user' ? 'user' : 'system', data, texts }); };
    await log('wake', { id: 'w-0', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], ...(keyed ? { handover: 'h-1' } : {}) });
    await log('msg.user', { wake: 'w-0', handed, handover: 'h-1' }, [['text', 'Our trip']]);
    await log('error', { kind: 'model', wake: 'w-0', message: "Shiori can't reach her model." });
    await then(log, store);
    const t = await Transcript.load(store, SCOPE);
    return [t.unanswered, t.handover, t.owedHandover];
  };
  /** @type {[string, (log: any, store: any) => Promise<void>, boolean, any[]][]} */
  const shapes = [
    ["a watch's turn under way (its wake: none)", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
    }, true, [true, null, 'h-1']],
    ["the same written before the turn's wake named its hand-over (read by its wakes' kinds)", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, false, [true, null, 'h-1']],
    ["a turn of the user's under way, written before the key: the owed one, as before", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] });
      await log('msg.user', { wake: 'w-1' }, [['text', 'Please file it']]);
    }, false, [true, 'h-1', 'h-1']],
    ["a watch's turn that took it up partway (the take-up record)", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('msg.user', { wake: 'w-1', meanwhile: true }, [['text', 'Please file it']]);
      await log('wake', { id: 'w-1', meanwhile: true, reasons: [], handover: 'h-1' });
    }, true, [true, 'h-1', 'h-1']],
    // A log saved before the take-up record (2026-11-17), or a page killed between the user's line and that record: the turn's wake named none, but
    // the user's typed line joined it, and a line of theirs takes up the owed hand-over as join() does, so the restart carries h-1.
    ["a watch's turn the user's line joined, with no take-up record after it: the owed one, as join() took it up", async (log, store) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('msg.user', { wake: 'w-1', meanwhile: true }, [['text', 'Please file it']]);
      await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, wake: 'w-1', handover: 'h-1', endLogged: true }), '', '', [{ type: 'tool_call', id: 'w', name: 'write', input: { path: '/trip/notes/f.md', content: 'x' } }]);
    }, true, [true, 'h-1', 'h-1']],
    // The last turn's line is the whole record of a take-up that had not been written yet: a user's line is owed whoever's turn it joined.
    ["a watch's turn the user's line joined, the page killed before her next reply: the owed one", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('msg.user', { wake: 'w-1', meanwhile: true }, [['text', 'Please file it']]);
    }, true, [true, 'h-1', 'h-1']],
    ["a watch's turn that a hand-over joined, with no take-up record: the new hand-over (msg.user carries it)", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('msg.user', { wake: 'w-1', meanwhile: true, handed, handover: 'h-2' }, [['text', 'And this']]);
    }, true, [true, 'h-2', 'h-2']],
    ["a turn carrying the owed hand-over that a newer hand-over joined, with no take-up record: the newer one (join() prefers the new)", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
      await log('msg.user', { wake: 'w-1', meanwhile: true, handed, handover: 'h-2' }, [['text', 'And this']]);
    }, true, [true, 'h-2', 'h-2']],
    // A meanwhile wake of annai's (its cue) keeps what the turn carried: none, for a watch's turn.
    ["a watch's turn that annai's cue \"The user hasn't been answered\" joined (a meanwhile wake of kind cue): none, as a live join() takes up nothing for it", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('wake', { id: 'w-1', meanwhile: true, reasons: [{ kind: 'cue', text: "The user hasn't been answered." }] });
    }, true, [true, null, 'h-1']],
    ["a turn of the user's under way in a log from before the key, that a watch joined (a meanwhile wake): the owed one still", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] });
      await log('msg.user', { wake: 'w-1' }, [['text', 'Please file it']]);
      await log('wake', { id: 'w-1', meanwhile: true, reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, false, [true, 'h-1', 'h-1']],
    ["a watch written while the conversation was closed", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, true, [true, null, 'h-1']],
    ["a line of the user's written while it was closed: the owed one, as their next turn would take it", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
      await log('wake', { id: 'w-3', reasons: [{ kind: 'user', text: 'typed' }] });
      await log('msg.user', { wake: 'w-3' }, [['text', 'Please file it']]);
    }, true, [true, 'h-1', 'h-1']],
    ["a Try again tapped while it was closed: the owed one", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'cue', text: 'Try again.' }] });
    }, true, [true, 'h-1', 'h-1']],
    // The final review's F1: the user's wake took h-1 up, so a wake of annai's kept after it keeps what it took up (it once reset it to none).
    ["a line of the user's written while it was closed, then a watch written after it: the owed one still", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'user', text: 'typed' }] });
      await log('msg.user', { wake: 'w-2' }, [['text', 'Please file it']]);
      await log('wake', { id: 'w-3', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, true, [true, 'h-1', 'h-1']],
    ["a Try again written while it was closed, then a reminder written after it: the owed one still", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'cue', text: 'Try again.' }] });
      await log('wake', { id: 'w-3', reasons: [{ kind: 'trigger', text: 'A reminder came due.' }] });
    }, true, [true, 'h-1', 'h-1']],
    ["a turn of the user's cut by an open, in a log from before the key, then a watch written after it: the owed one still", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] });
      await log('msg.user', { wake: 'w-1' }, [['text', 'Please file it']]);
      await log('wake', { id: 'w-2', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, false, [true, 'h-1', 'h-1']],
    // conversation.moved: the hand-over's turn was let go to another trip and killed before its "left" record; a watch kept while closed carries none.
    ["a hand-over's turn let go to another trip (conversation.moved), then a watch written while it was closed: none", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
      await log('conversation.moved', { to: 'trip-2', title: 'Kyoto' });
      await log('wake', { id: 'w-2', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, true, [true, null, 'h-1']],
    // A move's line with no files is annai's own, of its own kind (move): no one's, so it takes up nothing. The version before wrote it as a cue (a Try again's kind),
    // and a log it wrote reads as before: the owed one.
    ["a move's line with no files, written while it was closed: none", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'move', text: 'You moved the user here from another conversation.' }] });
    }, true, [true, null, 'h-1']],
    ["a move's line with no files, written as a cue by the version before: the owed one, as before", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'cue', text: 'You moved the user here from another conversation.' }] });
    }, true, [true, 'h-1', 'h-1']],
    ["a file she moved here from another conversation, not under a hand-over, written while it was closed: none", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'file', text: 'Shiori moved a file here.', files: ['/files/menu.pdf'] }] });
    }, true, [true, null, 'h-1']],
    ["the restart of a watch's cut turn, written into it when another conversation opened before it ran: still none", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
      await log('wake', { id: 'w-2', reasons: [{ kind: 'restart', text: 'annai restarted before you answered.' }] });
    }, true, [true, null, 'h-1']],
    ["files handed to it while it was closed: theirs", async (log) => {
      await log('wake', { id: 'w-2', reasons: [{ kind: 'file', text: 'Files were added.', files: ['/files/hotel.pdf'], handover: 'h-2' }] });
      await log('wake', { id: 'w-3', reasons: [{ kind: 'trigger', text: 'The watch fired.' }] });
    }, true, [true, 'h-2', 'h-2']],
    ["the user undid the hand-over the cut turn carried", async (log) => {
      await log('wake', { id: 'w-1', reasons: [{ kind: 'user', text: 'typed', handover: 'h-2' }], handover: 'h-2' });
      await log('msg.user', { wake: 'w-1', handover: 'h-2' }, [['text', 'And this']]);
      await log('handover.undo', { handover: 'h-2', undone: 0, kept: [] });
    }, true, [true, null, null]],
  ];
  for (const [what, then, keyed, read] of shapes) await t.test(what, async () => { assert.deepEqual(await after(then, keyed), read); });
});

test("two halves: Kokoro is in a watch's turn after a failed hand-over, the user types, Koe writes their line, and the page is killed before Kokoro's next call: Kokoro's restart carries the owed hand-over, as the take-up its next call would have written", async () => {
  const handed = [{ path: '/trip/files/flight.pdf', type: 'application/pdf', name: 'flight.pdf', new: true }];
  const store = createMemoryStore();
  const log = async (/** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ texts = []) => { await record(store, SCOPE, { type, actor: type === 'msg.user' ? 'user' : 'system', data, texts }); };
  // The hand-over: Koe writes the user's line, Kokoro's turn for it fails ("Shiori can't reach her model") and is left alone.
  await log('wake', { id: 'k-0', half: 'koe', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }] });
  await log('msg.user', { wake: 'k-0', split: true, handed, handover: 'h-1' }, [['text', 'Our trip']]);
  await log('wake', { id: 'w-0', half: 'kokoro', reasons: [{ kind: 'user', text: 'typed', handover: 'h-1' }], handover: 'h-1' });
  await log('error', { kind: 'model', wake: 'w-0', half: 'kokoro', message: "Shiori can't reach her model." });
  // A watch fires: Kokoro's turn carries none.
  await log('wake', { id: 'w-1', half: 'kokoro', reasons: [{ kind: 'trigger', text: 'The watch fired.' }], handover: null });
  const kokoro = async () => { const t = await Transcript.load(store, SCOPE, { half: 'kokoro' }); return [t.unanswered, t.handover, t.owedHandover]; };
  assert.deepEqual(await kokoro(), [true, null, 'h-1'], "the watch's turn carries none");
  // The user types, and Koe writes their line at once; Kokoro takes it up at its next model call (loop.js join(), which writes the take-up record).
  await log('wake', { id: 'k-1', half: 'koe', reasons: [{ kind: 'user', text: 'typed' }] });
  await log('msg.user', { wake: 'k-1', split: true }, [['text', 'Please file my flight']]);
  assert.deepEqual(await kokoro(), [true, 'h-1', 'h-1'], 'killed before that call: the line is owed, and takes the owed hand-over up');
  // Had the call been made: the take-up record names it, and the reader reads the same.
  await log('wake', { id: 'w-1', half: 'kokoro', meanwhile: true, reasons: [], handover: 'h-1' });
  assert.deepEqual(await kokoro(), [true, 'h-1', 'h-1']);
});

test("the user carried the conversation on in another trip (open_trip's card): her turn is not under way here any more, and opening this one again takes nothing up", async () => {
  const store = createMemoryStore();
  await record(store, SCOPE, { type: 'wake', actor: 'system', data: { id: 'w-1', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(store, SCOPE, { type: 'msg.user', actor: 'user', data: { wake: 'w-1' }, texts: [['text', 'Move this to the Kyoto trip']] });
  await modelTrace(store, SCOPE).turn(/** @type {any} */ ({ ...info, endLogged: true }), '', '', [{ type: 'tool_call', id: 'o', name: 'open_trip', input: { trip: 'trip-2' } }]);
  assert.equal((await Transcript.load(store, SCOPE)).unanswered, true, 'her reply is under way until the loop logs its end');
  // As open_trip logs it: the line saying where the conversation went, then the call's result, with no end logged yet.
  await record(store, SCOPE, { type: 'conversation.moved', actor: 'shiori', data: { to: 'trip-2', title: 'Kyoto' } });
  assert.equal((await Transcript.load(store, SCOPE)).unanswered, false, 'the move settles it: nobody wakes here');
  await record(store, SCOPE, { type: 'tool.result', actor: 'system', data: { id: 'o', name: 'open_trip', ok: true, cut: false, ms: 1, wake: 'w-1' }, texts: [['content', 'The user carried this conversation on in Kyoto.']] });
  assert.equal((await Transcript.load(store, SCOPE)).unanswered, false);
});
