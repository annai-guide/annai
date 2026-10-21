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
 * A config with one provider per script, its chat ability scripted, one model on each, and those models in main.
 * @param {any[][]} scripts @param {{ models?: any[], types?: [string, any][] , endpointTypes?: string[], off?: number[] }} [opts]
 *   endpointTypes: each chat ability's type; off: the providers whose chat ability is switched off
 */
function setup(scripts, { models = [], types = [], endpointTypes = [], off = [] } = {}) {
  /** @type {any} */
  const config = { providers: {}, models: {}, roles: { main: { models: [], level: 'medium' }, utility: { models: [], level: 'low' }, decide: { models: [], level: 'off' } } };
  scripts.forEach((script, i) => {
    const chat = { kind: 'chat', type: endpointTypes[i] ?? 'scripted', tunables: { script }, ...(off.includes(i) ? { on: false } : {}) };
    config.providers[`pv-${i}`] = { id: `pv-${i}`, plugin: 'provider-test', template: null, user: { name: `E${i}`, abilities: { chat } }, created: 0 };
    config.models[`m-${i}`] = { id: `m-${i}`, provider: `pv-${i}`, ability: 'chat', template: null, user: { providerId: `model-${i}`, prices: { input: 1, output: 1 }, ...(models[i] ?? {}) }, created: 0 };
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

test("a connection failure while the device is offline benches nobody and isn't retried; online, it still benches (emulator pass)", async () => {
  const s = setup([[{ error: 'unreachable', message: 'Failed to fetch' }], [{ error: 'network', message: 'The connection dropped.' }]]);
  await assert.rejects(call(s, { online: () => false }), (e) => e instanceof AllFailedError && e.attempts.map((a) => a.outcome).join() === 'unreachable,network');
  assert.deepEqual(s.waits, []);
  assert.equal(s.bench.until('m-0'), 0);
  assert.equal(s.bench.until('m-1'), 0);
  // Back online, the same failure is the model's (a server that is down): it rests, so turns don't wait on it.
  await assert.rejects(call(s, { online: () => true }));
  assert.ok(s.bench.until('m-0') > 1_000_000);
  assert.ok(s.bench.until('m-1') > 1_000_000);
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

test('a model of a switched-off ability is skipped as off, and the next model answers', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { off: [0], endpointTypes: ['gone', 'scripted'] });
  const r = await call(s);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['off', 'ok']);
  assert.equal(r.reply.text, 'B.');
});

test("a provider's key goes to its abilities, once per provider; with keyHeader it goes in that header, and the protocol gets none (decision 25)", async () => {
  /** @type {any[]} */
  const seen = [];
  const spy = { type: 'spy', name: 'Spy', pluginId: 'spy', async *run(/** @type {any} */ c) { seen.push({ key: c.key, headers: c.endpoint.headers, id: c.endpoint.id }); yield { type: 'text', text: 'ok' }; } };
  const s = setup([[]], { types: [['spy', spy]], endpointTypes: ['spy'] });
  /** @type {string[]} */
  const asked = [];
  await call(s, { keyFor: async (/** @type {string} */ id) => { asked.push(id); return 'sk-test-1'; } });
  assert.deepEqual(asked, ['pv-0']);
  assert.deepEqual(seen.at(-1), { key: 'sk-test-1', headers: {}, id: 'pv-0/chat' });
  s.config.providers['pv-0'].user.keyHeader = 'api-key';
  await call(s, { keyFor: async () => 'sk-test-1' });
  assert.deepEqual(seen.at(-1), { key: null, headers: { 'api-key': 'sk-test-1' }, id: 'pv-0/chat' });
});

test('a request that needs a provider tool skips models without one', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]], { models: [{}, { providerTools: [{ id: 'f', name: 'Fetch', kind: 'fetch', patch: {} }] }] });
  const r = await call(s, { request: { ...hello, providerTools: { kinds: ['fetch'] }, needsProviderTool: 'fetch' } });
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['no-provider-tool', 'ok']);
});

test('record: the model.turn carries the tag and wake, keeps the parts, and the result names the model', async () => {
  const s = setup([[{ text: 'Hi.', toolCalls: [{ name: 'sleep', input: {} }] }]]);
  const r = await call(s, { record: { tag: 'conversation', wake: 'w-1', keepParts: true } });
  assert.equal(r.modelId, 'm-0');
  const [turn] = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.equal(turn.data.tag, 'conversation');
  assert.equal(turn.data.wake, 'w-1');
  assert.deepEqual(turn.data.stored, ['reply', 'parts']);
  const blob = await s.store.tx(['blobs'], 'readonly', (t) => t.getBlob(turn.refs[1]));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(blob?.data)).map((/** @type {any} */ p) => p.type), ['text', 'tool_call']);
});

test('prefer: the model whose cache is warm is tried first (spec §9.6, switching back)', async () => {
  const s = setup([[{ text: 'A.' }], [{ text: 'B.' }]]);
  const r = await call(s, { prefer: 'm-1' });
  assert.equal(r.reply.text, 'B.');
  assert.deepEqual(r.attempts.map((a) => a.model), ['m-1']);
  assert.equal((await call(s, { prefer: 'm-gone' })).reply.text, 'A.');
});

