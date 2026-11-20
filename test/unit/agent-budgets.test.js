import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { inQuiet, quietEnds, spentToday, spentIn, costs, UNWATCHED_STEPS } from '../../src/core/agent/budgets.js';
import { isWatched } from '../../src/core/agent/loop.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, createTrip, ME, SYS } from '../../src/core/scopes.js';
import { logEvent } from '../../src/core/events.js';

const at = (/** @type {string} */ iso) => Date.parse(iso);
const loop = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };
/** A reply that reaches the user, then sleeps: a turn of the user's that says nothing is asked again (spec §7.1). */
const done = { toolCalls: [{ name: 'speak', input: { text: 'OK.' } }, { name: 'sleep', input: {} }] };

test('quiet hours in local time, across midnight', () => {
  const q = { from: '22:00', to: '07:00' };
  assert.equal(inQuiet(at('2026-11-26T23:00:00Z'), q, 'UTC'), true);
  assert.equal(inQuiet(at('2026-11-26T06:59:00Z'), q, 'UTC'), true);
  assert.equal(inQuiet(at('2026-11-26T12:00:00Z'), q, 'UTC'), false);
  assert.equal(quietEnds(at('2026-11-26T23:00:00Z'), q, 'UTC'), at('2026-11-27T07:00:00Z'));
  assert.equal(inQuiet(at('2026-11-27T07:30:00Z'), q, 'America/Los_Angeles'), true); // 23:30 the night before, there
});

test('no budget is set by default: a long turn runs on', async () => {
  // Different calls each step: three identical ones in a row would be stopped as stuck (spec §6.6).
  const other = { toolCalls: [{ name: 'list', input: { path: '/me/' } }] };
  const k = await agentKit([[loop, other, loop, other, done]]);
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.length, 5);
});

test('steps per wake: the turn ends with a card, and every call has its result', async () => {
  const k = await agentKit([[loop]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { stepsPerWake: 2 } } });
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.equal(k.notices[0].title, 'Shiori stopped: step limit');
  assert.equal((await k.events(['error']))[0].data.which, 'steps');
  assert.deepEqual(k.agent.transcript.open(), []);
});

test("spend per day: once today's calls cost the budget, no more calls", async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]]);
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'off', answeredBy: 'A', attempts: [], usage: {}, cost: 0.5 }, 'earlier', '');
  assert.equal(await spentToday(k.store, Date.now(), 'UTC'), 0.5);
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  assert.equal(k.notices[0].title, "Shiori stopped: today's budget is spent");
});

/**
 * The scope of every events read a store is asked for from now on.
 * @param {import('../../src/core/types.js').Store} store @returns {string[]}
 */
function readsOf(store) {
  /** @type {string[]} */
  const scopes = [];
  const tx = store.tx.bind(store);
  store.tx = (stores, mode, fn) => tx(stores, mode, (t) => fn({ ...t, listEvents: (scope, q) => (scopes.push(scope), t.listEvents(scope, q)) }));
  return scopes;
}
/** A scripted model that costs this much a call: 12 and 6 tokens at $10,000 a million (what "dear" is in the test of both halves). */
const dear = { prices: { input: 10_000, output: 10_000 } };
/** Another conversation's model call that cost this much, today; its scope. @param {any} k @param {number} cost */
async function earlier(k, cost) {
  const other = await createTrip(k.ws, { title: 'Earlier trip' });
  await modelTrace(k.store, other).turn({ role: 'main', level: 'off', answeredBy: 'A', attempts: [], usage: {}, cost }, 'earlier', '');
  return other;
}

test("no Spend per day set: a turn reads no other conversation's log, though other conversations spent", async () => {
  const k = await agentKit([[done]]);
  const other = await earlier(k, 0.5);
  const reads = readsOf(k.store);
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
  assert.ok(reads.includes(k.trip), 'the turn read its own log');
  assert.ok(!reads.includes(other), "the other conversation's log was not read");
});

