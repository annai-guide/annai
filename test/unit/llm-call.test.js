import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { callOnce, applyPatches, withTail, photoHash } from '../../src/core/llm/call.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { text as textOf } from '../../src/core/bytes.js';
import { SLOW_UPLINK } from '../../src/core/llm/uploads.js';
import { useClock } from './clock.js';

const endpoint = (over = {}) => ({ id: 'pv-1/chat', provider: 'pv-1', ability: 'chat', type: 'test', name: 'Test provider', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {}, ...over });
const model = (over = {}) => ({ id: 'm-1', provider: 'pv-1', ability: 'chat', name: 'Test model', providerId: 'test-1', input: ['text'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over });
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
  assert.equal(ev.data.endpoint, 'Test provider');
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

test("reasoning as it streams keeps the first-output timer alive: it is an inactivity timer, not a thinking timer", async () => {
  const thinker = runType(async function* () {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'reasoning_delta', text: 'hm ' };
    }
    yield { type: 'reasoning', text: 'hm hm' };
    yield { type: 'text', text: 'Hello' };
    yield { type: 'stop', reason: 'end' };
  });
  const reply = await callOnce({ type: thinker, endpoint: endpoint(), model: model(), key: null, request, firstOutputMs: 60 });
  assert.equal(reply.text, 'Hello');
  assert.deepEqual(reply.parts.map((p) => p.type), ['reasoning', 'text']);
});

test('the caller can stop a call, and what it said so far is kept with a cut-off', async () => {
  const stop = new AbortController();
  const slow = runType(async function* () {
    yield { type: 'text', text: 'Kyoto is' };
    await new Promise(() => {});
  });
  await assert.rejects(callOnce({ type: slow, endpoint: endpoint(), model: model(), key: null, request, signal: stop.signal, onEvent: () => stop.abort() }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled' && e.partial === 'Kyoto is');
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
  registry.add('run-plugin', 'endpoint-type', buggy);
  await assert.rejects(callOnce({ type: buggy, endpoint: endpoint(), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === 'plugin');
  assert.equal(logged[0].type, 'plugin.error');
  assert.equal(logged[0].actor, 'plugin:run-plugin');
});

test('M6 fix: the plugin blamed for a bug is the one that registered the type, never a pluginId the type carries', async () => {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const spoofed = { ...runType(async function* () { throw new TypeError('oops'); }), pluginId: 'chat-completions' };
  registry.add('evil', 'endpoint-type', spoofed);
  for (let i = 0; i < 3; i++) await assert.rejects(callOnce({ type: spoofed, endpoint: endpoint(), model: model(), key: null, request, registry }));
  assert.deepEqual([...new Set(logged.filter((e) => e.type === 'plugin.error').map((e) => e.actor))], ['plugin:evil']);
  assert.deepEqual([registry.isDisabled('evil'), registry.isDisabled('chat-completions')], [true, false]);
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

test('short keys, keys in the path, and secrets inside secrets are blanked too', async () => {
  const store = createMemoryStore();
  const key = 'k7Q9x2';
  const url = `https://llm.test/bot${key}/send?api_key=z9Y8&page=2`;
  const type = httpType([], { build: () => ({ url, headers: {}, body: {} }) });
  await assert.rejects(callOnce({
    type, endpoint: endpoint({ headers: { 'X-Token': 'abcd1234' } }), model: model(), key, request, trace: modelTrace(store, SYS),
    fetch: async () => new Response(JSON.stringify({ error: { message: `no ${key}, no z9Y8, no abcd1234efgh` } }), { status: 401 }),
  }));
  const [ev] = await traced(store);
  const shown = JSON.stringify(ev);
  for (const secret of [key, 'z9Y8', 'abcd1234']) assert.ok(!shown.includes(secret), `${secret} reached the trace: ${shown}`);
  assert.equal(ev.data.url, 'https://llm.test/bot«key»/send?…');
  assert.ok(!shown.includes('efgh') || shown.includes('«key»efgh'), 'an outer secret is blanked whole');
});

test('a type that does not place the tail itself gets it folded into the last user message', async () => {
  /** @type {any} */
  let seen = null;
  const t = runType(async function* (/** @type {any} */ c) { seen = c.request; yield { type: 'text', text: 'ok' }; yield { type: 'stop', reason: 'end' }; });
  await callOnce({ type: t, endpoint: endpoint(), model: model(), key: null, request: { ...request, tail: 'NOW' } });
  assert.equal(seen.tail, undefined);
  assert.deepEqual(seen.messages.at(-1).parts.at(-1), { type: 'text', text: 'NOW' });
  assert.deepEqual(withTail({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] }], tail: 'NOW' }).messages.at(-1), { role: 'user', parts: [{ type: 'text', text: 'NOW' }] });
});

test("the reply keeps the first token's alternatives", async () => {
  const t = runType(async function* () {
    yield { type: 'logprobs', top: [{ token: 'A', logprob: -0.1 }] };
    yield { type: 'text', text: 'A' };
    yield { type: 'stop', reason: 'end' };
  });
  const reply = await callOnce({ type: t, endpoint: endpoint(), model: model(), key: null, request });
  assert.deepEqual(reply.logprobs, [{ token: 'A', logprob: -0.1 }]);
});

const search = { id: 'p-search', name: 'Web search', kind: 'search', patch: { 'tools+': [{ type: 'web_search_x', name: 'web_search' }] }, pricePerCall: 0.01, usageKey: 'web_search_requests' };
const fetchTool = { id: 'p-fetch', name: 'Web fetch', kind: 'fetch', patch: { 'tools+': [{ type: 'web_fetch_x', name: 'web_fetch' }] } };

test('provider tools: the kinds the request asks for, minus the ones switched off, patch the body', async () => {
  /** @type {any[]} */
  const bodies = [];
  const ok = async (/** @type {any} */ _u, /** @type {any} */ init) => { bodies.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  const t = httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }]);
  const m = model({ providerTools: [search, fetchTool] });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: null, request: { ...request, providerTools: { kinds: ['search'] } }, fetch: /** @type {any} */ (ok) });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: null, request: { ...request, providerTools: { kinds: ['search', 'fetch'], off: ['p-search'] } }, fetch: /** @type {any} */ (ok) });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: null, request, fetch: /** @type {any} */ (ok) });
  assert.deepEqual(bodies.map((b) => (b.tools ?? []).map((/** @type {any} */ x) => x.name)), [['web_search'], ['web_fetch'], []]);
});

