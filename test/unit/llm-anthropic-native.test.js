import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activate } from '../../plugins-official/anthropic-messages/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

// Claude's reply as it came, read and sent back within a turn (the keep-reasoning design §4, §7, §8).

/** @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = t; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
/** @param {any} [over] */
function spec(over = {}) {
  const endpoint = { id: 'ep-2', type: 'anthropic-messages', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', headers: {}, tunables: { ...type.tunables }, extraBody: {} };
  const model = { id: 'm-2', endpoint: 'ep-2', name: 'Sonnet', providerId: 'claude-sonnet-5-5', input: ['text', 'image'], tools: true, contextWindow: 1000000, maxOutput: null, prices: null, cacheTtls: ['5m', '1h'], reasoning: {}, tunables: {}, extraBody: {} };
  return { endpoint, model, key: 'sk-ant-test', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** A stream of these events, as SSE. @param {any[]} events */
const stream = (events) => events.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join('');
/** @param {any[]} events */
async function read(events) {
  const out = [];
  for await (const e of type.read(new Response(stream(events)), spec())) out.push(e);
  return out;
}
/** A reply's events: each block of content streamed as the API streams it, then the stop. @param {any[]} content @param {string} stop */
function reply(content, stop) {
  /** @type {any[]} */
  const ev = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }];
  content.forEach((b, index) => {
    if (b.type === 'thinking') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (b.thinking) ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const c of b.citations ?? []) ev.push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation: c } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      ev.push({ type: 'content_block_start', index, content_block: { type: b.type, id: b.id, name: b.name, input: {} } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: typeof b.input === 'string' ? b.input : JSON.stringify(b.input) } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: b });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } });
  ev.push({ type: 'message_stop' });
  return ev;
}
const cite = { type: 'web_search_result_location', url: 'https://www.nepenthe.com/', title: 'Nepenthe', encrypted_index: 'Eo8B', cited_text: 'Open daily' };
const CONTENT = [
  { type: 'thinking', thinking: '', signature: 'sig-1' },
  { type: 'redacted_thinking', data: 'EmwKAhgB' },
  { type: 'text', text: 'Open daily ', citations: [cite] },
  { type: 'text', text: 'till 10.', citations: [cite] },
  { type: 'thinking', thinking: 'Now the plan.', signature: 'sig-2' },
  { type: 'tool_use', id: 'toolu_1', name: 'list', input: { path: '/trip/' } },
];

test("read: a finished reply's content, as Claude sent it, once at its end: empty thinking, redacted thinking, cited text blocks and the parsed tool input", async () => {
  for (const [stop, reason] of [['tool_use', 'tool'], ['end_turn', 'end'], ['stop_sequence', 'end'], ['pause_turn', 'pause']]) {
    const events = await read(reply(CONTENT, stop));
    const natives = events.filter((e) => e.type === 'native');
    assert.equal(natives.length, 1, stop);
    assert.deepEqual(natives[0].content, CONTENT);
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['native', 'stop']);
    assert.equal(events.at(-1).reason, reason);
  }
  // The words still go to the Trace as before.
  assert.deepEqual((await read(reply(CONTENT, 'tool_use'))).filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'Now the plan.' }]);
});

test('read: a paused turn with a server search keeps its blocks as they came', async () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'sig-p' },
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'nepenthe hours' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://www.nepenthe.com/', title: 'Nepenthe', encrypted_content: 'EqgfCio' }] },
  ];
  const events = await read(reply(content, 'pause_turn'));
  assert.deepEqual(events.find((e) => e.type === 'native')?.content, content);
});

