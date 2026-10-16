import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { callRole, candidates, Bench, AllFailedError, COOLDOWN_MS, continueAfter } from '../../src/core/llm/fallback.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** A fresh scripted endpoint type, as the plugin registers it. @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}

/**
 * A config with one scripted endpoint per script, one model on each, and those models in main.
 * @param {any[][]} scripts @param {{ models?: any[], types?: [string, any][] , endpointTypes?: string[] }} [opts]
 */
function setup(scripts, { models = [], types = [], endpointTypes = [] } = {}) {
  /** @type {any} */
  const config = { endpoints: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  scripts.forEach((script, i) => {
    config.endpoints[`ep-${i}`] = { id: `ep-${i}`, type: endpointTypes[i] ?? 'scripted', template: null, user: { name: `E${i}`, tunables: { script } }, created: 0 };
    config.models[`m-${i}`] = { id: `m-${i}`, endpoint: `ep-${i}`, template: null, user: { providerId: `model-${i}`, prices: { input: 1, output: 1 }, ...(models[i] ?? {}) }, created: 0 };
    config.roles.main.models.push(`m-${i}`);
  });
  /** @type {number[]} */
  const waits = [];
  let clock = 1_000_000;
  const store = createMemoryStore();
  return {
    config, waits, store,
    bench: new Bench(),
    types: new Map([['scripted', scriptedType()], ...types]),
    tick: (/** @type {number} */ ms) => { clock += ms; },
    base: () => ({ config, types: undefined, bench: undefined, keyFor: async () => null, sleep: async (/** @type {number} */ ms) => { waits.push(ms); }, now: () => clock, trace: modelTrace(store, SYS) }),
  };
}
/** @type {any} */
const hello = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }] };
/** @param {ReturnType<typeof setup>} s @param {any} [over] */
const call = (s, over = {}) => callRole({ ...s.base(), types: s.types, bench: s.bench, role: 'main', request: hello, ...over });

test('the first model that answers is the answer, with no fallback', async () => {
  const s = setup([[{ text: 'Hi from A.' }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from A.');
  assert.equal(r.answeredBy, 'model-0');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['ok']);
});

test('out of credit: the next model answers, and the first one rests (benched) for a while', async () => {
  const s = setup([[{ error: 'credit', status: 402 }], [{ text: 'Hi from B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, 'Hi from B.');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['credit', 'ok']);
  const again = await call(s);
  assert.deepEqual(again.attempts.map((a) => a.outcome), ['benched', 'ok']);
  s.tick(COOLDOWN_MS + 1);
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['credit', 'ok']);
  const turns = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }))).map((e) => e.data.answeredBy);
  assert.deepEqual(turns, ['model-1', 'model-1', 'model-1']);
});

test('overloaded: two quick retries, then the next model', async () => {
  const s = setup([[{ error: 'overloaded' }, { error: 'overloaded' }, { text: 'Third time lucky.' }]]);
  assert.equal((await call(s)).reply.text, 'Third time lucky.');
  assert.deepEqual(s.waits, [500, 1500]);
  const t = setup([[{ error: 'overloaded' }], [{ text: 'B.' }]]);
  const r = await call(t);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['overloaded', 'overloaded', 'overloaded', 'ok']);
  assert.deepEqual(t.waits, [500, 1500]);
});

test('rate-limited: a short wait is waited out; a long one benches the model for that long', async () => {
  const s = setup([[{ error: 'rate', retryAfter: 2000 }, { text: 'After the wait.' }]]);
  assert.equal((await call(s)).reply.text, 'After the wait.');
  assert.deepEqual(s.waits, [2000]);
  const t = setup([[{ error: 'rate', retryAfter: 60_000 }], [{ text: 'B.' }]]);
  assert.equal((await call(t)).reply.text, 'B.');
  assert.deepEqual(t.waits, []);
  assert.equal(t.bench.until('m-0'), 1_000_000 + 60_000);
});

test('a model that declines has still answered', async () => {
  const s = setup([[{ text: "I can't help with that." }], [{ text: 'B.' }]]);
  const r = await call(s);
  assert.equal(r.reply.text, "I can't help with that.");
  assert.equal(r.attempts.length, 1);
});

