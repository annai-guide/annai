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
  // Gemma's 503 said service_unavailable (2026-10-20): busy, so the next model is tried after a short wait.
  await assert.rejects(read(stream([{ event_type: 'error', error: { code: 'service_unavailable', message: 'gemma-4-31b-it is currently experiencing high demand.' } }])), { kind: 'overloaded' });
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
  const tools = await read(stream([completed('completed', { ...usage, total_tool_use_tokens: 7 })]));
  assert.equal(tools[0].usage.input, 27, "a tool's tokens Google counts apart are input too");
});

test('stop: status completed → end, requires_action → tool, incomplete → length', async () => {
  for (const [status, reason] of [['completed', 'end'], ['requires_action', 'tool'], ['incomplete', 'length'], ['cancelled', 'other']]) {
    assert.deepEqual((await read(stream([completed(status)]))).at(-1), { type: 'stop', reason }, status);
  }
});

/** The recorded grounded reply's steps, as Google streamed them (paid key, 2026-10-21). */
async function grounded() {
  const text = await fixture('search-grounded-lite.sse');
  const data = text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  const delta = (/** @type {number} */ i) => data.find((e) => e.event_type === 'step.delta' && e.index === i).delta;
  return { text, call: delta(0), result: delta(1), thought: delta(2) };
}

test('read: the recorded grounded reply (Google Search beside a function tool) gives the progress line, two provider parts, the words, citations, one attribution and the searches counted', async () => {
  const { text, call, result, thought } = await grounded();
  const events = await read(new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG8B6eUk40XfuJAJZB9BANLdx2Fta7M6abGxkUfZ82NrIQKzV9RXAwSw7pDzQ8fPaROdSuCE6UQ6haKaY41ZAxd8znYNbSHyf5dKwFCFXPv_GewMtebJ3I4BeU4N6Xf8DyqAQ==';
  const words = 'Nepenthe restaurant closes at 10:00 PM.';
  assert.deepEqual(events.map((e) => e.type), ['reasoning_delta', 'provider', 'provider', 'reasoning', 'text', 'text', 'text', 'citation', 'attribution', 'usage', 'stop']);
  assert.deepEqual(events[0], { type: 'reasoning_delta', text: 'Searching Google: Nepenthe restaurant Big Sur closing time, Nepenthe restaurant Big Sur hours' });
  // Each search step goes back to the model that made it as it came: its start and its whole delta, signature and all.
  assert.deepEqual(events[1], { type: 'provider', block: { type: 'google_search_call', id: 'call_439229', search_type: 'web_search', signature: call.signature, arguments: { queries: ['Nepenthe restaurant Big Sur closing time', 'Nepenthe restaurant Big Sur hours'] } } });
  assert.deepEqual(events[2], { type: 'provider', block: { type: 'google_search_result', call_id: 'call_439229', signature: result.signature, result: result.result, is_error: false } });
  assert.deepEqual(events[3], { type: 'reasoning', text: '', signature: thought.signature });
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), words);
  assert.deepEqual(events[7], { type: 'citation', url, title: 'nepenthe.com' });
  assert.deepEqual(events[8], { type: 'attribution', source: 'Google Search', text: words, links: [{ url, title: 'nepenthe.com' }], html: result.result[0].search_suggestions });
  assert.match(events[8].html, /<a class="chip" href="https:\/\/www\.google\.com\/search\?q=Nepenthe\+restaurant\+Big\+Sur\+hours/);
  assert.deepEqual(events[9], { type: 'usage', usage: { input: 76, cacheRead: 0, output: 20, reasoning: 0, serverTools: { google_search: 2 } } });
  assert.deepEqual(events[10], { type: 'stop', reason: 'end' });
});

