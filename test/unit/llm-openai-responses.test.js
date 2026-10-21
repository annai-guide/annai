import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/openai-responses/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { applyPatches, callOnce } from '../../src/core/llm/call.js';
import { testModel } from '../../src/core/llm/check.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes } from '../../src/core/scopes.js';
import { readConfig, modelOf as recordModel, providerOf } from '../../src/core/llm/config.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { official } from './provider-kit.js';

/** The endpoint type, registered the way annai's plugin host would. @returns {any} */
function load() {
  /** @type {any} */
  let type = null;
  activate({ providers: { register: (/** @type {any} */ t) => { type = { ...t, pluginId: 'openai-responses' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return type;
}
const type = load();
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/llm/openai-responses/${name}`, import.meta.url), 'utf8');
const MODEL = 'gpt-6-luna';
/** @param {any} [over] */
function endpointOf(over = {}) {
  return { id: 'ep-r', type: 'openai-responses', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1/', headers: {}, tunables: { ...type.tunables }, extraBody: {}, ...over };
}
/** @param {any} [over] */
function modelOf(over = {}) {
  return { id: 'm-r', provider: 'pv-r', ability: 'chat', name: 'Luna', providerId: MODEL, input: ['text', 'image'], tools: true, contextWindow: 922000, maxOutput: 128000, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over };
}
/** A spec for one call. @param {any} [over] */
function spec(over = {}) {
  return { endpoint: endpointOf(), model: modelOf(), key: 'sk-test-r', tunables: { ...type.tunables }, request: { messages: [] }, ...over };
}
/** @param {string} text */
async function read(text) {
  const out = [];
  for await (const e of type.read(new Response(text), spec())) out.push(e);
  return out;
}
/** Reads a stream that fails, keeping what came before. @param {string} text */
async function readFailing(text) {
  /** @type {any[]} */
  const seen = [];
  /** @type {any} */
  let error = null;
  try {
    for await (const e of type.read(new Response(text), spec())) seen.push(e);
  } catch (e) {
    error = e;
  }
  return { seen, error };
}
/** The encrypted reasoning item reasoning.sse ends with, without its status. */
const RS_1 = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: '**Looking at the square**\n\nIt is red.' }, { type: 'summary_text', text: '**Reporting**\n\nCall the tool.' }], encrypted_content: 'gAAAAABencryptedReasoning==' };

test('build: a conversation with photos, a PDF, tool calls and results, this model’s reasoning and phases, with the now block last', () => {
  const s = spec({
    request: {
      system: 'Be brief.',
      maxOutput: 500,
      tools: [{ name: 'report_color', description: 'Report a color.', input: { type: 'object', properties: { color: { type: 'string' } } } }],
      messages: [
        { role: 'user', parts: [
          { type: 'text', text: 'What color?' },
          { type: 'image', mediaType: 'image/png', data: 'AAAA' },
          { type: 'image', mediaType: 'image/webp', data: 'BBBB', fileId: 'file-1' },
          { type: 'document', mediaType: 'application/pdf', data: 'JVBE', name: 'menu.pdf' },
        ] },
        { role: 'assistant', parts: [
          { type: 'reasoning', text: 'Red.', signature: JSON.stringify(RS_1), model: MODEL },
          { type: 'reasoning', text: 'signed elsewhere', signature: 'sig', model: 'claude-haiku-5-5' },
          { type: 'reasoning', text: 'not signed', model: MODEL },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_call', id: 'call_1', name: 'report_color', input: { color: 'red' } },
        ] },
        { role: 'user', parts: [{ type: 'text', text: 'Thanks' }, { type: 'tool_result', id: 'call_1', content: 'noted' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'Glad to help.' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] },
      ],
      tail: '<now>16:12</now>',
    },
  });
  const { url, headers, body } = type.build(s);
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(headers, { 'content-type': 'application/json', authorization: 'Bearer sk-test-r' });
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, true);
  assert.equal(body.store, false, 'nothing is kept on the server: the whole conversation goes each time');
  assert.equal(body.instructions, 'Be brief.');
  assert.equal(body.max_output_tokens, 500);
  // A model without reasoning levels may not reason: it is sent no reasoning field, and isn't asked for encrypted reasoning.
  assert.equal(body.reasoning, undefined);
  assert.equal(body.include, undefined);
  assert.deepEqual(body.tools, [{ type: 'function', name: 'report_color', description: 'Report a color.', parameters: { type: 'object', properties: { color: { type: 'string' } } }, strict: false }]);
  assert.deepEqual(body.input, [
    { role: 'user', content: [
      { type: 'input_text', text: 'What color?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_image', file_id: 'file-1' },
      { type: 'input_file', filename: 'menu.pdf', file_data: 'data:application/pdf;base64,JVBE' },
    ] },
    RS_1,
    { role: 'assistant', content: 'Let me look.', phase: 'commentary' },
    { type: 'function_call', call_id: 'call_1', name: 'report_color', arguments: '{"color":"red"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'noted' },
    { role: 'user', content: [{ type: 'input_text', text: 'Thanks' }] },
    { role: 'assistant', content: 'Glad to help.', phase: 'final_answer' },
    { role: 'user', content: [{ type: 'input_text', text: 'Hello?' }] },
    // Not an eligible message for OpenAI's cache breakpoint, so the cached prefix ends before it (spec §6.3).
    { role: 'developer', content: '<now>16:12</now>' },
  ]);
  assert.equal(type.tail, true);
});

test('build: the tunables: no key, the now block as a user message, no phase, image detail', () => {
  const tunables = { ...type.tunables, nowRole: 'user', phase: false, imageDetail: 'high' };
  const s = spec({ key: null, tunables, endpoint: endpointOf({ headers: { 'OpenAI-Project': 'proj_1' } }), request: { messages: [
    { role: 'user', parts: [{ type: 'image', mediaType: 'image/jpeg', data: 'CCCC' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'A red square.' }] },
  ], tail: 'NOW' } });
  const { headers, body } = type.build(s);
  assert.deepEqual(headers, { 'content-type': 'application/json', 'OpenAI-Project': 'proj_1' });
  assert.equal(body.max_output_tokens, 128000, "the model's maximum output, when the request sets none");
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,CCCC', detail: 'high' }] },
    { role: 'assistant', content: 'A red square.' },
    { role: 'user', content: 'NOW' },
  ]);
});

test('build: a model with reasoning levels asks for summaries and encrypted reasoning, unless the endpoint says not to; the level patch adds the effort', () => {
  const reasoning = { off: { reasoning: { effort: 'none' } }, low: { reasoning: { effort: 'low' } } };
  const s = spec({ model: modelOf({ reasoning }), request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  const { body } = type.build(s);
  assert.deepEqual(body.reasoning, { summary: 'auto' });
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(applyPatches(body, s.endpoint, s.model, 'medium').reasoning, { summary: 'auto', effort: 'low' });
  assert.deepEqual(applyPatches(body, s.endpoint, s.model, 'off').reasoning, { summary: 'auto', effort: 'none' });
  // An organization that isn't verified for summaries switches them off once, for every model (plan choice 6).
  const off = type.build({ ...s, tunables: { ...s.tunables, reasoningSummary: false, encryptedReasoning: false } }).body;
  assert.equal(off.reasoning, undefined);
  assert.equal(off.include, undefined);
});

test('build: a forced tool, logprobs, and never fewer than 16 output tokens', () => {
  const s = spec({ request: {
    toolChoice: 'decide', logprobs: 5, maxOutput: 1,
    tools: [{ name: 'decide', description: 'Pick one.', input: { type: 'object' } }],
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'A or B?' }] }],
  } });
  const { body } = type.build(s);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'decide' });
  assert.equal(body.top_logprobs, 5);
  assert.deepEqual(body.include, ['message.output_text.logprobs']);
  assert.equal(body.max_output_tokens, 16);
});

test('build: a turn of Shiori\'s must call a tool: tool_choice "required" (item 15)', () => {
  const tools = [{ name: 'speak', description: 'Say.', input: { type: 'object' } }, { name: 'sleep', description: 'End.', input: { type: 'object' } }];
  const messages = [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }];
  assert.equal(type.build(spec({ request: { tools, messages, toolRequired: true } })).body.tool_choice, 'required');
  assert.equal('tool_choice' in type.build(spec({ request: { tools, messages } })).body, false);
});

test('build: reasoning goes back only with what followed it in the same reply, and only when it can be replayed', () => {
  const sig = (/** @type {any} */ item) => JSON.stringify(item);
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    // A reply cut short after its reasoning: the API wants what a reasoning item led to right after it.
    { role: 'assistant', parts: [{ type: 'reasoning', text: 'Hm.', signature: sig(RS_1), model: MODEL }] },
    { role: 'user', parts: [{ type: 'text', text: 'Hello?' }] },
    { role: 'assistant', parts: [
      // Neither encrypted nor readable: with store false, OpenAI would look it up by id and fail.
      { type: 'reasoning', text: '', signature: sig({ id: 'rs_2', type: 'reasoning', summary: [] }), model: MODEL },
      { type: 'reasoning', text: 'x', signature: 'not json', model: MODEL },
      // A server that sends its reasoning as text (an open-weight model) gets it back.
      { type: 'reasoning', text: 'Think.', signature: sig({ id: 'rs_3', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Think.' }] }), model: MODEL },
      { type: 'text', text: 'Hi there.' },
      { type: 'reasoning', text: 'After.', signature: sig({ ...RS_1, id: 'rs_4' }), model: MODEL },
    ] },
  ] } });
  assert.deepEqual(type.build(s).body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Hello?' }] },
    { id: 'rs_3', type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Think.' }] },
    { role: 'assistant', content: 'Hi there.', phase: 'final_answer' },
  ]);
});

test('build: words with a call or this model’s search after them in the reply are commentary; the rest is the final answer', () => {
  const ws = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'nepenthe hours' } };
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hours?' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Let me check their hours.' }, { type: 'provider', block: ws, model: MODEL }, { type: 'text', text: 'Open till 10.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'And the road?' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Asking.' }, { type: 'tool_call', id: 'call_1', name: 'route', input: {} }, { type: 'text', text: 'Then I will say.' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'Elsewhere.' }, { type: 'provider', block: { type: 'server_tool_use' }, model: 'claude-x' }] },
  ] } });
  const phases = type.build(s).body.input.filter((/** @type {any} */ x) => x.role === 'assistant').map((/** @type {any} */ x) => [x.content, x.phase]);
  assert.deepEqual(phases, [
    ['Let me check their hours.', 'commentary'], ['Open till 10.', 'final_answer'],
    ['Asking.', 'commentary'], ['Then I will say.', 'final_answer'],
    ['Elsewhere.', 'final_answer'],
  ]);
});

test('build: a search the model made goes back unchanged, in place, and only to that model; a cut-short call gets empty arguments', () => {
  const ws = { id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'nepenthe hours' } };
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Hours?' }] },
    { role: 'assistant', parts: [{ type: 'provider', block: ws, model: MODEL }, { type: 'provider', block: { type: 'server_tool_use' }, model: 'claude-x' }, { type: 'text', text: 'Till 10.' }] },
    { role: 'user', parts: [{ type: 'text', text: 'Note it' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_9', name: 'write', input: '{"path":"/trip/notes/a.md","content":"a long no' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'call_9', content: "Error: the input for write wasn't valid JSON.", isError: true }] },
  ] } });
  const input = type.build(s).body.input;
  assert.deepEqual(input[1], ws);
  assert.deepEqual(input[2], { role: 'assistant', content: 'Till 10.', phase: 'final_answer' });
  assert.equal(input.length, 6);
  assert.deepEqual(input[4], { type: 'function_call', call_id: 'call_9', name: 'write', arguments: '{}' });
  assert.deepEqual(input[5], { type: 'function_call_output', call_id: 'call_9', output: "Error: the input for write wasn't valid JSON." });
});

test('read: text as it streams, usage with cache reads, and the stop reason', async () => {
  assert.deepEqual(await read(await fixture('text.sse')), [
    { type: 'text', text: 'こんにちは! ' },
    { type: 'text', text: 'Welcome to Kyoto.' },
    { type: 'usage', usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 40, reasoning: 0 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('read: a tool call whose arguments arrive in pieces', async () => {
  const events = await read(await fixture('tools.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => [e.id, e.name, e.partial]), [
    ['call_abc', 'report_color', ''], ['call_abc', 'report_color', '{"col'], ['call_abc', 'report_color', '{"color":"re'], ['call_abc', 'report_color', '{"color":"red"}'],
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'call_abc', name: 'report_color', input: { color: 'red' } }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: a few words, then two tool calls, each with its own arguments', async () => {
  const events = await read(await fixture('two-tools.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: 'Checking both.' }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_input').at(-1), { type: 'tool_input', id: 'call_b', name: 'route', partial: '{"to":"Carmel"}' });
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [
    { type: 'tool_call', id: 'call_a', name: 'weather', input: { place: 'Big Sur' } },
    { type: 'tool_call', id: 'call_b', name: 'route', input: { to: 'Carmel' } },
  ]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('read: a reasoning summary as it streams and as a whole, kept with its encrypted item; usage with cache reads, writes and reasoning', async () => {
  const events = await read(await fixture('reasoning.sse'));
  // Shown as it streams, so a model that is thinking is not a model that never started (spec §9.6).
  assert.deepEqual(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text), ['**Looking at the square**\n\n', 'It is red.', '**Reporting**\n\nCall the tool.']);
  const reasoning = events.filter((e) => e.type === 'reasoning');
  assert.equal(reasoning.length, 1);
  assert.equal(reasoning[0].text, '**Looking at the square**\n\nIt is red.\n\n**Reporting**\n\nCall the tool.');
  assert.deepEqual(JSON.parse(reasoning[0].signature), RS_1, 'the item as it came, without its status, to send back');
  assert.ok(events.indexOf(reasoning[0]) < events.findIndex((e) => e.type === 'tool_call'), 'the reasoning comes before the call it led to');
  assert.deepEqual(events.find((e) => e.type === 'usage'), { type: 'usage', usage: { input: 500, cacheRead: 3000, cacheWrite: 1500, output: 220, reasoning: 180 } });
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
});

test('a reply read and kept goes back as it came: the reasoning item, the call, then its result', async () => {
  const res = new Response(await fixture('reasoning.sse'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const reply = await callOnce({ type, endpoint: endpointOf(), model: modelOf(), key: 'sk-test-r', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Color?' }] }] }, fetch: async () => res });
  assert.deepEqual(reply.parts.map((p) => p.type), ['reasoning', 'tool_call']);
  assert.equal(/** @type {any} */ (reply.parts[0]).model, MODEL);
  const next = type.build(spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Color?' }] },
    { role: 'assistant', parts: reply.parts },
    { role: 'user', parts: [{ type: 'tool_result', id: 'call_r', content: 'noted' }] },
  ] } })).body;
  assert.deepEqual(next.input.slice(1), [
    RS_1,
    { type: 'function_call', call_id: 'call_r', name: 'report_color', arguments: '{"color":"red"}' },
    { type: 'function_call_output', call_id: 'call_r', output: 'noted' },
  ]);
});

test('read: a stream cut short is a network error, after what it said', async () => {
  const { seen, error } = await readFailing(await fixture('cut.sse'));
  assert.ok(error instanceof ProviderError && error.kind === 'network');
  assert.deepEqual(seen, [{ type: 'text', text: 'Kyoto is' }]);
});

test('read: a reply that ran out of output tokens stops with "length"', async () => {
  const events = await read(await fixture('incomplete.sse'));
  assert.deepEqual(events, [
    { type: 'text', text: 'The best stops are' },
    { type: 'usage', usage: { input: 400, cacheRead: 0, cacheWrite: 0, output: 16, reasoning: 0 } },
    { type: 'stop', reason: 'length' },
  ]);
});

test('read: a failed response and an error event become ProviderErrors of the right kind', async () => {
  const failed = await readFailing(await fixture('failed.sse'));
  assert.ok(failed.error instanceof ProviderError && failed.error.kind === 'server');
  assert.equal(failed.error.message, 'The model failed to generate a response.');
  assert.deepEqual(failed.seen, [{ type: 'text', text: 'Kyoto is' }]);
  const rate = await readFailing(await fixture('error.sse'));
  assert.ok(rate.error instanceof ProviderError && rate.error.kind === 'rate');
  assert.match(rate.error.message, /Rate limit reached/);
});

test('read: an error event with a code annai doesn’t know is a bad request when the code says the request was wrong, else a server error', async () => {
  const error = (/** @type {string} */ code) => `event: error\ndata: ${JSON.stringify({ type: 'error', code, message: `x ${code}`, param: null })}\n\n`;
  const kinds = [];
  for (const code of ['invalid_value', 'unsupported_parameter', 'invalid_image_format', 'something_new']) kinds.push((await readFailing(error(code))).error.kind);
  assert.deepEqual(kinds, ['bad-request', 'bad-request', 'image', 'server']);
  const failed = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { code: 'unsupported_value', message: 'No.' } } })}\n\n`;
  assert.equal((await readFailing(failed)).error.kind, 'bad-request');
});

test('read: the stop reason comes from the event the response ended with, even without a status', async () => {
  const incomplete = `event: response.incomplete\ndata: ${JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`;
  assert.deepEqual((await read(incomplete)).at(-1), { type: 'stop', reason: 'length' });
  const other = `event: response.incomplete\ndata: ${JSON.stringify({ type: 'response.incomplete', response: {} })}\n\n`;
  assert.deepEqual((await read(other)).at(-1), { type: 'stop', reason: 'other' });
});

test('read: a web search comes back as provider items, one counted search, and a citation', async () => {
  const events = await read(await fixture('search.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'provider').map((e) => [e.block.id, e.block.action.type]), [['ws_1', 'search'], ['ws_2', 'open_page']]);
  assert.deepEqual(events.filter((e) => e.type === 'citation'), [{ type: 'citation', url: 'https://www.nepenthe.com/', title: 'Nepenthe Big Sur' }]);
  // Only searches are charged, not the pages it opened (plan, fact 11).
  assert.deepEqual(events.find((e) => e.type === 'usage')?.usage.serverTools, { web_search_requests: 1 });
  assert.equal(events.filter((e) => e.type === 'tool_input' || e.type === 'tool_call').length, 0);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'end' });
});

test('read: a refusal is the answer, in words, and says so', async () => {
  const events = await read(await fixture('refusal.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: "I can't help with that." }]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'refusal' });
});

test('read: the first token’s alternatives, once', async () => {
  const events = await read(await fixture('logprobs.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'logprobs'), [{ type: 'logprobs', top: [{ token: 'B', logprob: -0.05 }, { token: 'A', logprob: -3.2 }] }]);
});

test('classify: OpenAI’s error codes', () => {
  const body = (/** @type {string | null} */ code, message = 'x', t = 'invalid_request_error') => JSON.stringify({ error: { message, type: t, param: null, code } });
  assert.equal(type.classify(401, body('invalid_api_key', 'Incorrect API key provided.')), 'auth');
  for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
    assert.equal(type.classify(429, body(code)), 'credit', code);
  }
  assert.equal(type.classify(429, body('rate_limit_exceeded')), 'rate');
  assert.equal(type.classify(429, body('slow_down', 'x', 'rate_limit_error')), 'rate');
  assert.equal(type.classify(503, body('server_is_overloaded', 'x', 'service_unavailable_error')), 'overloaded');
  assert.equal(type.classify(400, body('context_length_exceeded', 'Your input exceeds the context window of this model.')), 'context');
  assert.equal(type.classify(404, body('model_not_found')), 'not-found');
  assert.equal(type.classify(400, body('invalid_image_format')), 'image');
  assert.equal(type.classify(400, body('image_too_large')), 'image');
  // An uploaded photo that expired or is unknown: upload it again (spec §9.9).
  assert.equal(type.classify(400, body('image_file_not_found')), 'upload');
  assert.equal(type.classify(404, body(null, "No such File object: 'file-abc'")), 'upload');
  assert.equal(type.classify(400, body(null, 'The file file-abc has expired.')), 'upload');
  // Blocked by policy: not a bad key, and not worth the same request again.
  assert.equal(type.classify(403, body('misalignment_policy_violation')), 'bad-request');
  assert.equal(type.classify(400, body('invalid_prompt')), 'bad-request');
  assert.equal(type.classify(400, body('something_else')), null);
  assert.equal(type.classify(500, 'not json'), null);
});

test('an HTTP 401, 429 and 400 context error each fail the call with their kind', async () => {
  const replies = [
    new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-test-r.', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401 }),
    new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-6-luna.', type: 'requests', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after-ms': '2000' } }),
    new Response(JSON.stringify({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }), { status: 429 }),
    new Response(JSON.stringify({ error: { message: 'Your input exceeds the context window of this model.', type: 'invalid_request_error', param: 'input', code: 'context_length_exceeded' } }), { status: 400 }),
  ];
  const kinds = [];
  for (const res of replies) {
    try {
      await callOnce({ type, endpoint: endpointOf(), model: modelOf(), key: 'sk-test-r', request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] }, fetch: async () => res });
    } catch (e) {
      kinds.push([/** @type {any} */ (e).kind, /** @type {any} */ (e).retryAfter]);
    }
  }
  assert.deepEqual(kinds, [['auth', undefined], ['rate', 2000], ['credit', undefined], ['context', undefined]]);
});

test('list: the models API, ids only', async () => {
  const { url, headers } = type.listRequest({ endpoint: endpointOf(), key: 'sk-test-r' });
  assert.equal(url, 'https://api.openai.com/v1/models');
  assert.equal(headers.authorization, 'Bearer sk-test-r');
  assert.deepEqual(type.readList(JSON.parse(await fixture('models.json'))), [{ providerId: 'gpt-6-luna' }, { providerId: 'gpt-6.1-sol' }, { providerId: 'text-embedding-3-small' }]);
  assert.deepEqual(type.readList({}), []);
});

test('uploads: a photo to the files API for vision, expiring as asked; the reply’s expiry is in seconds', () => {
  const s = spec();
  const r = type.uploadRequest({ ...s, bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', name: 'annai-abc.webp', expiresInSeconds: 172800 });
  assert.equal(r.url, 'https://api.openai.com/v1/files');
  assert.equal(r.headers.authorization, 'Bearer sk-test-r');
  assert.equal(r.headers['content-type'], undefined, 'FormData sets its own, with the boundary');
  assert.equal(r.body.get('purpose'), 'vision');
  assert.equal(r.body.get('expires_after[anchor]'), 'created_at');
  assert.equal(r.body.get('expires_after[seconds]'), '172800');
  assert.equal(/** @type {File} */ (r.body.get('file')).name, 'annai-abc.webp');
  assert.deepEqual(type.readUpload({ id: 'file-1', object: 'file', expires_at: 1792483200 }), { id: 'file-1', expiresAt: 1792483200000 });
  assert.deepEqual(type.readUpload({ id: 'file-2', expires_at: null }), { id: 'file-2' });
  assert.equal(type.tunables.uploads, true, 'on by default, with its switch in Settings (spec §4.8)');
});

test('the Test button with a Responses endpoint: access, the key, the tool and the photo, and the upload (spec §9.8)', async () => {
  /** @type {{ url: string, body: any }[]} */
  const asked = [];
  const ok = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"OK"}\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":20,"output_tokens":2}}}\n\n';
  const color = await fixture('tools.sse');
  const replies = [ok, color];
  const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
    asked.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    if (url.endsWith('/files')) return new Response(JSON.stringify({ id: 'file-test', object: 'file', expires_at: 1792314000 }), { status: 200 });
    return new Response(/** @type {string} */ (replies.shift()), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const r = await testModel({ type, endpoint: endpointOf(), model: modelOf(), key: 'sk-test-r', fetch: get });
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true], ['images', true], ['upload', true]]);
  assert.equal(r.ok, true);
  const second = asked[1].body;
  assert.equal(second.input[0].content[0].type, 'input_image');
  assert.match(second.input[0].content[0].image_url, /^data:image\/png;base64,iVBOR/);
  assert.deepEqual(second.tools.map((/** @type {any} */ t) => t.name), ['report_color']);
  assert.equal(asked[2].url, 'https://api.openai.com/v1/files');
  assert.equal(asked[2].body.get('expires_after[seconds]'), '3600');
});

