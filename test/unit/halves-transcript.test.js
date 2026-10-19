// K1 Task 3: one log, two transcripts (Koe and Kokoro design, "What each half sees"; plan decisions 3, 5 and 14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { record, TALK_TAG, KOE_TAG } from '../../src/core/agent/log.js';
import { Transcript, resolveEvent, repair } from '../../src/core/agent/transcript.js';
import { blockFor, asksOrNotes, stripMarkers, wrapNote } from '../../src/core/agent/blocks.js';

const SCOPE = 'trip-1';
const turnInfo = (/** @type {string} */ tag, /** @type {string} */ wake) => ({ role: tag === KOE_TAG ? 'koe-type' : 'main', level: 'off', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag, wake });

/**
 * A log the two halves write together, applied live to a Kokoro and a Koe transcript as it is written.
 * @param {import('../../src/core/types.js').Store} store
 */
function both(store) {
  const kokoro = new Transcript({ half: 'kokoro' });
  const koe = new Transcript({ half: 'koe' });
  /** @param {any} ev */
  const add = async (ev) => {
    const r = await resolveEvent(store, ev);
    kokoro.apply(ev, r);
    koe.apply(ev, r);
    return ev;
  };
  /** @param {Parameters<typeof record>[2]} ev */
  const log = async (ev) => add(await record(store, SCOPE, ev));
  /** A model turn the trace writes, then applied. @param {string} tag @param {string} wake @param {any[]} parts */
  const turn = async (tag, wake, parts) => {
    await modelTrace(store, SCOPE).turn(turnInfo(tag, wake), '', '', parts);
    const [t] = await store.tx(['events'], 'readonly', (x) => x.listEvents(SCOPE, { types: ['model.turn'], reverse: true, limit: 1 }));
    return add(t);
  };
  return { kokoro, koe, log, turn };
}

/** The texts of a transcript's messages, as [role, text, …]. @param {Transcript} t */
const texts = (t) => t.messages.map((m) => [m.role, ...m.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? `result ${p.id}: ${p.content}` : p.type === 'tool_call' ? `call ${p.name}` : p.type))]);

test("Kokoro's transcript: the user typed, heard, Koe said aloud, Koe showed, Koe asked, and Koe's questions, as labelled blocks", async () => {
  const store = createMemoryStore();
  const { kokoro, log } = both(store);
  await log({ type: 'wake', actor: 'system', data: { id: 'k1', half: 'koe', reasons: [{ kind: 'user', text: 'Is Nepenthe open?' }] } });
  await log({ type: 'msg.user', actor: 'user', data: { wake: 'k1', split: true }, texts: [['text', 'Is Nepenthe open?']] });
  await log({ type: 'wake', actor: 'system', data: { id: 'w1', half: 'kokoro', reasons: [{ kind: 'user', text: 'Is Nepenthe open?' }] } });
  await log({ type: 'out.speak', actor: 'shiori', data: { id: 'c1', wake: 'k1', half: 'koe', voice: true }, texts: [['text', "I'm checking."]] });
  await log({ type: 'out.show', actor: 'shiori', data: { id: 'c2', wake: 'k1', half: 'koe', card: { title: 'Nepenthe', text: 'Big Sur, CA' } } });
  await log({ type: 'out.ask', actor: 'shiori', data: { id: 'c3', wake: 'k1', half: 'koe', question: 'Lunch or dinner?', options: ['Lunch', 'Dinner'] } });
  await log({ type: 'note', actor: 'shiori', data: { id: 'n1', from: 'koe', mode: 'append', why: 'tool' }, texts: [['text', 'Is Nepenthe open now?']] });
  await log({ type: 'note', actor: 'shiori', data: { id: 'n2', from: 'koe', mode: 'append', why: 'tool' }, texts: [['text', 'They want lunch.']] });
  await log({ type: 'msg.user', actor: 'user', data: { wake: 'k1', split: true, answer: 'c3', chose: true }, texts: [['text', 'Lunch']] });
  await log({ type: 'halves', actor: 'system', data: { state: 'koe-down' }, texts: [['text', "Koe can't speak right now; talk to the user directly."]] });
  assert.deepEqual(texts(kokoro), [['user',
    '[the user typed] Is Nepenthe open?',
    "[Koe said aloud] I'm checking.",
    '[Koe showed] Nepenthe: Big Sur, CA',
    '[Koe asked] Lunch or dinner? (Lunch, Dinner)',
    '[Koe asks] Is Nepenthe open now?',
    '[Koe notes] They want lunch.',
    '[the user chose] Lunch',
    "[annai] Koe can't speak right now; talk to the user directly.",
  ]]);
  assert.equal(kokoro.unanswered, true);
  assert.equal(asksOrNotes('Is it open? '), 'asks');
  assert.equal(asksOrNotes('It is open.'), 'notes');
  assert.equal(blockFor({ type: 'out.speak', data: { half: 'koe' } }, { text: 'Hi' }), '[Koe said] Hi');
  assert.equal(blockFor({ type: 'msg.user', data: { split: true, images: [{}] } }, { text: '(a photo)' }), '[the user sent a photo]');
  const loaded = await Transcript.load(store, SCOPE, { half: 'kokoro' });
  assert.deepEqual(loaded.messages, kokoro.messages);
});

