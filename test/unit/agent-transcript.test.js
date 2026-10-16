import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
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
  await store.tx(['blobs'], 'readwrite', (t) => t.putBlob({ hash, type: 'image/webp', size: 4, data: /** @type {ArrayBuffer} */ (bytes.buffer) }));
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
    `[Earlier conversation, summarized (events 1–${last})]\nThey asked where to eat; Shiori looked it up.`,
    '[annai] A new file: /trip/files/booking.pdf',
    '[meanwhile, the user wrote] Also, rain?',
  ]);
  assert.ok(t.compaction > last);
});
