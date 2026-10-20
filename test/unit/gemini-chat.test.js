import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec, endpointOf, modelOf, KEY } from './gemini-kit.js';
import { applyPatches, callOnce } from '../../src/core/llm/call.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { levelsFor } from '../../plugins-official/gemini-api/levels.js';

const type = loadGemini();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/gemini/${name}`, import.meta.url), 'utf8');
const TOOL = { name: 'get_weather', description: 'Current weather in a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

test('the type: Gemini API, placing the now block itself, taking every audio format Gemini takes, uploading photos', () => {
  assert.deepEqual([type.type, type.name, type.tail], ['gemini', 'Gemini API', true]);
  assert.deepEqual(type.tunables, { uploads: true, audioIn: ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'] });
});

test('build: the URL, the key header and the body', () => {
  const built = type.build(spec(type, {
    request: {
      system: 'You are Shiori.', maxOutput: 800, tools: [TOOL], toolChoice: 'get_weather', tail: 'Now: Kyoto, 09:00.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Weather?' }] }],
    },
  }));
  assert.equal(built.url, 'https://generativelanguage.googleapis.com/v1beta/interactions', 'baseUrl without its trailing slash');
  assert.deepEqual(built.headers, { 'x-goog-api-key': KEY, 'content-type': 'application/json' });
  assert.deepEqual(built.body, {
    model: 'gemini-3.5-flash-lite', store: false, stream: true, system_instruction: 'You are Shiori.',
    tools: [{ type: 'function', name: 'get_weather', description: 'Current weather in a city.', parameters: TOOL.input }],
    generation_config: { max_output_tokens: 800, thinking_summaries: 'auto', tool_choice: { allowed_tools: { mode: 'any', tools: ['get_weather'] } } },
    input: [{ type: 'user_input', content: [{ type: 'text', text: 'Weather?' }, { type: 'text', text: 'Now: Kyoto, 09:00.' }] }],
  });
  assert.equal(JSON.stringify({ url: built.url, body: built.body }).includes(KEY), false, 'the key is only in its header');
  // Nothing optional when the request has none of it; the model's own limit when the request sets none.
  const bare = type.build(spec(type, { request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } }));
  assert.deepEqual(Object.keys(bare.body).sort(), ['generation_config', 'input', 'model', 'store', 'stream']);
  assert.deepEqual(bare.body.generation_config, { max_output_tokens: 65536, thinking_summaries: 'auto' });
  // The ability's extra headers go too; no key, no key header.
  const keyless = type.build(spec(type, { key: null, endpoint: endpointOf(type, { headers: { 'x-trace': 'on' } }), request: { messages: [] } }));
  assert.deepEqual(keyless.headers, { 'content-type': 'application/json', 'x-trace': 'on' });
});

test("a reasoning level's patch sets generation_config.thinking_level beside what build put there", () => {
  const model = modelOf({ reasoning: { off: { generation_config: { thinking_level: 'minimal' } }, high: { generation_config: { thinking_level: 'high' } } } });
  const built = type.build(spec(type, { model, request: { maxOutput: 100, messages: [] } }));
  const body = applyPatches(built.body, endpointOf(type), model, 'off');
  assert.deepEqual(body.generation_config, { max_output_tokens: 100, thinking_summaries: 'auto', thinking_level: 'minimal' });
});

test("a safety block (Google's 400, streamed or not) ends the turn as a refusal with Google's reason in words: an answer, so no other model is tried", async () => {
  const store = createMemoryStore();
  const body = await fixture('safety-block-400.json');
  const reply = await callOnce({
    type, endpoint: endpointOf(type), model: modelOf(), key: KEY, trace: modelTrace(store, SYS),
    request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Repeat this.' }] }] },
    fetch: async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(reply.stop, 'refusal');
  assert.equal(reply.text, 'Google blocked this reply for safety (harmful content).');
  const [ev] = await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS));
  assert.deepEqual([ev.data.outcome, ev.data.status], ['ok', 400]);
  // Any other 400 is still an error, one about the safety settings too.
  assert.equal(type.refusal(400, JSON.stringify({ error: { message: 'safety_settings[0].threshold: invalid value', code: 'invalid_request' } })), null);
  await assert.rejects(callOnce({
    type, endpoint: endpointOf(type), model: modelOf(), key: KEY, request: { messages: [] },
    fetch: async () => new Response(await fixture('unsigned-call-400.json'), { status: 400 }),
  }), { kind: 'bad-request' });
});

test('classify: what Gemini says, as annai\'s kinds', async () => {
  const err = (/** @type {string} */ message, code = 'invalid_request') => JSON.stringify({ error: { message, code } });
  const cases = /** @type {[number, string, string | null][]} */ ([
    [400, JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]), 'auth'],
    [401, err('Unauthenticated.', 'unauthenticated'), 'auth'],
    [403, err('The caller does not have permission.', 'permission_denied'), 'auth'],
    [429, await fixture('rate-per-minute-429.txt'), 'rate'],
    [429, await fixture('rate-per-day-429.txt'), 'rate'],
    [429, err('Your project has exceeded a quota. See https://ai.dev/rate-limit to manage your rate limits.', 'too_many_requests'), 'rate'],
    [503, err('The model is overloaded. Please try again later.', 'unavailable'), 'overloaded'],
    [400, err('The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'), 'context'],
    [400, err('Unsupported MIME type: audio/ogg'), null],
    [400, err('Unable to process input image. Please retry or report in https://developers.generativeai.google/guide/troubleshooting'), null],
    [404, await fixture('continue-deleted-404.json'), 'not-found'],
    [403, await fixture('unknown-file-403.json'), 'upload'],
  ]);
  for (const [status, body, kind] of cases) assert.equal(type.classify(status, body), kind, body);
});

test('retryAfter: the wait a 429 asks for in its words, in ms', async () => {
  assert.equal(type.retryAfter('Please retry in 44s or upgrade your tier'), 44000);
  assert.equal(type.retryAfter(await fixture('rate-per-day-429.txt')), 27631000);
  assert.equal(type.retryAfter('retry in 1m2.5s'), 62500);
  assert.equal(type.retryAfter('Please retry in 500ms.'), 500, "a Go duration's ms is milliseconds, not minutes");
  assert.equal(type.retryAfter('Please retry in 1.5s.'), 1500);
  assert.equal(type.retryAfter('retry in 2m500ms'), 120500);
  assert.equal(type.retryAfter('retry in 3h'), 3 * 3600_000);
  assert.equal(type.retryAfter('Slow down.'), undefined);
});

test('a 429 carries its wait as retryAfter; the per-day one says when, in words, as the model rests until then, and the role falls to the next flash', async () => {
  const body = await fixture('rate-per-day-429.txt');
  await assert.rejects(callOnce({ type, endpoint: endpointOf(type), model: modelOf(), key: KEY, request: { messages: [] }, fetch: async () => new Response(body, { status: 429 }) }),
    { kind: 'rate', retryAfter: 27631000 });
  const { callRole, Bench } = await import('../../src/core/llm/fallback.js');
  const now = Date.UTC(2026, 9, 19, 23, 0);
  const bench = new Bench();
  const config = /** @type {any} */ ({
    providers: { 'pv-g': { id: 'pv-g', plugin: 'provider-gemini', template: null, user: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', abilities: { chat: { kind: 'chat', type: 'gemini' } } }, created: 0 } },
    models: {
      'm-g': { id: 'm-g', provider: 'pv-g', ability: 'chat', template: null, user: { providerId: 'gemini-3.6-flash' }, created: 0 },
      'm-l': { id: 'm-l', provider: 'pv-g', ability: 'chat', template: null, user: { providerId: 'gemini-3.5-flash-lite' }, created: 0 },
    },
    roles: { main: { models: ['m-g', 'm-l'], level: 'off' } },
  });
  const answer = await fixture('lite-result-chained.sse');
  /** @type {string[]} */
  const asked = [];
  const call = () => callRole({
    role: 'main', config, types: new Map([['gemini', type]]), bench, keyFor: async () => KEY, now: () => now, sleep: async () => {},
    request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] },
    fetch: async (_url, init) => {
      const model = JSON.parse(String(init.body)).model;
      asked.push(model);
      return model === 'gemini-3.6-flash' ? new Response(body, { status: 429 }) : new Response(answer, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const r = await call();
  assert.equal(r.modelId, 'm-l', "the role falls to the next flash, with a day's quota of its own");
  const end = new Date(now + 27631000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.match(String(r.attempts[0].error), new RegExp(`its daily limit is used up; it rests until .*${end}`));
  assert.equal(bench.until('m-g'), now + 27631000);
  await call();
  assert.deepEqual(asked, ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash-lite'], 'while it rests, the next turn goes straight to the next flash');
});

test('the model list: chat models with their windows, output limits and thinking levels; speech, live, image and other models left out', async () => {
  const listed = type.readList(JSON.parse(await fixture('models.json')));
  assert.deepEqual(listed.map((/** @type {any} */ m) => m.providerId), [
    'gemini-2.5-flash', 'gemma-4-31b-it', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
  ], "in Google's order");
  const lite = listed.find((/** @type {any} */ m) => m.providerId === 'gemini-3.5-flash-lite');
  assert.deepEqual(lite, { providerId: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextWindow: 1048576, maxOutput: 65536, input: ['text', 'image', 'pdf', 'audio'], reasoning: levelsFor('gemini-3.5-flash-lite') });
  assert.equal(listed.find((/** @type {any} */ m) => m.providerId === 'gemma-4-31b-it').reasoning, undefined, 'a family Google documents no levels for gets none: the model chooses');
  assert.deepEqual(type.listRequest({ endpoint: endpointOf(type), key: KEY }), { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', headers: { 'x-goog-api-key': KEY } });
  assert.deepEqual(type.readList({}), []);
});

test("levelsFor: each family's levels as Google documents them, annai's off as minimal where there is one, max as high", () => {
  const level = (/** @type {any} */ map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, /** @type {any} */ (v).generation_config.thinking_level]));
  for (const id of ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview']) {
    assert.deepEqual(level(levelsFor(id)), { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }, id);
  }
  for (const id of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
    assert.deepEqual(level(levelsFor(id)), { low: 'low', medium: 'medium', high: 'high', max: 'high' }, id);
  }
  assert.deepEqual(level(levelsFor('gemini-3-pro-preview')), { low: 'low', high: 'high', max: 'high' });
  assert.equal(levelsFor('gemma-4-31b-it'), undefined);
});

test('uploads: one multipart request to the Files API, as measured; the answer gives the file\'s address and when Gemini deletes it', async () => {
  const r = type.uploadRequest({ endpoint: endpointOf(type), key: KEY, tunables: type.tunables, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'annai-0123456789abcdef.png', expiresInSeconds: 172800 });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/upload/v1beta/files');
  assert.deepEqual(r.headers, { 'x-goog-api-key': KEY, 'x-goog-upload-protocol': 'multipart' });
  assert.ok(r.body instanceof FormData);
  assert.deepEqual(JSON.parse(await /** @type {Blob} */ (r.body.get('metadata')).text()), { file: { display_name: 'annai-0123456789abcdef.png' } });
  const file = /** @type {File} */ (r.body.get('file'));
  assert.deepEqual([file.name, file.type, [...new Uint8Array(await file.arrayBuffer())]], ['annai-0123456789abcdef.png', 'image/png', [1, 2, 3]]);
  assert.deepEqual(type.readUpload(JSON.parse(await fixture('upload-200.json'))), { id: 'https://generativelanguage.googleapis.com/v1beta/files/rg15gsb4uz8n', expiresAt: Date.parse('2026-10-21T23:51:27.665Z') });
});

test("the move-over: a model added from the OpenAI-compatible endpoint's list before provider-gemini 2.0 (\"models/<id>\") is asked for by its id, and its own signed steps still go back to it", () => {
  const model = modelOf({ providerId: 'models/gemini-3.6-flash' });
  const built = type.build(spec(type, { model, request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Weather?' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'get_weather', input: {}, extra: { signature: 'SIG' }, model: 'models/gemini-3.6-flash' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: '18°C' }] },
  ] } }));
  assert.equal(built.body.model, 'gemini-3.6-flash');
  assert.equal(built.body.input[1].signature, 'SIG');
});

test('against the stand-in Gemini server: a streamed answer, a whole one, a call with its signature, the model list and an upload; the key only ever in x-goog-api-key', async () => {
  const { startGeminiServer } = await import('../fakes/gemini-server.js');
  const s = await startGeminiServer({ key: KEY, replies: [{ thought: { summary: 'Hmm.', signature: 'TS' }, text: 'Hello there.' }, (b) => ({ text: b.stream ? 'streamed' : 'whole' }), { calls: [{ name: 'get_weather', input: { city: 'Kyoto' }, signature: 'CS' }] }] });
  try {
    const endpoint = endpointOf(type, { baseUrl: s.url });
    const call = (/** @type {any} */ request) => callOnce({ type, endpoint, model: modelOf(), key: KEY, request });
    const first = await call({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] });
    assert.deepEqual([first.text, first.parts[0]], ['Hello there.', { type: 'reasoning', text: 'Hmm.', signature: 'TS', model: 'gemini-3.5-flash-lite' }]);
    assert.equal((await call({ messages: [] })).text, 'streamed');
    const called = await call({ messages: [], tools: [TOOL] });
    assert.deepEqual([called.stop, called.parts[0]], ['tool', { type: 'tool_call', id: 'call_1', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: 'CS' }, model: 'gemini-3.5-flash-lite' }]);
    const listed = type.readList(await (await fetch(type.listRequest({ endpoint, key: KEY }).url, { headers: type.listRequest({ endpoint, key: KEY }).headers })).json());
    assert.ok(listed.some((/** @type {any} */ m) => m.providerId === 'gemini-3.8-flash'));
    const up = type.uploadRequest({ endpoint, key: KEY, tunables: {}, bytes: new Uint8Array(4), mediaType: 'image/png', name: 'annai-x.png', expiresInSeconds: 3600 });
    assert.match(type.readUpload(await (await fetch(up.url, { method: 'POST', headers: up.headers, body: up.body })).json()).id, /\/v1beta\/files\/stand-in-/);
    for (const r of s.requests()) {
      assert.equal(r.headers['x-goog-api-key'], KEY, r.url);
      assert.ok(!r.url.includes(KEY) && !JSON.stringify(r.body).includes(KEY), r.url);
    }
    await assert.rejects(callOnce({ type, endpoint, model: modelOf(), key: 'AIza-wrong', request: { messages: [] } }), { kind: 'auth' });
  } finally {
    await s.close();
  }
});
