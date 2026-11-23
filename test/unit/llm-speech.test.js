import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { speechCost } from '../../src/core/llm/cost.js';
import { readConfig, saveProvider, saveRoles, newProvider, newModel, speechKind } from '../../src/core/llm/config.js';
import { costs, spentToday } from '../../src/core/agent/budgets.js';
import { createLlm } from '../../src/core/llm/service.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { sendMs } from '../../src/core/llm/uploads.js';
import { Voice } from '../../src/core/voice/voice.js';
import { useClock } from './clock.js';

/** A speech type of each direction, as a plugin would register them. */
const hears = {
  type: 'test-in', name: 'Test transcription', speech: 'in', pluginId: 'test', tunables: {},
  transcribeRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/hear`, headers: { authorization: `Bearer ${c.key}` }, body: JSON.stringify({ model: c.model.providerId, bytes: c.audio.data.length }) }),
  readTranscript: async (/** @type {Response} */ res) => ({ text: (await res.json()).text }),
};
const speaks = {
  type: 'test-out', name: 'Test voice', speech: 'out', pluginId: 'test', tunables: {},
  speechRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/say?key=${c.key}`, headers: {}, body: JSON.stringify({ model: c.model.providerId, text: c.text }) }),
  readSpeech: async (/** @type {Response} */ res) => ({ data: new Uint8Array(await res.arrayBuffer()), mediaType: res.headers.get('content-type') ?? 'audio/mpeg' }),
};

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  return { registry, store, ws };
}
/** @param {string} type */
const endpoint = (type) => ({ id: 'pv-1/speech', provider: 'pv-1', ability: 'speech', type, name: 'Speech', baseUrl: 'https://speech.test/v1', headers: {}, tunables: {}, extraBody: {} });
/** A provider with one speech ability, and one model on it. @param {'transcription' | 'voice'} kind @param {string} type @param {string} name @param {string} baseUrl @param {string} providerId */
const speechProvider = (kind, type, name, baseUrl, providerId) => {
  const p = newProvider('provider-test', { user: { name, baseUrl, abilities: { [kind]: { kind, type } } } });
  return { p, m: newModel(p.id, kind, { user: { providerId } }) };
};
/** @param {any} prices @returns {any} */
const model = (prices) => ({ id: 'm-1', provider: 'pv-1', ability: 'speech', name: 'Ears', providerId: 'ears-1', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} });
/** @param {any} store */
const traced = async (store) => (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request');
const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-12;

test('a transcription: the words, traced as a speech request with its cost (spec §2, §9.9)', async () => {
  const { store } = await setup();
  /** @type {any[]} */
  const seen = [];
  const r = await speechCall({
    type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model({ perMinute: 0.006, minSeconds: 10 }), key: 'sk-hear-secret', wake: 'w-1',
    audio: { data: new Uint8Array(32000), mediaType: 'audio/wav', seconds: 1 }, trace: modelTrace(store, SYS),
    fetch: async (url, init) => { seen.push([url, init]); return Response.json({ text: '  Where should we eat? ' }); },
  });
  assert.equal(r.text, 'Where should we eat?');
  assert.equal(seen[0][0], 'https://speech.test/v1/hear');
  assert.equal(seen[0][1].method, 'POST');
  const [req] = await traced(store);
  assert.equal(req.data.kind, 'speech-in');
  assert.equal(req.data.outcome, 'ok');
  assert.equal(req.data.wake, 'w-1');
  assert.equal(req.data.seconds, 1);
  assert.ok(near(req.data.cost, 0.001), `${req.data.cost}: billed for at least 10 seconds`);
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-hear-secret'));
});

test('a voice clip: its bytes and type, priced per character; a key in the address is never traced', async () => {
  const { store } = await setup();
  const r = await speechCall({
    type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model({ perMillionChars: 15 }), key: 'sk-say-secret', text: 'Hello there.',
    trace: modelTrace(store, SYS), fetch: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
  });
  assert.deepEqual([.../** @type {any} */ (r).clip.data], [1, 2, 3]);
  assert.equal(/** @type {any} */ (r).clip.mediaType, 'audio/mpeg');
  const [req] = await traced(store);
  assert.equal(req.data.kind, 'speech-out');
  assert.equal(req.data.chars, 12);
  assert.ok(near(req.data.cost, (12 / 1e6) * 15));
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-say-secret'));
});

test("the trace says each clip's format and size: what was sent to be written down, and what a voice sent back (Koe and Kokoro design, \"Audio formats\")", async () => {
  const { store } = await setup();
  const trace = modelTrace(store, SYS);
  await speechCall({
    type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: null, trace,
    audio: { data: new Uint8Array(5283), mediaType: 'audio/webm', seconds: 1.7 }, fetch: async () => Response.json({ text: 'hi' }),
  });
  await speechCall({
    type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: null, trace,
    audio: { data: new Uint8Array(900), mediaType: 'audio/ogg', seconds: 0.3 }, fetch: async () => new Response('down', { status: 500 }),
  }).catch(() => {});
  await speechCall({
    type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model(null), key: null, text: 'Hello.', trace,
    fetch: async () => new Response(new Uint8Array(4000), { headers: { 'content-type': 'audio/ogg' } }),
  });
  const reqs = await traced(store);
  assert.deepEqual(reqs.map((/** @type {any} */ e) => [e.data.kind, e.data.outcome, e.data.format, e.data.bytes]),
    [['speech-in', 'ok', 'webm', 5283], ['speech-in', 'server', 'ogg', 900], ['speech-out', 'ok', 'ogg', 4000]]);
});

test("a voice whose format is auto is asked for the smallest it offers that the device plays: Opus where Ogg plays, else MP3", async () => {
  /** @type {any[]} */
  const asked = [];
  const voice = { ...speaks, speechRequest: (/** @type {any} */ c) => { asked.push(c.tunables.format); return speaks.speechRequest(c); } };
  const auto = { ...endpoint('test-out'), tunables: { format: 'auto', audioOut: ['opus', 'aac', 'mp3', 'flac', 'wav'] } };
  const ok = async () => new Response(new Uint8Array(4), { headers: { 'content-type': 'audio/ogg' } });
  const call = (/** @type {any} */ c) => speechCall({ type: /** @type {any} */ (voice), model: model(null), key: null, text: 'Hi.', fetch: ok, ...c });
  await call({ endpoint: auto, plays: ['ogg', 'webm', 'mp3', 'wav'] });
  await call({ endpoint: auto, plays: ['webm', 'mp4', 'aac', 'mp3', 'wav'] });
  await call({ endpoint: auto });
  await call({ endpoint: { ...auto, tunables: { format: 'auto', audioOut: ['mp3'] } }, plays: ['ogg', 'mp3'] });
  await call({ endpoint: { ...auto, tunables: { ...auto.tunables, format: 'wav' } }, plays: ['ogg', 'mp3'] });
  await call({ endpoint: { ...auto, tunables: { format: 'auto' } }, plays: ['ogg'] });
  assert.deepEqual(asked, ['opus', 'aac', 'mp3', 'mp3', 'wav', 'mp3'], "a format chosen by the user is left alone; with nothing to go on, MP3");
});

test('speech errors come back as the usual kinds, with an echoed key blanked out', async () => {
  const { store } = await setup();
  /** @param {any} fetch @param {any} [more] */
  const call = (fetch, more = {}) => speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: 'sk-hear-secret', audio: { data: new Uint8Array(10), mediaType: 'audio/wav' }, trace: modelTrace(store, SYS), fetch, ...more });
  await assert.rejects(call(async () => Response.json({ error: { message: 'Incorrect API key provided: sk-hear-secret' } }, { status: 401 })), (e) => e instanceof ProviderError && e.kind === 'auth');
  await assert.rejects(call(async () => { throw new TypeError('Failed to fetch'); }), (e) => e instanceof ProviderError && e.kind === 'unreachable');
  const hang = (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  await assert.rejects(call(hang, { timeoutMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.deepEqual((await traced(store)).map((e) => e.data.outcome), ['auth', 'unreachable', 'timeout']);
  assert.ok(!JSON.stringify(await traced(store)).includes('sk-hear-secret'));
});

test("a transcription's time limit starts once the provider has the recording, as a model's wait does: a recording slower to go up than the limit is heard; one that never goes up ends at the limit and the send's time once; once the answer came, the limit is its own (photo-wait's follow-ups, 1)", async (t) => {
  useClock(t); // a clock that moves only by its timers: an end is exact, whatever the machine's speed
  // 4,000 bytes: 0.46 s at the slow link (SLOW_UPLINK, 70 kbit/s), past the 50 ms limit; a WAV of 10 s is about 320 KB, 37 s.
  const audio = { data: new Uint8Array(4_000), mediaType: 'audio/wav', seconds: 0.1 };
  /** A fetch whose answer's headers come ms after it is asked, its body then the transcript, or nothing until it is stopped. @param {number} ms @param {boolean} [stalls] */
  const answersAfter = (ms, stalls = false) => (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    const body = () => (stalls ? new ReadableStream({ start: (c) => init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }) }) : JSON.stringify({ text: 'Where should we eat?' }));
    const t = ms === Infinity ? undefined : setTimeout(() => done(new Response(body())), ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); fail(init.signal.reason); }, { once: true });
  });
  const hear = (/** @type {any} */ fetch) => speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: null, audio, fetch, timeoutMs: 50 });
  assert.equal((await hear(answersAfter(250))).text, 'Where should we eat?');
  let started = Date.now();
  await assert.rejects(hear(answersAfter(Infinity)), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.equal(Date.now() - started, 50 + sendMs(4_000), "the limit and the recording's send time, once");
  started = Date.now();
  await assert.rejects(hear(answersAfter(10, true)), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.equal(Date.now() - started, 10 + 50, 'the answer at 10 ms, then the limit from it');
});