test("models that can't take the request are skipped: photos, tools, a window too small", async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }], [{ text: 'C.' }], [{ text: 'D.' }]], {
    models: [{}, { input: ['text', 'image'], tools: false }, { input: ['text', 'image'], contextWindow: 10 }, { input: ['text', 'image'] }],
  });
  const request = {
    messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }, { type: 'text', text: 'What is this?' }] }],
    tools: [{ name: 'look', description: 'Look.', input: { type: 'object' } }],
  };
  const r = await call(s, { request });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-images', 'no-tools', 'too-long', 'ok']);
  assert.equal(r.reply.text, 'D.');
});

test('a reply cut off partway is continued by the next model, without repeating it (spec §9.6)', async () => {
  /** @type {any} */
  let seen = null;
  const spy = /** @type {any} */ ({
    type: 'spy', name: 'Spy', pluginId: 'spy',
    run: async function* (/** @type {any} */ c) {
      seen = c.request;
      yield { type: 'text', text: ' the old capital.' };
      yield { type: 'stop', reason: 'end' };
    },
  });
  const s = setup([[{ text: 'Kyoto is', cut: true }], []], { types: [['spy', spy]], endpointTypes: ['scripted', 'spy'] });
  /** @type {string[]} */
  const streamed = [];
  const r = await call(s, { onEvent: (/** @type {any} */ e) => { if (e.type === 'text') streamed.push(e.text); } });
  assert.equal(r.reply.text, 'Kyoto is the old capital.');
  assert.equal(streamed.join(''), 'Kyoto is the old capital.');
  assert.match(seen.messages.at(-1).parts[0].text, /You had already said: "Kyoto is✂"/);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['network', 'ok']);
  assert.equal(continueAfter(hello, 'x').messages.length, 2);
});

test('when every model fails: AllFailedError with every attempt, and the trace still has the turn', async () => {
  const s = setup([[{ error: 'credit' }], [{ error: 'auth' }]]);
  await assert.rejects(call(s), (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'credit,auth');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.answeredBy, null);
  assert.equal(turn.data.attempts.length, 2);
});

test('an empty chat role uses the main list; other roles have only their own', () => {
  /** @type {any} */
  const config = { roles: { main: { models: ['a', 'b'], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: ['c'], level: 'off' } } };
  assert.deepEqual(candidates(config, 'utility'), ['a', 'b']);
  assert.deepEqual(candidates(config, 'decide'), ['c']);
  assert.deepEqual(candidates(config, 'speech-out'), []);
});

test('stopping a call stops the fallback too', async () => {
  const s = setup([[{ delayMs: 1000, text: 'Too late.' }], [{ text: 'B.' }]]);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(call(s, { signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled');
});

test('stopping keeps what the model had said so far, in the error and in the trace (spec §6.7)', async () => {
  const sayThenWait = { type: 'hang', name: 'Hang', pluginId: 'hang', async *run() { yield { type: 'text', text: 'Kyoto is' }; await new Promise(() => {}); } };
  const s = setup([[]], { types: [['hang', sayThenWait]], endpointTypes: ['hang'] });
  const stop = new AbortController();
  await assert.rejects(call(s, { signal: stop.signal, onEvent: () => stop.abort() }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled' && e.partial === 'Kyoto is');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turn.data.stored, ['reply']);
  const blob = await s.store.tx(['blobs'], 'readonly', (t) => t.getBlob(turn.refs[0]));
  assert.equal(new TextDecoder().decode(blob?.data), 'Kyoto is');
});

test('a timeout benches the model and the next one answers', async () => {
  const s = setup([[{ delayMs: 500, text: 'Slow.' }], [{ text: 'B.' }]]);
  const r = await call(s, { firstOutputMs: 20 });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
  assert.ok(s.bench.until('m-0') > 1_000_000);
});

test("a role's own wait for the first words decides when a slow model is passed over", async () => {
  const s = setup([[{ delayMs: 1500, text: 'Slow.' }], [{ text: 'B.' }]]);
  s.config.roles.main.firstOutputSeconds = 1;
  const r = await call(s);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['timeout', 'ok']);
});

test('the trace keeps what the answering model reasoned', async () => {
  const s = setup([[{ reasoning: 'They want a greeting.', text: 'Hi.' }]]);
  await call(s);
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turn.data.stored, ['reply', 'reasoning']);
});

test('a model whose endpoint type is missing is skipped', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { endpointTypes: ['gone', 'scripted'] });
  assert.deepEqual((await call(s)).attempts.map((a) => a.outcome), ['type-missing', 'ok']);
});