test('adding OpenAI saves its Responses models, its transcription and voices, and fills the empty roles', async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const id = await addProvider({ ws, store }, await official('provider-openai'), { key: 'sk-test-r' });
  const cfg = await readConfig(ws);
  assert.equal(providerOf(cfg.providers[id]).abilities.chat.type, 'openai-responses');
  const name = (/** @type {string} */ m) => recordModel(cfg.models[m]).name;
  assert.deepEqual(Object.values(cfg.models).filter((m) => m.ability === 'chat').map((m) => name(m.id)).sort(), ['GPT-6 Astra', 'GPT-6 Luna', 'GPT-6.1 Sol']);
  assert.deepEqual([cfg.roles.main.models.map(name), cfg.roles.utility.models.map(name), cfg.roles.decide.models.map(name)], [['GPT-6.1 Sol'], ['GPT-6 Luna'], ['GPT-6 Luna']]);
});

// Item 24 (2026-10-18): a server that never streams answers `stream: true` with the whole response object, as
// application/json. It is read as the same events a stream gives.
/** @param {string} text @param {number} [status] */
const whole = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json' } });
/** @param {Response} res */
async function readWhole(res) {
  const out = [];
  for await (const e of type.read(res, spec())) out.push(e);
  return out;
}

test('a whole JSON response where a stream was asked for: reasoning with its item as the signature, the words, logprobs, a source, usage and the stop reason', async () => {
  const events = await readWhole(whole(await fixture('whole-text.json')));
  const signature = JSON.stringify({ id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'The user asks where Kyoto is.' }], encrypted_content: 'gAAAA-sealed' });
  assert.deepEqual(events, [
    { type: 'reasoning_delta', text: 'The user asks where Kyoto is.' },
    { type: 'reasoning', text: 'The user asks where Kyoto is.', signature },
    { type: 'logprobs', top: [{ token: 'Ky', logprob: -0.01 }, { token: 'It', logprob: -4.2 }] },
    { type: 'text', text: 'Kyoto is in Japan.' },
    { type: 'citation', url: 'https://en.wikipedia.org/wiki/Kyoto', title: 'Kyoto' },
    { type: 'usage', usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 30, reasoning: 12 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('a whole JSON response with a tool call: the words, then the call whole, and the stop reason "tool"', async () => {
  const events = await readWhole(whole(await fixture('whole-tools.json')));
  assert.deepEqual(events.filter((e) => e.type === 'text' || e.type === 'tool_call'), [
    { type: 'text', text: 'Let me note that.' },
    { type: 'tool_call', id: 'call_abc', name: 'report_color', input: { color: 'red' } },
  ]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
  const cut = await readWhole(whole(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Kyo' }] }] })));
  assert.deepEqual(cut.at(-1), { type: 'stop', reason: 'length' });
});

test('a whole JSON response that failed, or an error in its place, is the error it says', async () => {
  await assert.rejects(readWhole(whole(await fixture('whole-failed.json'))), (e) => e instanceof ProviderError && e.kind === 'rate' && /Rate limit/.test(e.message));
  await assert.rejects(readWhole(whole(await fixture('whole-error.json'))), (e) => e instanceof ProviderError && e.kind === 'auth' && /Incorrect API key/.test(e.message));
  await assert.rejects(readWhole(whole('not json')), (e) => e instanceof ProviderError && e.kind === 'server' && /can't read/.test(e.message));
  await assert.rejects(readWhole(whole('{"id":"resp"}')), (e) => e instanceof ProviderError && e.kind === 'server' && /no answer/.test(e.message));
});

test("a whole response whose connection drops part way is a dropped connection, tried again elsewhere, and never counted against the plugin (fix pass 1)", async () => {
  const dropping = () => new Response(new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"status":"completed","output":[{"type":"mess'));
      c.error(new TypeError('network error'));
    },
  }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(readWhole(dropping()), (e) => e instanceof ProviderError && e.kind === 'network' && e.message === 'The connection dropped.');
  const s = spec({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  let failed = 0;
  await assert.rejects(callOnce({ type, endpoint: s.endpoint, model: s.model, key: s.key, request: s.request, fetch: async () => dropping(), registry: /** @type {any} */ ({ fail: () => { failed++; } }) }),
    (e) => e instanceof ProviderError && e.kind === 'network');
  assert.equal(failed, 0);
});

test('only application/json is a whole response: NDJSON, stream+json and problem+json are read as streams, and so is a stream sent as application/json (fix pass 3)', async () => {
  const sseText = await fixture('tools.sse');
  const streamed = [];
  for await (const e of type.read(new Response(sseText), spec())) streamed.push(e);
  for (const kind of ['application/x-ndjson', 'application/stream+json', 'application/problem+json', 'application/json']) {
    const events = [];
    for await (const e of type.read(new Response(sseText, { headers: { 'content-type': kind } }), spec())) events.push(e);
    assert.deepEqual(events, streamed, kind);
  }
});
