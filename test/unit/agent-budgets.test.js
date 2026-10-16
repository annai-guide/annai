import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { inQuiet, quietEnds, spentToday, costs } from '../../src/core/agent/budgets.js';
import { updateAppSettings } from '../../src/core/settings.js';
import { modelTrace } from '../../src/core/llm/trace.js';

const at = (/** @type {string} */ iso) => Date.parse(iso);
const loop = { toolCalls: [{ name: 'list', input: { path: '/trip/' } }] };

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
  const k = await agentKit([[loop, other, loop, other, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
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
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]]);
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
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }] }]], { agent: { now: () => at('2026-11-26T23:00:00Z') } });
  await updateAppSettings(k.ws, { shiori: { budgets: { quietHours: { from: '22:00', to: '07:00' } } } });
  k.agent.wake({ kind: 'plugin', plugin: 'tides', text: 'Low tide.' });
  await k.agent.idle();
  assert.equal(k.requests.length, 0);
  k.agent.send('Still up?');
  await k.agent.idle();
  assert.equal(k.requests.length, 1);
});

test('costs: per wake and for the whole trip', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }], usage: { input: 1000, output: 0 } }]]);
  k.agent.send('One');
  await k.agent.idle();
  k.agent.send('Two');
  await k.agent.idle();
  const c = await costs(k.store, k.trip);
  assert.equal(c.byWake.size, 2);
  assert.equal(Number(c.total.toFixed(6)), 0.002);
});