test('a provider block is kept for the model that wrote it, citations are collected, and searches are priced per call', async () => {
  const t = runType(async function* () {
    yield { type: 'provider', block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'nepenthe' } } };
    yield { type: 'citation', url: 'https://nepenthe.com', title: 'Nepenthe' };
    yield { type: 'citation', url: 'https://nepenthe.com', title: 'Nepenthe' };
    yield { type: 'text', text: 'Open till 10.' };
    yield { type: 'usage', usage: { input: 1000, output: 100, serverTools: { web_search_requests: 2 } } };
    yield { type: 'stop', reason: 'end' };
  });
  const reply = await callOnce({ type: t, endpoint: endpoint(), model: model({ providerTools: [search] }), key: null, request });
  assert.deepEqual(reply.parts[0], { type: 'provider', block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'nepenthe' } }, model: 'test-1' });
  assert.deepEqual(reply.citations, [{ url: 'https://nepenthe.com', title: 'Nepenthe' }]);
  // 1000 × $1/M + 100 × $2/M + 2 searches × $0.01
  assert.equal(Number(reply.cost?.toFixed(6)), 0.0212);
});

test('an attribution is kept beside the reply\'s parts, never in them, so no model is sent it and the log keeps it once (G4)', async () => {
  /** @type {any[]} */
  const seen = [];
  const card = { source: 'Google Search', text: 'Open till 10.', links: [{ url: 'https://nepenthe.com', title: 'nepenthe.com' }], html: '<div>chips</div>' };
  const t = runType(async function* () {
    yield { type: 'text', text: 'Open till 10.' };
    yield { type: 'attribution', ...card };
    yield { type: 'stop', reason: 'end' };
  });
  const reply = await callOnce({ type: t, endpoint: endpoint(), model: model(), key: null, request, onEvent: (e) => seen.push(e.type) });
  assert.deepEqual(reply.parts, [{ type: 'text', text: 'Open till 10.' }]);
  assert.deepEqual(reply.attribution, card);
  assert.deepEqual(seen, ['text', 'attribution', 'stop']);
  const plain = await callOnce({ type: runType(async function* () { yield { type: 'text', text: 'Hi.' }; }), endpoint: endpoint(), model: model(), key: null, request });
  assert.equal(plain.attribution, undefined);
});

test("uploads are known by the hash of the bytes sent, never by the hash a part claims: another photo's upload is never reused for other bytes (review, 1)", async () => {
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { Uploads } = await import('../../src/core/llm/uploads.js');
  const { sha256Hex } = await import('../../src/core/hash.js');
  const { fromBase64 } = await import('../../src/core/bytes.js');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const uploads = new Uploads(ws);
  /** @type {string[]} */
  const sent = [];
  let n = 0;
  const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url.endsWith('/v1/files')) {
      sent.push(await (/** @type {Blob} */ (init.body.get('file'))).text());
      return new Response(JSON.stringify({ id: `file_${++n}`, expires_at: new Date(Date.now() + 172_800_000).toISOString() }));
    }
    sent.push(JSON.parse(init.body).images.join());
    return new Response('');
  };
  const t = httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }], {
    uploadRequest: (/** @type {any} */ c) => { const f = new FormData(); f.set('file', new Blob([c.bytes], { type: c.mediaType }), c.name); return { url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: f }; },
    readUpload: (/** @type {any} */ j) => ({ id: j.id, expiresAt: Date.parse(j.expires_at) }),
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
  });
  const m = model({ input: ['text', 'image'] });
  const kyoto = 'a2lvdG8gcGhvdG8='; // "kioto photo"
  const theirs = await sha256Hex(fromBase64(kyoto));
  const photo = (/** @type {string} */ data) => ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data, hash: theirs }] }] });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (photo(kyoto)), fetch: /** @type {any} */ (get), uploads });
  // Other bytes claiming that photo's hash: uploaded as themselves, not sent as file_1.
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (photo('b3RoZXI=')), fetch: /** @type {any} */ (get), uploads });
  assert.deepEqual(sent, ['kioto photo', 'file_1', 'other', 'file_2']);
  // The real photo again: its upload is reused.
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (photo(kyoto)), fetch: /** @type {any} */ (get), uploads });
  assert.equal(sent.at(-1), 'file_1');
});

test("a photo's hash is its bytes' own, worked out once while the same data is sent again (verification, 4)", async () => {
  const { photoHash } = await import('../../src/core/llm/call.js');
  const { sha256Hex } = await import('../../src/core/hash.js');
  const { fromBase64 } = await import('../../src/core/bytes.js');
  const data = 'a2lvdG8gcGhvdG8=';
  const want = await sha256Hex(fromBase64(data));
  assert.equal(await photoHash(data), want);
  assert.equal(await photoHash(data), want);
  assert.notEqual(await photoHash('b3RoZXI='), want);
});

test("photos' hashes asked for at once are counted once, so the cache keeps as many as its bound allows (re-verification, 2; V15b)", async () => {
  const { photoHash, forgetPhotoHashes } = await import('../../src/core/llm/call.js');
  const { toBase64 } = await import('../../src/core/bytes.js');
  forgetPhotoHashes();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let digests = 0;
  crypto.subtle.digest = /** @type {any} */ ((/** @type {any[]} */ ...a) => { digests++; return /** @type {any} */ (digest)(...a); });
  try {
    const photo = (/** @type {number} */ i) => toBase64(new Uint8Array(750_000).fill(i)); // 1,000,000 characters
    const held = Array.from({ length: 24 }, (_, i) => photo(i + 1)); // 24M characters: as many as fit with one more
    for (const d of held) await photoHash(d);
    await Promise.all(Array.from({ length: 6 }, () => photoHash(photo(200)))); // one new photo, asked for six times at once
    digests = 0;
    for (const d of held.slice(1)) await photoHash(d);
    assert.equal(digests, 0, 'the newest are all still known');
  } finally {
    crypto.subtle.digest = digest;
    forgetPhotoHashes();
  }
});

