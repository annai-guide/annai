import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { record } from '../../src/core/agent/log.js';
import { replies, replyBefore, wording, PAGE } from '../../src/ui/format.js';

// voice-reply-next (the Deferred entry "A line's tag doesn't read her reply so far, as the phone's voice does"): a screen that draws her lines one by
// one gives each the sentences of her reply before it, her turn's (its `wake`) speak words and questions, as the speaker hands them to her voice; one
// that draws a line alone reads them from the log (replyBefore), by the same rule.

const SCOPE = 'trip-1';
const app = { languages: { spoken: ['en', 'ja', 'zh'] } };

/** The store, and how many reads it has been asked for. @param {any} store */
function counting(store) {
  let reads = 0;
  return { store: { ...store, tx: (/** @type {any[]} */ ...a) => { reads++; return store.tx(...a); } }, reads: () => reads };
}
/** What replies (fed the log in order) and replyBefore (from the log, line by line) say for each entry: the two must agree. @param {any} store @param {any[]} events */
async function both(store, events) {
  const feed = replies(store);
  const inOrder = await Promise.all(events.map((e) => feed(e)));
  const alone = await Promise.all(events.map((e) => replyBefore(store, SCOPE, e)));
  return { inOrder, alone };
}

/** Her lines as the loop writes them: speak's words as texts, a long one stored apart. @param {any} store */
async function reply(store) {
  const at = (/** @type {any} */ e) => record(store, SCOPE, { actor: 'shiori', ...e });
  return [
    await at({ type: 'out.speak', data: { id: 's1', wake: 'w1' }, texts: [['text', '我们明天去故宫吧。']] }),
    await at({ type: 'msg.user', actor: 'user', data: { wake: 'w1', meanwhile: true }, texts: [['text', 'OK']] }),
    await at({ type: 'out.show', data: { id: 'c1', wake: 'w2', card: { title: '东京' } } }), // another turn's card (the other half): no reply's line
    await at({ type: 'out.speak', data: { id: 's2', wake: 'w1' }, texts: [['text', `好的。${' '.repeat(2001)}`]] }), // stored apart from the entry
    await at({ type: 'out.ask', actor: 'system', data: { id: 'a0', wake: 'w1', question: '今日は確認しますか？', options: ['はい'], own: true } }), // annai's own card
    await at({ type: 'out.ask', data: { id: 'a1', wake: 'w1', question: '几点出发？', options: ['十点'] } }),
    await at({ type: 'out.show', data: { id: 'c2', wake: 'w1', card: { title: '故宫', choice: ['十点'] } } }),
    await at({ type: 'out.speak', data: { id: 's3', wake: 'w3' }, texts: [['text', '東京駅。']] }),
    await at({ type: 'out.speak', data: { id: 's4', wake: 'wL', live: true }, texts: [['text', '好的。']] }), // a live session's line, under its session's wake
    await at({ type: 'out.speak', data: { id: 's5', wake: 'w3' }, texts: [['text', '好的。']] }),
  ];
}

test("replies: each of her lines gets the sentences her turn said before it (speak's words and her questions), not a card's, annai's card's or a live session's; a new turn, and a live line, start with nothing", async () => {
  const store = createMemoryStore();
  const events = await reply(store);
  const before = replies(store);
  const got = await Promise.all(events.map((e) => before(e)));
  assert.deepEqual(got, [
    [], // her turn's first line
    [], // the user's line is no line of hers
    [], // another turn's card
    ['我们明天去故宫吧。'],
    [], // annai's own card
    ['我们明天去故宫吧。', '好的。'],
    ['我们明天去故宫吧。', '好的。', '几点出发？'],
    [], // a new turn
    [], // a live session's line
    [], // the turn's next line: the live line ended the reply
  ]);
  // The tag reads them: 「好的。」 alone is Han that says neither, the first listed in Han; after her Chinese, Chinese.
  const hers = wording(app, true);
  assert.equal(hers('好的。').lang, 'ja');
  assert.equal(hers('好的。', { before: got[3] }).lang, 'zh-Hans');
  assert.equal(hers('十点', { before: got[6] }).lang, 'zh-Hans');
});

