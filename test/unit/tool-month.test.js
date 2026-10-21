import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callOnce, billMonth } from '../../src/core/llm/call.js';
import { gap } from '../../src/core/llm/fallback.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_DEVICE, SYS_SETTINGS } from '../../src/core/scopes.js';

// Provider tools that are paid only, and that have a monthly free allowance (G4): Google Search on Gemini, 5,000 a month
// free on a paid project, then $0.014 each; never on a free-tier key.

const T0 = Date.UTC(2026, 9, 21, 12, 0);
const SEARCH = { id: 'gemini-google-search', name: 'Google Search', kind: /** @type {const} */ ('search'), patch: { 'tools+': [{ type: 'google_search' }] }, pricePerCall: 0.014, usageKey: 'google_search', paidOnly: true, freePerMonth: 5000 };
const endpoint = (over = {}) => ({ id: 'pv-1/chat', provider: 'pv-1', ability: 'chat', type: 'test', name: 'Gemini', baseUrl: 'https://llm.test', headers: {}, tunables: {}, extraBody: {}, ...over });
const model = (over = {}) => ({ id: 'm-1', provider: 'pv-1', ability: 'chat', name: 'Flash', providerId: 'flash', input: ['text'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: { input: 1, output: 2 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [SEARCH], logprobs: false, images: {}, ...over });
/** @type {any} */
const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Is Nepenthe open?' }] }], providerTools: { kinds: ['search'] } };

async function kit() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const clock = { t: T0 };
  return { ws, clock, month: { bill: (/** @type {string} */ id, /** @type {number} */ n, /** @type {number} */ free) => billMonth(ws, id, n, free, clock.t) } };
}

/** An HTTP type whose reply searched `searches` times; the bodies it was sent. @param {number} searches */
function searching(searches) {
  /** @type {any[]} */
  const bodies = [];
  const type = /** @type {any} */ ({
    type: 'test', name: 'Test', pluginId: 'p',
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { model: c.model.providerId } }),
    read: async function* () {
      yield { type: 'text', text: 'Open till 10.' };
      yield { type: 'usage', usage: { input: 0, output: 0, serverTools: { google_search: searches } } };
      yield { type: 'stop', reason: 'end' };
    },
  });
  const fetch = async (/** @type {string} */ _u, /** @type {any} */ init) => { bodies.push(JSON.parse(init.body)); return new Response('', { status: 200 }); };
  return { type, fetch, bodies };
}

test('the first 5000 searches of a month cost nothing, then 0.014 each', async () => {
  const { month } = await kit();
  assert.equal(await month.bill(SEARCH.id, 4999, 5000), 0);
  assert.equal(await month.bill(SEARCH.id, 3, 5000), 2, 'the 5001st and 5002nd');
  assert.equal(await month.bill(SEARCH.id, 1, 5000), 1);
  assert.equal(await month.bill('another-tool', 1, 5000), 0, 'each tool counts on its own');
  assert.equal(await month.bill(SEARCH.id, 0, 5000), 0);
});

test('two calls counted at once are counted one after the other: none is lost, and the allowance is crossed once', async () => {
  const { ws, month } = await kit();
  const over = await Promise.all([month.bill(SEARCH.id, 3000, 5000), month.bill(SEARCH.id, 3000, 5000), month.bill(SEARCH.id, 1, 5000)]);
  assert.equal(over.reduce((a, b) => a + b, 0), 1001);
  assert.deepEqual((await ws.readJSON(SYS_DEVICE, '/llm/tool-calls.json')).counts, { [SEARCH.id]: 6001 });
});

test('a new month starts over', async () => {
  const { month, clock } = await kit();
  assert.equal(await month.bill(SEARCH.id, 5002, 5000), 2);
  clock.t = Date.UTC(2026, 10, 1, 0, 0, 1);
  assert.equal(await month.bill(SEARCH.id, 2, 5000), 0, 'November: 2 of 5000');
});