test("no Spend per day set: a call cut for a note doesn't read the other conversations' logs either", async () => {
  const k = await agentKit([[{ delayMs: 500, text: 'thinking' }, done]]);
  const other = await earlier(k, 0.5);
  const reads = readsOf(k.store);
  k.agent.send('Go');
  await until(() => k.requests.length === 1);
  k.agent.cutIn();
  await k.agent.idle();
  assert.equal(k.requests.length, 2, 'the cut call went on to a second request');
  assert.ok(!reads.includes(other), "the other conversation's log was not read");
});

test("Spend per day set: other conversations' spend today counts before the turn's first call, and the turn's own calls add to it", async () => {
  const k = await agentKit([[loop, loop, loop, loop, done]], { models: [dear] });
  await earlier(k, 0.3);
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
  k.agent.send('Go');
  await k.agent.idle();
  // $0.3 before, then $0.18 a call: 0.48 after the first, 0.66 after the second. Without the $0.3, a third would run (0.54).
  assert.equal(k.requests.length, 2);
  assert.equal((await k.events(['error']))[0].data.which, 'spend');
});

test("Spend per day set: what a call cut for a note cost, by its trace, counts before the next call is made", async () => {
  const k = await agentKit([[{ delayMs: 500, text: 'thinking' }, loop, done]]);
  await earlier(k, 0.3);
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.5 } } });
  k.agent.send('Go');
  await until(() => k.requests.length === 1);
  // The scripted model bills nothing for a call that is cut; a real one bills what it began to read, and its trace says so.
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'off', answeredBy: 'A', attempts: [], usage: {}, cost: 0.3 }, 'cut', '');
  k.agent.cutIn();
  await k.agent.idle();
  assert.equal(k.requests.length, 1, 'no call after the cut one: $0.3 and $0.3 are over the $0.5');
  assert.equal((await k.events(['error']))[0].data.which, 'spend');
});

test("a Spend per day set while a turn runs takes hold at the next turn, with the day's spend before it: the first turn's too", async () => {
  /** @type {(() => void)[]} */
  const held = [];
  const k = await agentKit([[loop, done, loop, done]], { models: [dear], hold: () => new Promise((r) => held.push(() => r(undefined))) });
  await earlier(k, 0.1);
  k.agent.send('First');
  await until(() => held.length === 1);
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.4 } } });
  held[0]();
  await until(() => held.length === 2);
  held[1]();
  await k.agent.idle();
  const calls = k.requests.length;
  assert.equal((await k.events(['error'])).length, 0, 'the turn that was running is not stopped by what was set during it');
  k.agent.send('Second');
  await k.agent.idle();
  assert.equal(k.requests.length, calls, "no call: $0.1 and the first turn's $0.36 are the day's");
  assert.equal((await k.events(['error']))[0].data.which, 'spend');
});

test("wakes per hour count only wakes that aren't the user's", async () => {
  const k = await agentKit([[done]]);
  await updateAppSettings(k.ws, { shiori: { budgets: { wakesPerHour: 1 } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide now.' });
  k.agent.send('Hello');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  assert.equal(k.notices[0].title, 'Shiori skipped a wake');
});

test('quiet hours hold wakes that are not the user’s, but the user is always heard', async () => {
  const k = await agentKit([[done]], { agent: { now: () => at('2026-11-26T23:00:00Z') } });
  await updateAppSettings(k.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide.' });
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  k.agent.send('Still up?');
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
});

test('costs: per wake and for the whole trip', async () => {
  const k = await agentKit([[{ ...done, usage: { input: 1000, output: 0 } }]]);
  k.agent.send('One');
  await k.agent.idle();
  k.agent.send('Two');
  await k.agent.idle();
  const c = await costs(k.store, k.trip);
  assert.equal(c.byWake.size, 2);
  assert.equal(Number(c.total.toFixed(6)), 0.002);
});

test("today's spending is all counted, however many web requests the day made (spec §6.6)", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: () => null });
  await ensureBaseScopes(ws);
  const now = at('2026-11-27T20:00:00Z');
  await logEvent(store, ME, { type: 'model.turn', data: { cost: 1 } }, at('2026-11-26T23:00:00Z')); // yesterday's
  await logEvent(store, ME, { type: 'model.turn', data: { cost: 0.5 } }, at('2026-11-27T08:00:00Z'));
  await logEvent(store, ME, { type: 'net.request', data: { kind: 'speech-out', cost: 0.25 } }, at('2026-11-27T08:01:00Z'));
  for (let i = 0; i < 4500; i++) await logEvent(store, ME, { type: 'net.request', data: { kind: 'web', tool: 'fetch' } }, at('2026-11-27T09:00:00Z') + i * 1000);
  assert.equal(await spentToday(store, now, 'UTC'), 0.75);
});

// The Spending section's figures (the cost-display design, option A): one read for Today, 7 days, 30 days and All time, and
// Spend per day's Today is the same number (spentToday is spentIn's Today).
/** A store with annai's own scopes, and a trip of its own. */
async function spendStore() {
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: () => null });
  await ensureBaseScopes(ws);
  return { store, ws, trip: await createTrip(ws, { title: 'Kyoto' }) };
}

