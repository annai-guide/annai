import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { TASK_STEPS } from '../../src/core/agent/self-tools.js';
import { utf8 } from '../../src/core/bytes.js';
import { typeForPath } from '../../src/core/paths.js';

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
  const k = await agentKit([[{ toolCalls: [{ name: 'skill', input: { name: 'driving' } }, { name: 'skill', input: { name: 'hiking' } }, { name: 'speak', input: { text: 'Ready.' } }, { name: 'sleep', input: {} }] }]]);
  k.registry.add('drive', 'skill', { name: 'driving', description: 'Guiding while driving.', text: 'Keep it short while driving.' });
  k.agent.send('Go');
  await k.agent.idle();
  const results = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill').map((e) => e.data.content);
  assert.deepEqual(results, ['Keep it short while driving.', 'There is no skill called "hiking". Skills: driving.']);
});

test('recall brings back the exact words from before a compaction, with photos as stubs', async () => {
  const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });
  const k = await agentKit([[say('Nepenthe opens at 11:30.'), say('ok'), say('ok'), say('ok'), { toolCalls: [{ name: 'recall', input: { query: 'nepenthe' } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]], { utility: [{ text: 'Summary.' }] });
  await k.ws.write(k.trip, '/files/menu.webp', new TextEncoder().encode('800x600'), { author: 'user', type: 'image/webp', meta: { width: 800, height: 600 } });
  for (const [m, photos] of /** @type {[string, any[]][]} */ ([['When does Nepenthe open?', [{ path: '/trip/files/menu.webp', region: [0, 0, 0.5, 0.5] }]], ['One', []], ['Two', []], ['Three', []]])) {
    k.agent.send(m, { photos });
    await k.agent.idle();
  }
  assert.equal(await k.agent.compact('cold'), true);
  k.agent.send('What did you say about Nepenthe?');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).find((e) => e.data.name === 'recall');
  const text = r.data.content ?? '';
  assert.match(text, /user: When does Nepenthe open\? \[photo \/trip\/files\/menu\.webp, part \[0, 0, 0\.5, 0\.5\]\]/);
  assert.match(text, /Shiori said: Nepenthe opens at 11:30\./);
});

test('skill: a file from the skill, as text or as an image; a missing one says what there is (choice 9)', async () => {
  const k = await agentKit([[{ toolCalls: [
    { name: 'skill', input: { name: 'tide-pools' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'references/safety.md' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/chart.png' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'scripts/fetch.py' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'assets/data.bin' } },
    { name: 'skill', input: { name: 'tide-pools', file: 'nope.md' } },
    { name: 'sleep', input: {} },
  ] }]]);
  const kept = new Map([['references/safety.md', utf8('Watch the waves.')], ['assets/chart.png', new Uint8Array([137, 80, 78, 71])], ['scripts/fetch.py', utf8('print(1)')], ['assets/data.bin', new Uint8Array(3)]]);
  k.registry.add('tide-pools', 'skill', {
    name: 'tide-pools', description: 'Tide pools.', text: async () => '# Tide pools',
    files: async () => [...kept.keys()], read: async (/** @type {string} */ f) => (kept.has(f) ? { bytes: kept.get(f), type: typeForPath(f) } : null),
  });
  k.agent.send('Go');
  await k.agent.idle();
  const r = (await k.events(['tool.result'])).filter((e) => e.data.name === 'skill');
  assert.equal(r[0].data.content, '# Tide pools\n\nFiles in this skill (read one with skill({ name: "tide-pools", file })): references/safety.md, assets/chart.png, scripts/fetch.py, assets/data.bin');
  assert.equal(r[1].data.content, 'Watch the waves.');
  assert.equal(r[2].data.images.length, 1);
  assert.equal(r[3].data.content, 'print(1)');
  assert.equal(r[4].data.content, "assets/data.bin is application/octet-stream, 3 bytes: annai can't show this kind of file.");
  assert.match(r[5].data.content, /^There is no file nope\.md in the skill tide-pools\. Its files: references\/safety\.md/);
});
