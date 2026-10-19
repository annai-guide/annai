import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
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

test('a plugin registers a speech type only with what its direction needs', async () => {
  const { registry, ws } = await setup();
  const manifest = { id: 'speechy', name: 'Speechy', version: '1.0.0', api: 1 };
  const good = { manifest, activate: (/** @type {any} */ a) => a.providers.register({ type: 'ok-out', speech: 'out', speechRequest() {}, readSpeech() {} }) };
  await new PluginHost({ registry, workspace: ws, importModule: async () => good }).addBuiltin('good');
  assert.ok(registry.list('endpoint-type').some((t) => t.type === 'ok-out'));
  const bad = { manifest: { ...manifest, id: 'speechy-bad' }, activate: (/** @type {any} */ a) => a.providers.register({ type: 'bad-in', speech: 'in', speechRequest() {} }) };
  await assert.rejects(new PluginHost({ registry, workspace: ws, importModule: async () => bad }).addBuiltin('bad'), /a speech type needs transcribeRequest\(\) and readTranscript\(\)/);
});
