import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentKit } from './agent-kit.js';
import { Transcript } from '../../src/core/agent/transcript.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { TALK_TAG, record } from '../../src/core/agent/log.js';

const say = (/** @type {string} */ text) => ({ toolCalls: [{ name: 'speak', input: { text } }, { name: 'sleep', input: {} }] });

test('a typed message wakes Shiori; she speaks and sleeps; the whole turn is in the log, and survives a reload', async () => {
  const k = await agentKit([[say('Nepenthe is 25 minutes south.')]]);
  /** @type {string[]} */
  const states = [];
  k.agent.on('state', (s) => states.push(s.name));
  k.agent.send('Where should we eat?');
  await k.agent.idle();
  const types = (await k.events()).map((e) => e.type).filter((t) => !['scope.create', 'file.write', 'net.request'].includes(t));
  assert.deepEqual(types, ['wake', 'msg.user', 'model.turn', 'tool.call', 'out.speak', 'tool.result', 'tool.call', 'tool.result']);
  const speak = (await k.events(['out.speak']))[0];
  assert.equal(speak.data.text, 'Nepenthe is 25 minutes south.');
  assert.deepEqual(states.at(0), 'thinking');
  assert.equal(k.agent.state.name, 'sleeping');
  assert.deepEqual((await Transcript.load(k.store, k.trip)).messages, k.agent.transcript.messages);
  assert.match(k.requests[0].tail, /^<now>/);
  assert.deepEqual(k.requests[0].tools.map((/** @type {any} */ t) => t.name).slice(0, 5), ['speak', 'show', 'ask', 'wait', 'sleep']);
});

test('tool calls run in order, sleep last, and every call gets a result', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'sleep', input: {} }, { name: 'write', input: { path: '/trip/notes/a.md', content: 'x' } }, { name: 'speak', input: { text: 'Noted.' } }] }]]);
  k.agent.send('Note x');
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.deepEqual(results.map((e) => e.data.name), ['write', 'speak', 'sleep']);
  assert.deepEqual(k.agent.transcript.open(), []);
});

test('fallback across two providers: the first is out of credit, the second answers (spec §9.6)', async () => {
  const k = await agentKit([[{ error: 'credit', status: 402 }], [say('Here.')]]);
  k.agent.send('Hi');
  await k.agent.idle();
  const [turn] = await k.events(['model.turn']);
  assert.deepEqual(turn.data.attempts.map((/** @type {any} */ a) => a.outcome), ['credit', 'ok']);
  assert.equal(turn.data.tag, TALK_TAG);
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Here.');
});

test('ask waits for a tap; a later step continues with the answer', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Keep the 6:30 dinner?', options: ['Keep it', 'Move it'] } }] }, say('Kept.')]]);
  k.agent.send('We are running late');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(k.agent.state.name, 'waiting');
  const [asked] = await k.events(['tool.call']);
  k.agent.answer(asked.data.id, 'Keep it');
  await k.agent.idle();
  const result = (await k.events(['tool.result']))[0];
  assert.equal(result.data.content, 'The user chose: Keep it');
  assert.equal(k.requests.length, 2);
});

test('typing answers a pending ask, and is not repeated as its own message', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'ask', input: { question: 'Which?', options: ['A', 'B'] } }] }, say('OK.')]]);
  k.agent.send('Start');
  await new Promise((r) => setTimeout(r, 30));
  k.agent.send('Neither, the café');
  await k.agent.idle();
  assert.equal((await k.events(['tool.result']))[0].data.content, 'The user wrote: Neither, the café');
  const texts = JSON.stringify(k.requests[1].messages);
  assert.equal(texts.split('Neither, the café').length - 1, 1);
});