test("a half's turn's transcription beside the other half's send (shared) has the send time of twice its bytes, as its model's send has: a recording up within that is heard where alone it is cut, one that never goes up ends at the limit and that time, and the service's transcribe passes it on (read-wait-next, 8, shape 6)", async (t) => {
  useClock(t);
  // 4,000 bytes: 0.46 s at the slow link alone, 0.92 s shared; the 50 ms limit after.
  const audio = { data: new Uint8Array(4_000), mediaType: 'audio/wav', seconds: 0.1 };
  /** A fetch whose answer's headers come ms after it is asked (Infinity: never), ended by its signal. @param {number} ms */
  const answersAfter = (ms) => (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    const t = ms === Infinity ? undefined : setTimeout(() => done(Response.json({ text: 'Where should we eat?' })), ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); fail(init.signal.reason); }, { once: true });
  });
  const hear = (/** @type {any} */ fetch, /** @type {boolean} */ shared) => speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: null, audio, fetch, timeoutMs: 50, shared });
  assert.equal((await hear(answersAfter(900), true)).text, 'Where should we eat?');
  await assert.rejects(hear(answersAfter(900), false), (e) => e instanceof ProviderError && e.kind === 'timeout');
  const started = Date.now();
  await assert.rejects(hear(answersAfter(Infinity), true), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.equal(Date.now() - started, 50 + sendMs(4_000, true));
  // The service's transcription passes it on: 40,000 bytes take 4.6 s alone, 9.1 s shared, after the role's 15 s; the answer comes at 22 s.
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', hears);
  const { p, m } = speechProvider('transcription', 'test-in', 'Ears', 'https://ears.test', 'ears-1');
  await saveProvider(ws, p, [m]);
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: /** @type {any} */ (answersAfter(22_000)) });
  const long = { data: new Uint8Array(40_000), mediaType: 'audio/wav', seconds: 1 };
  assert.equal(/** @type {any} */ (await llm.transcribe({ modelId: m.id, audio: long, shared: true })).text, 'Where should we eat?');
  await assert.rejects(llm.transcribe({ modelId: m.id, audio: long }), (e) => e instanceof ProviderError && e.kind === 'timeout');
});

