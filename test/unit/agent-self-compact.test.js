// Shiori keeps her own long work (the self-compaction design 2): a cold return to a long conversation is summarized first, her to-do
// list is in every request's now block, and her mark (mark_done) moves where the next summary cuts. Usage numbers are shaped as real
// replies of Claude Opus reported them (numbers and field names only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { anthropicStandIn } from '../fakes/anthropic-binding.js';
import { Agent } from '../../src/core/agent/loop.js';
import { selfTools } from '../../src/core/agent/self-tools.js';
import { record } from '../../src/core/agent/log.js';
import { replyPrompt, tokensAfter, keepTokens, DUE_TOKENS } from '../../src/core/agent/compaction.js';
import { nowBlock } from '../../src/core/agent/context.js';
import { createTrip } from '../../src/core/scopes.js';
import { exportArchive, PRESETS } from '../../src/core/archive.js';

const MINUTE = 60_000;
/** A long conversation's call: 111,030 tokens of prompt, most of it read from the cache. */
const LONG = { input: 460, cacheRead: 100131, cacheWrite: 8718, cacheWrite1h: 1721, output: 893, reasoning: 0 };
/** One under 100,000 tokens: 90,030. */
const UNDER = { ...LONG, cacheRead: 79131 };
/** A reply in which the provider ran its own web search: the count sums the steps inside it (369,742, beside a request of about 180,000). */
const SEARCHED = { input: 506, cacheRead: 357212, cacheWrite: 6738, cacheWrite1h: 5286, output: 941, reasoning: 0, serverTools: { web_search_requests: 1, web_fetch_requests: 0 } };
/** A short one: 10,119 tokens, written to the hour's cache. */
const SHORT = { input: 145, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 9974, output: 134, reasoning: 0 };
/** The main model as Opus 5.5 is: a window of a million, the hour's cache. */
const OPUS = { providerId: 'claude-opus-5-5', contextWindow: 1_000_000, cacheTtls: ['5m', '1h'] };
const NO_TIMERS = { set: () => 1, clear: () => {} };
const say = (/** @type {string} */ words, /** @type {any} */ usage = SHORT) => ({ toolCalls: [{ name: 'speak', input: { text: words } }, { name: 'sleep', input: {} }], usage });
/** @param {any} r */
const isUtility = (r) => String(r.system ?? '').startsWith('You summarize a conversation');
/** @param {any} r */
const words = (r) => JSON.stringify(r.messages);

/**
 * The device's clock, moved on by hand (Date.now, which the log's times and the agent's clock both read): set before the kit is made.
 * @param {import('node:test').TestContext} t
 */
function clockOf(t) {
  const real = Date.now;
  let shift = 0;
  Date.now = () => real() + shift;
  t.after(() => { Date.now = real; });
  return (/** @type {number} */ ms) => { shift += ms; };
}

/** The page loaded again: a new Agent on the same store, nothing kept in memory. @param {any} k @param {string} [trip] */
async function reload(k, trip = k.trip) {
  const a = new Agent({ store: k.store, ws: k.ws, llm: k.llm, registry: k.registry, codec: k.codec, timeZone: () => 'UTC', secondMs: 10, timers: NO_TIMERS });
  a.addLoopTools(selfTools(a));
  a.on('notice', (/** @type {any} */ n) => k.notices.push(n));
  await a.open(trip);
  return a;
}

/** @param {any} agent @param {string[]} lines */
async function talk(agent, lines) {
  for (const l of lines) {
    agent.send(l);
    await agent.idle();
  }
}