test("the count is this phone's, in /llm/tool-calls.json in This device: no backup carries it, and it keeps no history", async () => {
  const { ws, month } = await kit();
  await month.bill(SEARCH.id, 2, 5000);
  await month.bill(SEARCH.id, 3, 5000);
  assert.deepEqual(await ws.readJSON(SYS_DEVICE, '/llm/tool-calls.json'), { month: '2026-10', counts: { [SEARCH.id]: 5 } });
  assert.equal(await ws.readJSON(SYS_SETTINGS, '/llm/tool-calls.json').catch(() => undefined), undefined);
  assert.deepEqual(await ws.history(SYS_DEVICE, '/llm/tool-calls.json'), [], 'one count a month, no version per search');
  // A count annai can't read starts over, rather than failing the call.
  await ws.write(SYS_DEVICE, '/llm/tool-calls.json', { month: '2026-10', counts: 'nonsense' }, { author: 'system' });
  assert.equal(await billMonth(ws, SEARCH.id, 1, 5000, T0), 0);
});

test("a call's searches are priced past this phone's monthly allowance: free within it, $0.014 each after", async () => {
  const { month, ws } = await kit();
  await month.bill(SEARCH.id, 4999, 5000);
  const s = searching(3);
  const reply = await callOnce({ type: s.type, endpoint: endpoint(), model: model(), key: null, request, fetch: /** @type {any} */ (s.fetch), tally: ws });
  assert.equal(reply.usage.serverTools?.google_search, 3, 'the usage says how many it made');
  assert.equal(Number(reply.cost?.toFixed(6)), 0.028, 'two past the 5000');
  // Without a count to go by, every search is priced.
  const all = await callOnce({ type: s.type, endpoint: endpoint(), model: model(), key: null, request, fetch: /** @type {any} */ (s.fetch) });
  assert.equal(Number(all.cost?.toFixed(6)), 0.042);
});

test('a free-tier endpoint leaves paidOnly tools out of the body, and counts nothing', async () => {
  const { ws } = await kit();
  const s = searching(0);
  await callOnce({ type: s.type, endpoint: endpoint(), model: model(), key: null, request, fetch: /** @type {any} */ (s.fetch), tally: ws });
  await callOnce({ type: s.type, endpoint: endpoint({ free: true }), model: model(), key: null, request, fetch: /** @type {any} */ (s.fetch), tally: ws });
  assert.deepEqual(s.bodies.map((b) => b.tools ?? []), [[{ type: 'google_search' }], []]);
  assert.equal(await ws.readJSON(SYS_DEVICE, '/llm/tool-calls.json').catch(() => undefined), undefined);
  // A request that needs the tool skips a model whose key is on the free tier.
  const needs = { ...request, needsProviderTool: 'search' };
  assert.equal(gap(model(), needs, { free: true }), 'no-provider-tool');
  assert.equal(gap(model(), needs, { free: false }), null);
  assert.equal(gap(model(), needs), null);
});

test('searches Google reported are counted even when the call then fails (a cut after the search)', async () => {
  const { ws } = await kit();
  const type = /** @type {any} */ ({
    type: 'test', name: 'Test', pluginId: 'p',
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: {} }),
    read: async function* () {
      yield { type: 'usage', usage: { input: 0, output: 0, serverTools: { google_search: 2 } } };
      throw new ProviderError('network', 'The reply stopped before it finished.');
    },
  });
  await assert.rejects(callOnce({ type, endpoint: endpoint(), model: model(), key: null, request, fetch: async () => new Response('', { status: 200 }), tally: ws }), { kind: 'network' });
  assert.deepEqual((await ws.readJSON(SYS_DEVICE, '/llm/tool-calls.json')).counts, { [SEARCH.id]: 2 });
});

test("a request's size is estimated as a model is sent it: another model's search steps (35 KB each) don't make a 128K fallback look too small", async () => {
  const { estimateTokens } = await import('../../src/core/llm/fallback.js');
  const step = (/** @type {number} */ i) => ({ type: /** @type {const} */ ('provider'), block: { type: 'google_search_result', call_id: `s${i}`, signature: 'x'.repeat(35_000), result: [{ search_suggestions: 'y'.repeat(5_000) }] }, model: 'gemini-3.5-flash-lite' });
  /** @type {any} */
  const grounded = { messages: Array.from({ length: 10 }, (_, i) => [{ role: 'user', parts: [{ type: 'text', text: `Question ${i}?` }] }, { role: 'assistant', parts: [step(i), { type: 'text', text: `Answer ${i}.` }] }]).flat() };
  assert.ok(estimateTokens(grounded, 'gemini-3.5-flash-lite') > 100_000, 'the model that made them is sent them');
  assert.ok(estimateTokens(grounded, 'other-model') < 1000);
  assert.equal(gap(model({ providerId: 'other-model', contextWindow: 128_000, providerTools: [] }), grounded), null);
});
