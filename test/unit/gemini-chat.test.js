import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadGemini, spec, endpointOf, modelOf, KEY } from './gemini-kit.js';
import { applyPatches, callOnce } from '../../src/core/llm/call.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { modelTrace } from '../../src/core/llm/trace.js';

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
  // Any other 400 is still an error.
  await assert.rejects(callOnce({
    type, endpoint: endpointOf(type), model: modelOf(), key: KEY, request: { messages: [] },
    fetch: async () => new Response(await fixture('unsigned-call-400.json'), { status: 400 }),
  }), { kind: 'bad-request' });
});