test('uploads: each photo is uploaded once and sent by id; a refused upload sends the bytes and stops uploading', async () => {
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { Uploads } = await import('../../src/core/llm/uploads.js');
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const uploads = new Uploads(ws);
  /** @type {string[]} */
  const posted = [];
  /** @type {any[]} */
  const bodies = [];
  let fail = false;
  const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
    posted.push(url);
    if (url.endsWith('/v1/files')) return fail ? new Response('no', { status: 403 }) : new Response(JSON.stringify({ id: `file_${posted.length}`, expires_at: new Date(Date.now() + 172_800_000).toISOString() }));
    bodies.push(JSON.parse(init.body));
    return new Response('');
  };
  const t = httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }], {
    uploadRequest: (/** @type {any} */ c) => { const f = new FormData(); f.set('file', new Blob([c.bytes], { type: c.mediaType }), c.name); return { url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: f }; },
    readUpload: (/** @type {any} */ j) => ({ id: j.id, expiresAt: Date.parse(j.expires_at) }),
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
  });
  const withPhoto = { messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }] }] };
  const m = model({ input: ['text', 'image'] });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (get), uploads });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (get), uploads });
  assert.equal(posted.filter((u) => u.endsWith('/v1/files')).length, 1);
  assert.deepEqual(bodies.map((b) => b.images[0]), ['file_1', 'file_1']);
  fail = true;
  await uploads.forget('pv-1/chat');
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (get), uploads });
  assert.equal(bodies.at(-1).images[0], 'bytes');
  assert.equal(uploads.isOff('pv-1/chat'), true);
  // Switched off on the endpoint: nothing is uploaded.
  const off = new Uploads(ws);
  await callOnce({ type: t, endpoint: endpoint({ id: 'pv-2/chat', tunables: { uploads: false } }), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (get), uploads: off });
  assert.equal(posted.filter((u) => u.endsWith('/v1/files')).length, 2);
  assert.equal(bodies.at(-1).images[0], 'bytes');
});

test("a chat photo's upload limit (UPLOAD_MS) only catches a hang: a request photo of 1 MiB, the default cap until 2026-11-21 and more than it now, goes up on 2G EDGE's uplink (the second opinion's lead 1 on openrouter-f1)", async () => {
  const { UPLOAD_MS } = await import('../../src/core/llm/uploads.js');
  const { DEFAULT_PHOTO_SETTINGS } = await import('../../src/core/photos.js');
  // 8,388,608 bits in UPLOAD_MS is the slowest uplink it lets through: 70 kbit/s is 59% of the 118.4 kbit/s published for EDGE (EGPRS multislot
  // class 10, two uplink slots at MCS-9; the 1-slot 59.2 kbit/s would need 142 s). A limit that cuts the link a photo needs is no hang guard: the
  // inline photo is a third larger and would stall there too.
  assert.ok(DEFAULT_PHOTO_SETTINGS.request.maxBytes <= 1024 * 1024);
  const slowest = (1024 * 1024 * 8) / (UPLOAD_MS / 1000);
  assert.ok(slowest <= 70_000, `a 1 MiB photo needs ${Math.round(slowest)} bit/s up to finish in ${UPLOAD_MS / 1000} s`);
});

test("a photo's upload has a time limit of its own (UPLOAD_MS): a stall ends it, the photo and the request's other new one go in the request, and both are held there, so the next call makes no try for them; a Stop still stops (review of openrouter-f1, L1)", async () => {
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { Uploads, UPLOAD_MS } = await import('../../src/core/llm/uploads.js');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  // AbortSignal.timeout can't be driven by fake timers: ask for its limit, make it short, and keep the signal it returns.
  const real = AbortSignal.timeout;
  /** @type {number[]} */
  const asked = [];
  /** @type {AbortSignal[]} */
  const made = [];
  AbortSignal.timeout = (ms) => { asked.push(ms); const s = real.call(AbortSignal, 20); made.push(s); return s; };
  try {
    /** @type {any[]} */
    const got = [];
    /** @type {any[]} */
    const bodies = [];
    const t = httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }], {
      uploadRequest: (/** @type {any} */ c) => { const f = new FormData(); f.set('file', new Blob([c.bytes], { type: c.mediaType }), c.name); return { url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: f }; },
      readUpload: (/** @type {any} */ j) => ({ id: j.id }),
      build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
    });
    // An upload that is accepted and never answered ends only when its signal does (a signal that isn't the limit's fails at once, not after a hang).
    const stalled = async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (!url.endsWith('/v1/files')) {
        bodies.push(JSON.parse(init.body));
        return new Response('');
      }
      got.push(init.signal);
      if (!made.includes(init.signal)) throw new Error('the upload has no time limit: a stall would wait for ever');
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const withPhoto = { messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }, { type: 'image', mediaType: 'image/webp', data: 'AAAB', hash: 'h2' }] }] };
    const m = model({ input: ['text', 'image'] });
    const uploads = new Uploads(ws);
    await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (stalled), uploads });
    assert.deepEqual(asked, [UPLOAD_MS], 'one upload was tried, with its own limit: the second photo is not tried once the link cut one');
    assert.equal(got.length, 1);
    assert.equal(got[0], made[0], 'the fetch got the limit it was made with');
    assert.deepEqual(bodies.map((b) => b.images), [['bytes', 'bytes']], 'both photos went in the request');
    assert.equal(uploads.isOff('pv-1/chat'), false, 'a cut is a hang, not a refusal: uploads are held there, not off');
    await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (stalled), uploads });
    // A hang is waited on once, not at each call (llm-rest-next's measurement: leaving uploads on after a cut paid it at every attempt).
    assert.deepEqual(asked, [UPLOAD_MS], 'the next call makes no upload try');
    assert.equal(got.length, 1);
    assert.deepEqual(bodies.map((b) => b.images), [['bytes', 'bytes'], ['bytes', 'bytes']], 'its photos went in the request');
    // A turn passes its own signal (loop.js), which never fires here: the limit still ends the stall, through the join. A throw inside the stub
    // is swallowed as a failed upload (a cut, or the link's quick failure), so whether the limit reached the upload is recorded there and asserted outside it.
    made.length = 0;
    bodies.length = 0;
    const joined = new Uploads(ws);
    /** @type {boolean[]} */
    const cut = [];
    const turn = new AbortController();
    const slow = async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (!url.endsWith('/v1/files')) {
        bodies.push(JSON.parse(init.body));
        return new Response('');
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { cut.push(true); reject(init.signal.reason); });
        setTimeout(() => reject(new Error('the limit did not reach the upload')), 1000);
      });
    };
    await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (slow), uploads: joined, signal: turn.signal });
    assert.deepEqual(cut, [true], 'the limit ends the upload of a call that passes its own signal, as every turn does');
    assert.deepEqual(bodies.map((b) => b.images), [['bytes', 'bytes']]);
    // held() holds the photo it is asked about while the endpoint waits for an answer; here the call was answered, so it only reads.
    assert.deepEqual([joined.isOff('pv-1/chat'), joined.held('pv-1/chat', await photoHash('AAAA'))], [false, true]);
    // The limit also ends an answer whose body stalls after its headers: the same cut, held, not off; a body broken off before the limit is the link's (below).
    bodies.length = 0;
    const bodyCut = new Uploads(ws);
    /** @type {boolean[]} */
    const bodyEnded = [];
    const hung = async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (!url.endsWith('/v1/files')) {
        bodies.push(JSON.parse(init.body));
        return new Response('');
      }
      return new Response(new ReadableStream({ start: (c) => {
        init.signal.addEventListener('abort', () => { bodyEnded.push(true); c.error(init.signal.reason); });
        setTimeout(() => c.error(new Error('the limit did not reach the answer')), 1000);
      } }));
    };
    await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (hung), uploads: bodyCut });
    assert.deepEqual(bodyEnded, [true], 'the limit ends the read of an answer too');
    assert.deepEqual(bodies.map((b) => b.images), [['bytes', 'bytes']]);
    assert.deepEqual([bodyCut.isOff('pv-1/chat'), bodyCut.held('pv-1/chat', await photoHash('AAAA'))], [false, true], 'a cut body read is the same hang (answered, so held() only reads)');
    asked.length = 0;
    // A Stop during the upload is a Stop: not a failed upload, which would turn uploads off and send the photo.
    asked.length = 0;
    made.length = 0;
    bodies.length = 0;
    const stop = new AbortController();
    const kept = new Uploads(ws);
    /** @type {boolean[]} */
    const reached = [];
    // The Stop is tapped inside the fetch, and whether the fetch's own signal knows it is recorded right then: the limit (20 ms here) would end
    // the request soon anyway, so only the join with the caller's signal ends it at once. The assert is outside the stub, where a throw is a cancel.
    const stoppable = async (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
      stop.abort();
      reached.push(init.signal.aborted);
    });
    await assert.rejects(callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ (withPhoto), fetch: /** @type {any} */ (stoppable), uploads: kept, signal: stop.signal }), (/** @type {any} */ e) => e.kind === 'cancelled');
    assert.deepEqual(reached, [true], 'a Stop ends the upload at once, not at its time limit');
    assert.equal(kept.isOff('pv-1/chat'), false, 'a Stop says nothing about uploads');
    // The endpoint isn't waiting after a Stop, so asking has no side effect here: a Stop holds nothing, and the photo is tried again.
    assert.equal(kept.held('pv-1/chat', await photoHash('AAAA')), false, 'a Stop holds nothing');
    assert.deepEqual(bodies, []);
  } finally {
    AbortSignal.timeout = real;
  }
});

