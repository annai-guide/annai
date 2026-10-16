import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { callOnce, applyPatches } from '../../src/core/llm/call.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { text as textOf } from '../../src/core/bytes.js';

const endpoint = (over = {}) => ({ id: 'ep-1', type: 'test', name: 'Test endpoint', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {}, ...over });
const model = (over = {}) => ({ id: 'm-1', endpoint: 'ep-1', name: 'Test model', providerId: 'test-1', input: ['text'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...over });
/** @type {any} */
const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] };

/** An endpoint type with no network that runs the given generator. @param {(c: any) => AsyncGenerator<any>} run */
const runType = (run) => /** @type {any} */ ({ type: 'test-run', name: 'Run', pluginId: 'run-plugin', run });
/** An HTTP endpoint type whose stream is these events. @param {any[]} events @param {any} [extra] */
const httpType = (events, extra = {}) => /** @type {any} */ ({
  type: 'test', name: 'Test', pluginId: 'test-plugin',
  build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: { authorization: `Bearer ${c.key}` }, body: { model: c.model.providerId, messages: c.request.messages } }),
  read: async function* () { for (const e of events) yield e; },
  ...extra,
});
/** @param {any} store */
const traced = async (store) => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS));

test('one call puts the reply together, with its usage and cost, and tells the trace', async () => {
  const store = createMemoryStore();
  const seen = [];
  const reply = await callOnce({
    type: runType(async function* () {
      yield { type: 'reasoning', text: 'Think.', signature: 'sig' };
      yield { type: 'text', text: 'Hello ' };
      yield { type: 'text', text: 'there' };
      yield { type: 'tool_call', id: 'c1', name: 'look', input: { at: 'map' } };
      yield { type: 'usage', usage: { input: 1000, output: 400 } };
      yield { type: 'usage', usage: { output: 500 } };
      yield { type: 'stop', reason: 'tool' };
    }),
    endpoint: endpoint(), model: model(), key: null, request, onEvent: (e) => seen.push(e), trace: modelTrace(store, SYS),
  });
  assert.deepEqual(reply.parts, [
    { type: 'reasoning', text: 'Think.', signature: 'sig', model: 'test-1' },
    { type: 'text', text: 'Hello there' },
    { type: 'tool_call', id: 'c1', name: 'look', input: { at: 'map' } },
  ]);
  assert.equal(reply.text, 'Hello there');
  assert.equal(reply.usage.input, 1000);
  assert.equal(reply.usage.output, 500);
  assert.ok(Math.abs(/** @type {number} */ (reply.cost) - (1000 * 1 + 500 * 2) / 1e6) < 1e-12);
  assert.equal(reply.stop, 'tool');
  assert.equal(reply.model, 'm-1');
  assert.equal(seen.length, 7);
  const [ev] = await traced(store);
  assert.equal(ev.type, 'net.request');
  assert.equal(ev.data.outcome, 'ok');
  assert.equal(ev.data.model, 'Test model');
  assert.equal(ev.data.endpoint, 'Test endpoint');
  assert.equal(typeof ev.data.firstMs, 'number');
});

test("patches: the endpoint's extra fields, then the model's, then the reasoning level's (spec §9.2–9.4)", async () => {
  const ep = endpoint({ extraBody: { a: 2, b: 1 } });
  const m = model({ extraBody: { b: 2, 'tools+': [2] }, reasoning: { high: { effort: 'high' } } });
  assert.deepEqual(applyPatches({ a: 1, tools: [1] }, ep, m, 'max'), { a: 2, b: 2, tools: [1, 2], effort: 'high' });
  /** @type {any} */
  let sent = null;
  await callOnce({
    type: httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }]), endpoint: ep, model: m, key: 'sk-1', request, level: 'high',
    fetch: async (url, init) => { sent = { url, init }; return new Response('streamed'); },
  });
  assert.equal(sent.url, 'https://llm.test/v1/chat');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.authorization, 'Bearer sk-1');
  assert.deepEqual(JSON.parse(sent.init.body), { model: 'test-1', messages: request.messages, a: 2, b: 2, tools: [2], effort: 'high' });
});

test('an error response becomes a ProviderError, sharpened by the endpoint type', async () => {
  const type = httpType([], { classify: (/** @type {number} */ _s, /** @type {string} */ body) => (body.includes('special') ? 'context' : null) });
  await assert.rejects(callOnce({ type, endpoint: endpoint(), model: model(), key: null, request, fetch: async () => new Response(JSON.stringify({ error: { message: 'x', code: 'special' } }), { status: 400 }) }),
    (e) => e instanceof ProviderError && e.kind === 'context' && e.status === 400);
});

