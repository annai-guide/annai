import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec } from './gemini-kit.js';

const type = loadGemini();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/gemini/${name}`, import.meta.url), 'utf8');
/** @param {Response} res */
async function read(res) {
  const out = [];
  for await (const e of type.read(res, spec(type))) out.push(e);
  return out;
}
/** A stream as Google sends it, from its events. @param {any[]} events */
const stream = (events) => new Response([...events.map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`), 'event: done\ndata: [DONE]\n\n'].join(''), { headers: { 'content-type': 'text/event-stream' } });
const usage = { total_tokens: 30, total_input_tokens: 20, input_tokens_by_modality: [{ modality: 'text', tokens: 20 }], total_cached_tokens: 0, total_output_tokens: 10, total_tool_use_tokens: 0, total_thought_tokens: 0 };
const completed = (status = 'completed', u = usage) => ({ event_type: 'interaction.completed', interaction: { id: 'v1_x', status, usage: u, object: 'interaction', model: 'gemini-3.5-flash-lite' } });

test('read: the recorded call gives the thought with its signature, the call with its own, usage and stop "tool"', async () => {
  const events = await read(new Response(await fixture('flash-call-with-signatures.sse'), { headers: { 'content-type': 'text/event-stream' } }));
  const thought = 'EmkKZwFpFH0TwTuhdcZL169DCbw+YzfwDvrX8RZxPHvgdnLBM8B2VVImzhXbteT4i2gmjLge3xlu9q7622A307J4VTgZ9ZoTiOl2vaqpeJas27IkUOdr+BLco3w8ccBzCvIFMN8ToqxSDC4=';
  const call = 'AWkUfRPBO6F1xkvXr0MJvD5jN/AO+tfxFnE8e+B2csEzwHZVUibOFdu15PiLaCaMuB7fGW72rvrbYDfTsnhVOBn1mhOI6Xa9qql4lqzbsiRQ52v4EtyjfDxxwHMK8gUw3xOirFIMLg==';
  assert.deepEqual(events.filter((e) => e.type !== 'tool_input'), [
    { type: 'reasoning', text: '', signature: thought },
    { type: 'tool_call', id: 'call_41070', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: call } },
    { type: 'usage', usage: { input: 57, cacheRead: 0, output: 17, reasoning: 0 } },
    { type: 'stop', reason: 'tool' },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"city":"Kyoto"}'], "the call's arguments as they arrive, to show progress");
});

test('read: the recorded answer gives its words as they arrive, then stop "end"', async () => {
  const events = await read(new Response(await fixture('lite-result-chained.sse'), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['The current', ' weather in Kyoto is 18°C with light rain.']);
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'The current weather in Kyoto is 18°C with light rain.');
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'end' });
});

test('read: thought_summary deltas are reasoning_delta, and the whole summary is the reasoning text', async () => {
  const events = await read(stream([
    { event_type: 'interaction.created', interaction: { id: 'v1_x', object: 'interaction', model: 'gemini-3.6-flash' } },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: '**Looking at the map**\n\n' } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Kyoto is close.' } } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'SIG' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: 'Close by.' } },
    { event_type: 'step.stop', index: 1 },
    completed(),
  ]));
  assert.deepEqual(events.slice(0, 4), [
    { type: 'reasoning_delta', text: '**Looking at the map**\n\n' },
    { type: 'reasoning_delta', text: 'Kyoto is close.' },
    { type: 'reasoning', text: '**Looking at the map**\n\nKyoto is close.', signature: 'SIG' },
    { type: 'text', text: 'Close by.' },
  ]);
});

test('read: a call split over several arguments_delta pieces is put together; one with none has the arguments it started with', async () => {
  const events = await read(stream([
    { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'c1', name: 'get_weather', arguments: {}, signature: 'S1' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"ci' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: 'ty":"Nara"}' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'c2', name: 'now', arguments: {} } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'c3', name: 'show', arguments: { place: 'Uji' } } },
    { event_type: 'step.stop', index: 2 },
    completed('requires_action'),
  ]));
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [
    { type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Nara' }, extra: { signature: 'S1' } },
    { type: 'tool_call', id: 'c2', name: 'now', input: {} },
    { type: 'tool_call', id: 'c3', name: 'show', input: { place: 'Uji' } },
  ]);
});

