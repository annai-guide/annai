import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { useClock } from './clock.js';
import { updateAppSettings } from '../../src/core/settings.js';

// voice-reply-next (the Deferred entry "A reply's separate speak calls each start with nothing before them"): her turn is one reply, so with the
// phone's voice a sentence that shows no language of its own in a later speak call, or in her question, is read in the language of the turn's
// earlier sentences; a new turn starts with nothing before it. Through the loop, with the browser voice and [en, zh, ja] listed.

const speak = (/** @type {string} */ text) => ({ name: 'speak', input: { text } });
const sleep = { name: 'sleep', input: {} };
/** Each sentence the phone's voice said, with the language it was read in. @param {any} k */
const read = (k) => k.platform.said.map((/** @type {any} */ s) => [s.text, s.lang]);

/** One Shiori with the phone's voice, [en, zh, ja] listed. @param {any} t @param {any[]} steps */
async function kit(t, steps) {
  useClock(t);
  const k = await agentKit([steps], { voice: { speechOut: ['browser-voice'] } });
  await updateAppSettings(k.ws, { languages: { spoken: ['en', 'zh', 'ja'] } });
  return k;
}

test("her reply's second speak call reads 「東京駅。」 in the language of the first's 「今日は新宿に行きましょう。」 (main: the first listed in Han, Chinese)", async (t) => {
  const k = await kit(t, [{ toolCalls: [speak('今日は新宿に行きましょう。'), speak('東京駅。'), sleep] }]);
  k.agent.send('今日はどこに行く？');
  await k.agent.idle();
  assert.deepEqual(read(k), [['今日は新宿に行きましょう。', 'ja-JP'], ['東京駅。', 'ja-JP']]);
});

test("a first speak that played as it streamed (its first sentence before its call had arrived) carries its sentences into the next call too", async (t) => {
  const first = '今日は新宿に行きましょう。駅は近いです。';
  const k = await kit(t, [{ stream: true, pieceMs: 15, toolCalls: [speak(first), speak('東京駅。'), sleep] }]);
  /** @type {number[]} */
  const saidAt = [];
  const say = k.platform.synth.say;
  k.platform.synth.say = (/** @type {string} */ text, /** @type {any} */ o) => { saidAt.push(Date.now()); return say(text, o); };
  // The scripted model sends a call's arguments 8 characters at a time, 15 ms apart: the first call has arrived once all its pieces have.
  const arrives = Math.ceil(JSON.stringify({ text: first }).length / 8) * 15;
  const sent = Date.now();
  k.agent.send('今日はどこに行く？');
  await k.agent.idle();
  assert.ok(saidAt[0] - sent < arrives, `the first sentence played ${saidAt[0] - sent} ms in, the call had arrived by ${arrives}`);
  assert.deepEqual(read(k), [['今日は新宿に行きましょう。', 'ja-JP'], ['駅は近いです。', 'ja-JP'], ['東京駅。', 'ja-JP']]);
});

test('her question said aloud after a speak call reads in the language of her reply so far', async (t) => {
  const k = await kit(t, [
    { toolCalls: [speak('今日は新宿に行きましょう。'), { name: 'ask', input: { question: '東京駅？', options: ['はい', 'いいえ'] } }] },
    { toolCalls: [sleep] },
  ]);
  k.agent.send('今日はどこに行く？');
  await until(() => k.agent.pendingId !== null && k.platform.said.length === 2);
  assert.deepEqual(read(k), [['今日は新宿に行きましょう。', 'ja-JP'], ['東京駅？', 'ja-JP']]);
  k.agent.answer(/** @type {string} */ (k.agent.pendingId), 'はい');
  await k.agent.idle();
});

test("a reply's first utterance, and a new turn's, start with nothing before them: 「東京駅。」 alone is the first listed in Han, whatever was said before", async (t) => {
  const k = await kit(t, [{ toolCalls: [speak('東京駅。'), speak('今日は新宿に行きましょう。'), sleep] }, { toolCalls: [speak('東京駅。'), sleep] }]);
  k.agent.send('今日はどこに行く？');
  await k.agent.idle();
  k.agent.send('駅は？');
  await k.agent.idle();
  assert.deepEqual(read(k), [['東京駅。', 'zh-CN'], ['今日は新宿に行きましょう。', 'ja-JP'], ['東京駅。', 'zh-CN']]);
});

test("a sentence of her reply is read by the ones before it, never by the ones after it in its own call: 「東京駅。今日は新宿に行きましょう。」 is zh-CN, then ja-JP", async (t) => {
  const k = await kit(t, [{ toolCalls: [speak('東京駅。今日は新宿に行きましょう。'), sleep] }]);
  k.agent.send('今日はどこに行く？');
  await k.agent.idle();
  assert.deepEqual(read(k), [['東京駅。', 'zh-CN'], ['今日は新宿に行きましょう。', 'ja-JP']]);
});