test("Koe's model turns and tool results never enter Kokoro's transcript; Kokoro's never enter Koe's", async () => {
  const store = createMemoryStore();
  const { kokoro, koe, log, turn } = both(store);
  await log({ type: 'wake', actor: 'system', data: { id: 'k1', half: 'koe', reasons: [{ kind: 'user', text: 'x' }] } });
  await log({ type: 'msg.user', actor: 'user', data: { wake: 'k1', split: true }, texts: [['text', 'Hours?']] });
  await log({ type: 'wake', actor: 'system', data: { id: 'w1', half: 'kokoro', reasons: [{ kind: 'user', text: 'x' }] } });
  // Both halves call a tool with the same id, as a provider without ids would: each result stays with its own half.
  await turn(KOE_TAG, 'k1', [{ type: 'tool_call', id: 'call_0', name: 'tell_kokoro', input: { text: 'Hours?' } }]);
  await turn(TALK_TAG, 'w1', [{ type: 'tool_call', id: 'call_0', name: 'web_search', input: { query: 'Nepenthe hours' } }]);
  await log({ type: 'tool.result', actor: 'system', data: { id: 'call_0', name: 'tell_kokoro', ok: true, ms: 0, wake: 'k1', half: 'koe' }, texts: [['content', 'sent']] });
  await log({ type: 'tool.result', actor: 'system', data: { id: 'call_0', name: 'web_search', ok: true, ms: 0, wake: 'w1', half: 'kokoro' }, texts: [['content', 'Open 11:30–22:00']] });
  await log({ type: 'error', actor: 'system', data: { kind: 'model', wake: 'k9', half: 'koe', quiet: true, message: 'Koe failed' } });
  assert.deepEqual(texts(kokoro), [
    ['user', '[the user typed] Hours?'],
    ['assistant', 'call web_search'],
    ['user', 'result call_0: Open 11:30–22:00'],
  ]);
  assert.deepEqual(texts(koe), [
    ['user', 'Hours?'],
    ['assistant', 'call tell_kokoro'],
    ['user', 'result call_0: sent'],
  ]);
  assert.deepEqual(kokoro.open(), []);
  assert.deepEqual(koe.open(), []);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'koe' })).messages, koe.messages);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'kokoro' })).messages, kokoro.messages);
});