test('read: a grounded reply sent whole gives the same events as its stream; a reply that searched nothing has no attribution', async () => {
  const sig = { call: 'CALLSIG', result: 'RESULTSIG' };
  const html = '<div class="container"><a class="chip" href="https://www.google.com/search?q=kyoto">kyoto</a></div>';
  const link = { type: 'url_citation', url: 'https://example.test/kyoto', title: 'example.test', start_index: 0, end_index: 6 };
  const u = { ...usage, grounding_tool_count: [{ type: 'google_search', count: 1 }] };
  const steps = [
    { type: 'google_search_call', id: 's1', search_type: 'web_search', arguments: { queries: ['kyoto'] }, signature: sig.call },
    { type: 'google_search_result', call_id: 's1', result: [{ search_suggestions: html }], is_error: false, signature: sig.result },
    { type: 'model_output', content: [{ type: 'text', text: 'Kyoto.', annotations: [link] }] },
  ];
  const whole = await read(new Response(JSON.stringify({ id: 'v1_w', status: 'completed', usage: u, steps, object: 'interaction', model: 'gemini-3.5-flash-lite' }), { headers: { 'content-type': 'application/json' } }));
  const streamed = await read(stream([
    { event_type: 'interaction.created', interaction: { object: 'interaction', model: 'gemini-3.5-flash-lite' } },
    { event_type: 'step.start', index: 0, step: { id: 's1', signature: '', type: 'google_search_call', search_type: 'web_search' } },
    { event_type: 'step.delta', index: 0, delta: { signature: sig.call, type: 'google_search_call', arguments: { queries: ['kyoto'] } } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { call_id: 's1', signature: '', type: 'google_search_result' } },
    { event_type: 'step.delta', index: 1, delta: { signature: sig.result, type: 'google_search_result', result: [{ search_suggestions: html }], is_error: false } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 2, delta: { type: 'text', text: 'Kyoto.' } },
    { event_type: 'step.delta', index: 2, delta: { type: 'text_annotation_delta', annotations: [link] } },
    { event_type: 'step.stop', index: 2 },
    completed('completed', u),
  ]));
  assert.deepEqual(whole, streamed);
  assert.deepEqual(whole.find((e) => e.type === 'attribution'), { type: 'attribution', source: 'Google Search', text: 'Kyoto.', links: [{ url: link.url, title: 'example.test' }], html });
  // No search, no card; a search with no suggestions and no links still says where it came from.
  const plain = await read(stream([{ event_type: 'step.start', index: 0, step: { type: 'model_output' } }, { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'Hi.' } }, { event_type: 'step.stop', index: 0 }, completed()]));
  assert.equal(plain.some((e) => e.type === 'attribution' || e.type === 'provider'), false);
  const bare = await read(stream([
    { event_type: 'step.start', index: 0, step: { id: 's1', type: 'google_search_call' } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { call_id: 's1', type: 'google_search_result', result: [] } },
    { event_type: 'step.stop', index: 1 },
    completed(),
  ]));
  assert.deepEqual(bare.filter((e) => e.type !== 'usage'), [
    { type: 'reasoning_delta', text: 'Searching Google' },
    { type: 'provider', block: { type: 'google_search_call', id: 's1' } },
    { type: 'provider', block: { type: 'google_search_result', call_id: 's1', result: [] } },
    { type: 'attribution', source: 'Google Search', text: '', links: [] },
    { type: 'stop', reason: 'end' },
  ]);
  // A search that failed grounds nothing: its steps go back, and no card says the words came from it.
  const failed = await read(stream([
    { event_type: 'step.start', index: 0, step: { id: 's1', type: 'google_search_call', arguments: { queries: ['kyoto'] } } },
    { event_type: 'step.stop', index: 0 },
    { event_type: 'step.start', index: 1, step: { call_id: 's1', type: 'google_search_result', result: [], is_error: true } },
    { event_type: 'step.stop', index: 1 },
    { event_type: 'step.start', index: 2, step: { type: 'model_output' } },
    { event_type: 'step.delta', index: 2, delta: { type: 'text', text: 'I could not check.' } },
    { event_type: 'step.stop', index: 2 },
    completed(),
  ]));
  assert.deepEqual(failed.map((e) => e.type), ['reasoning_delta', 'provider', 'provider', 'text', 'usage', 'stop']);
});

test('a safety block in the stream ends the turn as a refusal with Google\'s reason in words', async () => {
  const blocked = JSON.parse(await fixture('safety-block-400.json')).error;
  const events = await read(stream([{ event_type: 'error', error: blocked }]));
  assert.deepEqual(events, [{ type: 'text', text: 'Google blocked this reply for safety (harmful content).' }, { type: 'stop', reason: 'refusal' }], 'no message to leave out, so no word of one');
});
