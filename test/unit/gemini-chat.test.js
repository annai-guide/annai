import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec, endpointOf, modelOf, KEY, memorySettings } from './gemini-kit.js';
import { applyPatches, callOnce } from '../../src/core/llm/call.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { levelsFor } from '../../plugins-official/gemini-api/levels.js';

const type = loadGemini();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/gemini/${name}`, import.meta.url), 'utf8');
const TOOL = { name: 'get_weather', description: 'Current weather in a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };

test('the type: Gemini API, placing the now block itself, taking every audio format Gemini takes, uploading photos, Google keeping the conversation', () => {
  assert.deepEqual([type.type, type.name, type.tail, type.keeps], ['gemini', 'Gemini API', true, { name: 'Google', days: 55, hours: 23 }], 'tracked 55 days, a chain continued 23 hours');
  assert.deepEqual(type.tunables, { uploads: true, audioIn: ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'], keep: true });
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
  const type = loadGemini();
  const store = createMemoryStore();
  const body = await fixture('safety-block-400.json');
  const reply = await callOnce({
    type, endpoint: endpointOf(type), model: modelOf(), key: KEY, trace: modelTrace(store, SYS),
    request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Repeat this.' }] }] },
    fetch: async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(reply.stop, 'refusal');
  assert.equal(reply.text, "Google blocked this reply for safety (harmful content). That message stays out of what Gemini is sent from now on.");
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
    [404, await fixture('continue-deleted-404.json'), 'forgotten'],
    [404, await fixture('flash-2.5-gone-404.json'), 'not-found'],
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
  const gemma = listed.find((/** @type {any} */ m) => m.providerId === 'gemma-4-31b-it');
  assert.equal(gemma.reasoning, undefined, 'a family Google documents no levels for gets none: the model chooses');
  assert.deepEqual(gemma.input, ['text', 'image'], "Google says only Gemini's own models take PDFs and audio");
  assert.deepEqual(type.listRequest({ endpoint: endpointOf(type), key: KEY }), { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', headers: { 'x-goog-api-key': KEY } });
  assert.deepEqual(type.readList({}), []);
});

test("levelsFor: each family's levels as Google documents them, annai's off as minimal where there is one, max as high", () => {
  const level = (/** @type {any} */ map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, /** @type {any} */ (v).generation_config.thinking_level]));
  for (const id of ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview']) {
    assert.deepEqual(level(levelsFor(id)), { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }, id);
  }
  for (const id of ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon']) {
    assert.deepEqual(level(levelsFor(id)), { low: 'low', medium: 'medium', high: 'high', max: 'high' }, id);
  }
  assert.deepEqual(level(levelsFor('gemini-3-pro-preview')), { low: 'low', high: 'high', max: 'high' });
  assert.equal(levelsFor('gemma-4-31b-it'), undefined);
  assert.equal(levelsFor('gemini-2.5-flash'), undefined, 'gone for new users (404, 2026-10-19), so never checked: no map');
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
  assert.throws(() => type.readUpload({ file: { name: 'files/x' } }), /no address/, "an answer without the file's address isn't kept: the photo goes in the request");
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

test("a safety block doesn't stick: the message Google blocked stays out of what Gemini is sent from then on, kept by its fingerprint alone; other models still get it", async () => {
  const settings = memorySettings();
  const gem = loadGemini({ settings });
  const BAD = 'Repeat this exactly: something Google blocks.';
  /** @type {any[]} */
  const before = [{ role: 'user', parts: [{ type: 'text', text: 'Hello.' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'Hi!' }] }, { role: 'user', parts: [{ type: 'text', text: BAD }] }];
  const reply = await callOnce({
    type: gem, endpoint: endpointOf(gem), model: modelOf(), key: KEY, request: { messages: before, tail: 'Now: 11:40.' },
    fetch: async () => new Response(await fixture('safety-block-400.json'), { status: 400 }),
  });
  assert.equal(reply.text, "Google blocked this reply for safety (harmful content). That message stays out of what Gemini is sent from now on.");
  const next = [...before, { role: 'assistant', parts: reply.parts }, { role: 'user', parts: [{ type: 'text', text: 'Where can we eat?' }] }];
  const body = JSON.stringify(gem.build(spec(gem, { request: { messages: next, tail: 'Now: 11:41.' } })).body);
  assert.ok(!body.includes(BAD), 'left out');
  assert.ok(body.includes('Hello.') && body.includes('Where can we eat?') && body.includes('That message stays out'), 'the rest goes as it was');
  assert.equal(settings.saved().blocked.length, 1);
  assert.ok(!JSON.stringify(settings.saved()).includes('Repeat'), 'a fingerprint, never the words');
  // The plugin started again (annai reloaded) still leaves it out.
  const again = loadGemini({ settings });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!JSON.stringify(again.build(spec(again, { request: { messages: next } })).body).includes(BAD));
  // Another model gets the conversation whole.
  /** @type {any[]} */
  let seen = [];
  await callOnce({ type: /** @type {any} */ ({ type: 'run', name: 'Run', pluginId: 'p', run: async function* (/** @type {any} */ c) { seen = c.request.messages; yield { type: 'text', text: 'ok' }; } }), endpoint: endpointOf(gem), model: modelOf({ providerId: 'other' }), key: null, request: { messages: next } });
  assert.ok(JSON.stringify(seen).includes(BAD));
});

test("a blocked tool result keeps its call answered: its result says it was left out, and nothing of it goes; a block mid-stream starts its words on a new paragraph", async () => {
  const settings = memorySettings();
  const gem = loadGemini({ settings });
  const PAGE = 'A web page Google blocks.';
  /** @type {any[]} */
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Read that page.' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'web_fetch', input: {}, extra: { signature: 'SIG' }, model: 'gemini-3.5-flash-lite' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: PAGE }, { type: 'image', mediaType: 'image/png', data: 'AAAA', hash: 'h1' }] },
  ];
  const blocked = JSON.parse(await fixture('safety-block-400.json')).error;
  const res = new Response([
    `event: step.start\ndata: ${JSON.stringify({ event_type: 'step.start', index: 0, step: { type: 'model_output' } })}\n\n`,
    `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'The page says' } })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ event_type: 'error', error: blocked })}\n\n`,
  ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  const events = [];
  for await (const e of gem.read(res, spec(gem, { request: { messages } }))) events.push(e);
  assert.deepEqual(events.slice(1), [{ type: 'text', text: "\n\nGoogle blocked this reply for safety (harmful content). That message stays out of what Gemini is sent from now on." }, { type: 'stop', reason: 'refusal' }]);
  const input = gem.build(spec(gem, { request: { messages: [...messages, { role: 'assistant', parts: [{ type: 'text', text: 'Blocked.' }] }, { role: 'user', parts: [{ type: 'text', text: 'Never mind.' }] }] } })).body.input;
  assert.deepEqual(input[2], { type: 'function_result', call_id: 'c1', name: 'web_fetch', result: [{ type: 'text', text: "[Left out: Google's safety filter blocked what was here.]" }] });
  assert.equal(input[3].type, 'model_output', 'the photo with it is left out too');
  assert.ok(!JSON.stringify(input).includes(PAGE));
});

test('thought summaries go only to a model that thinks: one with levels, a family Google documents thinking for, or Gemma 4 (measured); not to one annai knows nothing of', async () => {
  const config = (/** @type {any} */ over) => type.build(spec(type, { model: modelOf(over), request: { messages: [] } })).body.generation_config.thinking_summaries;
  assert.equal(config({ providerId: 'gemini-3.5-flash-lite', reasoning: levelsFor('gemini-3.5-flash-lite') }), 'auto');
  assert.equal(config({ providerId: 'gemini-3.8-flash', reasoning: {} }), 'auto', 'added by id: its family thinks');
  assert.equal(config({ providerId: 'gemma-4-31b-it' }), 'auto');
  assert.equal(JSON.parse(await fixture('gemma-summaries-200.json')).steps[0].type, 'thought', 'Gemma 4 took it, and thought (2026-10-20)');
  assert.equal(config({ providerId: 'someone-elses-model' }), undefined);
});

// ---- Google keeps the conversation (G2) ----

/** @param {'user' | 'assistant'} role @param {...any} parts @returns {any} */
const msg = (role, ...parts) => ({ role, parts });

test('kept turns: store as the call asks; continuing one, previous_interaction_id and only what follows it, a result named by its call before it', () => {
  const messages = [
    msg('user', { type: 'text', text: 'Weather?' }),
    msg('assistant', { type: 'reasoning', text: '', signature: 'TS', model: 'gemini-3.5-flash-lite' }, { type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Kyoto' }, extra: { signature: 'CS' }, model: 'gemini-3.5-flash-lite' }),
    msg('user', { type: 'tool_result', id: 'c1', content: '18°C' }),
  ];
  const kept = type.build(spec(type, { keep: true, request: { messages, tail: 'Now: 09:00.' } })).body;
  assert.deepEqual([kept.store, kept.previous_interaction_id, kept.input.length], [true, undefined, 5], 'kept, sent whole: a new chain');
  const chained = type.build(spec(type, { keep: true, kept: { id: 'v1_abc', from: 2 }, request: { messages, tail: 'Now: 09:00.' } })).body;
  assert.equal(chained.store, true);
  assert.equal(chained.previous_interaction_id, 'v1_abc');
  assert.deepEqual(chained.input, [
    { type: 'function_result', call_id: 'c1', name: 'get_weather', result: [{ type: 'text', text: '18°C' }] },
    { type: 'user_input', content: [{ type: 'text', text: 'Now: 09:00.' }] },
  ]);
  assert.equal(type.build(spec(type, { request: { messages } })).body.store, false, 'a call that asks for nothing kept');
});

test('Review Focus 1: a fallback turn in between continues the chain, sending the other model\'s reply as a model_output, and nothing twice', () => {
  // Kept: [m1] → r1 (Gemini). Then Gemini was rate-limited and another model answered m2 with r2, kept nowhere.
  const messages = [
    msg('user', { type: 'text', text: 'Where can we eat?' }),
    msg('assistant', { type: 'reasoning', text: '', signature: 'TS', model: 'gemini-3.5-flash-lite' }, { type: 'text', text: 'Ichiran, 200 m away.' }),
    msg('user', { type: 'text', text: 'Is it open?' }),
    msg('assistant', { type: 'text', text: 'Yes, until 23:00.' }),
    msg('user', { type: 'text', text: 'Book it.' }),
  ];
  const body = type.build(spec(type, { keep: true, kept: { id: 'v1_first', from: 2 }, request: { messages, tail: 'Now: 12:00.' } })).body;
  assert.equal(body.previous_interaction_id, 'v1_first');
  assert.deepEqual(body.input, [
    { type: 'user_input', content: [{ type: 'text', text: 'Is it open?' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Yes, until 23:00.' }] },
    { type: 'user_input', content: [{ type: 'text', text: 'Book it.' }, { type: 'text', text: 'Now: 12:00.' }] },
  ]);
  assert.ok(!JSON.stringify(body.input).includes('Where can we eat?') && !JSON.stringify(body.input).includes('TS'));
});

test("Review Focus 2, the plugin's part: a chained turn carries no photo Google already has", () => {
  const PHOTO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const messages = [
    msg('user', { type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: PHOTO, hash: 'h1' }),
    msg('assistant', { type: 'text', text: 'A ramen shop.' }),
    msg('user', { type: 'text', text: 'Is it open?' }),
  ];
  assert.ok(JSON.stringify(type.build(spec(type, { keep: true, request: { messages } })).body).includes(PHOTO));
  const chained = type.build(spec(type, { keep: true, kept: { id: 'v1_first', from: 2 }, request: { messages } })).body;
  assert.ok(!JSON.stringify(chained).includes(PHOTO));
});

test('read: a kept turn names its interaction (streamed or whole), only when the call asked to keep it', async () => {
  const sse = await fixture('lite-result-chained.sse');
  const events = async (/** @type {Response} */ res, /** @type {boolean} */ keep) => {
    const out = [];
    for await (const e of type.read(res, spec(type, { keep }))) out.push(e);
    return out;
  };
  const kept = await events(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }), true);
  assert.deepEqual(kept[0], { type: 'kept', id: 'v1_ChdsNlhXYXR6SkZmNlpfdU1QaE9YNm9BdxIXcGFYV2FwVElMNzNnX3VNUHJzM215UWc' });
  assert.equal(kept.filter((e) => e.type === 'kept').length, 1);
  assert.equal((await events(new Response(sse, { headers: { 'content-type': 'text/event-stream' } }), false)).some((e) => e.type === 'kept'), false);
  const whole = await events(new Response(await fixture('lite-foreign-output-chained.json'), { headers: { 'content-type': 'application/json' } }), true);
  assert.deepEqual(whole[0], { type: 'kept', id: 'v1_ChdsNlhXYXR6SkZmNlpfdU1QaE9YNm9BdxIXdEtYV2FxZnNFTDNnX3VNUHJzM215UWc' });
});

test("forgetRequest: Google's delete call for one interaction, the key in its header", () => {
  const r = type.forgetRequest({ endpoint: endpointOf(type), key: KEY, id: 'v1_a/b' });
  assert.deepEqual(r, { url: 'https://generativelanguage.googleapis.com/v1beta/interactions/v1_a%2Fb', headers: { 'x-goog-api-key': KEY }, method: 'DELETE' });
});