test('spentIn: each range starts at local midnight in the phone\'s zone, today and the 6 or 29 days before; Spend per day\'s today is the same number', async () => {
  const { store, trip } = await spendStore();
  // 12:00 in Tokyo. Whatever zone the machine running the test is in, Tokyo's and UTC's edges both hold only when the zone given counts.
  const now = at('2026-11-27T03:00:00Z');
  // Each a power of two, so each sum says which entries it holds: the minute before each edge, then the edge itself.
  for (const [iso, cost] of /** @type {[string, number][]} */ ([
    ['2026-10-28T14:59:00Z', 64], // 23:59, 28 Oct in Tokyo: all time only
    ['2026-10-28T15:00:00Z', 32], // 00:00, 29 Oct: 30 days (today, 27 Nov, and the 29 days before)
    ['2026-11-20T14:59:00Z', 16], // 23:59, 20 Nov
    ['2026-11-20T15:00:00Z', 8], // 00:00, 21 Nov: 7 days
    ['2026-11-26T14:59:00Z', 4], // 23:59, 26 Nov
    ['2026-11-26T15:00:00Z', 2], // 00:00, 27 Nov: today
  ])) await logEvent(store, iso < '2026-11-20' ? ME : trip, { type: 'model.turn', data: { answeredBy: 'A', cost } }, at(iso));
  await logEvent(store, ME, { type: 'net.request', data: { kind: 'speech-out', outcome: 'ok', cost: 1 } }, at('2026-11-27T02:00:00Z')); // her voice, today
  assert.deepEqual(await spentIn(store, now, 'Asia/Tokyo', [1, 7, 30, Infinity]), { sums: [3, 15, 63, 127], unpriced: 0 });
  assert.equal(await spentToday(store, now, 'Asia/Tokyo'), 3);
  assert.deepEqual((await spentIn(store, now, 'UTC', [1, 7, 30, Infinity])).sums, [1, 7, 31, 127], "by UTC's midnights, each of Tokyo's falls the day before");
});

test("spentIn: on a day the clocks change, today starts at that day's midnight", async () => {
  const { store } = await spendStore();
  await logEvent(store, ME, { type: 'model.turn', data: { answeredBy: 'A', cost: 1 } }, at('2026-03-28T22:30:00Z')); // 23:30 in Berlin, 28 Mar
  await logEvent(store, ME, { type: 'model.turn', data: { answeredBy: 'A', cost: 2 } }, at('2026-03-28T23:00:00Z')); // 00:00, 29 Mar (summer time from 02:00)
  assert.equal(await spentToday(store, at('2026-03-29T10:00:00Z'), 'Europe/Berlin'), 2);
  await logEvent(store, ME, { type: 'model.turn', data: { answeredBy: 'A', cost: 4 } }, at('2026-10-24T22:30:00Z')); // 00:30, 25 Oct (winter time from 03:00)
  assert.equal(await spentToday(store, at('2026-10-25T11:00:00Z'), 'Europe/Berlin'), 4);
  assert.deepEqual((await spentIn(store, at('2026-10-25T11:00:00Z'), 'Europe/Berlin', [1, 7, 30, Infinity])).sums, [4, 4, 4, 7]);
});