test('read: an error event throws a ProviderError of its kind', async () => {
  await assert.rejects(read(stream([
    { event_type: 'step.start', index: 0, step: { type: 'model_output' } },
    { event_type: 'error', error: { code: 'gateway_timeout', message: 'The server took too long.' } },
  ])), (/** @type {any} */ e) => e.name === 'ProviderError' && e.kind === 'server' && /took too long/.test(e.message));
  await assert.rejects(read(stream([{ event_type: 'error', error: { code: 'too_many_requests', message: 'Slow down.' } }])), { kind: 'rate' });
  // A stream that ends before the interaction completed was cut off.
  await assert.rejects(read(new Response('event: step.start\ndata: {"index":0,"step":{"type":"model_output"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })), { kind: 'network' });
});

test('read: a whole JSON reply gives the same events as a stream would', async () => {
  const text = await fixture('lite-foreign-output-chained.json');
  const whole = await read(new Response(text, { headers: { 'content-type': 'application/json; charset=UTF-8' } }));
  const j = JSON.parse(text);
  const [thought, output] = j.steps;
  const streamed = await read(stream([
    { event_type: 'interaction.created', interaction: { id: j.id, object: 'interaction', model: j.model } },
    { event_type: 'step.start', index: 0, step: { type: 'thought' } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: thought.summary[0] } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: thought.signature } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 1, delta: output.content[0] },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'interaction.completed', interaction: { id: j.id, status: j.status, usage: j.usage } },
  ]));
  assert.deepEqual(whole, streamed);
  assert.deepEqual(whole.map((e) => e.type), ['reasoning_delta', 'reasoning', 'text', 'usage', 'stop']);
  assert.deepEqual(whole.at(-2), { type: 'usage', usage: { input: 27, cacheRead: 0, output: 141, reasoning: 140 } }, 'thinking is billed as output');
  // A stream sent as JSON is still a stream.
  const sent = await read(new Response(await fixture('lite-result-chained.sse'), { headers: { 'content-type': 'application/json' } }));
  assert.equal(sent.at(-1).reason, 'end');
});

test('usage: thinking counts as output, cached tokens as cache reads, audio and image apart', async () => {
  const events = await read(stream([completed('completed', {
    total_tokens: 2000, total_input_tokens: 1500, total_cached_tokens: 400, total_output_tokens: 100, total_thought_tokens: 300, total_tool_use_tokens: 0,
    input_tokens_by_modality: [{ modality: 'text', tokens: 900 }, { modality: 'audio', tokens: 320 }, { modality: 'image', tokens: 258 }, { modality: 'video', tokens: 22 }],
    cached_tokens_by_modality: [{ modality: 'text', tokens: 300 }, { modality: 'audio', tokens: 100 }],
  })]));
  assert.deepEqual(events[0], { type: 'usage', usage: { input: 900 - 300, cacheRead: 300, cacheReadAudio: 100, audioIn: 220, image: 280, output: 400, reasoning: 300 } });
  assert.equal(600 + 300 + 100 + 220 + 280, 1500, 'every input token counted once');
});

test('stop: status completed → end, requires_action → tool, incomplete → length', async () => {
  for (const [status, reason] of [['completed', 'end'], ['requires_action', 'tool'], ['incomplete', 'length'], ['cancelled', 'other']]) {
    assert.deepEqual((await read(stream([completed(status)]))).at(-1), { type: 'stop', reason }, status);
  }
});

test('a safety block in the stream ends the turn as a refusal with Google\'s reason in words', async () => {
  const blocked = JSON.parse(await fixture('safety-block-400.json')).error;
  const events = await read(stream([{ event_type: 'error', error: blocked }]));
  assert.deepEqual(events, [{ type: 'text', text: 'Google blocked this reply for safety (harmful content).' }, { type: 'stop', reason: 'refusal' }]);
});
