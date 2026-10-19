import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/chat-completions/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';

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

test('build: enforceToolCall (off unless a provider turns it on) sends a forced tool as tool_choice "required" when it is the one tool offered; a request offering several tools, or forcing none, is unchanged (the user, 2026-10-19)', () => {
  assert.equal(type.tunables.enforceToolCall, false);
  const one = [{ name: 'decide', description: 'Pick one.', input: { type: 'object' } }];
  const two = [...one, { name: 'look', description: 'Look.', input: { type: 'object' } }];
  const on = { ...type.tunables, enforceToolCall: true };
  const body = (/** @type {any} */ tunables, /** @type {any} */ request) => type.build(spec({ tunables, request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }], ...request } })).body;
  assert.equal(body(on, { tools: one, toolChoice: 'decide' }).tool_choice, 'required');
  assert.deepEqual(body(type.tunables, { tools: one, toolChoice: 'decide' }).tool_choice, { type: 'function', function: { name: 'decide' } });
  assert.deepEqual(body(on, { tools: two, toolChoice: 'decide' }).tool_choice, { type: 'function', function: { name: 'decide' } });
  assert.equal('tool_choice' in body(on, { tools: two }), false);
  assert.equal('tool_choice' in body(on, { tools: one }), false);
  assert.deepEqual(body(on, { tools: two }).tools, body(type.tunables, { tools: two }).tools);
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

test("classify: the protocol names no provider's own limits: OpenRouter's free-model limit is its plugin's (provider-openrouter.test.js)", () => {
  const daily = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' } });
  assert.equal(type.classify(429, daily), null);
  assert.equal(type.classify(402, daily), null);
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

test('list: a model list with max_model_len gives the context window (vLLM, SGLang); llama.cpp\'s training context is not the one it serves', async () => {
  const { startFakeServer } = await import('../fakes/model-server.js');
  for (const flavour of /** @type {const} */ (['vllm', 'sglang', 'llamacpp'])) {
    const s = await startFakeServer({ flavour });
    try {
      const [m] = type.readList(await (await fetch(`${s.origin}/v1/models`)).json());
      if (flavour === 'llamacpp') assert.deepEqual([m.contextWindow, m.input], [undefined, ['text', 'image']], 'n_ctx_train is left alone; photos are found');
      else assert.deepEqual(m, { providerId: 'Qwen/Qwen3-8B', contextWindow: 32768 }, flavour);
    } finally {
      await s.stop();
    }
  }
  // OpenRouter's context_length comes first, then max_model_len, then its top provider's.
  assert.equal(type.readList({ data: [{ id: 'x', context_length: 1000, max_model_len: 2000, top_provider: { context_length: 3000 } }] })[0].contextWindow, 1000);
  assert.equal(type.readList({ data: [{ id: 'x', max_model_len: 2000, top_provider: { context_length: 3000 } }] })[0].contextWindow, 2000);
});

test('read: url citations and counted searches', async () => {
  const events = await read(await fixture('citations.sse'));
  assert.deepEqual(events.filter((e) => e.type === 'citation'), [{ type: 'citation', url: 'https://www.nepenthe.com/', title: 'Nepenthe Big Sur' }]);
  assert.deepEqual(events.find((e) => e.type === 'usage')?.usage.serverTools, { web_search_requests: 1 });
});

test('build: a tool call whose arguments were cut short is sent with empty arguments, which every server parses', () => {
  const s = spec({ request: { messages: [
    { role: 'user', parts: [{ type: 'text', text: 'Note this' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'write', input: '{"path":"/trip/notes/a.md","content":"a very long no' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'call_1', content: "Error: the input for write wasn't valid JSON.", isError: true }] },
  ] } });
  const call = type.build(s).body.messages.find((/** @type {any} */ m) => m.tool_calls).tool_calls[0];
  assert.equal(call.function.arguments, '{}');
});

// Item 24 (2026-10-18): a server that never streams, such as the user's own router, answers `stream: true` with one
// whole application/json chat completion. It is read as the same events a stream gives.
/** @param {string} text @param {number} [status] */
const json = (text, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
/** @param {Response} res @param {any} [s] */
async function readAll(res, s = spec()) {
  const out = [];
  for await (const e of type.read(res, s)) out.push(e);
  return out;
}

test('a whole JSON reply where a stream was asked for: its words, reasoning first, the logprobs, a source, usage with cached tokens and the stop reason', async () => {
  const events = await readAll(json(await fixture('whole-text.json')));
  assert.deepEqual(events, [
    { type: 'logprobs', top: [{ token: 'Ky', logprob: -0.01 }, { token: 'It', logprob: -4.2 }] },
    { type: 'reasoning_delta', text: 'The user asks where Kyoto is.' },
    { type: 'reasoning', text: 'The user asks where Kyoto is.' },
    { type: 'text', text: 'Kyoto is in Japan.' },
    { type: 'citation', url: 'https://en.wikipedia.org/wiki/Kyoto', title: 'Kyoto' },
    { type: 'usage', usage: { input: 200, cacheRead: 1000, cacheWrite: 0, output: 30, reasoning: 12 } },
    { type: 'stop', reason: 'end' },
  ]);
});

test('a whole JSON reply with tool calls: each call whole, with its arguments, after the reasoning ("reasoning", as OpenRouter names it)', async () => {
  const events = await readAll(json(await fixture('whole-tools.json')));
  assert.deepEqual(events.filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'A color is asked for.' }]);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [
    { type: 'tool_call', id: 'call_abc', name: 'report_color', input: { color: 'red' } },
    { type: 'tool_call', id: 'call_def', name: 'report_size', input: { size: 3 } },
  ]);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' });
  assert.ok(events.findIndex((e) => e.type === 'reasoning') < events.findIndex((e) => e.type === 'tool_call'));
  // Its words as a list of parts, as some servers write them, and arguments already an object.
  const parts = JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'Hi ' }, { type: 'text', text: 'there' }], tool_calls: [{ id: 'c1', function: { name: 'x', arguments: { a: 1 } } }] }, finish_reason: 'tool_calls' }] });
  const more = await readAll(json(parts));
  assert.deepEqual(more.filter((e) => e.type === 'text' || e.type === 'tool_call'), [{ type: 'text', text: 'Hi there' }, { type: 'tool_call', id: 'c1', name: 'x', input: { a: 1 } }]);
});