test("a recording that got no answer's headers within its send's time fails as a cut send, in a photo's words and with its code (the voice's rule on it is in the next test and in voice-resolve's); a stall after the headers, and a voice's text that never goes up, stay late (read-wait-fix1, 1)", async (t) => {
  useClock(t);
  const { store } = await setup();
  // 4,000 bytes at the default 15 s limit: 15.458 s alone, 15.916 s shared.
  const audio = { data: new Uint8Array(4_000), mediaType: 'audio/wav', seconds: 0.1 };
  /** A fetch whose headers come ms after it is asked (Infinity: never), its body then never; ended by its signal. @param {number} ms */
  const answersAfter = (ms) => (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    const t = ms === Infinity ? undefined : setTimeout(() => done(new Response(new ReadableStream({ start: (c) => init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true }) }))), ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); fail(init.signal.reason); }, { once: true });
  });
  const hear = (/** @type {any} */ fetch, /** @type {boolean} */ shared = false) => speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(null), key: null, audio, fetch, shared, trace: modelTrace(store, SYS) });
  await assert.rejects(hear(answersAfter(Infinity)), (e) => e instanceof ProviderError && e.kind === 'timeout' && e.said?.code === 'send' && e.said?.seconds === 15
    && e.message === 'No answer in 15 seconds. The connection may be too slow to send photos or files.');
  await assert.rejects(hear(answersAfter(Infinity), true), (e) => e instanceof ProviderError && e.said?.code === 'send' && e.said?.seconds === 16);
  assert.equal((await traced(store))[0].data.error, 'No answer in 15 seconds. The connection may be too slow to send photos or files.', 'the trace says it too');
  // The provider had the request (its headers came), then nothing: late.
  await assert.rejects(hear(answersAfter(10)), (e) => e instanceof ProviderError && e.kind === 'timeout' && e.said?.code === 'late' && e.message === 'No output started in time.');
  // A voice's text is small: no send to blame.
  await assert.rejects(speechCall({ type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model(null), key: null, text: 'Hello', fetch: answersAfter(Infinity) }), (e) => e instanceof ProviderError && e.said?.code === 'late');
});

