import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/** The endpoint type, registered the way annai's plugin host would. @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/llm/chat-completions/${name}`, import.meta.url), 'utf8');
/** A spec for one call. @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-1', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1/', headers: { 'X-Title': 'annai' }, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-1', endpoint: 'ep-1', name: 'Haiku', providerId: 'anthropic/claude-haiku-5.5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: 8000, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-or-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** @param {string} text @param {any} [s] */
async function read(text, s = spec()) {
  const out = [];
  for await (const e of type.read(new Response(text), s)) out.push(e);
  return out;
}

test('build: annai’s request as an OpenAI-style chat completion', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      maxOutput: 500,
      tools: [{ name: 'report_color', description: 'Report a color.', input: { type: 'object', properties: { color: { type: 'string' } } } }],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'What color?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_call', id: 'call_1', name: 'report_color', input: { color: 'red' } }] },
        { role: 'user', parts: [{ type: 'tool_result', id: 'call_1', content: 'noted' }, { type: 'text', text: 'Thanks' }] },
      ],
    },
  });
  const { url, headers, body } = type.build(s);
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: 'Bearer sk-or-test', 'X-Title': 'annai' });
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 500);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'report_color', description: 'Report a color.', parameters: { type: 'object', properties: { color: { type: 'string' } } } } }]);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: 'Let me look.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report_color', arguments: '{"color":"red"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'noted' },
    { role: 'user', content: 'Thanks' },
  ]);
});

test('build: a reply that held only reasoning is left out, since an empty assistant message is refused by some servers', () => {
  const s = spec({
    request: {
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', parts: [{ type: 'reasoning', text: 'Nothing to say.' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] },
      ],
    },
  });
  assert.deepEqual(type.build(s).body.messages, [{ role: 'user', content: 'Hi' }, { role: 'user', content: 'Hello?' }]);
});

test('build: the tail joins the last user message, or follows tool results; documents, a forced tool, logprobs', () => {
  const s = spec({
    request: {
      toolChoice: 'decide',
      logprobs: 5,
      tools: [{ name: 'decide', description: 'Pick one.', input: { type: 'object' } }],
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'document', mediaType: 'application/pdf', data: 'JVBE', name: 'menu.pdf' }] }],
      tail: '<now>16:12</now>',
    },
  });
  const { body } = type.build(s);
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: [
    { type: 'text', text: 'Hi' },
    { type: 'file', file: { filename: 'menu.pdf', file_data: 'data:application/pdf;base64,JVBE' } },
    { type: 'text', text: '<now>16:12</now>' },
  ] });
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'decide' } });
  assert.equal(body.logprobs, true);
  assert.equal(body.top_logprobs, 5);
  const plain = type.build(spec({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], tail: 'NOW' } })).body;
  assert.deepEqual(plain.messages.at(-1), { role: 'user', content: 'Hi\n\nNOW' });
  const afterTools = type.build(spec({ request: { messages: [
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'look', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'seen' }] },
  ], tail: 'NOW' } })).body;
  assert.deepEqual(afterTools.messages.slice(-2), [{ role: 'tool', tool_call_id: 'c1', content: 'seen' }, { role: 'user', content: 'NOW' }]);
  assert.equal(type.tail, true);
});

test('read: the first token’s alternatives, once', async () => {
  const events = await read(await fixture('logprobs.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'logprobs'), [{ type: 'logprobs', top: [{ token: 'B', logprob: -0.05 }, { token: 'A', logprob: -3.2 }] }]);
});

test('build: the tunables for OpenAI and for endpoints without usage in streams or a key', () => {
  const tunables = { ...type.tunables, maxTokensField: 'max_completion_tokens', systemRole: 'developer', usageInStream: false, imageDetail: 'high' };
  const s = spec({ key: null, tunables, request: { system: 'S', messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/jpeg', data: 'BBBB' }] }] } });
  const { headers, body } = type.build(s);
  assert.equal(headers.authorization, undefined);
  assert.equal(body.max_completion_tokens, 8000, "the model's maximum output, when the request sets none");
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.messages[0], { role: 'developer', content: 'S' });
  assert.deepEqual(body.messages[1].content, [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB', detail: 'high' } }]);
});

test('read: text, reasoning as it streams and as a whole, usage with cache reads and reported cost, and the stop reason', async () => {
  const events = await read(await fixture('text.sse'));
  assert.deepEqual(events, [
    { type: 'reasoning_delta', text: 'The user greets me. ' },
    { type: 'reasoning_delta', text: 'Reply warmly.' },
    { type: 'reasoning', text: 'The user greets me. Reply warmly.' },
    { type: 'text', text: 'こんにちは! ' },
    { type: 'text', text: 'Welcome to Kyoto.' },
    { type: 'usage', usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 40, reasoning: 12, cost: 0.000125 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('read: a streamed tool call, its arguments as they arrive, then the whole call', async () => {
  const events = await read(await fixture('tools.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"col', '{"color":"red"}']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'call_abc', name: 'report_color', input: { color: 'red' } }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: an error inside the stream becomes a ProviderError of the right kind', async () => {
  const seen = [];
  await assert.rejects((async () => { for await (const e of type.read(new Response(await fixture('error-midstream.sse')), spec())) seen.push(e); })(),
    (e) => e instanceof ProviderError && e.kind === 'server' && /Provider returned error/.test(e.message));
  assert.deepEqual(seen, [{ type: 'text', text: 'Kyoto is' }]);
});

test('a stream that ends early is a network error', async () => {
  await assert.rejects(read(await fixture('cut.sse')), (e) => e instanceof ProviderError && e.kind === 'network');
});

test('classify: OpenAI-style error codes', () => {
  const body = (/** @type {string} */ code) => JSON.stringify({ error: { message: 'x', code } });
  assert.equal(type.classify(400, body('context_length_exceeded')), 'context');
  assert.equal(type.classify(429, body('insufficient_quota')), 'credit');
  assert.equal(type.classify(401, body('invalid_api_key')), 'auth');
  assert.equal(type.classify(404, body('model_not_found')), 'not-found');
  assert.equal(type.classify(400, body('something_else')), null);
  assert.equal(type.classify(500, 'not json'), null);
});

test("list: OpenRouter's model list becomes models with windows, inputs, tools and prices per million tokens", async () => {
  const { url, headers } = type.listRequest({ endpoint: spec().endpoint, key: 'sk-or-test' });
  assert.equal(url, 'https://openrouter.ai/api/v1/models');
  assert.equal(headers.authorization, 'Bearer sk-or-test');
  const models = type.readList(JSON.parse(await fixture('models-openrouter.json')));
  assert.deepEqual(models[0], {
    providerId: 'anthropic/claude-haiku-5.5', name: 'Anthropic: Claude Haiku 5.5', contextWindow: 1000000, maxOutput: 128000, input: ['text', 'image'], tools: true,
    prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, tiers: [{ above: 99999, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 }] },
  });
  assert.deepEqual(models[1].prices, { input: 0, output: 0 });
  assert.deepEqual(type.readList({ data: [{ id: 'gpt-x', object: 'model' }] }), [{ providerId: 'gpt-x' }]);
});
