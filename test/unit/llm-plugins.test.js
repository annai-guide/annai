import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { endpointTypes, ProviderError } from '../../src/core/llm/contract.js';
import { ensureType } from '../../src/core/llm/official.js';
import { utf8 } from '../../src/core/bytes.js';

const root = new URL('../../', import.meta.url);

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: load installed plugin files from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule });
  return { registry, ws, host, importModule };
}

/** A fetch that serves annai's own catalog and official plugin files from this repository. @param {(path: string, bytes: Uint8Array) => Uint8Array} [tamper] */
function repoFetch(tamper = (_p, b) => b) {
  /** @type {string[]} */
  const asked = [];
  const get = async (/** @type {any} */ url) => {
    const path = new URL(String(url), 'http://annai.test').pathname;
    asked.push(path);
    try {
      return new Response(/** @type {any} */ (tamper(path, new Uint8Array(await readFile(new URL(`.${path}`, root))))));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return { get, asked };
}

/** @param {any} type @param {any} spec */
async function events(type, spec) {
  const out = [];
  for await (const e of type.run(spec)) out.push(e);
  return out;
}

test('an official plugin is installed from the catalog only when every file matches it (spec §5.3)', async () => {
  const { host, registry } = await setup();
  const tampered = repoFetch((p, b) => (p.endsWith('/index.js') ? utf8('export function activate() {}') : b));
  await assert.rejects(ensureType(host, 'scripted', { fetch: tampered.get }), (e) => e instanceof PluginError && /doesn't match/.test(e.message));
  assert.equal((await host.installed())['scripted-model'], undefined);
  const real = repoFetch();
  await ensureType(host, 'scripted', { fetch: real.get });
  const type = endpointTypes(registry).get('scripted');
  assert.equal(type?.pluginId, 'scripted-model');
  assert.equal((await host.installed())['scripted-model'].source, 'official');
});

test('ensureType starts an installed plugin instead of downloading it again, and knows no other types', async () => {
  const { host, ws, importModule } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const relaunched = new PluginHost({ registry: new Registry(), workspace: ws, importModule });
  const again = repoFetch();
  await ensureType(relaunched, 'scripted', { fetch: again.get });
  assert.deepEqual(again.asked, ['/catalog/plugins.json']);
  assert.ok(endpointTypes(relaunched.registry).has('scripted'));
  await assert.rejects(ensureType(relaunched, 'no-such-type', { fetch: repoFetch().get }), /isn't an endpoint type annai knows/);
});

test('an endpoint type needs build() and read(), or run()', async () => {
  const { host } = await setup();
  const files = new Map([
    ['annai-plugin.json', utf8(JSON.stringify({ id: 'half-type', name: 'Half', version: '1.0.0', api: 1, entry: 'index.js' }))],
    ['index.js', utf8("export function activate(annai) { return annai.providers.register({ type: 'half', build() {} }); }")],
  ]);
  await host.install(files);
  await assert.rejects(host.start('half-type'), /needs build\(\) and read\(\), or run\(\)/);
});

test('the scripted model replies from its script, one step per call, the last one repeating (spec §18)', async () => {
  const { host, registry } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const type = /** @type {any} */ (endpointTypes(registry).get('scripted'));
  const endpoint = { id: 'ep-1', tunables: { script: [{ text: 'Hello there, friend.', reasoning: 'Greet them.' }, { error: 'credit', status: 402 }, { text: 'Kyoto is', cut: true }] } };
  const first = await events(type, { endpoint });
  assert.deepEqual(first.filter((e) => e.type === 'reasoning'), [{ type: 'reasoning', text: 'Greet them.' }]);
  assert.equal(first.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello there, friend.');
  assert.ok(first.filter((e) => e.type === 'text').length > 1, 'the text arrives in pieces');
  assert.deepEqual(first.at(-1), { type: 'stop', reason: 'end' });
  await assert.rejects(events(type, { endpoint }), (e) => e instanceof Error && e.name === 'ProviderError' && /** @type {any} */ (e).kind === 'credit');
  const cut = [];
  await assert.rejects((async () => { for await (const e of type.run({ endpoint })) cut.push(e); })(), (e) => /** @type {any} */ (e).kind === 'network');
  assert.equal(cut.map((e) => e.text).join(''), 'Kyoto is');
  await assert.rejects(events(type, { endpoint }), (e) => /** @type {any} */ (e).kind === 'network', 'the last step repeats');
  assert.deepEqual(await type.list(), [{ providerId: 'scripted', name: 'Scripted', contextWindow: 200000, maxOutput: 4096, input: ['text', 'image'], tools: true }]);
});

test('the error classes plugins get are the core ones', async () => {
  const { host, registry } = await setup();
  await ensureType(host, 'scripted', { fetch: repoFetch().get });
  const type = /** @type {any} */ (endpointTypes(registry).get('scripted'));
  await assert.rejects(events(type, { endpoint: { id: 'e', tunables: { script: [{ error: 'auth' }] } } }), ProviderError);
});

test('registry.fail counts a failure found outside guard()', () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev), maxFailures: 2 });
  r.add('p', 'endpoint-type', { type: 'x' });
  r.fail('p', 'reading a stream', new Error('bad chunk'));
  assert.equal(logged[0].type, 'plugin.error');
  r.fail('p', 'reading a stream', new Error('bad chunk'));
  assert.equal(r.isDisabled('p'), true);
  assert.deepEqual(r.list('endpoint-type'), []);
});

test('catalog/plugins.json lists every official plugin', async () => {
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const dirs = (await readdir(new URL('plugins-official/', root), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(catalog.plugins.map((/** @type {any} */ p) => p.id).sort(), dirs);
});