test('spentIn: what counts is what Spend per day counts, annai\'s own log too; a call that answered with no price is counted once as not counted, a call that failed or a model attempt never as not counted', async () => {
  const { store, trip } = await spendStore();
  const now = at('2026-11-27T12:00:00Z');
  /** @param {string} scope @param {string} type @param {any} data */
  const log = (scope, type, data) => logEvent(store, scope, { type, data }, now - 60_000);
  const failed = [{ model: 'm', name: 'M', outcome: 'timeout', ms: 30_000 }];
  // First, so that its time follows its place in the log, as every entry's does: a call that answered 100 days ago with no price, in All time only.
  await logEvent(store, trip, { type: 'model.turn', data: { role: 'main', answeredBy: 'C', attempts: [{ model: 'c', name: 'C', outcome: 'ok', ms: 900 }] } }, now - 100 * 86_400_000);
  await log(trip, 'model.turn', { role: 'main', answeredBy: 'A', attempts: [{ model: 'a', name: 'A', outcome: 'ok', ms: 900, cost: 0.5 }], cost: 0.5 });
  await log(trip, 'net.request', { kind: 'model', model: 'A', outcome: 'ok', cost: 0.5 }); // its attempt: the turn holds its cost
  await log(trip, 'model.turn', { role: 'main', answeredBy: 'B', attempts: [{ model: 'b', name: 'B', outcome: 'ok', ms: 900 }] }); // no prices
  await log(trip, 'net.request', { kind: 'model', model: 'B', outcome: 'ok' });
  await log(trip, 'model.turn', { role: 'utility', answeredBy: null, attempts: failed }); // failed before using anything
  await log(trip, 'model.turn', { role: 'main', answeredBy: null, attempts: failed, cost: 0.125 }); // failed, after using some
  await log(ME, 'net.request', { kind: 'speech-in', outcome: 'ok', cost: 0.25 });
  await log(ME, 'net.request', { kind: 'speech-out', outcome: 'ok' }); // a voice with no prices
  await log(ME, 'net.request', { kind: 'speech-out', outcome: 'timeout' });
  await log(trip, 'net.request', { kind: 'realtime', outcome: 'ok', cost: undefined }); // a live turn with no prices
  await log(trip, 'net.request', { kind: 'realtime', outcome: 'ok', cost: 0 }); // a free tier's
  await log(trip, 'net.request', { kind: 'web', tool: 'fetch', outcome: 'ok' });
  await log(SYS, 'model.turn', { role: 'try', answeredBy: 'A', attempts: [{ model: 'a', name: 'A', outcome: 'ok', ms: 900, cost: 0.0625 }], cost: 0.0625 }); // Try this model, in annai's own log
  const { sums, unpriced } = await spentIn(store, now, 'UTC', [1, 7, 30, Infinity]);
  assert.deepEqual(sums, [0.9375, 0.9375, 0.9375, 0.9375], "the System log's call is in every range");
  assert.equal(unpriced, 4, "B, the voice, the live turn and the call 100 days ago, once across the four ranges (All time's)");
  assert.equal((await spentIn(store, now, 'UTC', [1, 7, 30])).unpriced, 3, "the call 100 days ago is outside the longest range asked for, whose count it is");
  assert.equal((await spentIn(store, now + 86_400_000, 'UTC', [1])).unpriced, 0, 'only in the longest range asked for: none tomorrow');
});

