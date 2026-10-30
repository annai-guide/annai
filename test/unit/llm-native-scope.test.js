import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { activate as activateAnthropic } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { callOnce, nativeKey, nativePrints } from '../../src/core/llm/call.js';

// A native reaches only the models that can read it: its endpoint, and the scope the endpoint type gives a model (the keep-reasoning
// review, F3). OpenRouter is one endpoint for every vendor, so a fallback from Claude to GPT must not be sent Claude's reasoning.

/** @param {typeof activate} start @returns {any} */
function load(start) {
  /** @type {any} */
  let type = null;
  start({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const chat = load(activate);
const anthropic = load(activateAnthropic);
const endpoint = /** @type {any} */ ({ id: 'ep-or', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, tunables: { ...chat.tunables, reasoningField: 'reasoning', cacheMarkers: ['anthropic/'] }, extraBody: {} });
/** @param {string} providerId */
const model = (providerId) => /** @type {any} */ ({ id: providerId, endpoint: 'ep-or', name: providerId, providerId, input: ['text'], tools: true, contextWindow: 1000000, maxOutput: 8000, prices: null, reasoning: {}, tunables: {}, extraBody: {} });
const KEY = 'sk-or-test';
const scopeOf = (/** @type {any} */ type, /** @type {any} */ ep, /** @type {any} */ m) => type.nativeScope?.({ model: m, tunables: { ...ep.tunables, ...m.tunables } }) ?? '';

test('chat-completions gives a model the cacheMarkers prefix it starts with, else its own id; anthropic-messages gives none', () => {
  assert.equal(scopeOf(chat, endpoint, model('anthropic/claude-sonnet-5.5')), 'anthropic/');
  assert.equal(scopeOf(chat, endpoint, model('anthropic/claude-haiku-5.5')), 'anthropic/');
  assert.equal(scopeOf(chat, endpoint, model('openai/gpt-5.5')), 'openai/gpt-5.5');
  assert.equal(scopeOf(chat, { ...endpoint, tunables: { ...chat.tunables } }, model('anthropic/claude-sonnet-5.5')), 'anthropic/claude-sonnet-5.5', 'no cacheMarkers: the model alone');
  assert.equal(anthropic.nativeScope, undefined);
});

/** Claude's step 1 on OpenRouter as the transcript holds it, then step 2's request. @param {string} writer the model that wrote the native */
async function turn(writer) {
  const here = await nativeKey(endpoint, KEY, scopeOf(chat, endpoint, model(writer)));
  const before = /** @type {any} */ ({ system: 'S', tools: [], tail: '<now>1</now>', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] });
  const prefix = nativePrints(before, []).end();
  const details = [{ type: 'reasoning.text', text: 'x', signature: 'sig', format: 'anthropic-claude-v1', index: 0 }];
  const withNative = {
    system: 'S', tools: [], tail: '<now>2</now>',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'text', text: '<now>1</now>', now: true }] },
      { role: 'assistant', parts: [{ type: 'native', endpoint: here, content: details, covers: 1, prefix }, { type: 'tool_call', id: 'c1', name: 'list', input: {} }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'a' }] },
    ],
  };
  // What the same conversation was before natives existed: the transcript with neither the native nor the kept now block.
  const plain = { ...withNative, messages: withNative.messages.map((m) => ({ role: m.role, parts: m.parts.filter((/** @type {any} */ p) => p.type !== 'native' && !p.now) })) };
  return { withNative, plain };
}
/** The body callOnce sends for a request, and the trace line's natives. @param {string} to @param {any} request */
async function bodyTo(to, request) {
  /** @type {any} */
  let body = null;
  const fetch = async (/** @type {string} */ _u, /** @type {RequestInit} */ init) => {
    body = JSON.parse(String(init.body));
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events = /** @type {any[]} */ ([]);
  const trace = { secret() {}, request: async (/** @type {any} */ e) => { events.push(e); }, upload: async () => {} };
  await callOnce({ type: chat, endpoint, model: model(to), key: KEY, request, fetch, trace: /** @type {any} */ (trace) });
  return { body, natives: events[0]?.natives };
}

test("a GPT fallback on OpenRouter is sent exactly what it was before natives: no reasoning_details, no kept now block, nothing counted as sent", async () => {
  const { withNative, plain } = await turn('anthropic/claude-sonnet-5.5');
  const gpt = await bodyTo('openai/gpt-5.5', withNative);
  const was = await bodyTo('openai/gpt-5.5', plain);
  assert.equal(JSON.stringify(gpt.body), JSON.stringify(was.body), 'byte for byte');
  assert.ok(!JSON.stringify(gpt.body).includes('reasoning_details'));
  assert.equal(gpt.natives, undefined, 'the Trace counts nothing sent');
});

test("Claude's Sonnet and Haiku through OpenRouter share a native; the kept now block goes with it", async () => {
  const { withNative } = await turn('anthropic/claude-sonnet-5.5');
  for (const to of ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']) {
    const { body, natives } = await bodyTo(to, withNative);
    assert.ok(JSON.stringify(body).includes('"reasoning_details"'), to);
    assert.ok(JSON.stringify(body).includes('<now>1</now>'), to);
    assert.deepEqual(natives, { sent: 1, changed: false }, to);
  }
});