test("read: no native for a reply cut at max_tokens, a refusal, a tool input that didn't parse, an unknown delta, or no thinking at all", async () => {
  for (const [content, stop] of /** @type {[any[], string][]} */ ([[CONTENT, 'max_tokens'], [CONTENT, 'refusal'], [[CONTENT[0], { ...CONTENT[5], input: '{"path": "/tr' }], 'tool_use'], [CONTENT.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'), 'end_turn']])) {
    assert.equal((await read(reply(content, stop))).some((e) => e.type === 'native'), false, `${stop}: ${JSON.stringify(content).slice(0, 60)}`);
  }
  const odd = reply(CONTENT, 'end_turn');
  odd.splice(3, 0, { type: 'content_block_delta', index: 0, delta: { type: 'brand_new_delta', x: 1 } });
  assert.equal((await read(odd)).some((e) => e.type === 'native'), false, 'a delta it does not know: it might not rebuild the block');
});

const native = (/** @type {any[]} */ content, covers = 2) => ({ type: 'native', endpoint: 'e', content, covers, prefix: 'p' });

test("build: a native's content in place of the parts it covers; two in one message (a paused turn); a kept now block as the tail was", () => {
  const paused = [{ type: 'thinking', thinking: '', signature: 'sig-p' }, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { q: 'x' } }];
  const s = spec({ request: { system: 'S', cacheTtl: '1h', tail: '<now>3</now>', messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hours?' }, { type: 'text', text: '<now>1</now>', now: true }] },
    { role: 'assistant', parts: [native(paused, 1), { type: 'provider', block: paused[1], model: 'claude-sonnet-5-5' }, native(CONTENT, 3), { type: 'reasoning', text: 'Now the plan.' }, { type: 'text', text: 'Open daily till 10.' }, { type: 'tool_call', id: 'toolu_1', name: 'list', input: { path: '/trip/' } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', content: 'a.md' }, { type: 'text', text: '<now>2</now>', now: true }] },
    { role: 'assistant', parts: [native([{ type: 'thinking', thinking: '', signature: 'sig-3' }, { type: 'text', text: 'Done.' }], 1), { type: 'text', text: 'Done.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Thanks' }] },
  ] } });
  const { body } = type.build(s);
  const ttl = { type: 'ephemeral', ttl: '1h' };
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Hours?' }, { type: 'text', text: '<now>1</now>' }] },
    { role: 'assistant', content: [...paused, ...CONTENT] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.md' }, { type: 'text', text: '<now>2</now>' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-3' }, { type: 'text', text: 'Done.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Thanks', cache_control: ttl }, { type: 'text', text: '<now>3</now>' }] },
  ]);
  assert.equal(JSON.stringify(body).split('cache_control').length - 1, 2, 'the system and the end');
});

test("build: cacheAt marks that message's last block: three marks with the system and the end", () => {
  const s = spec({ request: { system: 'S', cacheTtl: '5m', cacheAt: 2, messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Earlier' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Yes.' }] },
    { role: 'user', parts: [{ type: 'text', text: '[annai] a note' }, { type: 'tool_result', id: 't1', content: 'r' }] },
    { role: 'assistant', parts: [native([{ type: 'thinking', thinking: '', signature: 's' }], 1), { type: 'text', text: 'Ok.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Next' }] },
  ] } });
  const { body } = type.build(s);
  assert.deepEqual(body.messages[2].content, [
    { type: 'tool_result', tool_use_id: 't1', content: 'r' },
    { type: 'text', text: '[annai] a note', cache_control: { type: 'ephemeral' } },
  ]);
  assert.equal(JSON.stringify(body).split('cache_control').length - 1, 3);
  // As the earlier request marked it: its end, before its tail.
  const was = type.build(spec({ request: { system: 'S', cacheTtl: '5m', tail: '<now>1</now>', messages: s.request.messages.slice(0, 3).map((/** @type {any} */ m) => ({ ...m, parts: m.parts.filter((/** @type {any} */ p) => !p.now) })) } })).body;
  assert.deepEqual(was.messages[2].content.slice(0, -1), body.messages[2].content);
});

test("classify: Claude refusing the thinking sent back is no kind of its own: callOnce reads a bad request that sent natives as that, whatever the words", () => {
  const body = (/** @type {string} */ msg) => JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } });
  assert.equal(type.classify(400, body('messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.')), 'bad-request');
  assert.equal(type.classify(400, body('messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.')), 'bad-request');
  assert.equal(type.classify(400, body('max_tokens: must be positive')), 'bad-request');
  assert.equal(type.classify(400, body('prompt is too long: 300000 tokens > 200000 maximum')), 'context', 'a size error goes its own way');
});
