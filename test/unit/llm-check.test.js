import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { testModel, testLevels, TEST_IMAGE } from '../../src/core/llm/check.js';
import { readConfig, modelOf, saveProvider, saveModel, saveRoles, setKey } from '../../src/core/llm/config.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { official } from './provider-kit.js';
import { createLlm } from '../../src/core/llm/service.js';
import { activate as scripted } from '../../plugins-official/scripted-model/index.js';

/** @returns {any} */
function scriptedType() {
  /** @type {any} */
  let t = null;
  scripted({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: 'scripted-model' }; return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return t;
}
/** @param {any[]} script @param {any} [model] */
function scriptedCase(script, model = {}) {
  return {
    type: scriptedType(),
    endpoint: { id: `pv-${Math.random()}/chat`, provider: 'pv', ability: 'chat', type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script }, extraBody: {} },
    model: { id: 'm', provider: 'pv', ability: 'chat', name: 'S', providerId: 'scripted', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...model },
    key: null,
  };
}

test('the Test button: access, key, tool calls and photos all work (spec §9.8)', async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true], ['images', true]]);
  assert.match(r.steps[1].detail, /The model said: "OK"/);
  assert.match(TEST_IMAGE, /^iVBORw0KGgo/);
});

test('a rejected key is a key problem, in plain words', async () => {
  const r = await testModel(scriptedCase([{ error: 'auth', status: 401 }]));
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => s.step), ['key']);
  assert.match(r.steps[0].detail, /key was rejected/);
});

test('"this address blocks web apps" is told apart from "annai couldn\'t reach it"', async () => {
  const type = /** @type {any} */ ({ type: 'http', name: 'HTTP', pluginId: 'p', build: () => ({ url: 'https://llm.test/v1/chat', headers: {}, body: {} }), read: async function* () {} });
  const base = { ...scriptedCase([]), type, fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const blocked = await testModel({ ...base, probe: async () => true });
  assert.match(blocked.steps[0].detail, /doesn't allow web apps/);
  const down = await testModel({ ...base, probe: async () => false });
  assert.match(down.steps[0].detail, /couldn't reach this address/);
});

test("a model that ignores the tool and doesn't see the square fails those steps only", async () => {
  const r = await testModel(scriptedCase([{ text: 'OK' }, { text: 'It is blue.' }]));
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', false], ['images', false]]);
  const textOnly = await testModel(scriptedCase([{ text: 'OK' }, { text: 'red' }], { input: ['text'], tools: false }));
  assert.deepEqual(textOnly.steps.map((s) => s.step), ['access', 'key']);
});

test('testLevels tries each reasoning level the model has (spec §9.3)', async () => {
  const r = await testLevels(scriptedCase([{ text: 'OK' }, { error: 'bad-request' }], { reasoning: { low: { a: 1 }, high: { a: 2 } } }));
  assert.deepEqual(r, { low: 'ok', high: 'bad-request' });
});

/** The real llm service over a memory store, with official plugins read from the repo. */
async function realLlm() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const root = new URL('../../', import.meta.url);
  const repoFetch = async (/** @type {any} */ url) => {
    try {
      return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws, importModule }), fetch: repoFetch });
  return { llm, ws, store };
}

test('the service records what the Test button found on the model, and a model that works rests no more', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const [id] = Object.keys((await readConfig(ws)).models);
  // A model that failed earlier rests; once Test reaches it with a working key, it is back at once.
  llm.bench.bench(id, 60_000);
  await llm.test(id);
  assert.equal(llm.bench.until(id), 0);
  // Saving a provider, or its key, puts its models back too: the user may have fixed what failed.
  llm.bench.bench(id, 60_000);
  await llm.unbench((await readConfig(ws)).models[id].provider);
  assert.equal(llm.bench.until(id), 0);
  const verified = (await readConfig(ws)).models[id].verified;
  assert.equal(verified?.access, true);
  assert.equal(verified?.key, true);
  assert.equal(typeof verified?.at, 'number');
  assert.equal(modelOf((await readConfig(ws)).models[id]).name, 'Scripted');
});

test('the service passes on the model to prefer and the photo repair (spec §9.6, §9.9)', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [first] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[first].provider];
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'image', status: 400, message: 'too big' }, { text: 'Fixed.' }, { text: 'Second.' }] } } } } });
  await saveModel(ws, { ...cfg.models[first], id: 'm-second', user: { ...cfg.models[first].user, providerId: 'scripted-2', name: 'Second' } });
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [first, 'm-second'], level: 'medium' } });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }] };
  let repaired = 0;
  const r = await llm.call({ role: 'main', request, repairImages: async (/** @type {any} */ _e, /** @type {string} */ _id, /** @type {any} */ req) => { repaired++; return req; } });
  assert.equal(r.reply.text, 'Fixed.');
  assert.equal(repaired, 1);
  assert.equal((await llm.call({ role: 'main', request, prefer: 'm-second' })).modelId, 'm-second');
});

