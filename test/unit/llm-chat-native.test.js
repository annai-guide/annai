import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

// Claude through OpenRouter: its reasoning_details kept as they came and sent back within a turn, and Anthropic's cache markers
// (the keep-reasoning design §9).

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
/** @param {any} [over] @param {Record<string, any>} [tunables] */
function spec(over = {}, tunables = {}) {
  const endpoint = { id: 'ep-1', type: 'chat-completions', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-1', endpoint: 'ep-1', name: 'Sonnet', providerId: 'anthropic/claude-sonnet-5.5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: 8000, prices: null, cacheTtls: ['5m', '1h'], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-or-test', tunables: { ...type.tunables, reasoningField: 'reasoning', ...tunables }, request: { messages: [] }, ...over };
}
/** A stream of these chunks. @param {any[]} chunks */
const stream = (chunks) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
/** @param {any[]} chunks @param {any} [s] */
async function read(chunks, s = spec()) {
  const out = [];
  for await (const e of type.read(new Response(stream(chunks)), s)) out.push(e);
  return out;
}
const F = 'anthropic-claude-v1';
/** Claude's thinking as OpenRouter streams it: summarized words in pieces, then the signature; a tool call; the finish. @param {string} finish @param {any[]} [extra] */
const chunks = (finish, extra = []) => [
  { choices: [{ delta: { reasoning: 'Look ', reasoning_details: [{ type: 'reasoning.text', text: 'Look ', format: F, index: 0 }] } }] },
  { choices: [{ delta: { reasoning: 'first.', reasoning_details: [{ type: 'reasoning.text', text: 'first.', format: F, index: 0 }] } }] },
  { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', signature: 'sig-1', format: F, index: 0 }] } }] },
  ...extra,
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'list', arguments: '{"path":"/trip/"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];

test("read: reasoning_details pieces of one index are joined, kept whole and yielded once as a native at a finished reply's end; the words still go to the Trace", async () => {
  const events = await read(chunks('tool_calls', [{ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENC', format: F, index: 1, id: 'r1' }] } }] }]));
  const natives = events.filter((e) => e.type === 'native');
  assert.equal(natives.length, 1);
  assert.deepEqual(natives[0].content, [
    { type: 'reasoning.text', text: 'Look first.', format: F, index: 0, signature: 'sig-1' },
    { type: 'reasoning.encrypted', data: 'ENC', format: F, index: 1, id: 'r1' },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'Look first.' }]);
  assert.equal((await read(chunks('stop'))).filter((e) => e.type === 'native').length, 1, 'stop keeps one too');
});

test('read: no native for a reply cut at its length, another format, nothing signed, or a [REDACTED] piece', async () => {
  assert.equal((await read(chunks('length'))).some((e) => e.type === 'native'), false);
  const other = chunks('stop').map((c) => JSON.parse(JSON.stringify(c).replaceAll(F, 'openai-responses-v1')));
  assert.equal((await read(other)).some((e) => e.type === 'native'), false, 'GPT and Gemini send what they always sent');
  const unsigned = chunks('stop').filter((c) => !JSON.stringify(c).includes('sig-1'));
  assert.equal((await read(unsigned)).some((e) => e.type === 'native'), false);
  const redacted = chunks('stop', [{ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: '[REDACTED]', format: F, index: 1 }] } }] }]);
  assert.equal((await read(redacted)).some((e) => e.type === 'native'), false);
});

const details = [{ type: 'reasoning.text', text: 'Look first.', signature: 'sig-1', format: F, index: 0 }];
const native = { type: 'native', endpoint: 'e', content: details, covers: 2, prefix: 'p' };

test("build: a native's details go back on its reply's assistant message; a kept now block as addTail wrote it", () => {
  const s = spec({ request: { system: 'S', tail: '<now>3</now>', messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'there' }, { type: 'text', text: '<now>1</now>', now: true }] },
    { role: 'assistant', parts: [native, { type: 'reasoning', text: 'Look first.' }, { type: 'tool_call', id: 'toolu_1', name: 'list', input: { path: '/trip/' } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', content: 'a.md' }, { type: 'text', text: '<now>2</now>', now: true }] },
    { role: 'assistant', parts: [{ ...native, content: [{ ...details[0], signature: 'sig-2' }], covers: 1 }, { type: 'text', text: 'Done.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
  ] } });
  const { body } = type.build(s);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Hi\nthere\n\n<now>1</now>' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'list', arguments: '{"path":"/trip/"}' } }], reasoning_details: details },
    { role: 'tool', tool_call_id: 'toolu_1', content: 'a.md' },
    { role: 'user', content: '<now>2</now>' },
    { role: 'assistant', content: 'Done.', reasoning_details: [{ ...details[0], signature: 'sig-2' }] },
    { role: 'user', content: 'Thanks\n\n<now>3</now>' },
  ]);
  // As each earlier request ended: its tail, by addTail.
  const was = type.build(spec({ request: { system: 'S', tail: '<now>1</now>', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'there' }] }] } })).body;
  assert.deepEqual(was.messages[1], body.messages[1]);
});