test("an upload the link failed (not made, or its answer broken off) sends that photo as bytes and leaves uploads on, so the next request uploads it; one the provider refused, or answered with no upload, turns them off (llm-rest-next)", async () => {
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { Uploads } = await import('../../src/core/llm/uploads.js');
  const t = httpType([{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }], {
    uploadRequest: (/** @type {any} */ c) => { const f = new FormData(); f.set('file', new Blob([c.bytes], { type: c.mediaType }), c.name); return { url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: f }; },
    readUpload: (/** @type {any} */ j) => { if (!j.id) throw new Error('the upload answered without a file id'); return { id: j.id }; },
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
  });
  const m = model({ input: ['text', 'image'] });
  const withPhoto = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }] }] });
  /**
   * Two calls with the photo, the first upload answered so, a later one as the provider takes it: whether uploads were off after the first, and how
   * each call sent the photo. @param {() => Promise<Response>} first
   */
  const twice = async (first) => {
    const ws = new Workspace(createMemoryStore());
    await ensureBaseScopes(ws);
    const uploads = new Uploads(ws);
    /** @type {string[]} */
    const sent = [];
    let tries = 0;
    const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (url.endsWith('/v1/files')) return tries++ ? Response.json({ id: 'file_1' }) : first();
      sent.push(JSON.parse(init.body).images[0]);
      return new Response('');
    };
    const call = () => callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: withPhoto, fetch: /** @type {any} */ (get), uploads });
    await call();
    const off = uploads.isOff('pv-1/chat');
    await call();
    return { off, sent };
  };
  const enc = new TextEncoder();
  // The link's: no connection (the browser's own failure), or an answer whose body broke off.
  assert.deepEqual(await twice(async () => { throw new TypeError('Failed to fetch'); }), { off: false, sent: ['bytes', 'file_1'] }, 'not made');
  const broken = () => new Response(new ReadableStream({ start: (c) => { c.enqueue(enc.encode('{"id":"fi')); c.error(new TypeError('network error')); } }));
  assert.deepEqual(await twice(async () => broken()), { off: false, sent: ['bytes', 'file_1'] }, 'its answer broke off');
  // The provider's: a refusal, or an answer that is no upload.
  for (const [what, answer] of /** @type {const} */ ([['a 401', () => new Response('no', { status: 401 })], ['not JSON', () => new Response('<html>')], ['no id', () => Response.json({})]])) {
    assert.deepEqual(await twice(async () => answer()), { off: true, sent: ['bytes', 'bytes'] }, what);
  }
  // A photo uploaded before still goes by its id beside one whose upload the link failed: only new photos wait for the link.
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const uploads = new Uploads(ws);
  /** @type {string[][]} */
  const sent = [];
  let tries = 0;
  const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
    if (url.endsWith('/v1/files')) {
      if (tries++) throw new TypeError('Failed to fetch');
      return Response.json({ id: 'file_1' });
    }
    sent.push(JSON.parse(init.body).images);
    return new Response('');
  };
  const photo = (/** @type {string} */ data, /** @type {string} */ hash) => ({ type: 'image', mediaType: 'image/webp', data, hash });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: withPhoto, fetch: /** @type {any} */ (get), uploads });
  await callOnce({ type: t, endpoint: endpoint(), model: m, key: 'k', request: /** @type {any} */ ({ messages: [{ role: 'user', parts: [photo('AAAB', 'h2'), photo('AAAA', 'h1')] }] }), fetch: /** @type {any} */ (get), uploads });
  assert.deepEqual(sent, [['file_1'], ['bytes', 'file_1']]);
});

/**
 * The test clock (useClock), AbortSignal.timeout on it too: an upload that hangs ends at its limit of the test's time, at no real time. The
 * real one is on real time and can't measure 120 s here; this one aborts with the same TimeoutError. A limit made for an upload that
 * succeeds is never cleared, so it fires up to UPLOAD_MS of test time later, at a request that is already done: harmless, and no test that
 * measures a wait has a successful upload before it. @param {import('node:test').TestContext} t
 */
const onTestClock = (t) => {
  useClock(t);
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return c.signal;
  };
  t.after(() => { AbortSignal.timeout = real; });
};

