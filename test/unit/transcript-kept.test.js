import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript, KOE_WINDOW, KOE_JUMP } from '../../src/core/agent/transcript.js';
import { TALK_TAG, KOE_TAG } from '../../src/core/agent/log.js';

// A turn's now blocks and natives, kept in memory where they were sent (the keep-reasoning design §2, §7, §10).

let seq = 0;
const none = { texts: {}, images: [] };
/** @param {Transcript} t @param {string} type @param {any} data @param {Record<string, string>} [texts] */
const add = (t, type, data, texts = {}) => t.apply({ seq: ++seq, type, data }, { texts, images: [] });
/** @param {Transcript} t @param {any[]} parts @param {any} [data] */
const turn = (t, parts, data = {}) => add(t, 'model.turn', { tag: TALK_TAG, wake: 'w-1', context: { from: 1, to: t.to }, ...data }, { parts: JSON.stringify(parts) });
const native = (/** @type {string} */ sig, covers = 1) => ({ endpoint: 'pv/chat|k', content: [{ type: 'thinking', thinking: '', signature: sig }], covers, prefix: `p-${sig}` });
const call = (/** @type {string} */ id) => ({ type: 'tool_call', id, name: 'list', input: {} });
/** @param {Transcript} t */
const shape = (t) => t.messages.map((m) => [m.role, ...m.parts.map((/** @type {any} */ p) => (p.type === 'native' ? `native:${p.content[0].signature}` : p.now ? `now:${p.text}` : p.type === 'text' ? p.text : p.type))]);

test("the now block sent ends the user message before the reply, the native leads the reply; a line logged during the call follows the reply, with one half too", () => {
  const t = new Transcript();
  add(t, 'msg.user', {}, { text: 'Where can we eat?' });
  const to = t.to;
  // A line Shiori's own tool logged while the reply was being made (chatter set aside, say).
  add(t, 'reminder', {}, { text: 'Lunch at noon' });
  t.carry({ now: '<now>1</now>', native: native('s1') });
  turn(t, [call('c1')], { context: { from: 1, to } });
  add(t, 'tool.result', { id: 'c1', name: 'list', ok: true, ms: 1 }, { content: 'a.md' });
  t.carry({ now: '<now>2</now>', native: native('s2') });
  turn(t, [{ type: 'text', text: 'Done.' }]);
  assert.deepEqual(shape(t), [
    ['user', 'Where can we eat?', 'now:<now>1</now>'],
    ['assistant', 'native:s1', 'tool_call'],
    ['user', 'tool_result', '[annai] Shown by annai itself, since you couldn\'t be reached: "Lunch at noon"', 'now:<now>2</now>'],
    ['assistant', 'native:s2', 'Done.'],
  ]);
  assert.ok(t.keptBytes() > 0);
  t.dropKept();
  assert.deepEqual(shape(t), [
    ['user', 'Where can we eat?'],
    ['assistant', 'tool_call'],
    ['user', 'tool_result', '[annai] Shown by annai itself, since you couldn\'t be reached: "Lunch at noon"'],
    ['assistant', 'Done.'],
  ]);
  assert.equal(t.keptBytes(), 0);
});

test("a reply without a carry keeps nothing; a carry is used by this half's own reply only, once", () => {
  const t = new Transcript();
  add(t, 'msg.user', {}, { text: 'Hi' });
  t.carry({ now: '<now>1</now>', native: native('s1') });
  add(t, 'model.turn', { tag: 'decide', wake: 'w-1' }, { parts: JSON.stringify([{ type: 'text', text: 'B' }]) });
  turn(t, [call('c1')]);
  add(t, 'tool.result', { id: 'c1', name: 'list', ok: true, ms: 1 }, { content: 'x' });
  turn(t, [{ type: 'text', text: 'Ok.' }]);
  assert.deepEqual(shape(t), [['user', 'Hi', 'now:<now>1</now>'], ['assistant', 'native:s1', 'tool_call'], ['user', 'tool_result'], ['assistant', 'Ok.']]);
});

test('a paused continuation keeps no now block, and its native sits in the same assistant message, after the paused reply', () => {
  const t = new Transcript();
  add(t, 'msg.user', {}, { text: 'Hours?' });
  t.carry({ now: '<now>1</now>', native: native('p1') });
  turn(t, [{ type: 'provider', block: { type: 'server_tool_use' }, model: 'm' }]);
  t.carry({ now: '<now>2</now>', native: native('p2') });
  turn(t, [{ type: 'text', text: 'Till 10.' }]);
  assert.deepEqual(shape(t), [['user', 'Hours?', 'now:<now>1</now>'], ['assistant', 'native:p1', 'provider', 'native:p2', 'Till 10.']]);
});