test('the Test button checks photo uploads where the endpoint stores files (spec §9.8)', async () => {
  const withUploads = (/** @type {any} */ c) => ({
    ...c, type: { ...c.type, uploadRequest: () => ({ url: 'https://files.test/v1/files', headers: {}, body: new FormData() }), readUpload: (/** @type {any} */ j) => ({ id: j.id }) },
  });
  const script = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const ok = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response(JSON.stringify({ id: 'file_1' })) });
  assert.deepEqual(ok.steps.map((s) => [s.step, s.ok]).at(-1), ['upload', true]);
  assert.equal(ok.ok, true);
  const refused = await testModel({ ...withUploads(scriptedCase(script)), fetch: async () => new Response('no', { status: 403 }) });
  const last = /** @type {any} */ (refused.steps.at(-1));
  assert.deepEqual([last.step, last.ok], ['upload', false]);
  assert.equal(last.detail, "Uploading photos didn't work with this key. annai will send photos in each request instead.");
  assert.equal(refused.ok, true, 'photos still work, sent in each request');
});

test("what the Test button says never shows a key, whatever the provider's message holds (spec §9.9)", async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [id] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[id].provider];
  await setKey(store, ep.id, 'sk-live-0123456789abcdef');
  // A kind the plugin made up has no plain words of annai's: the provider's own message is shown, blanked.
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'quota-ish', status: 400, message: 'Key sk-live-0123456789abcdef may not use this model.' }] } } } } });
  const r = await llm.test(id);
  assert.equal(r.ok, false);
  assert.match(r.steps[0].detail, /may not use this model/);
  assert.doesNotMatch(JSON.stringify(r), /0123456789abcdef/);
});

test("a model that takes no photos is asked something it can answer with the tool, with room to think first; a reply cut off by its length says so (the user's DeepSeek, 2026-10-18)", async () => {
  const c = scriptedCase([{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }], { input: ['text'], tools: true });
  /** @type {any[]} */
  const seen = [];
  const run = c.type.run;
  c.type.run = (/** @type {any} */ x) => { seen.push(x.request); return run(x); };
  const r = await testModel(c);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['access', true], ['key', true], ['tools', true]]);
  const ask = seen[1];
  const words = ask.messages[0].parts.filter((/** @type {any} */ p) => p.type === 'text').map((/** @type {any} */ p) => p.text).join(' ');
  assert.ok(!ask.messages[0].parts.some((/** @type {any} */ p) => p.type === 'image'));
  assert.match(words, /red/, 'without a picture, the question carries the answer');
  assert.doesNotMatch(words, /What color is the square\?/);
  assert.ok(ask.maxOutput >= 4096, `room for a thinking model before its tool call: ${ask.maxOutput}`);
  const cut = await testModel(scriptedCase([{ text: 'OK' }, { text: 'Let me think about the', stop: 'length' }], { input: ['text'], tools: true }));
  assert.match(cut.steps[2].detail, /ran out of room|length/i);
});

test('every Test request leaves room for a model that must think before it answers: 4096 tokens, or the model\'s own limit when lower (the user, 2026-10-18)', async () => {
  /** @param {any} c */
  const watch = (c) => {
    /** @type {number[]} */
    const asked = [];
    const run = c.type.run;
    c.type.run = (/** @type {any} */ x) => { asked.push(x.request.maxOutput); return run(x); };
    return asked;
  };
  const ok = [{ text: 'OK' }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }] }];
  const c = scriptedCase(ok);
  const asked = watch(c);
  await testModel(c);
  assert.deepEqual(asked, [4096, 4096]);
  const small = scriptedCase(ok, { maxOutput: 1024 });
  const askedSmall = watch(small);
  await testModel(small);
  assert.deepEqual(askedSmall, [1024, 1024]);
  const levels = scriptedCase([{ text: 'OK' }, { text: 'OK' }], { reasoning: { low: {}, high: {} } });
  const askedLevels = watch(levels);
  await testLevels(levels);
  assert.deepEqual(askedLevels, [4096, 4096]);
});

test('Try this model calls that model alone: no fallback when it fails, a model resting is still asked, and the trace keeps the call (the user, 2026-10-18)', async () => {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  await addProvider({ ws, store }, await official('provider-scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [one] = Object.keys(cfg.models);
  const ep = cfg.providers[cfg.models[one].provider];
  await saveProvider(ws, { ...ep, user: { ...ep.user, abilities: { chat: { tunables: { script: [{ error: 'credit', status: 402 }] } } } } });
  await saveProvider(ws, { ...ep, id: 'pv-two', user: { ...ep.user, name: 'Two', abilities: { chat: { tunables: { script: [{ text: 'From two.' }] } } } } });
  await saveModel(ws, { ...cfg.models[one], id: 'm-two', provider: 'pv-two', user: { ...cfg.models[one].user, providerId: 'scripted-2', name: 'Two' } });
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [one, 'm-two'], level: 'medium' } });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }] };
  // The main role would fall back to Two; the one model asked does not.
  const failed = await llm.callModel({ modelId: one, request }).then(() => null, (/** @type {any} */ e) => e);
  assert.equal(failed?.name, 'AllFailedError');
  assert.deepEqual(failed.attempts.map((/** @type {any} */ a) => [a.model, a.outcome]), [[one, 'credit']]);
  assert.equal(llm.bench.until(one), 0, "a try doesn't rest the model for Shiori");
  // A model resting is asked all the same, and once it answers it rests no more.
  llm.bench.bench('m-two', 60_000);
  const r = await llm.callModel({ modelId: 'm-two', request });
  assert.equal(r.reply.text, 'From two.');
  assert.equal(r.answeredBy, 'Two');
  assert.equal(llm.bench.until('m-two'), 0);
  const turns = await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['model.turn'] }));
  assert.deepEqual(turns.map((e) => [e.data.role, e.data.answeredBy, e.data.attempts.length]), [['try', null, 1], ['try', 'Two', 1]]);
});