test('an upload the provider no longer knows: the endpoint forgets its uploads, and the same model is tried once more (spec §9.9)', async () => {
  const s = setup([[{ error: 'upload', status: 404, message: 'File `file_1` not found.' }, { text: 'Seen.' }], [{ text: 'B.' }]]);
  let forgot = 0;
  const uploads = /** @type {any} */ ({ forget: async () => { forgot++; }, isOff: () => false, get: async () => null, set: async () => {}, off: () => {} });
  const r = await call(s, { uploads });
  assert.equal(r.reply.text, 'Seen.');
  assert.deepEqual(r.attempts.map((a) => [a.model, a.outcome]), [['m-0', 'upload'], ['m-0', 'ok']]);
  assert.equal(forgot, 1);
});

test("fix pass: a key sent in a header of its own (keyHeader) never reaches the trace, even under a header name that doesn't look like a credential and in an error that echoes it", async () => {
  const KEY = 'sk-test-access-code-0123456789';
  /** @type {any} */
  const echo = { type: 'echo', name: 'Echo', pluginId: 'echo', build: (/** @type {any} */ c) => ({ url: 'https://llm.example/v1/chat', headers: { ...c.endpoint.headers }, body: {} }), async *read() {} };
  const s = setup([[]], { types: [['echo', echo]], endpointTypes: ['echo'] });
  s.config.providers['pv-0'].user = { ...s.config.providers['pv-0'].user, baseUrl: 'https://llm.example/v1', keyHeader: 'X-Access-Code' };
  /** @type {any[]} */
  const sent = [];
  const fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    sent.push(init.headers);
    return new Response(JSON.stringify({ error: { message: `Bad X-Access-Code ${init.headers['X-Access-Code']}` } }), { status: 400 });
  };
  await assert.rejects(call(s, { keyFor: async () => KEY, fetch }));
  assert.equal(sent[0]['X-Access-Code'], KEY, 'the key went in its header');
  const events = await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS));
  assert.ok(events.length > 0);
  assert.ok(!JSON.stringify(events).includes(KEY), 'no trace entry holds it');
});

test('a model that refuses the audio format it was sent gets the same request again with WAV, once; the trace says what each attempt carried (Koe and Kokoro design, "Audio formats")', async () => {
  const refusal = { error: 'bad-request', status: 400, message: 'Invalid value: ogg. Valid formats are: [wav, mp3]' };
  const s = setup([[refusal, { text: 'Heard you.' }], [{ text: 'B heard you.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  /** @type {boolean[]} */
  const plain = [];
  /** The heard speech as a resolver gives it: Ogg, or WAV when plain. @param {any} _m @param {any} _r @param {boolean} [wav] */
  const speech = async (_m, _r, wav) => {
    plain.push(Boolean(wav));
    return { messages: [{ role: 'user', parts: [{ type: 'audio', mediaType: wav ? 'audio/wav' : 'audio/ogg', data: wav ? 'UklGRgAAAAA=' : 'T2dnUw==' }] }] };
  };
  const heard = { messages: [{ role: 'user', parts: [{ type: 'speech', id: 's-1' }] }] };
  const r = await call(s, { request: heard, speech });
  assert.equal(r.reply.text, 'Heard you.');
  assert.deepEqual(plain, [false, true]);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['bad-request', 'ok']);
  const sent = (await s.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['net.request'] }))).map((e) => e.data.audio);
  assert.deepEqual(sent, [[{ format: 'ogg', bytes: 4 }], [{ format: 'wav', bytes: 8 }]]);
  // WAV refused too, or a refusal of something else: the next model, as before.
  const t = setup([[refusal, refusal], [{ text: 'B heard you.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  plain.length = 0;
  assert.equal((await call(t, { request: heard, speech })).reply.text, 'B heard you.');
  assert.deepEqual(plain, [false, true, false]);
  const u = setup([[{ error: 'bad-request', status: 400, message: 'tools[0] is not valid' }], [{ text: 'B.' }]], { models: [{ input: ['text', 'audio'] }, { input: ['text', 'audio'] }] });
  plain.length = 0;
  assert.equal((await call(u, { request: heard, speech })).reply.text, 'B.');
  assert.deepEqual(plain, [false, false]);
});

test("Koe fix pass 10: a rest past 10 minutes (a provider's day limit) is said plainly, with when it ends, on the model's line, and while it rests", async () => {
  const t = setup([[{ error: 'rate', retryAfter: 18 * 3_600_000, message: 'You exceeded your current quota, please check your plan and billing details.' }], [{ text: 'B.' }]]);
  const r = await call(t);
  const until = new Date(1_000_000 + 18 * 3_600_000);
  assert.match(String(r.attempts[0].error), /^its daily limit is used up; it rests until .+/);
  assert.ok(String(r.attempts[0].error).includes(until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  assert.doesNotMatch(String(r.attempts[0].error), /billing/);
  const again = await call(t);
  assert.deepEqual(again.attempts.map((a) => [a.outcome, a.error]), [['benched', r.attempts[0].error], ['ok', undefined]]);
  // A short rest keeps the provider's words.
  const s = setup([[{ error: 'rate', retryAfter: 60_000, message: 'Slow down.' }], [{ text: 'B.' }]]);
  assert.equal((await call(s)).attempts[0].error, 'Slow down.');
});