/** What the chat failing in each way of heldKit ends in; any other error out of a call is a crash. */
const CHAT_FAILS = { down: 'unreachable', slow: 'timeout' };

/**
 * Calls with photos, by endpoint id, to a files service that answers as `files` says ('hang': only its time limit ends it; a status; 'ok': an
 * upload, `file_<try>`) and a chat that answers as `chat` says ('ok'; 'down': not made; 'slow': a link too slow for photos, a request that
 * sends one as bytes is never answered and ends at its wait, one with none is answered), the model's answer being as `step` says ('end': text,
 * which ends a turn; 'tool': a call to a tool, which goes on). call gives how the request sent each photo (its upload id, or 'bytes'), or
 * 'failed'; last, how the last request sent them, answered or not; tries counts the uploads made; model is the model called.
 */
const heldKit = async () => {
  const { Workspace } = await import('../../src/core/workspace.js');
  const { ensureBaseScopes } = await import('../../src/core/scopes.js');
  const { Uploads } = await import('../../src/core/llm/uploads.js');
  const ws = new Workspace(createMemoryStore());
  await ensureBaseScopes(ws);
  const t = httpType([], {
    uploadRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: new Blob([c.bytes]) }),
    readUpload: (/** @type {any} */ j) => ({ id: j.id }),
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.filter((/** @type {any} */ p) => p.type === 'image').map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
    read: async function* () {
      if (k.step === 'tool') yield* [{ type: 'tool_call', id: 'c1', name: 'read', input: {} }, { type: 'stop', reason: 'tool' }];
      else yield* [{ type: 'text', text: 'ok' }, { type: 'stop', reason: 'end' }];
    },
  });
  const k = {
    ws,
    uploads: new Uploads(ws),
    /** @type {'hang' | 'ok' | number} */
    files: /** @type {'hang' | 'ok' | number} */ ('ok'),
    /** @type {'ok' | 'down' | 'slow'} */
    chat: /** @type {'ok' | 'down' | 'slow'} */ ('ok'),
    /** @type {'end' | 'tool'} */
    step: /** @type {'end' | 'tool'} */ ('end'),
    model: model({ input: ['text', 'image'] }),
    tries: 0,
    /** @type {string[]} */
    last: [],
    /** @param {string} at the endpoint's id @param {...string} photos each photo's data @returns {Promise<string[] | 'failed'>} */
    call: async (at, ...photos) => {
      /** @type {string[] | 'failed'} */
      let sent = 'failed';
      const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
        if (url.endsWith('/v1/files')) {
          k.tries++;
          if (k.files === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
          return typeof k.files === 'number' ? new Response('busy', { status: k.files }) : Response.json({ id: `file_${k.tries}` });
        }
        k.last = JSON.parse(init.body).images;
        if (k.chat === 'down') throw new TypeError('Failed to fetch');
        if (k.chat === 'slow' && k.last.includes('bytes')) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        sent = k.last;
        return new Response('');
      };
      const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is this?' }, ...photos.map((data) => ({ type: 'image', mediaType: 'image/webp', data, hash: data }))] }] };
      // Only the chat's own failure is let go as 'failed': any other error (a crash in what the call does after it) is the test's to see.
      await callOnce({ type: t, endpoint: endpoint({ id: at, provider: at.split('/')[0] }), model: k.model, key: 'k', request: /** @type {any} */ (request), fetch: /** @type {any} */ (get), uploads: k.uploads }).catch((e) => {
        if (!(e instanceof ProviderError && e.kind === CHAT_FAILS[/** @type {'down' | 'slow'} */ (k.chat)])) throw e;
      });
      return sent;
    },
  };
  return k;
};

test('a cut upload holds uploads at its endpoint until a turn ends in an answer to a request that sent a photo as bytes there: the photo cut, and any first seen while it waits, go as bytes there from then on (for their window) and the next new photo is uploaded; another endpoint is not held, and a photo uploaded before goes by its id meanwhile (upload-rest-next)', async (t) => {
  onTestClock(t);
  const k = await heldKit();
  k.files = 'hang';
  assert.deepEqual(await k.call('pv-1/chat', 'AAAA'), ['bytes'], 'cut: the photo goes in the request, which is answered');
  assert.equal(k.tries, 1);
  k.files = 'ok';
  assert.deepEqual(await k.call('pv-1/chat', 'AAAA', 'AAAB'), ['bytes', 'file_2'], 'the cut photo stays as bytes; the next new one is uploaded');
  assert.deepEqual(await k.call('pv-1/chat', 'AAAA', 'AAAB'), ['bytes', 'file_2'], 'and goes by its id after');
  assert.equal(k.tries, 2);
  assert.equal(k.uploads.isOff('pv-1/chat'), false);
  // Cut on a link that answers nothing: no photo is tried there until its provider answers, a second model at the same endpoint included. The photo
  // uploaded before (AAAB) goes by its id while the endpoint waits, beside the cut one and a new one as bytes: held() holds what it is asked about
  // while the endpoint waits, so a check of it that comes before the known id would send AAAB as bytes, and this call shows it.
  k.files = 'hang';
  k.chat = 'down';
  assert.equal(await k.call('pv-1/chat', 'AAAC'), 'failed');
  assert.equal(k.tries, 3);
  k.files = 'ok';
  k.model = model({ id: 'm-2', providerId: 'test-2', input: ['text', 'image'] });
  assert.equal(await k.call('pv-1/chat', 'AAAB', 'AAAC', 'AAAD'), 'failed', 'a second model there');
  assert.deepEqual(k.last, ['file_2', 'bytes', 'bytes'], 'while the endpoint waits: the photo uploaded before goes by its id, the cut one and the new one as bytes');
  assert.equal(k.tries, 3, 'no try while the endpoint waits for its provider');
  k.model = model({ input: ['text', 'image'] });
  k.chat = 'ok';
  assert.deepEqual(await k.call('pv-2/chat', 'AAAA'), ['file_4'], 'another endpoint is not held: the photo held at pv-1 is uploaded at pv-2');
  assert.deepEqual(await k.call('pv-1/chat', 'AAAD', 'AAAF'), ['bytes', 'bytes'], 'still held there: its provider answers this one');
  assert.equal(k.tries, 4);
  assert.deepEqual(await k.call('pv-1/chat', 'AAAC', 'AAAD', 'AAAF', 'AAAG', 'AAAB'), ['bytes', 'bytes', 'bytes', 'file_5', 'file_2'], 'the cut photo, and AAAD and AAAF that were first seen while it waited, stay as bytes after the answer; only a photo new since that answer is uploaded; one uploaded before goes by its id');
});

