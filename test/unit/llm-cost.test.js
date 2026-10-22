import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_USAGE, mergeUsage, addUsage, costOf, addCost } from '../../src/core/llm/cost.js';
import { LEVELS, ROLE_LEVELS, nearestLevel, levelPatch } from '../../src/core/llm/reasoning.js';

/** @param {number | undefined} a @param {number} b */
const close = (a, b) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('cost is usage × prices per million tokens, by kind of token (spec §9.9)', () => {
  const prices = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 };
  const usage = { ...NO_USAGE, input: 1000, cacheRead: 10_000, cacheWrite: 2000, cacheWrite1h: 1000, output: 500, reasoning: 200 };
  close(costOf(usage, prices), (1000 * 2 + 10_000 * 0.1 + 2000 * 2.5 + 1000 * 4 + 500 * 10) / 1e6);
});

test('a long prompt is priced by its tier', () => {
  const prices = { input: 0.1, output: 0.5, cacheRead: 0.01, tiers: [{ above: 99_999, input: 0.5, output: 2.5, cacheRead: 0.05 }] };
  close(costOf({ ...NO_USAGE, input: 50_000, output: 1000 }, prices), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, input: 90_000, cacheRead: 60_000, output: 1000 }, prices), (90_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
});

test('missing cache prices fall back to the input price; a reported cost wins; no prices is unknown', () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheWrite: 1000, cacheWrite1h: 1000 }, { input: 1, output: 1 }), 3000 / 1e6);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.5 }, { input: 1, output: 1 }), 0.5);
  assert.equal(costOf({ ...NO_USAGE, input: 1000 }, null), undefined);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, cost: 0.25 }, null), 0.25);
  assert.equal(costOf({ ...NO_USAGE, input: 1000, output: 10 }, { input: 0, output: 0 }), 0);
});

test('mergeUsage keeps the latest number of each kind; addUsage and addCost sum calls', () => {
  const a = mergeUsage(mergeUsage({ ...NO_USAGE }, { input: 50, cacheRead: 8000, output: 1 }), { output: 7 });
  assert.deepEqual(a, { ...NO_USAGE, input: 50, cacheRead: 8000, output: 7 });
  assert.equal(mergeUsage(a, { cost: 0.01 }).cost, 0.01);
  assert.deepEqual(addUsage(a, { ...NO_USAGE, input: 1, output: 1, reasoning: 2 }), { ...NO_USAGE, input: 51, cacheRead: 8000, output: 8, reasoning: 2 });
  assert.equal(addCost(undefined, undefined), undefined);
  assert.equal(addCost(undefined, 0.5), 0.5);
  close(addCost(0.25, 0.5), 0.75);
});

test('audio tokens are priced by audioIn and audioOut, else as input and output; usage carries them only when a report gives them (K4)', () => {
  const live = { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 };
  close(costOf({ ...NO_USAGE, input: 1000, audioIn: 2000, output: 100, audioOut: 500 }, live), (1000 * 0.75 + 2000 * 3 + 100 * 4.5 + 500 * 12) / 1e6);
  close(costOf({ ...NO_USAGE, input: 1000, audioIn: 2000, output: 100, audioOut: 500 }, { input: 1, output: 2 }), (3000 * 1 + 600 * 2) / 1e6);
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { input: 5 }), { ...NO_USAGE, input: 5 }, 'no audio fields for a call without audio');
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { audioIn: 7, audioOut: 9 }), { ...NO_USAGE, audioIn: 7, audioOut: 9 });
  assert.deepEqual(addUsage({ ...NO_USAGE, audioIn: 7 }, { ...NO_USAGE, audioIn: 1, audioOut: 2 }), { ...NO_USAGE, audioIn: 8, audioOut: 2 });
  assert.deepEqual(addUsage({ ...NO_USAGE, input: 1 }, { ...NO_USAGE, input: 2 }), { ...NO_USAGE, input: 3 });
});

test("a realtime model's image and video tokens are priced by its image price, else as input (review)", () => {
  close(costOf({ ...NO_USAGE, input: 1000, image: 2000 }, { input: 0.75, image: 1, output: 4.5 }), (1000 * 0.75 + 2000 * 1) / 1e6);
  close(costOf({ ...NO_USAGE, input: 1000, image: 2000 }, { input: 0.75, output: 4.5 }), (3000 * 0.75) / 1e6);
  assert.deepEqual(addUsage({ ...NO_USAGE, image: 3 }, { ...NO_USAGE, image: 4 }), { ...NO_USAGE, image: 7 });
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { image: 5 }), { ...NO_USAGE, image: 5 });
});

