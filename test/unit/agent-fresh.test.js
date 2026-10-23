import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';

// "do you think we should have some way to let the user compact or clear the transcript / session manually?" (the user, 2026-10-23):
// Summarize now, and Start fresh (spec §6.5, §16.2).
const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };

/** Five exchanges, each with words of its own. @param {any} k */
async function talk(k) {
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Question ${i} about pelicans`);
    await k.agent.idle();
  }
}

test('Start fresh: the context holds none of the earlier lines, the next request neither, and the log, the divider and recall keep them all', async () => {
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i} about pelicans`)), say('A fresh answer'), { toolCalls: [{ name: 'recall', input: { query: 'Question 0' } }] }, sleep]]);
  await talk(k);
  assert.equal(await k.agent.startFresh(), true);
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.mode, 'fresh');
  assert.equal(c.data.summary, undefined, 'no summary: nothing of the earlier lines is carried');
  const context = JSON.stringify(k.agent.transcript.messages);
  assert.equal(context.includes('pelicans'), false, 'none of the earlier lines are in her context');
  assert.match(context, /Started fresh/);
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages, 'a fresh read of the log agrees');
  // The next turn is sent without them.
  k.agent.send('Hello again');
  await k.agent.idle();
  const sent = JSON.stringify(k.requests.at(-1).messages);
  assert.equal(sent.includes('pelicans'), false);
  assert.match(sent, /Hello again/);
  // Nothing was deleted: every earlier line is still in the log, in order, and recall finds them.
  const said = (await k.events(['msg.user'])).map((e) => e.data.text);
  assert.deepEqual(said.slice(0, 5), Array.from({ length: 5 }, (_, i) => `Question ${i} about pelicans`));
  k.agent.send('What was my first question?');
  await k.agent.idle();
  const recalled = (await k.events(['tool.result'])).find((e) => e.data.name === 'recall');
  assert.match(recalled.data.content ?? '', /user: Question 0 about pelicans/);
  assert.match(recalled.data.content ?? '', /Shiori said: Answer 0 about pelicans/);
});

test('Start fresh with nothing in the conversation, or twice in a row, starts nothing', async () => {
  const k = await agentKit([[say('Hi')]]);
  assert.equal(await k.agent.startFresh(), false);
  assert.deepEqual(await k.events(['compaction']), []);
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(await k.agent.startFresh(), true);
  assert.equal(await k.agent.startFresh(), false, 'nothing came since');
  assert.equal((await k.events(['compaction'])).length, 1);
});

test('a later housekeeping after Start fresh summarizes only what came after it', async () => {
  const k = await agentKit([[...Array.from({ length: 8 }, (_, i) => say(`Reply ${i}`))]], { utility: [{ text: 'Only the new part.' }] });
  for (let i = 0; i < 3; i++) {
    k.agent.send(`Old ${i}`);
    await k.agent.idle();
  }
  await k.agent.startFresh();
  for (let i = 0; i < 4; i++) {
    k.agent.send(`New ${i}`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  const asked = JSON.stringify(k.requests.at(-1).messages);
  assert.equal(asked.includes('Old 0'), false, 'the summary is made from after the fresh start');
  assert.match(asked, /New 0/);
});

test('Summarize now, while her cache is warm: the model that holds it writes the summary; too little to summarize says so; the earlier words are still recallable', async () => {
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i} about herons`)), { text: 'They asked about herons.' }, { toolCalls: [{ name: 'recall', input: { query: 'One question' } }] }, sleep]]);
  k.agent.send('One question about herons');
  await k.agent.idle();
  assert.equal(await k.agent.summarizeNow(), 'nothing', 'one exchange is too little');
  assert.deepEqual(await k.events(['compaction']), []);
  for (let i = 1; i < 5; i++) {
    k.agent.send(`Question ${i} about herons`);
    await k.agent.idle();
  }
  assert.equal(await k.agent.summarizeNow(), 'done');
  const [c] = await k.events(['compaction']);
  assert.equal(c.data.mode, 'warm');
  assert.match(JSON.stringify(k.agent.transcript.messages[0]), /They asked about herons\./);
  k.agent.send('What did I ask first?');
  await k.agent.idle();
  const recalled = (await k.events(['tool.result'])).find((e) => e.data.name === 'recall');
  assert.match(recalled.data.content ?? '', /user: One question about herons/);
});

test('Summarize now, once her cache has gone cold: the utility model writes it', async () => {
  let clock = Date.now();
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i}`))]], { utility: [{ text: 'A cold summary.' }], agent: { now: () => clock } });
  for (let i = 0; i < 5; i++) {
    k.agent.send(`Question ${i}`);
    await k.agent.idle();
  }
  clock += 3 * 3600_000;
  assert.equal(await k.agent.summarizeNow(), 'done');
  assert.equal((await k.events(['compaction']))[0].data.mode, 'cold');
  assert.match(JSON.stringify(k.agent.transcript.messages[0]), /A cold summary\./);
});

test('Start fresh with both halves: each reads the conversation again from there, and a live session is closed with its handle forgotten', async () => {
  const KOE = { rules: [{ match: 'the user wrote', reply: { toolCalls: [{ name: 'speak', input: { text: 'Koe says hello' } }, { name: 'sleep', input: {} }] } }] };
  const KOKORO = { rules: [{ match: 'the user wrote', reply: sleep }] };
  const k = await agentKit([KOKORO], { koe: { type: KOE } });
  k.agent.send('Tell me about otters');
  await k.agent.idle();
  assert.match(JSON.stringify(k.agent.koe.transcript.messages), /otters/);
  assert.match(JSON.stringify(k.agent.kokoro.transcript.messages), /otters/);
  /** @type {any[]} */
  const closed = [];
  const close = k.agent.live.close.bind(k.agent.live);
  k.agent.live.close = (/** @type {string} */ why, /** @type {any} */ o) => { closed.push([why, o]); return close(why, o); };
  assert.equal(await k.agent.startFresh(), true);
  assert.deepEqual(closed, [['fresh', { forget: true }]]);
  assert.equal(JSON.stringify(k.agent.koe.transcript.messages).includes('otters'), false, 'Koe starts fresh');
  assert.equal(JSON.stringify(k.agent.kokoro.transcript.messages).includes('otters'), false, 'Kokoro starts fresh');
  k.agent.send('Something new');
  await k.agent.idle();
  for (const r of k.requests.slice(-2)) assert.equal(JSON.stringify(r.messages).includes('otters'), false);
});