test('typing while she works arrives at her next call as "meanwhile" (spec §6.1)', async () => {
  const k = await agentKit([[{ delayMs: 40, toolCalls: [{ name: 'list', input: { path: '/trip/' } }] }, say('Both noted.')]]);
  k.agent.send('First thing');
  await new Promise((r) => setTimeout(r, 10));
  k.agent.send('Second thing');
  await k.agent.idle();
  assert.equal(k.requests.length, 2);
  const last = k.requests[1].messages.at(-1);
  assert.deepEqual(last.parts.map((/** @type {any} */ p) => p.type), ['tool_result', 'text']);
  assert.equal(last.parts[1].text, '[meanwhile, the user wrote] Second thing');
});

test('wait returns what the user typed, or that nothing came', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'speak', input: { text: 'Ready?' } }, { name: 'wait', input: { seconds: 3 } }] }, { toolCalls: [{ name: 'wait', input: { seconds: 1 } }] }, { toolCalls: [{ name: 'sleep', input: {} }] }]]);
  k.agent.send('Go');
  await new Promise((r) => setTimeout(r, 15));
  k.agent.send('Yes!');
  await k.agent.idle();
  const waits = (await k.events(['tool.result'])).filter((e) => e.data.name === 'wait');
  assert.deepEqual(waits.map((e) => e.data.content), ['The user wrote: Yes!', 'Nothing yet (1 seconds).']);
});

test('tapping Shiori stops a hanging tool and the turn; every call still has a result (spec §6.7)', async () => {
  const k = await agentKit([[{ toolCalls: [{ name: 'hang', input: {} }, { name: 'speak', input: { text: 'Never said.' } }] }]]);
  k.registry.add('test', 'tool', { name: 'hang', description: 'Never ends.', input: { type: 'object' }, run: () => new Promise(() => {}) });
  k.agent.send('Go');
  await new Promise((r) => setTimeout(r, 20));
  k.agent.interrupt();
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.deepEqual(results.map((e) => [e.data.name, e.data.content]), [['hang', 'Stopped by the user.'], ['speak', 'Stopped by the user.']]);
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal(k.agent.state.name, 'sleeping');
});

test("no model answers: a system card, never in Shiori's voice", async () => {
  const k = await agentKit([[{ error: 'auth', status: 401 }]]);
  k.agent.send('Hi');
  await k.agent.idle();
  assert.equal(k.notices[0].title, "Shiori can't reach her model");
  assert.equal((await k.events(['out.speak'])).length, 0);
  assert.equal((await k.events(['error']))[0].data.kind, 'model');
});

test('a reload before Shiori answered: the message still gets its answer', async () => {
  const k = await agentKit([[say('Yes, here.')]], { open: false });
  await record(k.store, k.trip, { type: 'wake', actor: 'system', data: { id: 'w-0', reasons: [{ kind: 'user', text: 'typed' }] } });
  await record(k.store, k.trip, { type: 'msg.user', actor: 'user', data: { text: 'Are you there?', wake: 'w-0' } });
  await k.agent.open(k.trip);
  await k.agent.idle();
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Yes, here.');
  assert.match(JSON.stringify(k.requests[0].messages), /Are you there\?/);
});

test('a reload mid-turn: open tool calls get "interrupted by app restart", then a catch-up wake runs (spec §6.7)', async () => {
  const k = await agentKit([[say('Back again.')]], { open: false });
  await modelTrace(k.store, k.trip).turn({ role: 'main', level: 'medium', answeredBy: 'A', attempts: [], usage: {}, cost: 0, tag: TALK_TAG, wake: 'w-0' }, '', '',
    [{ type: 'tool_call', id: 'f1', name: 'fetch', input: { url: 'https://x' } }]);
  await k.agent.open(k.trip);
  await k.agent.idle();
  const results = await k.events(['tool.result']);
  assert.equal(results[0].data.content, 'interrupted by app restart');
  const wakes = await k.events(['wake']);
  assert.equal(wakes[0].data.reasons[0].kind, 'restart');
  assert.equal((await k.events(['out.speak']))[0].data.text, 'Back again.');
});