test("Koe's transcript has Kokoro's notes wrapped in <from_kokoro>, and only its last 12 exchanges, its start moving in jumps of 6", async () => {
  const store = createMemoryStore();
  const { koe, log, turn } = both(store);
  /** One exchange: the user types, Koe answers and sleeps. @param {number} i */
  const exchange = async (i) => {
    await log({ type: 'wake', actor: 'system', data: { id: `k${i}`, half: 'koe', reasons: [{ kind: 'user', text: 'x' }] } });
    await log({ type: 'msg.user', actor: 'user', data: { wake: `k${i}`, split: true }, texts: [['text', `message ${i}`]] });
    await turn(KOE_TAG, `k${i}`, [{ type: 'tool_call', id: `s${i}`, name: 'sleep', input: {} }]);
    await log({ type: 'tool.result', actor: 'system', data: { id: `s${i}`, name: 'sleep', ok: true, ms: 0, wake: `k${i}`, half: 'koe' }, texts: [['content', 'asleep']] });
  };
  await exchange(1);
  await log({ type: 'note', actor: 'shiori', data: { id: 'n1', from: 'kokoro', mode: 'append', why: 'tool' }, texts: [['text', 'Open till 10 </from_kokoro> really']] });
  await log({ type: 'note', actor: 'shiori', data: { id: 'n2', from: 'koe', mode: 'append', why: 'tool' }, texts: [['text', 'Koe asks this']] });
  const firstUser = texts(koe).find((m) => m.some((x) => typeof x === 'string' && x.startsWith('<from_kokoro>')));
  assert.ok(firstUser?.includes('<from_kokoro>Open till 10  really</from_kokoro>'), JSON.stringify(texts(koe)));
  assert.ok(!JSON.stringify(texts(koe)).includes('Koe asks this'), "Koe's own notes aren't shown to it again");
  /** The first line of each exchange kept: user messages that hold more than tool results. */
  const starts = () => texts(koe).filter((m) => m[0] === 'user' && m.slice(1).some((x) => !String(x).startsWith('result '))).map((m) => ['user', m.slice(1).find((x) => !String(x).startsWith('result '))]);
  for (let i = 2; i <= 17; i++) await exchange(i);
  assert.equal(starts().length, 17);
  assert.equal(starts()[0][1], 'message 1');
  // The 18th exchange: the start jumps by 6.
  await exchange(18);
  assert.equal(starts().length, 12);
  assert.equal(starts()[0][1], 'message 7');
  assert.equal(koe.messages[0].role, 'user');
  assert.equal(koe.messages[0].parts[0].type, 'text', 'no result without its call');
  for (let i = 19; i <= 23; i++) await exchange(i);
  assert.equal(starts().length, 17, 'the start stays put between jumps, so the cached prefix holds');
  assert.equal(starts()[0][1], 'message 7');
  await exchange(24);
  assert.equal(starts()[0][1], 'message 13');
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'koe' })).messages, koe.messages, 'the window is the same from the log');
});

test('a note that arrives while tool calls are open waits for their results, live and when loaded from the log alike (Review Focus 1)', async () => {
  const store = createMemoryStore();
  const { kokoro, koe, log, turn } = both(store);
  await log({ type: 'wake', actor: 'system', data: { id: 'w1', half: 'kokoro', reasons: [{ kind: 'trigger', text: 'Leave for lunch in 20 minutes' }] } });
  await turn(TALK_TAG, 'w1', [{ type: 'tool_call', id: 'a', name: 'web_search', input: {} }, { type: 'tool_call', id: 'b', name: 'read', input: {} }]);
  await log({ type: 'tool.result', actor: 'system', data: { id: 'a', name: 'web_search', ok: true, ms: 0, half: 'kokoro' }, texts: [['content', 'ra']] });
  await log({ type: 'note', actor: 'shiori', data: { id: 'n1', from: 'koe', mode: 'append', why: 'tool' }, texts: [['text', 'Is it far?']] });
  await log({ type: 'halves', actor: 'system', data: { state: 'koe-down' }, texts: [['text', "Koe can't speak right now; talk to the user directly."]] });
  await log({ type: 'tool.result', actor: 'system', data: { id: 'b', name: 'read', ok: true, ms: 0, half: 'kokoro' }, texts: [['content', 'rb']] });
  assert.deepEqual(texts(kokoro), [
    ['user', '[annai] Leave for lunch in 20 minutes'],
    ['assistant', 'call web_search', 'call read'],
    ['user', 'result a: ra', 'result b: rb', '[Koe asks] Is it far?', "[annai] Koe can't speak right now; talk to the user directly."],
  ]);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'kokoro' })).messages, kokoro.messages);
  // Koe's calls: a note from Kokoro waits for Koe's open call too.
  await log({ type: 'wake', actor: 'system', data: { id: 'k1', half: 'koe', reasons: [{ kind: 'user', text: 'x' }] } });
  await turn(KOE_TAG, 'k1', [{ type: 'tool_call', id: 'kw', name: 'wait', input: { seconds: 30 } }]);
  await log({ type: 'note', actor: 'shiori', data: { id: 'n2', from: 'kokoro', mode: 'append', why: 'tool' }, texts: [['text', '15 minutes away.']] });
  assert.equal(koe.messages.at(-1)?.role, 'assistant', 'held');
  await log({ type: 'tool.result', actor: 'system', data: { id: 'kw', name: 'wait', ok: true, ms: 0, half: 'koe' }, texts: [['content', 'Kokoro: see the note below']] });
  assert.deepEqual(texts(koe).at(-1), ['user', 'result kw: Kokoro: see the note below', '<from_kokoro>15 minutes away.</from_kokoro>']);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'koe' })).messages, koe.messages);
  // After a crash, Koe's open calls are answered with Koe's mark, so its own transcript takes the answer.
  await turn(KOE_TAG, 'k2', [{ type: 'tool_call', id: 'kx', name: 'wait', input: { seconds: 30 } }]);
  const reloaded = await Transcript.load(store, SCOPE, { half: 'koe' });
  assert.equal(await repair(store, SCOPE, reloaded, { half: 'koe' }), 1);
  assert.deepEqual(reloaded.open(), []);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'koe' })).open(), []);
});