test("a gate's transcription cut before its provider's headers, through the real service and voice, leaves the model awake: the turn's own transcription of the same words asks it again and hears (read-wait-fix1, 1)", async (t) => {
  useClock(t);
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', hears);
  const { p, m } = speechProvider('transcription', 'test-in', 'Ears', 'https://ears.test', 'ears-1');
  await saveProvider(ws, p, [m]);
  await saveRoles(ws, { 'speech-in': { models: [m.id], level: 'off' } });
  let sent = 0;
  // The first recording never goes up; the second is answered at once.
  const fetch = (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    if (sent++ === 0) init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true });
    else done(Response.json({ text: 'Where should we eat?' }));
  });
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: /** @type {any} */ (fetch) });
  const voice = new Voice({ llm, ws, registry, store, locale: 'en' });
  voice.memory.keep({ id: 's-1', source: 'mic', audio: { data: new Uint8Array(4_000), mediaType: 'audio/wav', seconds: 0.1 }, ms: 100, at: 0 }, 'trip-1');
  /** The gate's resolver (loop.js: the scope alone), then the turn's (with its wake, and shared). @param {boolean} [turn] */
  const ask = (turn = false) => /** @type {Promise<any>} */ ((turn ? voice.resolver('trip-1', 'w-1', undefined, true) : voice.resolver('trip-1'))({ id: 'm-chat', name: 'Chat', input: ['text'] }, { messages: [{ role: 'user', parts: [{ type: 'speech', id: 's-1' }] }] }, false));
  await assert.rejects(ask(), /nothing in the speech-in list worked for Chat/);
  assert.equal(llm.bench.until(m.id), 0, 'a cut send rests no model');
  assert.match((await ask(true)).messages[0].parts[0].text, /Where should we eat\?/);
  assert.equal(sent, 2);
});

