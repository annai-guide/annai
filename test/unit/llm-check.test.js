import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { testModel, testLevels, TEST_IMAGE } from '../../src/core/llm/check.js';
import { readConfig, modelOf, saveEndpoint, saveModel, saveRoles } from '../../src/core/llm/config.js';
import { addFromTemplate } from '../../src/core/llm/templates.js';
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
    endpoint: { id: `ep-${Math.random()}`, type: 'scripted', name: 'S', baseUrl: '', headers: {}, tunables: { script }, extraBody: {} },
    model: { id: 'm', endpoint: 'ep', name: 'S', providerId: 'scripted', input: ['text', 'image'], tools: true, contextWindow: null, maxOutput: null, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, ...model },
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

test('"this endpoint blocks web apps" is told apart from "annai couldn\'t reach it"', async () => {
  const type = /** @type {any} */ ({ type: 'http', name: 'HTTP', pluginId: 'p', build: () => ({ url: 'https://llm.test/v1/chat', headers: {}, body: {} }), read: async function* () {} });
  const base = { ...scriptedCase([]), type, fetch: async () => { throw new TypeError('Failed to fetch'); } };
  const blocked = await testModel({ ...base, probe: async () => true });
  assert.match(blocked.steps[0].detail, /doesn't allow web apps/);
  const down = await testModel({ ...base, probe: async () => false });
  assert.match(down.steps[0].detail, /couldn't reach this endpoint/);
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
  const catalog = JSON.parse(await readFile(new URL('../../catalog/templates.json', import.meta.url), 'utf8'));
  await llm.ensureType('scripted');
  await addFromTemplate({ ws, store }, catalog.endpoints.find((/** @type {any} */ t) => t.id === 'scripted'), { roles: null });
  const [id] = Object.keys((await readConfig(ws)).models);
  // A model that failed earlier rests; once Test reaches it with a working key, it is back at once.
  llm.bench.bench(id, 60_000);
  await llm.test(id);
  assert.equal(llm.bench.until(id), 0);
  // Saving an endpoint, or its key, puts its models back too: the user may have fixed what failed.
  llm.bench.bench(id, 60_000);
  await llm.unbench((await readConfig(ws)).models[id].endpoint);
  assert.equal(llm.bench.until(id), 0);
  const verified = (await readConfig(ws)).models[id].verified;
  assert.equal(verified?.access, true);
  assert.equal(verified?.key, true);
  assert.equal(typeof verified?.at, 'number');
  assert.equal(modelOf((await readConfig(ws)).models[id]).name, 'Scripted');
});

test('the service passes on the model to prefer and the photo repair (spec §9.6, §9.9)', async () => {
  const { llm, ws, store } = await realLlm();
  const catalog = JSON.parse(await readFile(new URL('../../catalog/templates.json', import.meta.url), 'utf8'));
  await llm.ensureType('scripted');
  await addFromTemplate({ ws, store }, catalog.endpoints.find((/** @type {any} */ t) => t.id === 'scripted'), { roles: null });
  const cfg = await readConfig(ws);
  const [first] = Object.keys(cfg.models);
  const ep = cfg.endpoints[cfg.models[first].endpoint];
  await saveEndpoint(ws, { ...ep, user: { ...ep.user, tunables: { script: [{ error: 'image', status: 400, message: 'too big' }, { text: 'Fixed.' }, { text: 'Second.' }] } } });
  await saveModel(ws, { ...cfg.models[first], id: 'm-second', user: { ...cfg.models[first].user, providerId: 'scripted-2', name: 'Second' } });
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [first, 'm-second'], level: 'medium' } });
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'Hi' }] }] };
  let repaired = 0;
  const r = await llm.call({ role: 'main', request, repairImages: async (/** @type {any} */ _e, /** @type {string} */ _id, /** @type {any} */ req) => { repaired++; return req; } });
  assert.equal(r.reply.text, 'Fixed.');
  assert.equal(repaired, 1);
  assert.equal((await llm.call({ role: 'main', request, prefer: 'm-second' })).modelId, 'm-second');
});