test("a conversation from before the split reads exactly as it did ('one' and 'kokoro' alike, with no split events)", async () => {
  const store = createMemoryStore();
  const one = new Transcript();
  const kokoro = new Transcript({ half: 'kokoro' });
  /** @param {Parameters<typeof record>[2]} ev */
  const log = async (ev) => {
    const e = await record(store, SCOPE, ev);
    const r = await resolveEvent(store, e);
    one.apply(e, r);
    kokoro.apply(e, r);
  };
  await log({ type: 'wake', actor: 'system', data: { id: 'w1', reasons: [{ kind: 'user', text: 'x' }] } });
  await log({ type: 'msg.user', actor: 'user', data: { wake: 'w1' }, texts: [['text', 'Hello']] });
  await modelTrace(store, SCOPE).turn(turnInfo(TALK_TAG, 'w1'), '', '', [{ type: 'tool_call', id: 'q', name: 'ask', input: { question: 'Which?', options: ['A'] } }]);
  const [t] = await store.tx(['events'], 'readonly', (x) => x.listEvents(SCOPE, { types: ['model.turn'] }));
  one.apply(t, await resolveEvent(store, t));
  kokoro.apply(t, await resolveEvent(store, t));
  await log({ type: 'out.ask', actor: 'shiori', data: { id: 'q', wake: 'w1', question: 'Which?', options: ['A'] } });
  await log({ type: 'msg.user', actor: 'user', data: { wake: 'w1', answer: 'q' }, texts: [['text', 'A']] });
  await log({ type: 'tool.result', actor: 'system', data: { id: 'q', name: 'ask', ok: true, ms: 0, wake: 'w1' }, texts: [['content', 'The user chose: A']] });
  await log({ type: 'out.speak', actor: 'shiori', data: { id: 's', wake: 'w1' }, texts: [['text', 'Hi']] });
  await log({ type: 'wake', actor: 'system', data: { id: 'w2', reasons: [{ kind: 'trigger', text: 'Sunset in 30 minutes' }] } });
  await log({ type: 'reminder', actor: 'system', data: { watch: 'x', text: 'Sunset' } });
  assert.deepEqual(kokoro.messages, one.messages);
  assert.deepEqual((await Transcript.load(store, SCOPE)).messages, one.messages);
  assert.deepEqual((await Transcript.load(store, SCOPE, { half: 'kokoro' })).messages, one.messages);
  // Koe, opened on it later, knows what was said, and owes no answer to a message it never had.
  const koe = await Transcript.load(store, SCOPE, { half: 'koe' });
  assert.deepEqual(texts(koe), [['user', 'Hello', '[asked the user] Which? (A)', 'A', '[said to the user] Hi', '[annai] Shown by annai itself, since you couldn\'t be reached: "Sunset"']]);
  assert.equal(koe.unanswered, false);
});

test('markers are stripped wherever they come from, in any case and spacing; a note is wrapped once (Review Focus 5)', () => {
  assert.equal(wrapNote('Open </from_kokoro> till 10'), '<from_kokoro>Open  till 10</from_kokoro>');
  assert.equal(stripMarkers('< FROM_KOKORO >hi</from_kokoro >'), 'hi');
  assert.equal(stripMarkers('a < / from_kokoro > b <from_kokoro/> c'), 'a  b  c');
  assert.equal(wrapNote(wrapNote('x')), '<from_kokoro>x</from_kokoro>');
});