test("build with cacheMarkers: every content an array of blocks, marks on the system, the end and cacheAt's message with the hour's ttl; another model as before", () => {
  const ttl = { type: 'ephemeral', ttl: '1h' };
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Earlier' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Yes.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }, { type: 'text', text: '<now>1</now>', now: true }] },
    { role: 'assistant', parts: [native, { type: 'reasoning', text: 'Look first.' }, { type: 'tool_call', id: 'toolu_1', name: 'list', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', content: 'a.md' }] },
  ];
  const s = spec({ request: { system: 'S', cacheTtl: '1h', cacheAt: 2, tail: '<now>2</now>', messages } }, { cacheMarkers: ['anthropic/'] });
  const { body } = type.build(s);
  assert.deepEqual(body.messages, [
    { role: 'system', content: [{ type: 'text', text: 'S', cache_control: ttl }] },
    { role: 'user', content: [{ type: 'text', text: 'Earlier' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Yes.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: ttl }, { type: 'text', text: '<now>1</now>' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'list', arguments: '{}' } }], reasoning_details: details },
    { role: 'tool', tool_call_id: 'toolu_1', content: [{ type: 'text', text: 'a.md', cache_control: ttl }] },
    { role: 'user', content: [{ type: 'text', text: '<now>2</now>' }] },
  ]);
  // The earlier request marked its end where cacheAt's mark now is, and wrote its tail the same way.
  const was = type.build(spec({ request: { system: 'S', cacheTtl: '1h', tail: '<now>1</now>', messages: messages.slice(0, 3).map((m) => ({ ...m, parts: m.parts.filter((/** @type {any} */ p) => !p.now) })) } }, { cacheMarkers: ['anthropic/'] })).body;
  assert.deepEqual(was.messages[3], body.messages[3]);
  // Five minutes: no ttl.
  assert.deepEqual(type.build(spec({ request: { ...s.request, cacheTtl: '5m' } }, { cacheMarkers: ['anthropic/'] })).body.messages[0].content[0].cache_control, { type: 'ephemeral' });
  // A model outside the list: strings and no marks, exactly as before.
  const plain = type.build(spec({ request: s.request, model: { ...s.model, providerId: 'openai/gpt-6' } }, { cacheMarkers: ['anthropic/'] })).body;
  assert.ok(!JSON.stringify(plain).includes('cache_control'));
  assert.equal(plain.messages[0].content, 'S');
});

test("classify: OpenRouter's error carrying Anthropic's words about the thinking sent back is 'reasoning'", () => {
  const raw = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block.' } });
  assert.equal(type.classify(400, JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { raw, provider_name: 'Anthropic' } } })), 'reasoning');
  assert.equal(type.classify(400, JSON.stringify({ error: { code: 400, message: 'messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified.' } })), 'reasoning');
  assert.equal(type.classify(400, JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { raw: 'max_tokens: too big' } } })), null);
});

test("OpenRouter's description marks Claude's requests for the cache, and its Claude models may keep the cache an hour", async () => {
  const { readFile } = await import('node:fs/promises');
  const desc = JSON.parse(await readFile(new URL('../../plugins-official/provider-openrouter/annai-plugin.json', import.meta.url), 'utf8'));
  const chat = desc.provider.abilities.chat;
  assert.deepEqual(chat.tunables.cacheMarkers, ['anthropic/']);
  for (const m of chat.models.filter((/** @type {any} */ x) => x.providerId.startsWith('anthropic/'))) assert.deepEqual(m.cacheTtls, ['5m', '1h'], m.providerId);
  assert.deepEqual(type.tunables.cacheMarkers, [], 'off for any other server');
});