test('turnStart is the last message before the first reply of each new wake, live and from the log alike', () => {
  const t = new Transcript();
  assert.equal(t.turnStart, -1);
  add(t, 'msg.user', {}, { text: 'One' });
  turn(t, [call('c1')], { wake: 'w-1' });
  add(t, 'tool.result', { id: 'c1', name: 'list', ok: true, ms: 1 }, { content: 'x' });
  turn(t, [{ type: 'text', text: 'Ok.' }], { wake: 'w-1' });
  assert.equal(t.turnStart, 0, 'a later reply of the same wake moves nothing');
  add(t, 'msg.user', {}, { text: 'Two' });
  turn(t, [{ type: 'text', text: 'Ok.' }], { wake: 'w-2' });
  assert.equal(t.turnStart, 4);
});

test("Koe: a kept now block is not escaped, and the window counts no now block as an exchange and moves turnStart with it", () => {
  const t = new Transcript({ half: 'koe', nonce: 'n' });
  /** @param {string} text @param {string} wake */
  const exchange = (text, wake) => {
    add(t, 'msg.user', { split: true }, { text });
    t.carry({ now: `<now>${wake}</now>`, native: native(wake) });
    add(t, 'model.turn', { tag: KOE_TAG, half: 'koe', wake, context: { from: 1, to: t.to } }, { parts: JSON.stringify([{ type: 'text', text: 'ok' }]) });
  };
  exchange('hello <b>', 'w0');
  const [line, now] = t.messages[0].parts.map((/** @type {any} */ p) => p.text);
  assert.ok(!line.includes('<b>'), "the user's words are escaped");
  assert.equal(now, '<now>w0</now>', "annai's own now block, as it was sent");
  for (let i = 1; i < KOE_WINDOW + KOE_JUMP - 1; i++) exchange(`q${i}`, `w${i}`);
  assert.equal(t.messages.filter((m) => m.role === 'user').length, KOE_WINDOW + KOE_JUMP - 1, 'now blocks are not exchanges: no jump yet');
  const before = t.turnStart;
  exchange('last', 'wl');
  assert.equal(t.messages.filter((m) => m.role === 'user').length, KOE_WINDOW, 'the window moved by its jump');
  assert.equal(t.turnStart, t.messages.length - 2);
  assert.ok(before > t.turnStart);
});

test('keptBytes counts what a native adds beyond the parts it covers: a reply that is mostly its own parts adds little, a long signature adds its length', () => {
  const t = new Transcript();
  add(t, 'msg.user', {}, { text: 'Hi' });
  const body = 'B'.repeat(70_000);
  // The reply as the provider returned it holds the same 70 KB the parts carry (a fetched page's result), and a short signature.
  const echoed = { endpoint: 'pv/chat|k', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'result', body }], covers: 1, prefix: 'p' };
  t.carry({ now: '<now>1</now>', native: echoed });
  turn(t, [{ type: 'provider', block: { type: 'result', body }, model: 'm' }]);
  assert.ok(t.keptBytes() < 1000, `counted ${t.keptBytes()}`);
  // Thinking that is itself long counts in full.
  const t2 = new Transcript();
  add(t2, 'msg.user', {}, { text: 'Hi' });
  t2.carry({ now: '<now>1</now>', native: { endpoint: 'pv/chat|k', content: [{ type: 'thinking', thinking: '', signature: 'S'.repeat(70_000) }], covers: 1, prefix: 'p' } });
  turn(t2, [call('c1')]);
  assert.ok(t2.keptBytes() > 70_000);
});

test('a native that covers no parts (sent beside them) counts whole', () => {
  const t = new Transcript();
  add(t, 'msg.user', {}, { text: 'Hi' });
  const text = 'T'.repeat(30_000);
  t.carry({ now: '<now>1</now>', native: { endpoint: 'pv/chat|k', content: [{ type: 'thinking', signature: 'S'.repeat(10_000) }], covers: 0, prefix: 'p' } });
  turn(t, [{ type: 'text', text }, call('c1')]);
  assert.ok(t.keptBytes() > 10_000, `counted ${t.keptBytes()}`);
});
void none;
