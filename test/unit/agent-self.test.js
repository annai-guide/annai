import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { TASK_STEPS } from '../../src/core/agent/self-tools.js';

const sleep = { toolCalls: [{ name: 'sleep', input: {} }] };

test('task: a helper on the utility model, with only the tools it was given, returns what it found', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'task', input: { prompt: 'List the trip files', tools: ['list', 'speak'] } }] }, sleep]], {
    utility: [{ toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, { text: 'There is trip.json and memory.md.' }],
  });
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (s) => states.push(s.label));
  k.agent.send('What files do we have?');
  await k.agent.idle();
  const helper = k.requests.filter((r) => r.messages[0].parts[0].text === 'List the trip files');
  assert.equal(helper.length, 2);
  assert.deepEqual(helper[0].tools.map((/** @type {any} */ t) => t.name), ['list']);
  const result = (await k.events(['tool.result'])).find((e) => e.data.name === 'task');
  assert.equal(result.data.content, 'There is trip.json and memory.md.');
  assert.ok((await k.events(['tool.call'])).some((e) => e.data.name === 'list' && e.data.task));
  assert.ok(states.includes('Working on List the trip files'));
});

test(`task: a helper that never finishes stops after ${TASK_STEPS} steps`, async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'task', input: { prompt: 'Loop' } }] }, sleep]], { utility: [{ toolCalls: [{ name: 'list', input: { path: '/me/' } }] }] });
  k.agent.send('Go');
  await k.agent.idle();
  assert.equal(k.requests.filter((r) => r.messages[0].parts[0].text === 'Loop').length, TASK_STEPS);
  assert.match((await k.events(['tool.result'])).find((e) => e.data.name === 'task').data.content, /stopped after 25 steps/);
});

test('skill: a registered skill by name, or the ones there are', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'skill', input: { name: 'driving' } }, { name: 'skill', input: { name: 'hiking' } }, { name: 'sleep', input: {} }] }]]);
  k.registry.add('drive', 'skill', { name: 'driving', description: 'Guiding while driving.', text: 'Keep it short while driving.' });
  k.agent.send('Go');
  await k.agent.idle();
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill').map((e) => e.data.content);
  assert.deepEqual(results, ['Keep it short while driving.', 'There is no skill called "hiking". Skills: driving.']);
});