test("spentIn: a first page of 20 a conversation reads little of one with nothing today, and gives the whole read's sum", async () => {
  const { store, ws, trip } = await spendStore();
  const now = at('2026-11-27T20:00:00Z');
  const idle = [];
  for (let i = 0; i < 5; i++) {
    const id = await createTrip(ws, { title: `Old ${i}` });
    idle.push(id);
    for (let j = 0; j < 200; j++) await logEvent(store, id, { type: 'model.turn', data: { answeredBy: 'A', cost: 0.01 } }, at('2026-11-20T08:00:00Z') + j * 1000);
  }
  await logEvent(store, trip, { type: 'model.turn', data: { answeredBy: 'A', cost: 1 } }, at('2026-11-26T23:00:00Z')); // yesterday's
  // More of today's than a first page holds, among more web requests than a page of 1000.
  for (let i = 0; i < 45; i++) {
    await logEvent(store, trip, { type: 'model.turn', data: { answeredBy: 'A', cost: 0.5 } }, at('2026-11-27T08:00:00Z') + i * 60_000);
    for (let j = 0; j < 30; j++) await logEvent(store, trip, { type: 'net.request', data: { kind: 'web', tool: 'fetch' } }, at('2026-11-27T08:00:00Z') + i * 60_000 + j);
  }
  /** @type {Map<string, number>} */
  const read = new Map();
  const tx = store.tx.bind(store);
  store.tx = (stores, mode, fn) => tx(stores, mode, (t) => fn({ ...t, listEvents: async (scope, q) => {
    const page = await t.listEvents(scope, q);
    read.set(scope, (read.get(scope) ?? 0) + page.length);
    return page;
  } }));
  const today = await spentToday(store, now, 'UTC');
  assert.equal(today, 22.5);
  for (const id of idle) assert.equal(read.get(id), 20, "a conversation with nothing today: its first page");
  read.clear();
  assert.equal((await spentIn(store, now, 'UTC', [1, Infinity])).sums[0], today, 'the whole read');
  for (const id of idle) assert.equal(read.get(id), 200);
});

test("Spend per day counts both halves' turns, and stops either at the budget, with one card (K1)", async () => {
  const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };
  const dear = { prices: { input: 10_000, output: 10_000 } }; // 12 and 6 tokens: $0.18 a call
  const k = await agentKit([[sleep]], { models: [dear], koe: { type: [done], model: dear } });
  await updateAppSettings(k.ws, { shiori: { budgets: { spendPerDay: 0.3 } } });
  k.agent.send('First');
  await k.agent.idle();
  const turns = await k.events(['model.turn']);
  assert.deepEqual(turns.map((e) => e.data.tag).sort(), ['conversation', 'koe']);
  assert.ok(Math.abs(await spentToday(k.store, Date.now(), 'UTC') - 0.36) < 1e-9);
  const calls = k.requests.length;
  k.agent.send('Second');
  await k.agent.idle();
  assert.equal(k.requests.length, calls, 'neither half calls past the budget');
  assert.deepEqual((await k.events(['error'])).map((e) => e.data.which).sort(), ['spend', 'spend']);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(k.notices.filter((/** @type {any} */ n) => n.title === "Shiori stopped: today's budget is spent").length, 1, 'one card, not one a half');
});

// Steps per wake empty: a turn nobody is watching stops after UNWATCHED_STEPS model calls; one the user started or joined has no limit.
/** n tool calls that differ from the one before (three identical ones in a row are stopped as stuck), then the end. @param {number} n @param {any} [end] */
const calls = (n, end = done) => [...Array.from({ length: n }, (_, i) => ({ toolCalls: [{ name: 'list', input: { path: i % 2 ? '/me/' : '/trip/' } }] })), end];
const stepCard = (/** @type {any} */ k) => k.notices.filter((/** @type {any} */ n) => n.title === 'Shiori stopped: step limit');

test('unwatched steps: 50, a number of annai\'s own', () => assert.equal(UNWATCHED_STEPS, 50));

test("a turn the user started (their message) runs 60 tool calls with no step card", async () => {
  const k = await agentKit([calls(60)]);
  k.agent.send('Plan everything');
  await k.agent.idle();
  assert.equal(k.requests.length, 61);
  assert.deepEqual(k.notices, []);
});

test('a trigger wake nobody is watching stops at 50 model calls, with the step-limit card', async () => {
  const k = await agentKit([calls(60)]);
  k.agent.wake({ kind: 'trigger', text: 'Your watch w-1 fired: the time came.', fallbacks: [] });
  await k.agent.idle();
  assert.equal(k.requests.length, UNWATCHED_STEPS);
  const [card] = stepCard(k);
  assert.match(card.body, /She took 50 steps on something she was doing on her own/);
  assert.match(card.body, /Ask her to go on/);
  assert.equal((await k.events(['error']))[0].data.which, 'steps');
  assert.deepEqual(k.agent.transcript.open(), []);
});