test("replyBefore reads a line's reply back from the log, as replies gives it in order, past a page of lines and up to the first line that is not its turn's", async () => {
  const store = createMemoryStore();
  const events = await reply(store);
  assert.deepEqual(await replyBefore(store, SCOPE, events[6]), ['我们明天去故宫吧。', '好的。', '几点出发？']);
  assert.deepEqual(await replyBefore(store, SCOPE, events[3]), ['我们明天去故宫吧。']);
  // It reads back only to the line before the turn: one read here, where her earlier turn's lines fill a whole page.
  const one = counting(store);
  assert.deepEqual(await replyBefore(/** @type {any} */ (one.store), SCOPE, events[7]), [], 'a new turn');
  assert.equal(one.reads(), 1);
  assert.deepEqual(await replyBefore(store, SCOPE, events[9]), [], "a live line came between: the reply it ended");
  const live = counting(store);
  assert.deepEqual(await replyBefore(/** @type {any} */ (live.store), SCOPE, events[8]), [], 'a live line');
  assert.equal(live.reads(), 0, "a live line is no reply's: nothing is read for it");
  assert.deepEqual(await replyBefore(store, SCOPE, { seq: events[6].seq, type: 'out.show', data: {} }), [], 'an entry with no turn (an older one)');
  // A turn of more lines than one read takes (PAGE): read back to its first.
  const long = [];
  for (let i = 0; i < 2 * PAGE + 1; i++) long.push(await record(store, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: `l${i}`, wake: 'w4' }, texts: [['text', i ? `${i}。` : '今日は晴れです。']] }));
  const all = await replyBefore(store, SCOPE, /** @type {any} */ (long.at(-1)));
  assert.deepEqual(all, ['今日は晴れです。', ...long.slice(1, -1).map((_, i) => `${i + 1}。`)]);
  const said = replies(store);
  for (const e of long.slice(0, -1)) said(e);
  assert.deepEqual(await said(long.at(-1)), all, 'the same answer as in order');
});

test("a speak or a question that is no line of her turn's ends her reply in replies and in replyBefore alike: a live line under a wake of its own between a question and its card, a question with no wake between two lines; annai's own card does not", async () => {
  const store = createMemoryStore();
  const at = (/** @type {any} */ e) => record(store, SCOPE, { actor: 'shiori', ...e });
  const events = [
    await at({ type: 'out.speak', data: { id: 'a1', wake: 'wA' }, texts: [['text', '我们明天去故宫吧。']] }),
    await at({ type: 'out.ask', data: { id: 'a2', wake: 'wA', question: '几点出发？', options: ['十点'] } }),
    await at({ type: 'out.speak', data: { id: 'l1', wake: 'wL', live: true }, texts: [['text', '今日は晴れです。']] }), // a live session's line between her question and her card
    await at({ type: 'out.show', data: { id: 'a3', wake: 'wA', card: { title: '好的' } } }),
    await at({ type: 'out.speak', data: { id: 'b1', wake: 'wB' }, texts: [['text', '我们明天去故宫吧。']] }),
    await at({ type: 'out.ask', data: { id: 'b2', question: '好吗？', options: ['好'] } }), // no wake: annai showing Kokoro's gated question
    await at({ type: 'out.speak', data: { id: 'b3', wake: 'wB' }, texts: [['text', '好的。']] }),
    await at({ type: 'out.speak', data: { id: 'c1', wake: 'wC' }, texts: [['text', '我们明天去故宫吧。']] }),
    await at({ type: 'out.ask', actor: 'system', data: { id: 'c2', wake: 'wC', question: '許可しますか？', options: ['はい'], own: true } }), // annai's own card, said with no reply of its own
    await at({ type: 'out.speak', data: { id: 'c3', wake: 'wC' }, texts: [['text', '好的。']] }),
  ];
  const { inOrder, alone } = await both(store, events);
  assert.deepEqual(inOrder, [
    [], ['我们明天去故宫吧。'],
    [], // the live line is no reply's
    [], // the turn's card: the live line ended its reply
    [],
    [], // no wake
    [], // the line after it: it ended the reply
    [],
    [], // annai's own card
    ['我们明天去故宫吧。'], // her turn goes on past it, as her voice does
  ]);
  assert.deepEqual(alone, inOrder, 'the same from the log');
  // So the card is drawn with no reply before it: 「好的」 alone is Han that says neither, the first listed in Han (after her Chinese question it was Chinese).
  assert.equal(wording(app, true)('好的', { before: inOrder[3] }).lang, 'ja');
});

test("a live session has one wake for all its lines: its question, many live lines, then its card have no reply before the card, and replyBefore reads once for it", async () => {
  const store = createMemoryStore();
  const at = (/** @type {any} */ e) => record(store, SCOPE, { actor: 'shiori', ...e });
  const events = [await at({ type: 'out.ask', data: { id: 'q', wake: 'wL', question: '几点出发？', options: ['十点'] } })]; // a live session's question: nothing marks it live
  for (let i = 0; i < 2 * PAGE + 1; i++) events.push(await at({ type: 'out.speak', data: { id: `l${i}`, wake: 'wL', live: true }, texts: [['text', '今日は晴れです。']] }));
  const card = await at({ type: 'out.show', data: { id: 'c', wake: 'wL', card: { title: '故宫' } } });
  events.push(card);
  const feed = replies(store);
  const got = await Promise.all(events.map((e) => feed(e)));
  assert.deepEqual(got.at(-1), [], 'no reply before the card: the live lines ended the question\'s');
  const read = counting(store);
  assert.deepEqual(await replyBefore(/** @type {any} */ (read.store), SCOPE, card), []);
  assert.equal(read.reads(), 1, 'read back to the first live line, no further');
});
