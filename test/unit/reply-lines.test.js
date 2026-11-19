import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { record } from '../../src/core/agent/log.js';
import { replies, replyBefore, wording } from '../../src/ui/format.js';

// voice-reply-next (the Deferred entry "A line's tag doesn't read her reply so far, as the phone's voice does"): a screen that draws her lines one by
// one gives each the sentences of her reply before it, her turn's (its `wake`) speak words and questions, as the speaker hands them to her voice; one
// that draws a line alone reads them from the log (replyBefore), by the same rule.

const SCOPE = 'trip-1';
const app = { languages: { spoken: ['en', 'ja', 'zh'] } };

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
    await at({ type: 'out.speak', data: { id: 's4', wake: 'w3', live: true }, texts: [['text', '好的。']] }), // a live session's line
    await at({ type: 'out.speak', data: { id: 's5', wake: 'w3' }, texts: [['text', '好的。']] }),
  ];
}

test("replies: each of her lines gets the sentences her turn said before it (speak's words and her questions), not a card's, annai's card's or a live session's; a new turn starts with nothing", async () => {
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
    ['東京駅。'], // the new turn's own
  ]);
  // The tag reads them: 「好的。」 alone is Han that says neither, the first listed in Han; after her Chinese, Chinese.
  const hers = wording(app, true);
  assert.equal(hers('好的。').lang, 'ja');
  assert.equal(hers('好的。', { before: got[3] }).lang, 'zh-Hans');
  assert.equal(hers('十点', { before: got[6] }).lang, 'zh-Hans');
});

test("replyBefore reads a line's reply back from the log, as replies gives it in order, past a page of lines and up to another turn's", async () => {
  const store = createMemoryStore();
  const events = await reply(store);
  assert.deepEqual(await replyBefore(store, SCOPE, events[6]), ['我们明天去故宫吧。', '好的。', '几点出发？']);
  assert.deepEqual(await replyBefore(store, SCOPE, events[3]), ['我们明天去故宫吧。']);
  // It reads back only to the turn before: one read here, where her earlier turn's lines fill a whole page.
  let reads = 0;
  const counted = { ...store, tx: (/** @type {any[]} */ ...a) => { reads++; return /** @type {any} */ (store.tx)(...a); } };
  assert.deepEqual(await replyBefore(/** @type {any} */ (counted), SCOPE, events[7]), [], 'a new turn');
  assert.equal(reads, 1);
  assert.deepEqual(await replyBefore(store, SCOPE, events[9]), ['東京駅。']);
  assert.deepEqual(await replyBefore(store, SCOPE, events[8]), [], 'a live line');
  assert.deepEqual(await replyBefore(store, SCOPE, { seq: events[6].seq, type: 'out.show', data: {} }), [], 'an entry with no turn (an older one)');
  // A turn of more lines than one read takes (PAGE): read back to its first.
  const long = [];
  for (let i = 0; i < 9; i++) long.push(await record(store, SCOPE, { type: 'out.speak', actor: 'shiori', data: { id: `l${i}`, wake: 'w4' }, texts: [['text', i ? `${i}。` : '今日は晴れです。']] }));
  const all = await replyBefore(store, SCOPE, long[8]);
  assert.deepEqual(all, ['今日は晴れです。', '1。', '2。', '3。', '4。', '5。', '6。', '7。']);
  const said = replies(store);
  for (const e of long.slice(0, 8)) said(e);
  assert.deepEqual(await said(long[8]), all, 'the same answer as in order');
});