test('a whole JSON reply that is an error is the error it says, sharpened as an HTTP error is; one with no answer in it says so', async () => {
  await assert.rejects(readAll(json(await fixture('whole-error.json'))), (e) => e instanceof ProviderError && e.kind === 'context' && /maximum context length/.test(e.message));
  await assert.rejects(readAll(json(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }))), (e) => e instanceof ProviderError && e.kind === 'credit');
  await assert.rejects(readAll(json('{"id":"x","choices":[]}')), (e) => e instanceof ProviderError && e.kind === 'server' && /no answer/.test(e.message));
  await assert.rejects(readAll(json('{"choices": [')), (e) => e instanceof ProviderError && e.kind === 'server' && /can't read/.test(e.message));
  // A stream is still read as one, whatever else is there.
  assert.deepEqual((await readAll(new Response(await fixture('tools.sse'), { headers: { 'content-type': 'text/event-stream' } }))).at(-1), { type: 'stop', reason: 'tool' });
});

test("a whole reply waits as a stream's first words do: one in time is taken, and one slower than the wait stops in words the trace and card show", async () => {
  const s = spec({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Where is Kyoto?' }] }] } });
  const body = await fixture('whole-text.json');
  /** The whole reply after ms, its headers at once or with it. @param {number} ms @param {boolean} early */
  const after = (ms, early) => async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
    const wait = () => new Promise((done, fail) => {
      const t = setTimeout(done, ms);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); fail(init.signal?.reason); });
    });
    if (!early) {
      await wait();
      return json(body);
    }
    const stream = new ReadableStream({ async start(c) { await wait().catch(() => {}); c.enqueue(new TextEncoder().encode(body)); c.close(); } });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  };
  const call = (/** @type {any} */ fetch, /** @type {number} */ firstOutputMs) => callOnce({ type, endpoint: s.endpoint, model: s.model, key: s.key, request: s.request, fetch, firstOutputMs });
  assert.equal((await call(after(20, false), 1000)).text, 'Kyoto is in Japan.');
  assert.equal((await call(after(20, true), 1000)).text, 'Kyoto is in Japan.');
  for (const early of [false, true]) {
    await assert.rejects(call(after(400, early), 50), (e) => e instanceof ProviderError && e.kind === 'timeout' && e.message === 'No output started in time.', String(early));
  }
});

/** A whole JSON reply whose connection drops after its first piece. */
const dropping = () => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"Kyo'));
    c.error(new TypeError('network error'));
  },
}), { headers: { 'content-type': 'application/json' } });