test('an upload answered 408, 429 or a server error (500, 502, 503, 504) holds uploads there the same way: that photo and the request\'s other new ones go as bytes without a try, and stay as bytes for their window after the answer, and the next new photo is uploaded (upload-rest-next)', async (t) => {
  onTestClock(t);
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const k = await heldKit();
    k.files = status;
    assert.deepEqual(await k.call('pv-1/chat', 'AAAA', 'AAAB'), ['bytes', 'bytes'], `${status}`);
    assert.equal(k.tries, 1, `${status}: the request's other new photo is not tried`);
    k.files = 'ok';
    assert.deepEqual(await k.call('pv-1/chat', 'AAAA', 'AAAB', 'AAAC'), ['bytes', 'bytes', 'file_2'], `${status}: answered, the next new photo is uploaded, and the two before stay as bytes`);
    assert.equal(k.uploads.isOff('pv-1/chat'), false, `${status}`);
  }
});

test('a refused upload (any other 4xx) still turns uploads off there through any answer, until a Test passes, a new key or address, or a restart, as before; each of these ends a hold too (upload-rest-next)', async (t) => {
  onTestClock(t);
  const { Uploads } = await import('../../src/core/llm/uploads.js');
  for (const status of [400, 401, 403, 404, 413]) {
    const k = await heldKit();
    k.files = status;
    assert.deepEqual(await k.call('pv-1/chat', 'AAAA'), ['bytes'], `${status}`);
    k.files = 'ok';
    assert.deepEqual(await k.call('pv-1/chat', 'AAAA', 'AAAB'), ['bytes', 'bytes'], `${status}: an answer brings nothing back`);
    assert.deepEqual([k.tries, k.uploads.isOff('pv-1/chat')], [1, true], `${status}`);
  }
  /** @type {[string, (k: Awaited<ReturnType<typeof heldKit>>) => void][]} */
  const ends = [['a Test that passes', (k) => k.uploads.retry('pv-1/chat')], ['a new key or address', (k) => k.uploads.retry('pv-1')], ['a restart', (k) => { k.uploads = new Uploads(k.ws); }]];
  for (const [what, end] of ends) {
    for (const first of /** @type {const} */ ([403, 'hang'])) {
      const k = await heldKit();
      k.files = first;
      k.chat = 'down'; // a hold stays: nothing answered since
      await k.call('pv-1/chat', 'AAAA');
      // What the end ends: off for a refusal, a hold for a hang (held() holds what it is asked about while the endpoint waits; AAAA is held already, so it only reads).
      assert.equal(first === 403 ? k.uploads.isOff('pv-1/chat') : k.uploads.held('pv-1/chat', await photoHash('AAAA')), true, `${what} after ${first}: before it, ${first === 403 ? 'off' : 'held'}`);
      k.files = 'ok';
      k.chat = 'ok';
      end(k);
      assert.deepEqual(await k.call('pv-1/chat', 'AAAA'), ['file_2'], `${what} after ${first}`);
    }
  }
});

test('a files service that hangs at every upload while chat answers costs one wait of UPLOAD_MS a turn that brings new photos, whatever its steps and models, and none for a turn with none, on the test clock; a link that answers nothing costs one until an answer to a request that sent a photo (upload-rest-next)', async (t) => {
  onTestClock(t);
  const { UPLOAD_MS } = await import('../../src/core/llm/uploads.js');
  // On main a cut turned uploads off until a restart: one wait in all, and every later photo as bytes in the request.
  /** What each turn waited, on the test clock: each turn its steps, each step the photos its request carries (its turn's and the turn before's). @param {Awaited<ReturnType<typeof heldKit>>} k @param {string[][][]} turns */
  const waited = async (k, turns) => {
    /** @type {number[]} */
    const out = [];
    for (const steps of turns) {
      const t0 = Date.now();
      for (const photos of steps) await k.call('pv-1/chat', ...photos);
      out.push(Date.now() - t0);
    }
    return out;
  };
  const k = await heldKit();
  k.files = 'hang';
  assert.deepEqual(await waited(k, [
    [['AAAA'], ['AAAA'], ['AAAA']], // a new photo, three steps
    [['AAAA'], ['AAAA']], // no new photo: the turn before's goes again
    [['AAAB'], ['AAAB']], // a new photo
    [['AAAB', 'AAAC', 'AAAD'], ['AAAB', 'AAAC', 'AAAD']], // two new ones, and the turn before's
  ]), [UPLOAD_MS, 0, UPLOAD_MS, UPLOAD_MS]);
  assert.equal(k.tries, 3, 'one try a turn with new photos');
  assert.deepEqual(await k.call('pv-1/chat', 'AAAB', 'AAAC', 'AAAD'), ['bytes', 'bytes', 'bytes']);
  // Nothing answers: one wait (two models at the endpoint in a turn), none until a request that sent a photo is answered; then the next new photo's.
  const dead = await heldKit();
  dead.files = 'hang';
  dead.chat = 'down';
  assert.deepEqual(await waited(dead, [[['AAAE'], ['AAAE']], [['AAAE', 'AAAF']]]), [UPLOAD_MS, 0]);
  dead.chat = 'ok';
  assert.deepEqual(await waited(dead, [[['AAAF', 'AAAG']], [['AAAH']]]), [0, UPLOAD_MS], 'the turn its provider answers tries nothing; the next new photo is tried');
  assert.equal(dead.tries, 2);
});

test('a turn whose steps each bring a new photo (a closer look, a photo Shiori reads) pays one wait of UPLOAD_MS, not one a step: only an answer that ends the turn, one that calls no tool, lets the next new photo be uploaded (upload-rest-next, review F1)', async (t) => {
  onTestClock(t);
  const k = await heldKit();
  k.files = 'hang';
  /** The seconds each step of a turn took, on the test clock: each step the photos its request carries (a tool's picture comes with the step after it) and what the model answers. @param {[string[], 'end' | 'tool'][]} steps */
  const turn = async (steps) => {
    /** @type {number[]} */
    const out = [];
    for (const [photos, step] of steps) {
      k.step = step;
      const t0 = Date.now();
      await k.call('pv-1/chat', ...photos);
      out.push((Date.now() - t0) / 1000);
    }
    return out;
  };
  // The traveller's photo, then three steps that each bring one more by a tool; the last answers in text. On main: 120, 0, 0, 0 (then off for good).
  assert.deepEqual(await turn([[['AAAA'], 'tool'], [['AAAA', 'AAAB'], 'tool'], [['AAAA', 'AAAB', 'AAAC'], 'tool'], [['AAAA', 'AAAB', 'AAAC', 'AAAD'], 'end']]), [120, 0, 0, 0]);
  assert.equal(k.tries, 1, 'one try in the turn');
  assert.deepEqual(k.last, ['bytes', 'bytes', 'bytes', 'bytes']);
  // The turn after, with a new photo: its end lifted the wait, so that one is tried.
  assert.deepEqual(await turn([[['AAAE'], 'tool'], [['AAAE', 'AAAF'], 'end']]), [120, 0]);
  assert.equal(k.tries, 2);
});

