import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/llm/anthropic/${name}`, import.meta.url), 'utf8');
/** @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-2', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-2', endpoint: 'ep-2', name: 'Haiku', providerId: 'claude-haiku-5-5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: null, prices: null, cacheTtls: ['5m', '1h'], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-ant-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** @param {string} text */
async function read(text) {
  const out = [];
  for await (const e of type.read(new Response(text), spec())) out.push(e);
  return out;
}

test('build: annai’s request as a Messages API request, with browser access and cache markers', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      cacheTtl: '1h',
      tools: [{ name: 'report_color', description: 'Report a color.', input: { type: 'object' } }],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'What color?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', parts: [
          { type: 'reasoning', text: 'A red square.', signature: 'sig', model: 'claude-haiku-5-5' },
          { type: 'reasoning', text: '', redacted: 'opaque', model: 'claude-haiku-5-5' },
          { type: 'reasoning', text: 'not signed', model: 'claude-haiku-5-5' },
          { type: 'tool_call', id: 'toolu_1', name: 'report_color', input: { color: 'red' } },
        ] },
        { role: 'user', parts: [{ type: 'text', text: 'And?' }, { type: 'tool_result', id: 'toolu_1', content: 'noted', isError: false }] },
        { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] },
      ],
    },
  });
  const { url, headers, body } = type.build(s);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(headers, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-test', 'anthropic-dangerous-direct-browser-access': 'true' });
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.stream, true);
  assert.deepEqual(body.system, [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
  assert.deepEqual(body.tools, [{ name: 'report_color', description: 'Report a color.', input_schema: { type: 'object' } }]);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'What color?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    // Thinking parts are never sent back, even to the model that signed it: Claude 5.5 binds it to the conversation (phone-fixes-1 item 1);
    // only a native, the reply as it came, goes back (llm-anthropic-native.test.js).
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'report_color', input: { color: 'red' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'noted' },
      { type: 'text', text: 'And?' },
      { type: 'text', text: 'Hello?', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ] },
  ]);
});

test('build: a 5-minute cache, a beta header, no key, and the request’s own maximum', () => {
  const s = spec({ key: null, tunables: { ...type.tunables, browserAccess: false, beta: 'files-api-2025-04-14' }, request: { system: 'S', cacheTtl: '5m', maxOutput: 100, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  const { headers, body } = type.build(s);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], undefined);
  assert.equal(headers['anthropic-beta'], 'files-api-2025-04-14');
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(type.build(spec({ request: { messages: [] } })).body.system, undefined);
});

test('build: the tail goes last, after the cache marker; documents and a forced tool', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      cacheTtl: '5m',
      toolChoice: 'decide',
      tools: [{ name: 'decide', description: 'Pick one.', input: { type: 'object' } }],
      messages: [{ role: 'user', parts: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBE', name: 'menu.pdf' }, { type: 'text', text: 'Hi' }] }],
      tail: '<now>16:12</now>',
    },
  });
  const { body } = type.build(s);
  assert.deepEqual(body.messages, [{ role: 'user', content: [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' }, title: 'menu.pdf' },
    { type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '<now>16:12</now>' },
  ] }]);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'decide' });
  assert.equal(type.tail, true);
});

test("Anthropic Messages never forces a tool for Shiori's turns: Claude 5.5 and 5.1 models refuse forced tool use, and the others think by default, which refuses it too (review A1)", () => {
  const tools = [{ name: 'speak', description: 'Say.', input: { type: 'object' } }, { name: 'sleep', description: 'End.', input: { type: 'object' } }];
  const { body } = type.build(spec({ request: { tools, toolRequired: true, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } }));
  assert.equal('tool_choice' in body, false);
  assert.equal(type.finish, undefined);
});

test('read: a paused turn stops with "pause", to be sent back and continued', async () => {
  const events = await read(await fixture('pause.sse'));
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'pause' });
});

test('read: text with cache reads and writes of both lifetimes, and the stop reason', async () => {
  assert.deepEqual(await read(await fixture('text.sse')), [
    { type: 'usage', usage: { input: 50, cacheRead: 8000, cacheWrite: 1500, cacheWrite1h: 500, output: 1 } },
    { type: 'text', text: 'Hello from ' },
    { type: 'text', text: 'B.' },
    { type: 'usage', usage: { output: 7 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('read: thinking as words alone, redacted thinking left out, and a tool call streamed in pieces', async () => {
  const events = await read(await fixture('thinking-tools.sse'));
  // Kept for the Trace as words only (phone-fixes-1), so a signature, redacted thinking or an empty block (display "omitted") isn't
  // carried in parts, steps and backups (its review); what goes back within a turn is the native, never stored (keep-reasoning).
  assert.deepEqual(events.filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'A red square. Call the tool.' }]);
  // Thinking is shown as it streams, so a long think never looks like a model that never started (spec §9.6).
  assert.equal(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join(''), 'A red square. Call the tool.');
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"color": "re', '{"color": "red"}']);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'toolu_01A', name: 'report_color', input: { color: 'red' } }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: an error event and a stream that stops early', async () => {
  await assert.rejects(read(await fixture('error.sse')), (e) => e instanceof ProviderError && e.kind === 'overloaded' && e.message === 'Overloaded');
  await assert.rejects(read(await fixture('cut.sse')), (e) => e instanceof ProviderError && e.kind === 'network');
});

test('classify: Anthropic error types', () => {
  const body = (/** @type {string} */ t, msg = 'x') => JSON.stringify({ type: 'error', error: { type: t, message: msg } });
  assert.equal(type.classify(401, body('authentication_error')), 'auth');
  assert.equal(type.classify(403, body('permission_error')), 'auth');
  assert.equal(type.classify(402, body('billing_error')), 'credit');
  assert.equal(type.classify(429, body('rate_limit_error')), 'rate');
  assert.equal(type.classify(529, body('overloaded_error')), 'overloaded');
  assert.equal(type.classify(413, body('request_too_large')), 'context');
  assert.equal(type.classify(404, body('not_found_error')), 'not-found');
  assert.equal(type.classify(500, body('api_error')), 'server');
  assert.equal(type.classify(504, body('timeout_error')), 'server');
  assert.equal(type.classify(400, body('invalid_request_error', 'prompt is too long: 1048577 tokens > 1000000 maximum')), 'context');
  assert.equal(type.classify(400, body('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')), 'credit');
  assert.equal(type.classify(400, body('invalid_request_error', 'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum')), 'image');
  assert.equal(type.classify(400, body('invalid_request_error', 'max_tokens: must be positive')), 'bad-request');
  assert.equal(type.classify(500, 'not json'), null);
});

test('list: the models API', () => {
  const { url, headers } = type.listRequest({ endpoint: spec().endpoint, key: 'sk-ant-test' });
  assert.equal(url, 'https://api.anthropic.com/v1/models');
  assert.equal(headers['x-api-key'], 'sk-ant-test');
  assert.deepEqual(type.readList({ data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 128000 }, { id: 'claude-x' }] }), [
    { providerId: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1000000, maxOutput: 128000 },
    { providerId: 'claude-x' },
  ]);
});

test('read: a server search comes back as provider blocks, citations and a counted search', async () => {
  const events = await read(await fixture('server-search.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'provider').map((e) => e.block.type), ['server_tool_use', 'web_search_tool_result']);
  assert.deepEqual(events.find((e) => e.type === 'provider').block, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'nepenthe hours' } });
  assert.deepEqual(events.filter((e) => e.type === 'citation'), [{ type: 'citation', url: 'https://www.nepenthe.com/', title: 'Nepenthe Big Sur' }]);
  assert.equal(events.filter((e) => e.type === 'tool_input' || e.type === 'tool_call').length, 0);
  assert.deepEqual(events.filter((e) => e.type === 'usage').at(-1), { type: 'usage', usage: { output: 30, serverTools: { web_search_requests: 1 } } });
});

test('build: provider blocks go back unchanged, in place', () => {
  const block = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://x', title: 'X', encrypted_content: 'E' }] };
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hours?' }] },
    { role: 'assistant', parts: [{ type: 'provider', block, model: 'claude-haiku-5-5' }, { type: 'text', text: 'Till 10.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
  ] } });
  assert.deepEqual(type.build(s).body.messages[1].content, [block, { type: 'text', text: 'Till 10.' }]);
});

test('build: a tool call whose arguments were cut short is sent with an empty input, which the API accepts', () => {
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Note this' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'toolu_1', name: 'write', input: '{"path":"/trip/notes/a.md","content":"a very long no' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', content: "Error: the input for write wasn't valid JSON.", isError: true }] },
  ] } });
  const use = type.build(s).body.messages.flatMap((/** @type {any} */ m) => m.content).find((/** @type {any} */ b) => b.type === 'tool_use');
  assert.deepEqual(use.input, {});
});

test('uploads: a multipart request to the files API that expires in 48 hours; files go in messages by id', async () => {
  const s = spec();
  const r = type.uploadRequest({ ...s, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', name: 'annai-abc.webp', expiresInSeconds: 172800 });
  assert.equal(r.url, 'https://api.anthropic.com/v1/files');
  assert.equal(r.headers['x-api-key'], s.key);
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(r.headers['content-type'], undefined);
  assert.equal(r.body.get('expires_in_seconds'), '172800');
  assert.equal(/** @type {File} */ (r.body.get('file')).name, 'annai-abc.webp');
  assert.deepEqual(type.readUpload({ id: 'file_1', expires_at: '2026-11-28T10:00:00Z' }), { id: 'file_1', expiresAt: Date.parse('2026-11-28T10:00:00Z') });
  const body = type.build(spec({ request: { messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', fileId: 'file_1' }] }] } })).body;
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'file', file_id: 'file_1' } });
  assert.equal(type.classify(404, JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'File `file_1` not found.' } })), 'upload');
});
