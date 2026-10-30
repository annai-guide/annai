import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError, errorFromResponse, explain, explainPlain, KINDS, portable } from '../../src/core/llm/contract.js';
import { callOnce, nativeKey, forEndpoint, withoutNatives } from '../../src/core/llm/call.js';
import { callRole, Bench, levelOf } from '../../src/core/llm/fallback.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

// Claude's reply as it came, kept beside annai's parts within a turn (the keep-reasoning design §4, §5, §8).

const endpoint = (over = {}) => ({ id: 'pv-1/chat', provider: 'pv-1', ability: 'chat', type: 'test', name: 'Test provider', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {}, ...over });
const model = (over = {}) => ({ id: 'm-1', provider: 'pv-1', ability: 'chat', name: 'Test model', providerId: 'test-1', input: ['text', 'image'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over });
/** @param {any} store */
const traced = async (store) => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS));

/**
 * An HTTP endpoint type that records what it is given, places the tail itself, and answers with these events (a `native` among them).
 * @param {any[]} seen @param {(c: any) => any[]} events
 */
const nativeType = (seen, events) => /** @type {any} */ ({
  type: 'test', name: 'Test', pluginId: 'test-plugin', tail: true,
  build: (/** @type {any} */ c) => { seen.push(structuredClone(c.request)); return { url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: {} }; },
  read: async function* (/** @type {any} */ _res, /** @type {any} */ c) { for (const e of events(c)) yield e; },
  classify: (/** @type {number} */ _s, /** @type {string} */ body) => (/too long/.test(body) ? 'context' : null),
});
const ok = async () => new Response('streamed');
/** callOnce with test requests written loosely. @param {any} c */
const once = (c) => callOnce(c);
const answer = (/** @type {string} */ text, content = [{ type: 'thinking', signature: `sig:${text}` }]) => () => [{ type: 'text', text }, { type: 'native', content }, { type: 'stop', reason: 'end' }];

test("the 'reasoning' kind has words for a model and for the screens, and is annai's own: a plugin cannot give it", () => {
  const e = new ProviderError('reasoning', 'messages.1.content.0: Invalid `signature` in `thinking` block.');
  assert.equal(explainPlain(e), 'The provider refused the reasoning annai sent back.');
  assert.equal(explain(e), 'The provider refused the reasoning annai sent back.');
  assert.ok(!KINDS.has('reasoning'));
});

test('portable() keeps a native and the parts it covers as they are, and drops what it drops elsewhere', () => {
  const native = { type: 'native', endpoint: 'e', content: [{ type: 'thinking' }], covers: 2, prefix: 'p' };
  const msgs = /** @type {any[]} */ ([
    { role: 'assistant', parts: [native, { type: 'provider', block: { type: 'server_tool_use' }, model: 'claude-a' }, { type: 'tool_call', id: 'a.b', name: 'x', input: {} }, { type: 'provider', block: { type: 'other' }, model: 'claude-a' }] },
  ]);
  assert.deepEqual(portable(msgs, 'claude-b'), [{ role: 'assistant', parts: [native, msgs[0].parts[1], { type: 'tool_call', id: 'a_b', name: 'x', input: {} }] }]);
});

test("a native is made for a caller that asks, from the plugin's native event: its endpoint, content, the parts it covers and a fingerprint", async () => {
  const seen = /** @type {any[]} */ ([]);
  const type = nativeType(seen, answer('Hi'));
  const request = { system: 'S', tail: '<now>1</now>', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] };
  const kept = await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request, fetch: ok, keepNative: true });
  assert.deepEqual(kept.native && { ...kept.native, prefix: typeof kept.native.prefix }, { endpoint: await nativeKey(endpoint(), 'sk-1'), content: [{ type: 'thinking', signature: 'sig:Hi' }], covers: 1, prefix: 'string' });
  assert.ok(String(kept.native?.endpoint).startsWith('pv-1/chat|'));
  assert.notEqual(await nativeKey(endpoint(), 'sk-2'), await nativeKey(endpoint(), 'sk-1'), 'another key is another endpoint');
  const plain = await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request, fetch: ok });
  assert.equal(plain.native, undefined, 'none unless asked for');
  assert.deepEqual(plain.parts, [{ type: 'text', text: 'Hi' }], 'never among the parts');
});