test('a reminder (a plugin wake) stops at 50 too', async () => {
  const k = await agentKit([calls(60)]);
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  assert.equal(k.requests.length, UNWATCHED_STEPS);
  assert.equal(stepCard(k).length, 1);
});

test("an unwatched turn the user's message joins at step 10 runs past 50", async () => {
  const script = calls(60);
  script[9] = { delayMs: 200, ...script[9] };
  const k = await agentKit([script]);
  k.agent.wake({ kind: 'trigger', text: 'Your watch w-1 fired: the time came.', fallbacks: [] });
  await until(() => k.requests.length === 10);
  k.agent.send('What are you doing?');
  await k.agent.idle();
  assert.equal(k.requests.length, 61);
  assert.deepEqual(stepCard(k), []);
});

test('a set Steps per wake of 5 stops a turn of the user\'s at 5', async () => {
  const k = await agentKit([calls(60)]);
  await updateAppSettings(k.ws, { shiori: { budgets: { stepsPerWake: 5 } } });
  k.agent.send('Plan everything');
  await k.agent.idle();
  assert.equal(k.requests.length, 5);
  assert.equal(stepCard(k).length, 1);
  assert.match(stepCard(k)[0].body, /5 steps a wake may take/);
});

test('a set Steps per wake is the limit of an unwatched turn too, not 50', async () => {
  const k = await agentKit([calls(60)]);
  await updateAppSettings(k.ws, { shiori: { budgets: { stepsPerWake: 7 } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide in 30 minutes.' });
  await k.agent.idle();
  assert.equal(k.requests.length, 7);
});

// Behind Koe, Kokoro's turn is watched when it comes from the user's conversation through Koe.
const KOE = { rules: [{ match: '.', reply: { toolCalls: [{ name: 'sleep', input: {} }] } }] };
const kokoroOf = (/** @type {any} */ k) => k.sent['model-0'] ?? [];

test("Kokoro's turn woken by Koe's note runs past 50", async () => {
  const k = await agentKit([calls(60, { toolCalls: [{ name: 'sleep', input: {} }] })], { koe: { type: KOE } });
  await k.agent.channel.send('koe', 'Is Nepenthe open tonight?', 'append', 'tool', undefined, undefined, true); // from a Koe turn the user watches
  await k.agent.idle();
  assert.equal(kokoroOf(k).length, 61);
  assert.deepEqual(stepCard(k), []);
});

test('Kokoro woken by "Koe answered the user" runs past 50 too', async () => {
  const k = await agentKit([calls(60, { toolCalls: [{ name: 'sleep', input: {} }] })], { koe: { type: KOE } });
  k.agent.kokoro.enqueue({ kind: 'cue', text: 'Koe answered the user', logged: true, input: true, watched: true });
  await k.agent.idle();
  assert.equal(kokoroOf(k).length, 61);
  assert.deepEqual(stepCard(k), []);
});

test("Kokoro's 3-minute review cue stops at 50, with the card", async () => {
  const k = await agentKit([calls(60, { toolCalls: [{ name: 'sleep', input: {} }] })], { koe: { type: KOE } });
  k.agent.kokoro.enqueue({ kind: 'cue', text: 'a review: 3 minutes or more of conversation since you last looked.', logged: true });
  await k.agent.idle();
  assert.equal(kokoroOf(k).length, UNWATCHED_STEPS);
  assert.equal(stepCard(k).length, 1);
});

// Koe's note, and its "answered the user" cue, are watched only when the Koe turn that made them was (it carries `watched`).
const TELL = { toolCalls: [{ name: 'tell_kokoro', input: { text: 'Is Nepenthe open tonight?' } }, { name: 'sleep', input: {} }] };
const ASKS = { rules: [{ match: '.', reply: TELL }] };
const sleeps = { toolCalls: [{ name: 'sleep', input: {} }] };

test('isWatched: a note of Koe\'s or its "answered the user" cue is watched only with the mark of a watched Koe turn', () => {
  assert.equal(isWatched({ kind: 'note', from: 'koe', text: 'n', watched: true }), true);
  assert.equal(isWatched({ kind: 'note', from: 'koe', text: 'n', watched: false }), false);
  assert.equal(isWatched({ kind: 'note', from: 'koe', text: 'n' }), false);
  assert.equal(isWatched({ kind: 'note', from: 'kokoro', text: 'n', watched: true }), false, 'Kokoro\'s notes are never the user\'s');
  assert.equal(isWatched({ kind: 'cue', text: 'Koe answered the user', input: true, watched: true }), true);
  assert.equal(isWatched({ kind: 'cue', text: 'Koe answered the user', input: true, watched: false }), false);
  assert.equal(isWatched({ kind: 'cue', text: 'Koe answered the user', input: true }), false);
  assert.equal(isWatched({ kind: 'cue', text: 'a review' }), false);
});

test('a trigger wakes Koe, Koe tells Kokoro: Kokoro\'s turn is not watched, and stops at 50', async () => {
  const k = await agentKit([calls(60, sleeps)], { koe: { type: ASKS } });
  await k.agent.koe.open(k.trip);
  k.agent.koe.enqueue({ kind: 'trigger', text: 'Your watch w-1 fired: the time came.', fallbacks: [] }); // Koe alone: Kokoro is woken only by its note
  await until(() => (k.sent['model-koe'] ?? []).length > 0);
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 1, 'Koe took the wake');
  assert.equal(kokoroOf(k).length, UNWATCHED_STEPS);
  assert.equal(stepCard(k).length, 1);
});

test('a message of the user\'s wakes Koe, Koe tells Kokoro: Kokoro\'s turn is watched, and runs past 50', async () => {
  const k = await agentKit([calls(60, sleeps)], { koe: { type: ASKS } });
  await k.agent.koe.open(k.trip);
  k.agent.koe.enqueue({ kind: 'user', text: 'Is Nepenthe open tonight?' });
  await until(() => (k.sent['model-koe'] ?? []).length > 0);
  await k.agent.idle();
  assert.equal(k.sent['model-koe'].length, 1, 'Koe took the message');
  assert.equal(kokoroOf(k).length, 61);
  assert.deepEqual(stepCard(k), []);
});

test('an unwatched Kokoro turn tells Koe, Koe (woken by that note) tells it back: Kokoro does not get an unlimited turn, and stops at 50 overall', async () => {
  const tellKoe = { toolCalls: [{ name: 'tell_koe', input: { text: 'Nepenthe is open till 10.' } }] };
  const k = await agentKit([[tellKoe, ...calls(60, sleeps)]], { koe: { type: { rules: [{ match: 'note from Kokoro', reply: TELL }, { match: '.', reply: sleeps }] } } });
  k.agent.kokoro.enqueue({ kind: 'cue', text: 'a review: 3 minutes or more of conversation since you last looked.', logged: true });
  await k.agent.idle();
  assert.ok(k.sent['model-koe'].length >= 1, 'Koe answered the note');
  assert.equal(kokoroOf(k).length, UNWATCHED_STEPS);
  assert.equal(stepCard(k).length, 1);
});

// The user turning live mode on is their own act; live mode's sensing wakes (a watch that fired, a catch-up) are not.
test('a live wake (the user turned live mode on) is watched: it runs past 50', async () => {
  const k = await agentKit([calls(60)]);
  k.agent.wake({ kind: 'live', text: 'The user turned live mode on.' });
  await k.agent.idle();
  assert.equal(k.requests.length, 61);
  assert.deepEqual(stepCard(k), []);
});

test("live mode's sensing wakes (a catch-up, a watch that fired) are not: they stop at 50", async () => {
  for (const kind of /** @type {const} */ (['catch-up', 'trigger'])) {
    const k = await agentKit([calls(60)]);
    k.agent.wake({ kind, text: 'You arrived somewhere.', fallbacks: [] });
    await k.agent.idle();
    assert.equal(k.requests.length, UNWATCHED_STEPS, kind);
    assert.equal(stepCard(k).length, 1, kind);
  }
});