test('a cold return over 100,000 tokens, after a reload: the utility model summarizes first, and her first request carries the summary and her to-do list', async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i}`, LONG)), say('Welcome back.')]], { models: [OPUS], utility: [{ text: 'They asked five questions.' }], agent: { timers: NO_TIMERS } });
  await k.ws.write(k.trip, '/todo.md', '- Find a vegetarian place for Friday\n', { author: 'shiori' });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']);
  const before = k.requests.length;
  jump(61 * MINUTE);
  const again = await reload(k);
  again.send('I am back');
  await again.idle();
  const [c, ...more] = await k.events(['compaction']);
  assert.equal(c?.data.mode, 'cold');
  assert.equal(more.length, 0);
  const [summary, first] = k.requests.slice(before);
  assert.ok(isUtility(summary), 'the utility model is asked first');
  assert.match(first.messages[0].parts[0].text, /^\[Earlier conversation, summarized \(events \d+–\d+\); recall brings back the exact words\]\nThey asked five questions\.$/);
  assert.equal(words(first).includes('Question 0'), false);
  assert.match(words(first), /Question 4/);
  assert.match(first.tail, /\nto-do \(\/trip\/todo\.md: [^\n]*\):\n- Find a vegetarian place for Friday\n<\/now>$/);
  assert.equal(words(first).includes('vegetarian'), false, 'the list is never in the transcript');
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Welcome back.');
});

test('not while the cache is warm: a return within its hour, after a reload, sends the whole conversation; an hour after that call, it is summarized', async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 6 }, (_, i) => say(`Answer ${i}`, LONG)), say('Later.')]], { models: [OPUS], utility: [{ text: 'Summary.' }], agent: { timers: NO_TIMERS } });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']);
  jump(50 * MINUTE);
  const again = await reload(k);
  await talk(again, ['I am back']);
  assert.deepEqual(await k.events(['compaction']), []);
  assert.equal(k.requests.some(isUtility), false);
  assert.match(words(k.requests.at(-1)), /Question 0/);
  jump(61 * MINUTE);
  await talk(await reload(k), ['And again']);
  assert.deepEqual((await k.events(['compaction'])).map((e) => e.data.mode), ['cold']);
});

test('not under 100,000 tokens: a cold return to a shorter conversation is sent whole; once it is over, the next one is summarized', async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i}`, UNDER)), say('Hello again.', LONG), say('Later.')]], { models: [OPUS], utility: [{ text: 'Summary.' }], agent: { timers: NO_TIMERS } });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']);
  jump(61 * MINUTE);
  await talk(await reload(k), ['I am back']);
  assert.deepEqual(await k.events(['compaction']), []);
  assert.match(words(k.requests.at(-1)), /Question 0/);
  jump(61 * MINUTE);
  await talk(await reload(k), ['And again']);
  assert.deepEqual((await k.events(['compaction'])).map((e) => e.data.mode), ['cold']);
});

test("another conversation opened within the hour: each is cold or warm by its own log, not by the other one's last call", async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 4 }, (_, i) => say(`Answer ${i}`, LONG)), say('Other.'), say('Back here.', LONG), say('And again.')]], { models: [OPUS], utility: [{ text: 'Four questions.' }], agent: { timers: NO_TIMERS } });
  const other = await createTrip(k.ws, { title: 'Other' });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3']);
  jump(5 * MINUTE);
  await k.agent.open(other);
  await talk(k.agent, ['A line elsewhere']);
  jump(5 * MINUTE);
  // Ten minutes after its own last call: warm, though another conversation was talked in since.
  await k.agent.open(k.trip);
  await talk(k.agent, ['Back ten minutes later']);
  assert.deepEqual(await k.events(['compaction']), []);
  jump(55 * MINUTE);
  await k.agent.open(other);
  jump(6 * MINUTE);
  await k.agent.open(k.trip);
  // 61 minutes after its own last call, the other one's 61 too; then the other is opened and left within the minute: this one is cold.
  await talk(k.agent, ['Back an hour later']);
  assert.deepEqual((await k.events(['compaction'])).map((e) => e.data.mode), ['cold']);
});

