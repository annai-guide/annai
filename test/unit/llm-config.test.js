import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { ensureBaseScopes, SYS_SETTINGS } from '../../src/core/scopes.js';
import {
  CHAT_ROLES, readConfig, endpointOf, endpointBase, modelOf, modelBase, diffLayer, newEndpoint, newModel,
  saveEndpoint, saveModel, saveRoles, removeEndpoint, removeModel, setKey, getKey,
} from '../../src/core/llm/config.js';

async function setup() {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  return { store, ws };
}

const openrouter = () => newEndpoint('chat-completions', {
  template: { id: 'openrouter', version: 1, values: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', tunables: { reasoningField: 'reasoning' } } },
});

test('settings round-trip, and effective values are plugin defaults < template < user (spec §9.2)', async () => {
  const { ws } = await setup();
  const ep = { ...openrouter(), user: { name: 'My router' } };
  const m = newModel(ep.id, {
    template: { id: 'openrouter/x', version: 1, values: { providerId: 'x/y', contextWindow: 1000, prices: { input: 1, output: 2 } } },
    user: { contextWindow: 500 },
  });
  await saveEndpoint(ws, ep, [m]);
  const cfg = await readConfig(ws);
  const e = endpointOf(cfg.endpoints[ep.id], { reasoningField: 'auto', usageInStream: true });
  assert.equal(e.name, 'My router');
  assert.equal(e.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(e.tunables, { reasoningField: 'reasoning', usageInStream: true });
  assert.deepEqual(e.headers, {});
  const mm = modelOf(cfg.models[m.id]);
  assert.equal(mm.name, 'x/y', 'a model is named by its provider id until the user names it');
  assert.equal(mm.contextWindow, 500);
  assert.deepEqual(mm.prices, { input: 1, output: 2 });
  assert.deepEqual(mm.input, ['text']);
  assert.equal(mm.tools, true);
  assert.equal(endpointBase(cfg.endpoints[ep.id]).name, 'OpenRouter');
  assert.equal(modelBase(cfg.models[m.id]).contextWindow, 1000);
});

test("a newer template changes what the user left alone, never what they changed", () => {
  const rec = newModel('ep-1', { template: { id: 't/x', version: 1, values: { providerId: 'x', contextWindow: 1000, maxOutput: 100 } }, user: { maxOutput: 50 } });
  const updated = { ...rec, template: { id: 't/x', version: 2, values: { providerId: 'x', contextWindow: 2000, maxOutput: 200 } } };
  assert.equal(modelOf(updated).contextWindow, 2000);
  assert.equal(modelOf(updated).maxOutput, 50);
});

test('diffLayer keeps only what the user changed', () => {
  const base = { name: 'OpenRouter', baseUrl: 'https://x', headers: {}, tunables: { a: 1 }, extraBody: {} };
  assert.deepEqual(diffLayer({ ...base }, base), {});
  assert.deepEqual(diffLayer({ ...base, name: 'Mine', tunables: { a: 2 } }, base), { name: 'Mine', tunables: { a: 2 } });
});

test('model names are unique, whatever their case', async () => {
  const { ws } = await setup();
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  await saveModel(ws, newModel(ep.id, { user: { providerId: 'a/b', name: 'Haiku' } }));
  await assert.rejects(saveModel(ws, newModel(ep.id, { user: { providerId: 'c/d', name: 'haiku' } })), (e) => e instanceof ValidationError && /already used/.test(e.errors.join()));
  await assert.rejects(saveModel(ws, newModel(ep.id, { user: {} })), ValidationError);
  await assert.rejects(saveModel(ws, newModel('ep-gone', { user: { providerId: 'z' } })), ValidationError);
});

test('roles: every chat role, its default level, and only models that exist', async () => {
  const { ws } = await setup();
  const ep = openrouter();
  const a = newModel(ep.id, { user: { providerId: 'a' } });
  await saveEndpoint(ws, ep, [a]);
  await saveRoles(ws, { main: { models: [a.id, 'm-gone'], level: 'high', firstOutputSeconds: 20 }, utility: { models: [], level: 'low' } });
  const { roles } = await readConfig(ws);
  assert.deepEqual(Object.keys(roles).sort(), [...CHAT_ROLES].sort());
  assert.deepEqual(roles.main, { models: [a.id], level: 'high', firstOutputSeconds: 20 });
  assert.deepEqual(roles.decide, { models: [], level: 'off' });
  await assert.rejects(saveRoles(ws, { main: { models: [], level: 'extreme' } }), ValidationError);
});

test('removing an endpoint removes its models, their places in roles, and its key', async () => {
  const { ws, store } = await setup();
  const ep = openrouter();
  const other = newEndpoint('anthropic-messages', { user: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com' } });
  const a = newModel(ep.id, { user: { providerId: 'a' } });
  const b = newModel(other.id, { user: { providerId: 'b' } });
  await saveEndpoint(ws, ep, [a]);
  await saveEndpoint(ws, other, [b]);
  await saveRoles(ws, { main: { models: [a.id, b.id], level: 'medium' } });
  await setKey(store, ep.id, 'sk-or-1234567890');
  await removeEndpoint(ws, store, ep.id);
  const cfg = await readConfig(ws);
  assert.deepEqual(Object.keys(cfg.endpoints), [other.id]);
  assert.deepEqual(Object.keys(cfg.models), [b.id]);
  assert.deepEqual(cfg.roles.main.models, [b.id]);
  assert.equal(await getKey(store, ep.id), null);
  await removeModel(ws, b.id);
  assert.deepEqual((await readConfig(ws)).roles.main.models, []);
});

test('keys live only in secrets, never in the settings files (spec §9.9)', async () => {
  const { ws, store } = await setup();
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  await setKey(store, ep.id, 'sk-or-secret-key-1');
  assert.equal(await getKey(store, ep.id), 'sk-or-secret-key-1');
  for (const f of await ws.list(SYS_SETTINGS, '/')) assert.doesNotMatch(String(await ws.readText(SYS_SETTINGS, f.path)), /sk-or-secret/);
  await setKey(store, ep.id, null);
  assert.equal(await getKey(store, ep.id), null);
});

test('records that are not valid are refused on save and skipped on read', async () => {
  const { ws } = await setup();
  await assert.rejects(saveEndpoint(ws, /** @type {any} */ ({ id: 'BAD ID', type: '', template: null, user: {}, created: 1 })), ValidationError);
  await ws.write(SYS_SETTINGS, '/llm/endpoints/broken.json', { nope: true }, { author: 'user' });
  const ep = openrouter();
  await saveEndpoint(ws, ep);
  assert.deepEqual(Object.keys((await readConfig(ws)).endpoints), [ep.id]);
});
