import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit, until } from './agent-kit.js';
import { inQuiet, quietEnds, spentToday, costs, UNWATCHED_STEPS } from '../../src/core/agent/budgets.js';
import { isWatched } from '../../src/core/agent/loop.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, ME } from '../../src/core/scopes.js';
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