/** A turn's second request: the first reply, its native first, and the now block that went before it. @param {any} native @param {string} [said] */
const second = (native, said = 'Hello') => ({
  system: 'S', tail: '<now>2</now>',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: said }, { type: 'text', text: '<now>1</now>', now: true }] },
    { role: 'assistant', parts: [native, { type: 'tool_call', id: 'c1', name: 'look', input: {} }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'seen' }] },
  ],
});

/** The first step of a turn, then its native as the transcript keeps it. */
async function firstStep(over = {}) {
  const seen = /** @type {any[]} */ ([]);
  const type = nativeType(seen, () => [{ type: 'tool_call', id: 'c1', name: 'look', input: {} }, { type: 'native', content: [{ type: 'thinking', signature: 's1' }, { type: 'tool_use', id: 'c1' }] }, { type: 'stop', reason: 'tool' }]);
  const r = await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request: { system: 'S', tail: '<now>1</now>', messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] }, fetch: ok, keepNative: true, ...over });
  return { native: { type: 'native', ...r.native }, seen, type };
}

test('the next request of the turn carries the native and its now block to the same endpoint, and the trace counts it', async () => {
  const { native, seen, type } = await firstStep();
  const store = createMemoryStore();
  const r = await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request: second(native), fetch: ok, keepNative: true, trace: modelTrace(store, SYS) });
  assert.equal(r.natives, undefined);
  assert.deepEqual(seen.at(-1).messages, second(native).messages, 'sent as the transcript holds it');
  const [ev] = await traced(store);
  assert.deepEqual(ev.data.natives, { sent: 1, changed: false });
  assert.ok(!JSON.stringify(ev).includes('s1'), 'the trace has counts only');
});

test('another endpoint or key never gets a native, nor the now blocks before one; a model on the same endpoint does', async () => {
  const { native, seen, type } = await firstStep();
  for (const [ep, key] of /** @type {const} */ ([[endpoint({ id: 'pv-2/chat' }), 'sk-1'], [endpoint(), 'sk-other']])) {
    const store = createMemoryStore();
    await once({ type, endpoint: ep, model: model(), key, request: second(native), fetch: ok, trace: modelTrace(store, SYS) });
    assert.deepEqual(seen.at(-1).messages, [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'look', input: {} }] },
      { role: 'user', parts: [{ type: 'tool_result', id: 'c1', content: 'seen' }] },
    ], 'exactly as before natives existed');
    assert.equal((await traced(store))[0].data.natives, undefined, 'nothing to count');
  }
  await once({ type, endpoint: endpoint(), model: model({ id: 'm-2', providerId: 'test-2' }), key: 'sk-1', request: second(native), fetch: ok });
  assert.equal(seen.at(-1).messages[1].parts[0].type, 'native', "another model on the endpoint: the API drops what it can't read");
});

test('forEndpoint keeps a now block only where the reply right after it begins with a native of this endpoint', () => {
  const n = (/** @type {string} */ e) => ({ type: 'native', endpoint: e, content: [], covers: 1, prefix: '' });
  const msgs = /** @type {any[]} */ ([
    { role: 'user', parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'now1', now: true }] },
    { role: 'assistant', parts: [n('A'), { type: 'text', text: 'r1' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'c', content: 'x' }, { type: 'text', text: 'now2', now: true }] },
    { role: 'assistant', parts: [n('B'), { type: 'text', text: 'r2' }] },
    { role: 'user', parts: [{ type: 'tool_result', id: 'd', content: 'y' }, { type: 'text', text: 'now3', now: true }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'r3' }] },
  ]);
  const texts = (/** @type {any[]} */ m) => m.flatMap((x) => x.parts.map((/** @type {any} */ p) => (p.type === 'native' ? `n${p.endpoint}` : p.text ?? p.type)));
  assert.deepEqual(texts(forEndpoint(msgs, 'A')), ['a', 'now1', 'nA', 'r1', 'tool_result', 'r2', 'tool_result', 'r3']);
  assert.deepEqual(texts(forEndpoint(msgs, 'B')), ['a', 'r1', 'tool_result', 'now2', 'nB', 'r2', 'tool_result', 'r3']);
  assert.deepEqual(texts(withoutNatives(msgs)), ['a', 'r1', 'tool_result', 'r2', 'tool_result', 'r3']);
});