test("a realtime model's cached audio tokens are priced by cacheReadAudio, else as cache reads, else as audio in (OpenAI's mini: $0.30 against $0.06 for cached text) (K6)", () => {
  const mini = { input: 0.6, cacheRead: 0.06, cacheReadAudio: 0.3, audioIn: 10, output: 2.4, audioOut: 20 };
  close(costOf({ ...NO_USAGE, input: 100, cacheRead: 1000, cacheReadAudio: 2000, audioIn: 50, output: 10, audioOut: 300 }, mini), (100 * 0.6 + 1000 * 0.06 + 2000 * 0.3 + 50 * 10 + 10 * 2.4 + 300 * 20) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadAudio: 2000 }, { input: 4, cacheRead: 0.4, audioIn: 32 }), (2000 * 0.4) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadAudio: 2000 }, { input: 4, audioIn: 32 }), (2000 * 32) / 1e6);
  assert.deepEqual(mergeUsage({ ...NO_USAGE }, { cacheReadAudio: 5 }), { ...NO_USAGE, cacheReadAudio: 5 });
  assert.deepEqual(addUsage({ ...NO_USAGE, cacheReadAudio: 3 }, { ...NO_USAGE }), { ...NO_USAGE, cacheReadAudio: 3 });
});

test("a realtime model's cached image tokens are priced by cacheReadImage, else as cache reads, else as images (OpenAI's: $0.50 against $0.40 for cached text) (review)", () => {
  close(costOf({ ...NO_USAGE, cacheRead: 1000, cacheReadImage: 2000 }, { input: 4, cacheRead: 0.4, cacheReadImage: 0.5, image: 5 }), (1000 * 0.4 + 2000 * 0.5) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadImage: 2000 }, { input: 4, cacheRead: 0.4, image: 5 }), (2000 * 0.4) / 1e6);
  close(costOf({ ...NO_USAGE, cacheReadImage: 2000 }, { input: 4, image: 5 }), (2000 * 5) / 1e6);
  assert.deepEqual(addUsage({ ...NO_USAGE, cacheReadImage: 3 }, { ...NO_USAGE, cacheReadImage: 4 }), { ...NO_USAGE, cacheReadImage: 7 });
});

test("reasoning levels: the model's own, else the nearest, the cheaper on a tie (spec §9.3)", () => {
  assert.deepEqual(LEVELS, ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(ROLE_LEVELS, { main: 'medium', utility: 'low', decide: 'off', 'koe-classic': 'low', 'koe-realtime': 'off' });
  const map = { low: { e: 'low' }, high: { e: 'high' } };
  assert.equal(nearestLevel(map, 'low'), 'low');
  assert.equal(nearestLevel(map, 'medium'), 'low', 'a tie goes to the cheaper level');
  assert.equal(nearestLevel(map, 'max'), 'high');
  assert.equal(nearestLevel(map, 'off'), 'low');
  assert.equal(nearestLevel({}, 'medium'), null);
  assert.equal(nearestLevel(undefined, 'medium'), null);
  assert.deepEqual(levelPatch(map, 'max'), { e: 'high' });
  assert.equal(levelPatch({}, 'high'), null);
});

test("a provider marked free tier costs nothing: a call's reply and trace, and a speech call's (the free-tier switch)", async () => {
  const { callOnce } = await import('../../src/core/llm/call.js');
  const { speechCall } = await import('../../src/core/llm/speech.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { modelTrace } = await import('../../src/core/llm/trace.js');
  const { SYS } = await import('../../src/core/scopes.js');
  const { providerOf, endpointOf, newProvider } = await import('../../src/core/llm/config.js');
  const rec = newProvider('provider-gemini', { template: { version: '2.0.0', values: { name: 'Google Gemini', baseUrl: 'https://llm.test', abilities: { chat: { kind: 'chat', type: 'run' }, voice: { kind: 'voice', type: 'say' } } } }, user: { free: true } });
  assert.equal(providerOf(rec).free, true);
  assert.equal(providerOf({ ...rec, user: {} }).free, false);
  const endpoint = endpointOf(rec, 'chat');
  assert.equal(endpoint.free, true, "every ability's calls");
  const model = { id: 'm-1', provider: rec.id, ability: 'chat', name: 'Flash', providerId: 'flash', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
  const store = createMemoryStore();
  const type = /** @type {any} */ ({ type: 'run', name: 'Run', pluginId: 'p', run: async function* () { yield { type: 'text', text: 'Hi' }; yield { type: 'usage', usage: { input: 1000, output: 1000 } }; yield { type: 'stop', reason: 'end' }; } });
  const reply = await callOnce({ type, endpoint, model, key: null, request: { messages: [] }, trace: modelTrace(store, SYS) });
  assert.equal(reply.cost, 0);
  assert.equal((await callOnce({ type, endpoint: { ...endpoint, free: false }, model, key: null, request: { messages: [] } })).cost, 3000 / 1e6, 'the same call on a paid key');
  const say = /** @type {any} */ ({ type: 'say', name: 'Say', pluginId: 'p', speech: 'out', speechRequest: () => ({ url: 'https://llm.test/say', headers: {}, body: '{}' }), readSpeech: async () => ({ data: new Uint8Array(1), mediaType: 'audio/wav' }) });
  const spoken = await speechCall({ type: say, endpoint: endpointOf(rec, 'voice'), model: { ...model, prices: { perMillionChars: 10 } }, key: null, text: 'Hello there.', fetch: async () => new Response(new Uint8Array(1)), trace: modelTrace(store, SYS) });
  assert.equal(spoken.cost, 0);
  const costs = (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS))).map((/** @type {any} */ e) => e.data.cost);
  assert.deepEqual(costs, [0, 0], 'the trace says free, and Spend per day adds nothing');
});