test("another conversation's call within the hour doesn't make a cold one warm", async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 4 }, (_, i) => say(`Answer ${i}`, LONG)), say('Other.'), say('Back here.')]], { models: [OPUS], utility: [{ text: 'Four questions.' }], agent: { timers: NO_TIMERS } });
  const other = await createTrip(k.ws, { title: 'Other' });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3']);
  jump(55 * MINUTE);
  await k.agent.open(other);
  await talk(k.agent, ['A line elsewhere']); // the last call this half made: 10 minutes before the next line here
  jump(10 * MINUTE);
  await k.agent.open(k.trip);
  await talk(k.agent, ['Back after 65 minutes']);
  assert.deepEqual((await k.events(['compaction'])).map((e) => e.data.mode), ['cold']);
  assert.equal(words(k.requests.at(-1)).includes('Question 0'), false);
});

/** Ten exchanges of about 5,200 tokens each by annai's own measure (compact: a typed line counts in its wake and as the line). */
const BIG = Array.from({ length: 10 }, (_, i) => `Q${i} ${'x'.repeat(8_500)}`);

test('the cold return keeps a third of 100,000 tokens word for word on a window of a million, not a third of its 70%', async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...BIG.map((_, i) => say(`A${i}`, LONG)), say('Back.')]], { models: [OPUS], utility: [{ text: 'Summary.' }], agent: { timers: NO_TIMERS } });
  await talk(k.agent, BIG);
  jump(61 * MINUTE);
  await talk(k.agent, ['Back']);
  const sent = words(k.requests.at(-1));
  const kept = BIG.map((_, i) => i).filter((i) => sent.includes(`Q${i} `));
  assert.deepEqual(kept, [3, 4, 5, 6, 7, 8, 9], 'about 33,000 tokens: seven questions of about 5,000');
  assert.equal(keepTokens({ window: 1_000_000, threshold: 0.7, maxBytes: 8 * 2 ** 20 }), DUE_TOKENS / 3);
});

test('on a small window the cold return, after a reload, keeps a third of its own threshold, so more than the oldest exchange is summarized', async (t) => {
  const jump = clockOf(t);
  const small = Array.from({ length: 6 }, (_, i) => `S${i} ${'y'.repeat(6_000)}`);
  // A window of 40,000: due at 28,000, forced over 36,000; a third of the threshold is 9,333 tokens, about two and a half exchanges here.
  const k = await agentKit([[...small.map((_, i) => say(`A${i}`, { input: 30_000, output: 5 })), say('Back.')]], { models: [{ contextWindow: 40_000, cacheTtls: ['1h'] }], utility: [{ text: 'Summary.' }], agent: { timers: NO_TIMERS } });
  await talk(k.agent, small);
  jump(61 * MINUTE);
  await talk(await reload(k), ['Back']);
  assert.deepEqual((await k.events(['compaction'])).map((e) => e.data.mode), ['cold']);
  const sent = words(k.requests.at(-1));
  assert.deepEqual(small.map((_, i) => i).filter((i) => sent.includes(`S${i} `)), [3, 4, 5], 'the last three exchanges stay, the first three are summarized');
});