test('the check: a native whose earlier messages changed is not sent, nor any other this turn, and the reply and the trace say so', async () => {
  const { native, seen, type } = await firstStep();
  const store = createMemoryStore();
  const r = await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request: second(native, 'Hello again'), fetch: ok, keepNative: true, trace: modelTrace(store, SYS) });
  assert.equal(r.natives, 'changed');
  assert.ok(!JSON.stringify(seen.at(-1)).includes('"native"') && !JSON.stringify(seen.at(-1)).includes('<now>1</now>'), 'no native, no kept now block');
  assert.deepEqual((await traced(store))[0].data.natives, { sent: 0, changed: true });
  // A changed system text, tools, or a now block in another place change it too; the level does not.
  for (const changed of [{ ...second(native), system: 'S2' }, { ...second(native), tools: [{ name: 'x', description: 'd', input: {} }] }]) {
    assert.equal((await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request: changed, fetch: ok })).natives, 'changed');
  }
  assert.equal((await once({ type, endpoint: endpoint(), model: model(), key: 'sk-1', request: second(native), level: 'high', fetch: ok })).natives, undefined);
});

test('photos count by their hash, so an upload in place of the bytes changes nothing; a photo replaced does', async () => {
  const photo = { type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' };
  const seen = /** @type {any[]} */ ([]);
  const type = nativeType(seen, () => [{ type: 'text', text: 'x' }, { type: 'native', content: [{ type: 'thinking', signature: 's' }] }, { type: 'stop', reason: 'end' }]);
  const first = await once({ type, endpoint: endpoint(), model: model(), key: null, request: { messages: [{ role: 'user', parts: [photo] }] }, fetch: ok, keepNative: true });
  const native = { type: 'native', ...first.native };
  const next = (/** @type {any} */ p) => ({ messages: [{ role: 'user', parts: [p] }, { role: 'assistant', parts: [native, { type: 'text', text: 'x' }] }, { role: 'user', parts: [{ type: 'text', text: 'more' }] }] });
  assert.equal((await once({ type, endpoint: endpoint(), model: model(), key: null, request: next({ ...photo, fileId: 'file_1' }), fetch: ok })).natives, undefined);
  assert.equal((await once({ type, endpoint: endpoint(), model: model(), key: null, request: next({ ...photo, hash: 'h2', data: 'BBBB' }), fetch: ok })).natives, 'changed');
});

test("a 400 on a request that sent natives is 'reasoning' whatever it says; on one that sent none, or that kept its natives back, an ordinary bad request; a size error is its own", async () => {
  const type = nativeType([], () => []);
  const refuse = (/** @type {string} */ message) => async () => new Response(JSON.stringify({ error: { message } }), { status: 400 });
  const plain = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] };
  await assert.rejects(once({ type, endpoint: endpoint(), model: model(), key: null, request: plain, fetch: refuse('Invalid `signature` in `thinking` block') }),
    (e) => e instanceof ProviderError && e.kind === 'bad-request', 'no native sent: the same words are a bad request');
  const { native } = await firstStep({ key: null });
  const sentOne = once({ type, endpoint: endpoint(), model: model(), key: null, request: second(native), fetch: refuse('max_tokens: must be positive') });
  await assert.rejects(sentOne, (e) => e instanceof ProviderError && e.kind === 'reasoning', 'a native sent: words that say nothing about it');
  await assert.rejects(once({ type, endpoint: endpoint(), model: model(), key: null, request: second(native, 'Hello again'), fetch: refuse('max_tokens: must be positive') }),
    (e) => e instanceof ProviderError && e.kind === 'bad-request', 'the check kept the natives back: none was sent');
  await assert.rejects(once({ type, endpoint: endpoint(), model: model(), key: null, request: second(native), fetch: refuse('prompt is too long: 300000 tokens') }),
    (e) => e instanceof ProviderError && e.kind === 'context', 'a size error goes its own way');
});