test("a whole reply whose connection drops part way is a dropped connection, tried again elsewhere, and never counted against the plugin (fix pass 1)", async () => {
  await assert.rejects(readAll(dropping()), (e) => e instanceof ProviderError && e.kind === 'network' && e.message === 'The connection dropped.');
  const s = spec({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  let failed = 0;
  await assert.rejects(callOnce({ type, endpoint: s.endpoint, model: s.model, key: s.key, request: s.request, fetch: async () => dropping(), registry: /** @type {any} */ ({ fail: () => { failed++; } }) }),
    (e) => e instanceof ProviderError && e.kind === 'network');
  assert.equal(failed, 0);
});

test('only application/json is a whole reply: NDJSON, stream+json and problem+json are read as streams, and so is a stream sent as application/json (fix pass 3)', async () => {
  const sseText = await fixture('tools.sse');
  for (const kind of ['application/x-ndjson', 'application/stream+json', 'application/problem+json', 'application/json', 'application/json; charset=utf-8']) {
    const events = await readAll(new Response(sseText, { headers: { 'content-type': kind } }));
    assert.deepEqual(events.filter((e) => e.type === 'tool_input').map((e) => e.partial), ['', '{"col', '{"color":"red"}'], kind);
    assert.deepEqual(events.at(-1), { type: 'stop', reason: 'tool' }, kind);
  }
  assert.equal((await readAll(json(await fixture('whole-text.json')))).find((e) => e.type === 'text')?.text, 'Kyoto is in Japan.');
});

// K1 Task 1 (the Koe and Kokoro spike, 2026-10-19): Gemini 3 models write a thought signature on each tool call, in
// extra_content.google.thought_signature, and refuse the next step without it ("Function call is missing a thought_signature").
const SIGNED = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"read","arguments":"{}"},"extra_content":{"google":{"thought_signature":"sig"}}}]},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"list","arguments":"{}"}}]},"finish_reason":null}]}',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
  '',
].join('\n\n');

test("a tool call's extra_content (Gemini's thought signature) comes back on that call in the next request", async () => {
  const s = spec({ model: { ...spec().model, providerId: 'gemini-3.8-flash' }, request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Read it' }] }] } });
  const events = await read(SIGNED, s);
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [
    { type: 'tool_call', id: 'c1', name: 'read', input: {}, extra: { google: { thought_signature: 'sig' } } },
    { type: 'tool_call', id: 'c2', name: 'list', input: {} },
  ]);
  // Through annai's call: the reply's parts keep it, with the model that wrote it.
  const reply = await callOnce({ type, endpoint: s.endpoint, model: s.model, key: s.key, request: s.request, fetch: async () => new Response(SIGNED, { headers: { 'content-type': 'text/event-stream' } }) });
  const calls = reply.parts.filter((p) => p.type === 'tool_call');
  assert.deepEqual(calls[0], { type: 'tool_call', id: 'c1', name: 'read', input: {}, extra: { google: { thought_signature: 'sig' } }, model: 'gemini-3.8-flash' });
  assert.deepEqual(calls[1], { type: 'tool_call', id: 'c2', name: 'list', input: {} });
  // The next request, to the same model: the signature is back on its call, and only there.
  /** @type {any} */
  let body = null;
  const next = { messages: [...s.request.messages, { role: /** @type {const} */ ('assistant'), parts: reply.parts }, { role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('tool_result'), id: 'c1', content: 'a' }, { type: /** @type {const} */ ('tool_result'), id: 'c2', content: 'b' }] }] };
  await callOnce({ type, endpoint: s.endpoint, model: s.model, key: s.key, request: next, fetch: async (_u, init) => { body = JSON.parse(String(init.body)); return new Response(await fixture('text.sse')); } });
  const sent = body.messages.find((/** @type {any} */ m) => m.tool_calls).tool_calls;
  assert.deepEqual(sent[0].extra_content, { google: { thought_signature: 'sig' } });
  assert.equal('extra_content' in sent[1], false);
  // To another model the signature isn't sent: it was written for the one that made the call.
  await callOnce({ type, endpoint: s.endpoint, model: { ...s.model, providerId: 'gpt-6-luna' }, key: s.key, request: next, fetch: async (_u, init) => { body = JSON.parse(String(init.body)); return new Response(await fixture('text.sse')); } });
  assert.equal('extra_content' in body.messages.find((/** @type {any} */ m) => m.tool_calls).tool_calls[0], false);
});