test("the utility model failing: a card says she couldn't tidy up, and the turn goes on with the whole conversation", async (t) => {
  const jump = clockOf(t);
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i}`, LONG)), say('Here anyway.')]], { models: [OPUS], utility: [{ error: 'auth', status: 401, message: 'bad utility key' }], agent: { timers: NO_TIMERS } });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']);
  jump(61 * MINUTE);
  await talk(k.agent, ['I am back']);
  assert.deepEqual(await k.events(['compaction']), []);
  assert.equal(k.notices.at(-1).title, "Shiori couldn't tidy up the conversation");
  assert.match(k.notices.at(-1).body, /bad utility key.* She will try again later\.$/is);
  assert.match(words(k.requests.at(-1)), /Question 0/);
  assert.equal((await k.events(['out.speak'])).at(-1).data.text, 'Here anyway.');
});

test('the header names the whole range: after two summaries, from the first event; after a Start fresh then a summary, from the fresh start', async () => {
  const k = await agentKit([[...Array.from({ length: 16 }, (_, i) => say(`Answer ${i}`))]], { utility: [{ text: 'First summary.' }, { text: 'Second summary.' }, { text: 'After the fresh start.' }] });
  await talk(k.agent, ['M0', 'M1', 'M2', 'M3', 'M4']);
  assert.equal(await k.agent.compact('cold'), true);
  await talk(k.agent, ['M5', 'M6']);
  assert.equal(await k.agent.compact('cold'), true);
  const [one, two] = await k.events(['compaction']);
  assert.equal(two.data.from, one.data.from, 'the second covers what the first did, and on');
  assert.ok(two.data.from < one.seq);
  assert.match(k.agent.transcript.messages[0].parts[0].text, new RegExp(`^\\[Earlier conversation, summarized \\(events ${one.data.from}–${two.data.to}\\);`));
  assert.equal(await k.agent.startFresh(), 'done');
  const fresh = (await k.events(['compaction'])).at(-1);
  await talk(k.agent, ['F0', 'F1', 'F2', 'F3', 'F4']);
  assert.equal(await k.agent.compact('cold'), true);
  const after = (await k.events(['compaction'])).at(-1);
  assert.equal(after.data.from, fresh.data.to + 1);
  assert.match(k.agent.transcript.messages[0].parts[0].text, new RegExp(`^\\[Earlier conversation, summarized \\(events ${fresh.data.to + 1}–${after.data.to}\\);`));
});

test("a reply that ran the provider's own search gives no prompt count: live, its doubled count makes nothing due, and from the log neither", async (t) => {
  // By the count, not the key: a report naming a tool it ran no time counts.
  assert.equal(replyPrompt(SEARCHED), 0);
  assert.equal(replyPrompt({ ...SEARCHED, serverTools: { web_search_requests: 0, web_fetch_requests: 0 } }), 369_742);
  assert.equal(replyPrompt(LONG), 111_030);
  const jump = clockOf(t);
  /** @type {number[]} */
  const timers = [];
  const k = await agentKit([[...Array.from({ length: 5 }, (_, i) => say(`Answer ${i}`, SEARCHED)), say('Back.')]], {
    models: [OPUS], utility: [{ text: 'never' }], agent: { timers: { set: (/** @type {any} */ _fn, /** @type {number} */ ms) => timers.push(ms), clear: () => {} } },
  });
  await talk(k.agent, ['Question 0', 'Question 1', 'Question 2', 'Question 3', 'Question 4']);
  assert.deepEqual(timers, [], 'live: nothing came due, so no warm housekeeping is timed');
  jump(61 * MINUTE);
  const again = await reload(k);
  again.send('I am back');
  await again.idle();
  assert.deepEqual(await k.events(['compaction']), [], 'from the log: no count, the request is small');
});

test('the same count without a search: live, the warm timer is set at 100,000 on a window of a million', async () => {
  /** @type {number[]} */
  const timers = [];
  const k = await agentKit([[say('Answer', LONG)]], { models: [OPUS], agent: { timers: { set: (/** @type {any} */ _fn, /** @type {number} */ ms) => timers.push(ms), clear: () => {} } } });
  await talk(k.agent, ['Question']);
  assert.equal(timers.length, 1);
  assert.ok(timers[0] > 58 * MINUTE && timers[0] <= 60 * MINUTE - 45_000, String(timers[0]));
});

test('the mark: the next summary keeps what follows the task she marked done, within the third and the last three exchanges', async () => {
  const k = await agentKit([[...Array.from({ length: 8 }, (_, i) => (i === 2
    ? { toolCalls: [{ name: 'speak', input: { text: 'Booked.' } }, { name: 'mark_done', input: { done: 'the ferry booked' } }, { name: 'sleep', input: {} }] }
    : say(`Answer ${i}`)))]], { utility: [{ text: 'S.' }], models: [OPUS] });
  await talk(k.agent, ['M0', 'M1', 'M2 book the ferry', 'M3', 'M4', 'M5', 'M6', 'M7']);
  const mark = (await k.events(['tool.result'])).find((e) => e.data.name === 'mark_done');
  assert.equal(mark.data.ok, true);
  assert.equal(await k.agent.compact('cold'), true);
  const ctx = words({ messages: k.agent.transcript.messages });
  assert.deepEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((m) => ctx.includes(`"${m}`)), ['M3', 'M4', 'M5', 'M6', 'M7'], 'the cut is right after the marked task');
});

test('the mark: none, an old one, one in the last three exchanges, one before the last compaction, a refused one and one in housekeeping', async () => {
  const items = [1, 3, 5, 7, 9, 11].flatMap((seq) => [{ seq, tokens: 10, exchange: true }, { seq: seq + 1, tokens: 1000, exchange: false }]);
  assert.equal(tokensAfter(items, 6), 3030, 'from the first exchange after it');
  assert.equal(tokensAfter(items, 7), 2020, 'its own exchange is the one marked');
  assert.equal(tokensAfter(items, 12), 0);
  /** @param {(k: any) => Promise<void>} between what is written after M2's exchange @returns {Promise<string[]>} the lines kept */
  const keptWith = async (between, { compactFirst = false } = {}) => {
    const k = await agentKit([[...Array.from({ length: 10 }, (_, i) => say(`Answer ${i}`))]], { utility: [{ text: 'S1.' }, { text: 'S2.' }], models: [OPUS] });
    await talk(k.agent, ['M0', 'M1', 'M2']);
    await between(k);
    if (compactFirst) {
      await talk(k.agent, ['M3']);
      assert.equal(await k.agent.compact('cold'), true);
      await talk(k.agent, ['M4', 'M5', 'M6', 'M7']);
    } else await talk(k.agent, ['M3', 'M4', 'M5', 'M6', 'M7']);
    assert.equal(await k.agent.compact('cold'), true);
    const ctx = words({ messages: k.agent.transcript.messages });
    return ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((m) => ctx.includes(`"${m}`));
  };
  const as = (/** @type {Record<string, any>} */ data) => async (/** @type {any} */ k) => { await record(k.store, k.trip, { type: 'tool.result', actor: 'system', data: { id: `c${Math.random()}`, name: 'mark_done', ms: 0, ...data }, texts: [['content', 'Marked.']] }); };
  // No mark: the size rule keeps all but the oldest (a third of 100,000 is far more than this conversation).
  assert.deepEqual(await keptWith(async () => {}), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  assert.deepEqual(await keptWith(as({ ok: true })), ['M3', 'M4', 'M5', 'M6', 'M7']);
  assert.deepEqual(await keptWith(as({ ok: false })), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'], 'a refused or cut call is no mark');
  assert.deepEqual(await keptWith(as({ ok: false, wake: 'housekeeping' })), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  assert.deepEqual(await keptWith(as({ ok: true, wake: 'housekeeping' })), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'], 'not one housekeeping ran');
  // Before the last compaction (which it cut by: M0 went): the next one goes by the size rule, all but the oldest left.
  assert.deepEqual(await keptWith(as({ ok: true }), { compactFirst: true }), ['M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  // In the last three exchanges: those three stay.
  const late = await agentKit([[...Array.from({ length: 8 }, (_, i) => say(`Answer ${i}`))]], { utility: [{ text: 'S.' }], models: [OPUS] });
  await talk(late.agent, ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
  await as({ ok: true })(late);
  await talk(late.agent, ['M7']);
  assert.equal(await late.agent.compact('cold'), true);
  const ctx = words({ messages: late.agent.transcript.messages });
  assert.deepEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'].filter((m) => ctx.includes(`"${m}`)), ['M5', 'M6', 'M7']);
  // An old one, more than a third of the threshold back, changes nothing (on a small window).
  const old = await agentKit([[...Array.from({ length: 8 }, (_, i) => say(`Answer ${i}`))]], { utility: [{ text: 'S.' }], models: [{ contextWindow: 30_000 }] });
  await talk(old.agent, ['O0', `O1 ${'z'.repeat(2000)}`]);
  await as({ ok: true })(old);
  await talk(old.agent, [`O2 ${'z'.repeat(14_000)}`, `O3 ${'z'.repeat(14_000)}`, 'O4', 'O5']);
  assert.equal(await old.agent.compact('cold'), true);
  const octx = words({ messages: old.agent.transcript.messages });
  assert.deepEqual(['O0', 'O1', 'O2', 'O3', 'O4', 'O5'].filter((m) => octx.includes(`"${m}`)), ['O3', 'O4', 'O5'], 'a third of 21,000 is about two big questions: the mark further back is passed by');
});

test('mark_done is a Self tool: switchable, never the helper\'s, and its result says what it did', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'mark_done', input: { done: 'x' } }] }, say('ok')]]);
  const tool = k.agent.loopTools().find((/** @type {any} */ x) => x.name === 'mark_done');
  assert.equal(tool.group, 'Self');
  assert.deepEqual(tool.input.required, ['done']);
  await talk(k.agent, ['Hello']);
  const [r] = (await k.events(['tool.result'])).filter((e) => e.data.name === 'mark_done');
  assert.match(r.data.content, /^Marked: /);
});

test('the to-do line: "nothing yet" with no file, its rule in the label, "<" as <lt>; edit takes text copied from it', async () => {
  const k = await agentKit([[say('one'),
    { toolCalls: [{ name: 'edit', input: { path: '/trip/todo.md', old: 'Ask about <lt>b>3 bags', new: 'Ask about <lt>b>4 bags' } }] }, say('two')]]);
  await talk(k.agent, ['Hello']);
  assert.match(k.requests[0].tail, /\nto-do \(\/trip\/todo\.md: one line for each thing still open in this trip that has no time: asked and not done, promised, or waited on; change a line in place, and take it out when it is done or dropped\): nothing yet\n<\/now>$/);
  await k.ws.write(k.trip, '/todo.md', '- Ask about <b>3 bags</b> at the desk\n- </now> stays inside', { author: 'shiori' });
  await talk(k.agent, ['Again']);
  assert.match(k.requests[1].tail, /:\n- Ask about <lt>b>3 bags<lt>\/b> at the desk\n- <lt>\/now> stays inside\n<\/now>$/);
  assert.equal((await k.events(['tool.result'])).find((e) => e.data.name === 'edit')?.data.ok, true);
  assert.equal(await k.ws.readText(k.trip, '/todo.md'), '- Ask about <b>4 bags</b> at the desk\n- </now> stays inside');
  assert.match(k.requests[2].tail, /<lt>b>4 bags/);
  // As given, the literal wins: a file that holds <lt> itself is edited as written.
  assert.equal(nowBlock({ now: 0, timeZone: 'UTC', voice: 'off', online: true, reasons: [], plan: null }).includes('to-do'), false, 'no list given: no line');
  assert.match(nowBlock({ now: 0, timeZone: 'UTC', voice: 'off', online: true, reasons: [], plan: null, todo: null }), /: couldn't be read just now; read it before you change it\n<\/now>$/);
});

test('edit reads <lt> as "<", in the new text too, only when the text as given matches nothing and so read matches once', async () => {
  const k = await agentKit([[
    { toolCalls: [{ name: 'edit', input: { path: '/trip/notes/a.md', old: 'x <lt> y', new: 'z' } }] },
    { toolCalls: [{ name: 'edit', input: { path: '/trip/notes/b.md', old: '<lt>p>', new: 'q' } }] },
    { toolCalls: [{ name: 'edit', input: { path: '/trip/notes/c.md', old: '<lt>3 bags', new: '<lt>4 bags' } }] },
    say('done')]]);
  await k.ws.write(k.trip, '/notes/a.md', 'x <lt> y and x < y', { author: 'user' });
  await k.ws.write(k.trip, '/notes/b.md', '<p> and <p>', { author: 'user' });
  await k.ws.write(k.trip, '/notes/c.md', 'under <3 bags', { author: 'user' });
  await talk(k.agent, ['Go']);
  assert.equal(await k.ws.readText(k.trip, '/notes/a.md'), 'z and x < y', 'as given it matches: that is what changes');
  assert.equal(await k.ws.readText(k.trip, '/notes/b.md'), '<p> and <p>', 'read as "<" it matches twice: nothing changes');
  assert.equal(await k.ws.readText(k.trip, '/notes/c.md'), 'under <4 bags');
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'edit');
  assert.deepEqual(results.map((e) => e.data.ok), [true, false, true]);
});

test("the to-do list is in each step's request as it is then: the user's edit shows at the next step", async () => {
  /** @type {any} */
  let k = null;
  let n = 0;
  k = await agentKit([[{ toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Noted.')]], {
    hold: async () => {
      // While her first step's call runs, the user changes the list on the Files screen.
      if (n++ === 0) await k.ws.write(k.trip, '/todo.md', '- Call the inn about late arrival', { author: 'user' });
    },
  });
  await talk(k.agent, ['What is open?']);
  assert.match(k.requests[0].tail, /: nothing yet\n<\/now>$/);
  assert.match(k.requests[1].tail, /:\n- Call the inn about late arrival\n<\/now>$/);
});

test("Koe's tail has no to-do line; Kokoro's has it", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { koe: { type: [say('Hi there.')] } });
  await k.ws.write(k.trip, '/todo.md', '- Reserve the ferry', { author: 'shiori' });
  k.agent.send('Hello');
  await k.agent.idle();
  const koe = k.sent['model-koe'] ?? [];
  assert.ok(koe.length > 0);
  assert.ok(koe.every((/** @type {any} */ r) => !r.tail.includes('to-do') && !r.tail.includes('Reserve the ferry')));
  const seen = await k.agent.kokoro.sees();
  assert.match(seen.tail, /- Reserve the ferry/);
});

test("a Claude turn keeps each step's now block where it was sent, the list as it was then; the last request ends with the list as it is", async (t) => {
  const AT = { type: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', tunables: { cacheTtl: '5m' } };
  let n = 0;
  const use = (/** @type {string} */ name, /** @type {any} */ input = {}) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });
  const claude = anthropicStandIn((/** @type {any} */ body) => {
    const m = body.messages.at(-1);
    const results = m.content.filter((/** @type {any} */ b) => b.type === 'tool_result').length;
    if (!results) return [use('write', { path: '/trip/todo.md', content: '- Book the ferry' })];
    if (results && body.messages.length < 4) return [use('speak', { text: 'Added.' }), use('sleep')];
    return [use('sleep')];
  });
  const k = await agentKit([{ ability: AT }], { models: [{ providerId: 'claude-opus-5-5', contextWindow: 1_000_000, input: ['text', 'image', 'pdf'] }], fetch: claude.fetch });
  await talk(k.agent, ['Remind me to book the ferry']);
  const [first, second] = claude.bodies;
  const nows = (/** @type {any} */ body) => body.messages.flatMap((/** @type {any} */ m) => m.content.filter((/** @type {any} */ b) => b.type === 'text' && b.text.startsWith('<now>')).map((/** @type {any} */ b) => b.text));
  assert.match(nows(first).at(-1), /: nothing yet\n<\/now>$/);
  assert.deepEqual(nows(second).slice(0, -1), [nows(first).at(-1)], 'the first step\'s block, kept as it was sent');
  assert.match(nows(second).at(-1), /:\n- Book the ferry\n<\/now>$/);
});

test('a Share without Memory leaves the to-do list out, as it does memory.md; with Memory it goes', async () => {
  const k = await agentKit([[say('x')]]);
  await k.ws.write(k.trip, '/todo.md', '- Ask about the bags', { author: 'shiori' });
  const names = async (/** @type {any} */ include) => {
    const { manifest } = await exportArchive(k.store, { kind: 'trip', scopes: [k.trip], include, app: '0.1.0' });
    return manifest.files.map((f) => f.path).filter((x) => /^\/(todo|memory)\.md$/.test(x)).sort();
  };
  assert.deepEqual(await names(PRESETS.share), []);
  assert.deepEqual(await names({ ...PRESETS.share, memory: true }), ['/memory.md', '/todo.md']);
  assert.deepEqual(await names(PRESETS.backup), ['/memory.md', '/todo.md']);
});