test('a link too slow for photos pays the wait for one new photo at a time, not once more after each answer to a request with no photo in it: only a request that sent a photo as bytes, answered, lets the next new photo be uploaded (upload-rest-next, review F2)', async (t) => {
  onTestClock(t);
  /** The seconds a call with these photos took, on the test clock. @param {Awaited<ReturnType<typeof heldKit>>} k @param {...string} photos */
  const secs = async (k, ...photos) => {
    const t0 = Date.now();
    await k.call('pv-1/chat', ...photos);
    return Math.round((Date.now() - t0) / 1000);
  };
  // A photo's upload is cut at UPLOAD_MS (120 s), and its request at the model's wait (30 s, plus the milliseconds its body takes at SLOW_UPLINK).
  const k = await heldKit();
  k.files = 'hang';
  k.chat = 'slow';
  const out = [await secs(k, 'AAAA')];
  await k.call('pv-1/chat'); // a small request is answered: a title, a line of Koe's, the traveller's "hello?"
  out.push(await secs(k, 'AAAB'));
  await k.call('pv-1/chat');
  out.push(await secs(k, 'AAAC'));
  assert.deepEqual(out, [150, 30, 30], 'with an answer between each, as with none (main: 150, 30, 30)');
  assert.equal(k.tries, 1, 'one try');
  const none = await heldKit();
  none.files = 'hang';
  none.chat = 'slow';
  assert.deepEqual([await secs(none, 'AAAA'), await secs(none, 'AAAB'), await secs(none, 'AAAC')], [150, 30, 30], 'with none between');
  // The link carries a photo again: the answer to a request that sent one as bytes lets the next new photo be uploaded.
  none.chat = 'ok';
  none.files = 'ok';
  assert.deepEqual(await none.call('pv-1/chat', 'AAAA'), ['bytes']);
  assert.deepEqual(await none.call('pv-1/chat', 'AAAD'), ['file_2']);
});

/** A request whose photo goes in the body (no files API), its data n base64 characters. @param {number} n @returns {any} */
const photoRequest = (n) => ({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/jpeg', data: 'A'.repeat(n) }] }] });
/**
 * A fetch whose answer's headers come ms after it is asked (its body going up until then), ended by its signal as a browser's is;
 * sent: the bodies it was given. @param {number} ms @param {() => Response} [answer]
 */
const answersAfter = (ms, answer = () => new Response('streamed')) => {
  /** @type {string[]} */
  const sent = [];
  const get = (/** @type {string} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    sent.push(init.body);
    const t = ms === Infinity ? undefined : setTimeout(() => done(answer()), ms);
    init.signal?.addEventListener('abort', () => { clearTimeout(t); fail(init.signal.reason); }, { once: true });
  });
  return Object.assign(get, { sent });
};
/** An HTTP endpoint type whose answer gives these events, then nothing more until it is stopped. @param {any[]} events */
const stallsAfter = (events) => httpType([], { read: async function* () { for (const e of events) yield e; await new Promise(() => {}); } });
const seesPhotos = model({ input: ['text', 'image'] });

test("the model's wait starts once the provider has the whole request: a body slower to send than the wait, answered at once when it is in, is the reply (the user's photo to Shiori, 2026-11-20)", async () => {
  // A 20 KB body: 2.3 s to send at the slow link the wait allows for, so the provider's answer at 600 ms is well within it, and long past the 100 ms wait.
  const get = answersAfter(600);
  const reply = await callOnce({ type: httpType([{ type: 'text', text: 'A pelican.' }, { type: 'stop', reason: 'end' }]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(20_000), fetch: /** @type {any} */ (get), firstOutputMs: 100 });
  assert.equal(reply.text, 'A pelican.');
});

test("a request whose body never finishes sending ends once the wait and the body's time on a slow link are up, in words that name the connection and the photos; with no photo, as no output in time", async () => {
  const { SLOW_UPLINK } = await import('../../src/core/llm/uploads.js');
  const get = answersAfter(Infinity);
  const started = performance.now();
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(1_000), fetch: /** @type {any} */ (get), firstOutputMs: 100 }), (/** @type {any} */ e) => {
    assert.equal(e.kind, 'timeout');
    assert.deepEqual(e.said, { code: 'send', seconds: 1 });
    assert.equal(e.shown, 'No answer in 1 second. The connection may be too slow to send photos or files.');
    assert.equal(e.message, 'No answer in 1 second. The connection may be too slow to send photos or files.');
    return true;
  });
  const sendMs = (new TextEncoder().encode(get.sent[0]).byteLength * 8 * 1000) / SLOW_UPLINK;
  assert.ok(sendMs > 100, `the body takes ${sendMs} ms at the slow link`);
  assert.ok(performance.now() - started >= 100 + sendMs - 2, `it waited ${Math.round(performance.now() - started)} ms, for the wait and the send's ${Math.round(sendMs)} ms`);
  // Text alone, or a photo sent by its upload's id: the send is no likelier than a slow model, so a server that never streams still says what
  // its note tells the user to look for.
  const byId = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/jpeg', data: 'A'.repeat(1_000), hash: 'h1', fileId: 'file-1' }] }] };
  for (const [what, r] of /** @type {const} */ ([['text', request], ['by id', byId]])) {
    await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: /** @type {any} */ (r), fetch: /** @type {any} */ (answersAfter(Infinity)), firstOutputMs: 100 }),
      (/** @type {any} */ e) => e.kind === 'timeout' && e.said?.code === 'late' && e.message === 'No output started in time.', what);
  }
});

test("once the provider has answered, the wait is the model's alone: no output within it ends as no output in time, and output that stops part-way as stopped, never later for the body's size", async () => {
  for (const [events, code] of /** @type {[any[], string][]} */ ([[[], 'late'], [[{ type: 'text', text: 'A peli' }], 'paused']])) {
    const started = performance.now();
    // A 20 KB body (2.3 s at the slow link): the answer's headers at once, then nothing more.
    await assert.rejects(callOnce({ type: stallsAfter(events), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(20_000), fetch: /** @type {any} */ (answersAfter(0)), firstOutputMs: 100 }),
      (/** @type {any} */ e) => e.kind === 'timeout' && e.said?.code === code);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${code}: it ended ${Math.round(ms)} ms in, by the model's 100 ms wait from the answer`);
  }
});