test("cacheAt names the same message after messages another model can't read are left out", async () => {
  const seen = /** @type {any[]} */ ([]);
  const type = nativeType(seen, () => [{ type: 'text', text: 'x' }, { type: 'stop', reason: 'end' }]);
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'a' }] },
    { role: 'assistant', parts: [{ type: 'provider', block: {}, model: 'other' }] },
    { role: 'user', parts: [{ type: 'text', text: 'b' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'c' }] },
    { role: 'user', parts: [{ type: 'text', text: 'd' }] },
  ];
  await once({ type, endpoint: endpoint(), model: model(), key: null, request: { messages, cacheAt: 2 }, fetch: ok });
  assert.equal(seen.at(-1).cacheAt, 1);
  assert.equal(seen.at(-1).messages[1].parts[0].text, 'b');
  await once({ type, endpoint: endpoint(), model: model(), key: null, request: { messages, cacheAt: 1 }, fetch: ok });
  assert.equal(seen.at(-1).cacheAt, undefined, 'its message is gone: no mark');
});

// callRole (§8): a refused reasoning is asked again of the same model, once, without any native.

/** @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}

test("callRole: the provider refuses the reasoning sent back: the same model again without it, no rest and no other model; the reply says so", async () => {
  const seen = /** @type {any[]} */ ([]);
  let refused = 0;
  const type = nativeType(seen, () => [{ type: 'text', text: 'Fine.' }, { type: 'native', content: [{ type: 'thinking', signature: 'new' }] }, { type: 'stop', reason: 'end' }]);
  const config = /** @type {any} */ ({
    providers: {
      a: { id: 'a', plugin: 'p', template: null, user: { name: 'A', baseUrl: 'https://llm.test', abilities: { chat: { kind: 'chat', type: 'test' } } }, created: 0 },
      b: { id: 'b', plugin: 'p', template: null, user: { name: 'B', abilities: { chat: { kind: 'chat', type: 'scripted', tunables: { script: [{ text: 'From B.' }] } } } }, created: 0 },
    },
    models: {
      'm-a': { id: 'm-a', provider: 'a', ability: 'chat', template: null, user: { providerId: 'claude-x', input: ['text'] }, created: 0 },
      'm-b': { id: 'm-b', provider: 'b', ability: 'chat', template: null, user: { providerId: 'other', input: ['text'] }, created: 0 },
    },
    roles: { main: { models: ['m-a', 'm-b'], level: 'high' } },
  });
  assert.equal(levelOf(config, 'main'), 'high');
  assert.equal(levelOf(config, 'utility'), 'low', "a role without one: annai's default");
  const bench = new Bench();
  const store = createMemoryStore();
  const here = await nativeKey(endpoint({ id: 'a/chat' }), null);
  // The first request it is sent refuses the reasoning; with none, it answers.
  const fetch = async (/** @type {string} */ _u, /** @type {any} */ _init) => {
    if (JSON.stringify(seen.at(-1)).includes('"native"')) {
      refused++;
      return new Response(JSON.stringify({ error: { message: 'Something nobody planned for.' } }), { status: 400 });
    }
    return new Response('streamed');
  };
  const native = { type: 'native', endpoint: here, content: [{ type: 'thinking', signature: 'old' }], covers: 1, prefix: 'whatever' };
  const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }, { role: 'assistant', parts: [native, { type: 'text', text: 'Hm.' }] }, { role: 'user', parts: [{ type: 'text', text: 'And?' }] }] };
  // The check is passed by giving the prefix it computes: a refusal the check can't see (the design §8).
  const first = await once({ type, endpoint: { ...endpoint({ id: 'a/chat' }) }, model: model({ providerId: 'claude-x' }), key: null, request: { messages: request.messages.slice(0, 1) }, fetch: ok, keepNative: true });
  native.prefix = /** @type {any} */ (first.native).prefix;
  const r = await callRole(/** @type {any} */ ({ role: 'main', request, config, types: new Map([['test', type], ['scripted', scriptedType()]]), keyFor: async () => null, bench, fetch, trace: modelTrace(store, SYS), sleep: async () => {}, keepNative: true }));
  assert.equal(refused, 1);
  assert.equal(r.modelId, 'm-a', 'the same model answered');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['reasoning', 'ok']);
  assert.match(String(r.attempts[0].error), /Something nobody planned for/);
  assert.equal(r.reply.natives, 'refused');
  assert.equal(bench.until('m-a'), 0, 'not rested');
  assert.ok(!JSON.stringify(seen.at(-1)).includes('"native"'), 'asked again without it');
});

