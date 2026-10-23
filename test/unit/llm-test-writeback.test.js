import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { readConfig, modelOf, saveModel, markVerified } from '../../src/core/llm/config.js';
import { addProvider } from '../../src/core/llm/providers.js';
import { createLlm } from '../../src/core/llm/service.js';
import { official } from './provider-kit.js';

// The model Test button reads the model, asks the provider (slowly), and records what it found. A field the user saved meanwhile must stay.

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

/** A scripted provider whose calls take 100 ms, and its one chat model. */
async function slowModel() {
  const { llm, ws, store } = await realLlm();
  await llm.ensureType('scripted');
  const desc = await official('provider-scripted');
  desc.provider.abilities.chat.tunables = { script: [{ text: 'OK', delayMs: 100 }, { toolCalls: [{ name: 'report_color', input: { color: 'red' } }], delayMs: 100 }] };
  await addProvider({ ws, store }, desc, { roles: null });
  const [id] = Object.keys((await readConfig(ws)).models);
  return { llm, ws, id };
}

/** The model page's field saver, as the user types a context window while the Test runs. */
async function typeWindow(/** @type {Workspace} */ ws, /** @type {string} */ id) {
  const rec = (await readConfig(ws)).models[id];
  await saveModel(ws, { ...rec, user: { ...(rec.user ?? {}), contextWindow: 12345 } });
}

test('a field saved while the model Test runs survives the Test, and the Test is recorded', async () => {
  const { llm, ws, id } = await slowModel();
  const testing = llm.test(id);
  await new Promise((r) => setTimeout(r, 50));
  await typeWindow(ws, id);
  await testing;
  const after = (await readConfig(ws)).models[id];
  assert.equal(modelOf(after).contextWindow, 12345, 'the field typed during the Test is kept');
  assert.equal(typeof after.verified?.at, 'number', 'and what the Test found is recorded');
});

test('a field saved while the reasoning levels are tried survives, and the levels are recorded', async () => {
  const { llm, ws, id } = await slowModel();
  // Levels are tried only on a model that has some.
  const rec = (await readConfig(ws)).models[id];
  await saveModel(ws, { ...rec, user: { ...(rec.user ?? {}), reasoning: { low: {}, high: {} } } });
  const testing = llm.testLevels(id);
  await new Promise((r) => setTimeout(r, 50));
  await typeWindow(ws, id);
  await testing;
  const after = (await readConfig(ws)).models[id];
  assert.equal(modelOf(after).contextWindow, 12345);
  assert.equal(typeof after.verified?.levelsAt, 'number');
});

test('markVerified changes only what a Test found, and a model removed meanwhile stays removed', async () => {
  const { ws, id } = await slowModel();
  await markVerified(ws, id, { speech: true, at: 5 });
  await markVerified(ws, id, { key: true });
  assert.deepEqual((await readConfig(ws)).models[id].verified, { speech: true, at: 5, key: true });
  const { removeModel } = await import('../../src/core/llm/config.js');
  await removeModel(ws, id);
  await markVerified(ws, id, { speech: false });
  assert.equal((await readConfig(ws)).models[id], undefined);
});