// photo-wait's follow-ups (the Deferred entry "Two other waits still count the sending, and the photo words' two edges").

test("the card's seconds are the wait and the send's time together: a body whose time at the slow link makes them 1.5 s or more says 2 seconds, not the wait's (4)", async () => {
  // About 12.6 KB: 1.45 s at 70 kbit/s, and the 100 ms wait: 1.55 s, so 2 seconds; the wait alone would round to 0, shown as 1.
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(12_500), fetch: /** @type {any} */ (answersAfter(Infinity)), firstOutputMs: 100 }),
    (/** @type {any} */ e) => e.said?.code === 'send' && e.said.seconds === 2 && e.shown === 'No answer in 2 seconds. The connection may be too slow to send photos or files.');
});

test("a PDF going up is a send as a photo's is: cut, it says the connection may be too slow to send photos or files ('send', which rests no model), not no output in time (6)", async () => {
  const pdf = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'When is check-in?' }, { type: 'document', mediaType: 'application/pdf', data: 'J'.repeat(1_000), name: 'booking.pdf' }] }] };
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model({ input: ['text', 'pdf'] }), key: 'k', request: /** @type {any} */ (pdf), fetch: /** @type {any} */ (answersAfter(Infinity)), firstOutputMs: 100 }),
    (/** @type {any} */ e) => e.kind === 'timeout' && e.said?.code === 'send' && e.message === 'No answer in 1 second. The connection may be too slow to send photos or files.');
});

test("a recording going up is a send as a photo's is: cut, it says the connection may be too slow to send photos or files ('send'), not no output in time (photo-wait's follow-ups, 6: a model that takes audio too)", async () => {
  const recording = { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: 'audio/wav', data: 'U'.repeat(1_000) }] }] };
  await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: model({ input: ['text', 'audio'] }), key: 'k', request: /** @type {any} */ (recording), fetch: /** @type {any} */ (answersAfter(Infinity)), firstOutputMs: 100 }),
    (/** @type {any} */ e) => e.kind === 'timeout' && e.said?.code === 'send' && e.message === 'No answer in 1 second. The connection may be too slow to send photos or files.');
});

test("a photo, a PDF or a recording in the turns a kept chain already holds isn't sent, so a text request after it that gets no answer is no output in time, not the files' send (3)", async () => {
  const old = {
    photo: photoRequest(1_000).messages[0],
    PDF: { role: 'user', parts: [{ type: 'text', text: 'When is check-in?' }, { type: 'document', mediaType: 'application/pdf', data: 'J'.repeat(1_000), name: 'booking.pdf' }] },
    recording: { role: 'user', parts: [{ type: 'audio', mediaType: 'audio/wav', data: 'U'.repeat(1_000) }] },
  };
  for (const [what, first] of Object.entries(old)) {
    const request = { messages: [first, { role: 'assistant', parts: [{ type: 'text', text: 'A pelican.' }] }, { role: 'user', parts: [{ type: 'text', text: 'Where is it from?' }] }] };
    // A provider that keeps turns (OpenAI Responses, Gemini): the request sends only what comes after the turn it continues.
    const keeps = httpType([], { keeps: { days: 30 }, build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { previous: c.kept?.id, messages: c.request.messages.slice(c.kept?.from ?? 0) } }) });
    const kept = { isOff: () => false, match: async () => ({ id: 'resp-1', from: 2 }), off: () => {}, ended: () => {}, record: async () => 'kept' };
    const get = answersAfter(Infinity);
    await assert.rejects(callOnce({ type: keeps, endpoint: endpoint(), model: model({ input: ['text', 'image', 'pdf', 'audio'] }), key: 'k', request: /** @type {any} */ (request), fetch: /** @type {any} */ (get), firstOutputMs: 100, keep: /** @type {any} */ ({ kept, scope: 'trip-a', chain: true, secret: 's' }) }),
      (/** @type {any} */ e) => e.kind === 'timeout' && e.said?.code === 'late' && e.message === 'No output started in time.', what);
    assert.ok(!get.sent[0].includes(/** @type {any} */ (first.parts.at(-1)).data.slice(0, 4)) && get.sent[0].includes('resp-1'), `the ${what} stayed with the kept turn`);
  }
});

test("a send beside the other half's on the same link (shared) has the time of twice its bytes: answered after its own bytes' time but within twice it, it is the reply; alone, the send ran out (5)", async () => {
  // About 5.2 KB: 0.59 s at the slow link, so 0.69 s with the 100 ms wait alone, 1.28 s shared; the provider has it at 0.95 s.
  const ask = (/** @type {boolean} */ shared) => callOnce({ type: httpType([{ type: 'text', text: 'A pelican.' }, { type: 'stop', reason: 'end' }]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(5_000), fetch: /** @type {any} */ (answersAfter(950)), firstOutputMs: 100, shared });
  assert.equal((await ask(true)).text, 'A pelican.');
  await assert.rejects(ask(false), (/** @type {any} */ e) => e.said?.code === 'send');
});

test("a send that never ends is cut at the wait plus its bytes' time at the slow link, twice that beside the other half's (shared), and the card says those seconds: both edges, exactly (5, 4)", async (t) => {
  useClock(t); // a clock that moves only by its timers: the end is exact, whatever the machine's speed
  // About 12.6 KB: 1.46 s at 70 kbit/s alone, 2.92 s shared; with the 100 ms wait, 1.56 s (2 seconds on the card) and 3.02 s (3).
  for (const [shared, seconds] of /** @type {const} */ ([[false, 2], [true, 3]])) {
    const get = answersAfter(Infinity);
    const started = Date.now();
    await assert.rejects(callOnce({ type: httpType([]), endpoint: endpoint(), model: seesPhotos, key: 'k', request: photoRequest(12_500), fetch: /** @type {any} */ (get), firstOutputMs: 100, shared }),
      (/** @type {any} */ e) => e.said?.code === 'send' && e.said.seconds === seconds && e.shown === `No answer in ${seconds} seconds. The connection may be too slow to send photos or files.`, `shared ${shared}`);
    const bytes = new TextEncoder().encode(get.sent[0]).byteLength;
    assert.equal(Date.now() - started, 100 + Math.ceil((bytes * (shared ? 2 : 1) * 8 * 1000) / SLOW_UPLINK), `shared ${shared}: the wait and the send's time`);
  }
});