test('a whole JSON reply keeps extra_content too', async () => {
  const whole = JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] }, finish_reason: 'tool_calls' }] });
  const events = await readAll(json(whole));
  assert.deepEqual(events.filter((e) => e.type === 'tool_call'), [{ type: 'tool_call', id: 'c1', name: 'read', input: {}, extra: { google: { thought_signature: 'sig' } } }]);
});

test("standInCallExtra (Gemini's description sets it): a call in the current turn that another model wrote carries the stand-in, so a fallback mid-turn isn't refused; earlier turns' calls, and its own, are as they were", () => {
  const stand = { google: { thought_signature: 'skip_thought_signature_validator' } };
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Earlier' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'old', name: 'read', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'old', content: 'a' }, { type: 'text', text: '[meanwhile, the user wrote] Now' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'theirs', name: 'read', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'theirs', content: 'b' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'mine', name: 'list', input: {}, extra: { google: { thought_signature: 'sig' } } }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'mine', content: 'c' }] },
  ];
  const calls = (/** @type {any} */ t) => Object.fromEntries(type.build(spec({ tunables: { ...type.tunables, ...t }, request: { messages } })).body.messages.filter((/** @type {any} */ m) => m.tool_calls).map((/** @type {any} */ m) => [m.tool_calls[0].id, m.tool_calls[0].extra_content]));
  assert.deepEqual(calls({ standInCallExtra: stand }), { old: undefined, theirs: stand, mine: { google: { thought_signature: 'sig' } } });
  assert.deepEqual(calls({}), { old: undefined, theirs: undefined, mine: { google: { thought_signature: 'sig' } } });
  assert.equal(type.tunables.standInCallExtra, null);
});

// Found against Gemini (2026-10-19): its compatible endpoint streams each tool call whole, with an id of its own and
// no index. Read by index alone, a reply's speak, tell_kokoro and sleep ran together into one call.
test('read: tool calls streamed with no index (Gemini) are told apart by their ids', async () => {
  const chunk = (/** @type {any} */ tc) => `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [tc] }, index: 0 }] })}`;
  const text = [
    chunk({ extra_content: { google: { thought_signature: 'sig' } }, function: { arguments: '{"text":"Let me check."}', name: 'speak' }, id: 'call_1', type: 'function' }),
    chunk({ function: { arguments: '{"text":"Is it open now?"}', name: 'tell_kokoro' }, id: 'call_2', type: 'function' }),
    chunk({ function: { arguments: '{}', name: 'sleep' }, id: 'call_3', type: 'function' }),
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] })}`,
    'data: [DONE]', '',
  ].join('\n\n');
  const calls = (await read(text)).filter((e) => e.type === 'tool_call');
  assert.deepEqual(calls, [
    { type: 'tool_call', id: 'call_1', name: 'speak', input: { text: 'Let me check.' }, extra: { google: { thought_signature: 'sig' } } },
    { type: 'tool_call', id: 'call_2', name: 'tell_kokoro', input: { text: 'Is it open now?' } },
    { type: 'tool_call', id: 'call_3', name: 'sleep', input: {} },
  ]);
});

test("classify: Gemini's RESOURCE_EXHAUSTED (its free tier's limit a minute, in an error list) is too many requests, not an account out of credit", () => {
  const body = JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' }] } }]);
  assert.equal(type.classify(429, body), 'rate');
  // Fix pass: a 402 RESOURCE_EXHAUSTED is prepaid credit used up: out of credit, as the status says, never tried again and again.
  const prepaid = JSON.stringify([{ error: { code: 402, message: 'Your Prepay credit balance is depleted. Add credits to your billing account.', status: 'RESOURCE_EXHAUSTED' } }]);
  assert.equal(type.classify(402, prepaid), null);
  assert.equal(errorFromResponse(402, prepaid).kind, 'credit');
});

test("Koe fix pass 11: Gemini's own parallel calls (the first signed, the rest not) take no stand-in: only a reply none of whose calls is signed does", () => {
  const stand = { google: { thought_signature: 'skip_thought_signature_validator' } };
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'Now' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'a', name: 'speak', input: {}, extra: { google: { thought_signature: 'sig' } } }, { type: 'tool_call', id: 'b', name: 'sleep', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'a', content: '1' }, { type: 'tool_result', id: 'b', content: '2' }] },
  ];
  const sent = type.build(spec({ tunables: { ...type.tunables, standInCallExtra: stand }, request: { messages } })).body.messages.find((/** @type {any} */ m) => m.tool_calls).tool_calls;
  assert.deepEqual(sent.map((/** @type {any} */ c) => c.extra_content), [{ google: { thought_signature: 'sig' } }, undefined]);
});
