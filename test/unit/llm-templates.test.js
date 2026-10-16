import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { readConfig, modelOf, endpointOf, getKey, saveEndpoint, saveRoles } from '../../src/core/llm/config.js';
import { loadTemplates, addFromTemplate, useSuggestion, templateUpdates, applyTemplate, addListedModel } from '../../src/core/llm/templates.js';
import { createLlm } from '../../src/core/llm/service.js';

const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog/templates.json', root), 'utf8'));
const tpl = (/** @type {string} */ id) => catalog.endpoints.find((/** @type {any} */ t) => t.id === id);

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  return { registry, store, ws };
}

/** A fetch that serves this repository's files, as annai's own origin would. */
const repoFetch = async (/** @type {any} */ url) => {
  try {
    return new Response(await readFile(new URL(`.${new URL(String(url), 'http://annai.test').pathname}`, root)));
  } catch {
    return new Response('not found', { status: 404 });
  }
};

test("catalog/templates.json: types annai can install, ids that are unique, suggestions it can keep", async () => {
  const plugins = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8')).plugins;
  const provided = new Set(plugins.flatMap((/** @type {any} */ p) => p.provides?.['endpoint-type'] ?? []));
  const ids = new Set();
  for (const t of catalog.endpoints) {
    assert.ok(provided.has(t.type), `${t.id}: no plugin provides ${t.type}`);
    assert.ok(!ids.has(t.id), `${t.id} twice`);
    ids.add(t.id);
    const providers = new Set((t.models ?? []).map((/** @type {any} */ m) => m.providerId));
    for (const m of t.models ?? []) assert.ok(typeof m.prices?.input === 'number' && typeof m.prices?.output === 'number', `${t.id}/${m.providerId}: prices`);
    for (const suggestion of Object.values(t.roles ?? {})) {
      for (const list of Object.values(/** @type {Record<string, string[]>} */ (suggestion))) for (const p of list) assert.ok(providers.has(p), `${t.id}: suggests ${p}`);
    }
  }
});

test('adding from a template: the endpoint, its models, its key, and suggested models for empty roles only', async () => {
  const { ws, store } = await setup();
  const or = await addFromTemplate({ ws, store }, tpl('openrouter'), { key: 'sk-or-test-1', roles: 'free' });
  let cfg = await readConfig(ws);
  assert.equal(endpointOf(cfg.endpoints[or]).baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(cfg.endpoints[or].template?.id, 'openrouter');
  assert.equal(Object.values(cfg.models).length, 5);
  assert.equal(await getKey(store, or), 'sk-or-test-1');
  const name = (/** @type {string} */ id) => modelOf(cfg.models[id]).name;
  assert.deepEqual(cfg.roles.main.models.map(name), ['Google: Gemma 4 31B (free)']);
  assert.deepEqual(cfg.roles.utility.models.map(name), ['Google: Gemma 4 26B A4B (free)']);
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: 'recommended' });
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles.main.models.map(name), ['Google: Gemma 4 31B (free)'], 'a role the user already has is kept');
  await useSuggestion({ ws }, or, tpl('openrouter'), 'recommended');
  cfg = await readConfig(ws);
  assert.deepEqual(cfg.roles.main.models.map(name), ['Anthropic: Claude Sonnet 5.5']);
});

test('adding the same template twice gives the second set of models names of their own', async () => {
  const { ws, store } = await setup();
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  const names = Object.values((await readConfig(ws)).models).map((m) => modelOf(m).name).sort();
  assert.ok(names.includes('Claude Haiku 5.5') && names.includes('Claude Haiku 5.5 (2)'), names.join());
});

test("a newer template is offered, and applying it keeps the user's own changes (spec §9.8)", async () => {
  const { ws, store } = await setup();
  const id = await addFromTemplate({ ws, store }, tpl('anthropic'), { roles: null });
  let cfg = await readConfig(ws);
  const rec = cfg.endpoints[id];
  await saveEndpoint(ws, { ...rec, user: { name: 'My Anthropic' } });
  const v2 = structuredClone(tpl('anthropic'));
  v2.version = 2;
  v2.baseUrl = 'https://api2.anthropic.com';
  v2.models[1].contextWindow = 2000000;
  const newer = { ...catalog, endpoints: [v2] };
  cfg = await readConfig(ws);
  assert.deepEqual(templateUpdates(cfg, newer).map((u) => u.endpoint), [id]);
  assert.deepEqual(templateUpdates(cfg, catalog), []);
  await applyTemplate({ ws }, id, v2);
  cfg = await readConfig(ws);
  const e = endpointOf(cfg.endpoints[id]);
  assert.equal(e.name, 'My Anthropic');
  assert.equal(e.baseUrl, 'https://api2.anthropic.com');
  const haiku = Object.values(cfg.models).map(modelOf).find((m) => m.providerId === 'claude-haiku-5-5');
  assert.equal(haiku?.contextWindow, 2000000);
  assert.deepEqual(templateUpdates(cfg, newer), []);
});

test('a model from a fetched list keeps what the list said, under a name of its own', async () => {
  const { ws, store } = await setup();
  const id = await addFromTemplate({ ws, store }, tpl('openrouter'), { roles: null });
  const m = await addListedModel({ ws }, id, { providerId: 'x/haiku', name: 'Anthropic: Claude Haiku 5.5', contextWindow: 1000, tools: true });
  const model = modelOf((await readConfig(ws)).models[m]);
  assert.equal(model.name, 'Anthropic: Claude Haiku 5.5 (2)');
  assert.equal(model.contextWindow, 1000);
});

test("templates load when online and come from last time's copy when offline", async () => {
  const { ws } = await setup();
  const online = await loadTemplates({ ws, fetch: repoFetch });
  assert.equal(online.endpoints[0].id, 'openrouter');
  const offline = await loadTemplates({ ws, fetch: async () => { throw new TypeError('offline'); } });
  assert.deepEqual(offline, online);
  const { ws: fresh } = await setup();
  assert.deepEqual(await loadTemplates({ ws: fresh, fetch: async () => { throw new TypeError('offline'); } }), { format: 1, endpoints: [] });
});

test('the service: installs an endpoint type on demand, calls a role with fallback, traces it, lists models', async () => {
  const { registry, store, ws } = await setup();
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const plugins = new PluginHost({ registry, workspace: ws, importModule });
  const llm = createLlm({ store, ws, plugins, fetch: repoFetch });
  await llm.ensureType('scripted');
  const id = await addFromTemplate({ ws, store }, tpl('scripted'), { roles: null });
  const cfg = await readConfig(ws);
  await saveRoles(ws, { ...cfg.roles, main: { models: Object.keys(cfg.models), level: 'medium' } });
  const r = await llm.call({ request: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] } });
  assert.equal(r.reply.text, 'Hello from the scripted model.');
  assert.equal(r.answeredBy, 'Scripted');
  const kinds = (await store.tx(['events'], 'readonly', (t) => t.listEvents(SYS))).map((e) => e.type);
  assert.ok(kinds.includes('net.request') && kinds.includes('model.turn'), kinds.join());
  assert.deepEqual((await llm.listModels(id)).map((m) => m.providerId), ['scripted']);
});