test("a transcription model whose recording was cut is asked once a call, through the real llm.call: the second text-only chat model it tries doesn't send it again, and the next call asks it (read-wait-fix2, 1)", async (t) => {
  useClock(t);
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', hears);
  registry.add('test', 'endpoint-type', { type: 'test-chat', name: 'Test chat', pluginId: 'test', tunables: {}, build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/chat`, headers: {}, body: { messages: c.request.messages } }), read: async function* () { yield { type: 'text', text: 'Yes.' }; } });
  const { p, m } = speechProvider('transcription', 'test-in', 'Ears', 'https://ears.test', 'ears-1');
  const chat = newProvider('provider-test', { user: { name: 'Chat', baseUrl: 'https://chat.test/v1', abilities: { chat: { kind: 'chat', type: 'test-chat' } } } });
  const texts = [newModel(chat.id, 'chat', { user: { providerId: 'chat-1', input: ['text'] } }), newModel(chat.id, 'chat', { user: { providerId: 'chat-2', input: ['text'] } })];
  await saveProvider(ws, p, [m]);
  await saveProvider(ws, chat, texts);
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: texts.map((x) => x.id), level: 'off' }, 'speech-in': { models: [m.id], level: 'off' } });
  let sent = 0;
  const fetch = (/** @type {any} */ url, /** @type {any} */ init) => new Promise((done, fail) => {
    // The chat models are asked only once the transcription model has heard: its words are what they take.
    if (String(url).startsWith('https://chat.test')) return done(new Response('streamed'));
    if (sent++ === 0) init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true });
    else done(Response.json({ text: 'Where should we eat?' }));
  });
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: /** @type {any} */ (fetch) });
  const voice = new Voice({ llm, ws, registry, store, locale: 'en' });
  // 40,000 bytes (a 10 s clip's size): 4.6 s alone, 9.1 s shared; the turn's call is shared.
  voice.memory.keep({ id: 's-1', source: 'mic', audio: { data: new Uint8Array(40_000), mediaType: 'audio/wav', seconds: 10 }, ms: 10_000, at: 0 }, 'trip-1');
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('speech'), id: 's-1' }] }] };
  const started = Date.now();
  await assert.rejects(llm.call({ request, speech: voice.resolver('trip-1', 'w-1', undefined, true) }));
  assert.equal(sent, 1, 'one send for the call, not one for each chat model');
  assert.equal(Date.now() - started, 15_000 + sendMs(40_000, true), 'one wait, not two');
  assert.equal(llm.bench.until(m.id), 0, 'and no rest');
  // The call's next step is a call of its own: it asks the model again, and it hears.
  assert.equal(/** @type {any} */ (await llm.call({ request, speech: voice.resolver('trip-1', 'w-1', undefined, true) })).reply.text, 'Yes.');
  assert.equal(sent, 2);
});

test("a voice's time limit counts the text's send as a transcription's does: a text slower to go up than the limit is spoken; one that never goes up ends at the limit and the send's time (photo-wait's follow-ups, 1)", async (t) => {
  useClock(t);
  // 4,000 characters: 0.46 s at the slow link, past the 100 ms limit; the answer's headers at 300 ms.
  const say = (/** @type {number} */ ms) => speechCall({ type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model(null), key: null, text: 'a'.repeat(4_000), timeoutMs: 100,
    fetch: (_url, init) => new Promise((done, fail) => {
      const t = ms === Infinity ? undefined : setTimeout(() => done(new Response(new Uint8Array(10), { headers: { 'content-type': 'audio/mpeg' } })), ms);
      /** @type {any} */ (init).signal.addEventListener('abort', () => { clearTimeout(t); fail(/** @type {any} */ (init).signal.reason); }, { once: true });
    }) });
  assert.equal((await say(300)).clip?.data.length, 10);
  const started = Date.now();
  await assert.rejects(say(Infinity), (e) => e instanceof ProviderError && e.kind === 'timeout');
  const sent = JSON.stringify({ model: 'ears-1', text: 'a'.repeat(4_000) }).length;
  assert.equal(Date.now() - started, 100 + sendMs(sent), "the limit and the text's send time, once");
});

test('speech prices: per minute (with a minimum), per million characters, or unknown', () => {
  assert.ok(near(/** @type {number} */ (speechCost({ perMinute: 0.006 }, { seconds: 30 })), 0.003));
  assert.ok(near(/** @type {number} */ (speechCost({ perMinute: 0.6, minSeconds: 10 }, { seconds: 2 })), 0.1));
  assert.equal(speechCost({ perMillionChars: 15 }, { chars: 1_000_000 }), 15);
  assert.equal(speechCost(null, { chars: 10 }), undefined);
  assert.equal(speechCost({ input: 1 }, { seconds: 10 }), undefined);
});

test('speech lists: the stand-ins by default, each only in its own list, and only models that exist (spec §9.6, §10.3)', async () => {
  const { ws } = await setup();
  let cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles['speech-in'].models, ['send-audio', 'dictation']);
  assert.deepEqual(cfg.roles['speech-out'].models, ['browser-voice']);
  const { p: ep, m } = speechProvider('transcription', 'test-in', 'Ears', 'https://speech.test/v1', 'ears-1');
  await saveProvider(ws, ep, [m]);
  await saveRoles(ws, { ...cfg.roles, 'speech-in': { models: ['dictation', m.id, 'browser-voice', 'm-gone'], level: 'off' }, 'speech-out': { models: [], level: 'off' } });
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles['speech-in'].models, ['dictation', m.id]);
  assert.deepEqual(cfg.roles['speech-out'].models, [], 'a list the user emptied stays empty');
  assert.equal(speechKind(cfg, new Map([['test-in', /** @type {any} */ (hears)]]), m.id), 'in');
  assert.equal(speechKind(cfg, new Map(), m.id), null);
});

test("speech costs count in a trip's cost and in today's spend (spec §6.6)", async () => {
  const { store } = await setup();
  const trace = modelTrace(store, SYS);
  await trace.request({ kind: 'speech-out', endpoint: 'V', model: 'v', providerModel: 'v', url: 'https://v.test/', status: 200, ms: 5, firstMs: null, outcome: 'ok', usage: null, cost: 0.25, wake: 'w-9' });
  await trace.request({ endpoint: 'M', model: 'm', providerModel: 'm', url: 'https://m.test/', status: 200, ms: 5, firstMs: null, outcome: 'ok', usage: null, cost: 9 });
  const c = await costs(store, SYS);
  assert.equal(c.total, 0.25, "a chat request's cost is already in its model.turn");
  assert.equal(c.byWake.get('w-9'), 0.25);
  assert.equal(await spentToday(store, Date.now(), 'UTC'), 0.25);
});

test('the service transcribes and speaks through speech models; a chat role never calls one', async () => {
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', hears);
  registry.add('test', 'endpoint-type', speaks);
  const { p: inEp, m: inM } = speechProvider('transcription', 'test-in', 'Ears', 'https://ears.test', 'ears-1');
  const { p: outEp, m: outM } = speechProvider('voice', 'test-out', 'Voice', 'https://voice.test', 'voice-1');
  await saveProvider(ws, inEp, [inM]);
  await saveProvider(ws, outEp, [outM]);
  const fetch = async (/** @type {any} */ url) => (String(url).startsWith('https://ears.test') ? Response.json({ text: 'yes' }) : new Response(new Uint8Array([9]), { headers: { 'content-type': 'audio/wav' } }));
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch });
  assert.equal(/** @type {any} */ (await llm.transcribe({ modelId: inM.id, audio: { data: new Uint8Array(4), mediaType: 'audio/wav', seconds: 1 } })).text, 'yes');
  assert.deepEqual([.../** @type {any} */ (await llm.synthesize({ modelId: outM.id, text: 'Hi.' })).clip.data], [9]);
  await assert.rejects(llm.synthesize({ modelId: inM.id, text: 'Hi.' }), /isn't a voice/);
  const cfg = await readConfig(ws);
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'hi' }] }] };
  await assert.rejects(callRole({ role: 'main', request, config: { ...cfg, roles: { ...cfg.roles, main: { models: [outM.id], level: 'off' } } }, types: llm.types(), keyFor: async () => null, bench: new Bench() }),
    (e) => /** @type {any} */ (e).attempts[0].outcome === 'not-chat');
  await saveProvider(ws, { ...outEp, user: { ...outEp.user, abilities: { voice: { kind: 'voice', type: 'test-out', on: false } } } });
  assert.equal(speechKind(await readConfig(ws), llm.types(), outM.id), null, 'a voice whose ability is off is no voice');
});

test("the service's role call passes a half's shared link on to its model's send, which then has the time of twice its bytes (photo-wait's follow-ups, 5)", async () => {
  const { registry, store, ws } = await setup();
  registry.add('test', 'endpoint-type', { type: 'test-chat', name: 'Test chat', pluginId: 'test', tunables: {}, build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/chat`, headers: {}, body: { messages: c.request.messages } }), read: async function* () { yield { type: 'text', text: 'A pelican.' }; } });
  const p = newProvider('provider-test', { user: { name: 'Chat', baseUrl: 'https://chat.test/v1', abilities: { chat: { kind: 'chat', type: 'test-chat' } } } });
  const m = newModel(p.id, 'chat', { user: { providerId: 'chat-1', input: ['text', 'image'] } });
  await saveProvider(ws, p, [m]);
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [m.id], level: 'off' } });
  // About 5.2 KB: 0.59 s at the slow link, so 0.69 s with the 100 ms wait alone, 1.28 s shared; the provider has the request at 0.95 s.
  const fetch = (/** @type {any} */ _url, /** @type {any} */ init) => new Promise((done, fail) => {
    const t = setTimeout(() => done(new Response('streamed')), 950);
    init.signal.addEventListener('abort', () => { clearTimeout(t); fail(init.signal.reason); }, { once: true });
  });
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: /** @type {any} */ (fetch) });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'What is this?' }, { type: /** @type {const} */ ('image'), mediaType: 'image/jpeg', data: 'A'.repeat(5_000) }] }] };
  assert.equal((await llm.call({ request, firstOutputMs: 100, shared: true })).reply.text, 'A pelican.');
});

test('a plugin registers a speech type only with what its direction needs', async () => {
  const { registry, ws } = await setup();
  const manifest = { id: 'speechy', name: 'Speechy', version: '1.0.0', api: 1 };
  const good = { manifest, activate: (/** @type {any} */ a) => a.providers.register({ type: 'ok-out', speech: 'out', speechRequest() {}, readSpeech() {} }) };
  await new PluginHost({ registry, workspace: ws, importModule: async () => good }).addBuiltin('good');
  assert.ok(registry.list('endpoint-type').some((t) => t.type === 'ok-out'));
  const bad = { manifest: { ...manifest, id: 'speechy-bad' }, activate: (/** @type {any} */ a) => a.providers.register({ type: 'bad-in', speech: 'in', speechRequest() {} }) };
  await assert.rejects(new PluginHost({ registry, workspace: ws, importModule: async () => bad }).addBuiltin('bad'), /a speech type needs transcribeRequest\(\) and readTranscript\(\)/);
});