test("callRole: a second 400 goes the normal bad-request way: the next model is asked, and a 400 on a request with no natives is as it always was", async () => {
  const type = nativeType([], () => [{ type: 'text', text: 'Fine.' }, { type: 'native', content: [{ type: 'thinking', signature: 's' }] }, { type: 'stop', reason: 'end' }]);
  const config = /** @type {any} */ ({
    providers: {
      a: { id: 'a', plugin: 'p', template: null, user: { name: 'A', baseUrl: 'https://llm.test', abilities: { chat: { kind: 'chat', type: 'test' } } }, created: 0 },
      b: { id: 'b', plugin: 'p', template: null, user: { name: 'B', abilities: { chat: { kind: 'chat', type: 'scripted', tunables: { script: [{ text: 'From B.' }, { text: 'From B.' }] } } } }, created: 0 },
    },
    models: {
      'm-a': { id: 'm-a', provider: 'a', ability: 'chat', template: null, user: { providerId: 'claude-x', input: ['text'] }, created: 0 },
      'm-b': { id: 'm-b', provider: 'b', ability: 'chat', template: null, user: { providerId: 'other', input: ['text'] }, created: 0 },
    },
    roles: { main: { models: ['m-a', 'm-b'] } },
  });
  let asked = 0;
  const fetch = async () => { asked++; return new Response(JSON.stringify({ error: { message: 'Not for you.' } }), { status: 400 }); };
  const here = await nativeKey(endpoint({ id: 'a/chat' }), null);
  const first = await once({ type, endpoint: endpoint({ id: 'a/chat' }), model: model({ providerId: 'claude-x' }), key: null, request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] }, fetch: ok, keepNative: true });
  const native = { type: 'native', endpoint: here, content: [{ type: 'thinking', signature: 'old' }], covers: 1, prefix: /** @type {any} */ (first.native).prefix };
  const messages = [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }, { role: 'assistant', parts: [native, { type: 'text', text: 'Hm.' }] }, { role: 'user', parts: [{ type: 'text', text: 'And?' }] }];
  const types = new Map([['test', type], ['scripted', scriptedType()]]);
  const bench = new Bench();
  const r = await callRole(/** @type {any} */ ({ role: 'main', request: { messages }, config, types, keyFor: async () => null, bench, fetch, trace: modelTrace(createMemoryStore(), SYS), sleep: async () => {}, keepNative: true }));
  assert.equal(asked, 2, 'once with natives, once without: never a third');
  assert.deepEqual(r.attempts.map((a) => [a.model, a.outcome]), [['m-a', 'reasoning'], ['m-a', 'bad-request'], ['m-b', 'ok']]);
  // No natives in the request: the first 400 is a bad request, and the model is not asked again.
  asked = 0;
  const plain = await callRole(/** @type {any} */ ({ role: 'main', request: { messages: messages.slice(0, 1) }, config, types, keyFor: async () => null, bench: new Bench(), fetch, trace: modelTrace(createMemoryStore(), SYS), sleep: async () => {} }));
  assert.equal(asked, 1);
  assert.deepEqual(plain.attempts.map((a) => [a.model, a.outcome]), [['m-a', 'bad-request'], ['m-b', 'ok']]);
});