test('a key the provider echoes in an error never reaches the trace', async () => {
  const store = createMemoryStore();
  const key = 'sk-live-abcdef123456';
  await assert.rejects(callOnce({
    type: httpType([]), endpoint: endpoint(), model: model(), key, request, trace: modelTrace(store, SYS),
    fetch: async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.` } }), { status: 401 }),
  }), (e) => e instanceof ProviderError && e.kind === 'auth');
  const log = JSON.stringify(await traced(store));
  assert.ok(!log.includes(key), log);
  assert.ok(log.includes('«key»'));
});

test("a fetch that fails is 'unreachable'", async () => {
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model(), key: null, request, fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e instanceof ProviderError && e.kind === 'unreachable');
});

test('no first output in time is a timeout, whether the request or the stream is slow', async () => {
  const never = runType(async function* () { await new Promise(() => {}); });
  await assert.rejects(callOnce({ type: never, endpoint: endpoint(), model: model(), key: null, request, firstOutputMs: 30 }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  const hanging = async (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model(), key: null, request, firstOutputMs: 30, fetch: /** @type {any} */ (hanging) }),
    (e) => e instanceof ProviderError && e.kind === 'timeout');
});

test('the caller can stop a call, and what it said so far is kept with a cut-off', async () => {
  const stop = new AbortController();
  const slow = runType(async function* () {
    yield { type: 'text', text: 'Kyoto is' };
    await new Promise(() => {});
  });
  await assert.rejects(callOnce({ type: slow, endpoint: endpoint(), model: model(), key: null, request, signal: stop.signal, onEvent: () => stop.abort() }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled');
  const cut = runType(async function* () {
    yield { type: 'text', text: 'Kyoto is' };
    throw new ProviderError('network', 'dropped');
  });
  await assert.rejects(callOnce({ type: cut, endpoint: endpoint(), model: model(), key: null, request }), (e) => e instanceof ProviderError && e.kind === 'network' && e.partial === 'Kyoto is');
});

test("a bug in an endpoint type counts against its plugin, and the call fails as 'plugin'", async () => {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const buggy = runType(async function* () { yield { type: 'text', text: 'a' }; throw new Error('oops'); });
  await assert.rejects(callOnce({ type: buggy, endpoint: endpoint(), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === 'plugin');
  assert.equal(logged[0].type, 'plugin.error');
  assert.equal(logged[0].actor, 'plugin:run-plugin');
});

test('reasoning signed by another model is never sent to this one', async () => {
  /** @type {any} */
  let sent = null;
  const type = httpType([{ type: 'stop', reason: 'end' }], { build: (/** @type {any} */ c) => { sent = c.request.messages; return { url: 'https://llm.test', headers: {}, body: {} }; } });
  const history = { messages: [...request.messages, { role: 'assistant', parts: [{ type: 'reasoning', text: 'x', signature: 's', model: 'other' }, { type: 'text', text: 'Hello' }] }] };
  await callOnce({ type, endpoint: endpoint(), model: model(), key: null, request: history, fetch: async () => new Response('') });
  assert.deepEqual(sent[1].parts, [{ type: 'text', text: 'Hello' }]);
});

test('model.turn keeps the reply and its reasoning as blobs it names, in one transaction (spec §4.9, §9.3)', async () => {
  const store = createMemoryStore();
  const trace = modelTrace(store, SYS);
  trace.secret('sk-abcdefgh12345');
  await trace.turn({ role: 'main', level: 'medium', answeredBy: 'Test model', attempts: [{ model: 'm-1', name: 'Test model', outcome: 'auth', ms: 5, error: 'bad key sk-abcdefgh12345' }], usage: null, cost: undefined, stop: 'end' }, 'Hello there', 'They said hello.');
  const [ev] = await traced(store);
  assert.equal(ev.type, 'model.turn');
  assert.equal(ev.data.attempts[0].error, 'bad key «key»');
  assert.deepEqual(ev.data.stored, ['reply', 'reasoning']);
  assert.equal(ev.refs.length, 2);
  const texts = [];
  for (const hash of ev.refs) texts.push(textOf(new Uint8Array(/** @type {any} */ (await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash))).data)));
  assert.deepEqual(texts, ['Hello there', 'They said hello.']);
  await trace.turn({ role: 'main', level: 'off', answeredBy: null, attempts: [], usage: null, cost: undefined }, '');
  assert.equal((await traced(store))[1].refs, undefined, 'nothing to keep, nothing named');
});

test('credentials in extra headers or in the address never reach the trace', async () => {
  const store = createMemoryStore();
  const headerSecret = 'hdr-secret-123456';
  const urlSecret = 'url-secret-987654';
  const ep = endpoint({ baseUrl: `https://llm.test/v1?token=${urlSecret}`, headers: { 'X-Api-Key': headerSecret, Authorization: 'Bearer auth-secret-555555', 'X-Title': 'annai' } });
  const type = httpType([], { build: (/** @type {any} */ c) => ({ url: c.endpoint.baseUrl, headers: c.endpoint.headers, body: {} }) });
  await assert.rejects(callOnce({
    type, endpoint: ep, model: model(), key: null, request, trace: modelTrace(store, SYS),
    fetch: async () => new Response(JSON.stringify({ error: { message: `bad ${headerSecret} or auth-secret-555555 for ${urlSecret}` } }), { status: 401 }),
  }));
  const log = JSON.stringify(await traced(store));
  for (const secret of [headerSecret, urlSecret, 'auth-secret-555555']) assert.ok(!log.includes(secret), `${secret} reached the trace: ${log}`);
  assert.ok(log.includes('X-Title') === false, 'headers are never traced');
});

test('an address is traced without its query or a password, however they are encoded', async () => {
  const store = createMemoryStore();
  const url = 'https://user:pa%40ss-1234567@llm.test/v1/chat?token=ab%2Bcd-1234567&k=x+y-12345678#frag';
  const type = httpType([], { build: () => ({ url, headers: {}, body: {} }) });
  const echoed = 'pa@ss-1234567 ab+cd-1234567 ab%2Bcd-1234567 x y-12345678 x+y-12345678';
  await assert.rejects(callOnce({
    type, endpoint: endpoint(), model: model(), key: null, request, trace: modelTrace(store, SYS),
    fetch: async () => new Response(JSON.stringify({ error: { message: echoed } }), { status: 401 }),
  }));
  const [ev] = await traced(store);
  assert.equal(ev.data.url, 'https://llm.test/v1/chat?…');
  for (const secret of echoed.split(' ')) assert.ok(!JSON.stringify(ev).includes(secret), `${secret} reached the trace: ${JSON.stringify(ev)}`);
});
