import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost, isPluginBug } from '../../src/core/plugins.js';
import { TargetError, NEEDS_YOU, storageTypes, readAnswer, TEXT_MAX, checkStorageType } from '../../src/core/storage-types.js';
import { ensureProvided, offeredTypes, officialUpdates } from '../../src/core/llm/official.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: installed plugin files load from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  return { registry, ws, host: new PluginHost({ registry, workspace: ws, importModule }) };
}

/** @param {string} code */
const moduleUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;

/** A complete storage type, to break one part at a time. */
const good = () => ({
  type: 'probe-two', name: 'Probe', stores: 'tree', fields: [{ key: 'where', label: 'Where' }], secret: [{ key: 'token', label: 'Token' }],
  where: () => '', check: async () => ({ note: '' }), list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]),
});

test('a plugin adds a kind of backup place through annai.storage (spec §5.4)', async () => {
  const k = await setup();
  await k.host.addBuiltin(moduleUrl(`export const manifest = { id: 'probe-store', name: 'Probe', version: '1.0.0', api: 1 };
    export function activate(a) {
      globalThis.__probeStore = a;
      return a.storage.register({ type: 'probe', name: ' Probe ', stores: 'tree', where: (c) => c.where,
        check: async () => ({ note: 'ok' }), list: async () => [], put: async () => ({ id: '1', at: 1 }), get: async () => new Blob([]) });
    }`));
  const t = storageTypes(k.registry).get('probe');
  assert.deepEqual([t?.pluginId, t?.stores, t?.name, t?.fields, t?.secret], ['probe-store', 'tree', 'Probe', [], []]);
  const a = /** @type {any} */ (globalThis).__probeStore;
  assert.equal(a.helpers.TargetError, TargetError);
  assert.equal(typeof a.helpers.zip.ZipReader.open, 'function');
  assert.equal(typeof a.helpers.zip.ZipWriter, 'function');
  /** @type {[any, RegExp][]} */
  const bad = [
    [{ ...good(), type: 'Bad Type' }, /lowercase/],
    [{ ...good(), name: ' ' }, /needs a name/],
    [{ ...good(), stores: 'disk' }, /"tree".*"file"/],
    [{ ...good(), get: undefined }, /needs get\(\)/],
    [{ ...good(), delete: 'yes' }, /delete/],
    [{ ...good(), fields: [{ label: 'no key' }] }, /field/],
  ];
  for (const [type, why] of bad) assert.throws(() => a.storage.register(type), (e) => e instanceof PluginError && why.test(e.message));
  await k.host.stop('probe-store');
  assert.equal(storageTypes(k.registry).has('probe'), false);
});

test('TargetError carries what annai needs to act on it; a bug in a plugin is told apart from its answer', () => {
  const e = new TargetError('newer', 'A newer backup is there.', { remote: { id: 'c2', at: 5 } });
  assert.deepEqual([e.name, e.kind, e.message, e.remote?.id], ['TargetError', 'newer', 'A newer backup is there.', 'c2']);
  assert.equal(new TargetError('rate', 'Wait.', { retryAt: 9 }).retryAt, 9);
  assert.deepEqual([...NEEDS_YOU].sort(), ['auth', 'missing', 'refused', 'setup']);
  assert.equal(isPluginBug(new TypeError('x is not a function')), true);
  assert.equal(isPluginBug(new ReferenceError('y is not defined')), true);
  assert.equal(isPluginBug(new TypeError('Failed to fetch')), false);
  assert.equal(isPluginBug(new TypeError('Load failed')), false);
  assert.equal(isPluginBug(new TargetError('auth', 'no')), false);
  assert.equal(isPluginBug(new DOMException('stopped', 'AbortError')), false);
  assert.equal(isPluginBug('a string'), true);
  assert.equal(isPluginBug(new TypeError('Invalid URL')), false, 'an address the user typed, not a bug');
  assert.equal(isPluginBug(new TypeError('Failed to parse URL from https://a b')), false);
});

test('choosing a kind of backup place installs the official plugin that provides it (spec §5.3)', async () => {
  const k = await setup();
  const code = utf8(`export function activate(a) {
    return a.storage.register({ type: 'probe', name: 'Probe', stores: 'file', where: () => '', check: async () => ({ note: '' }),
      list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]) });
  }`);
  const manifest = utf8(JSON.stringify({ id: 'storage-probe', name: 'Probe storage', version: '1.0.0', api: 1, entry: 'index.js', provides: { 'storage-type': ['probe'] } }));
  const catalog = { format: 1, plugins: [{ id: 'storage-probe', name: 'Probe storage', version: '1.0.0', provides: { 'storage-type': ['probe'] },
    files: { 'annai-plugin.json': await sha256Hex(manifest), 'index.js': await sha256Hex(code) } }] };
  /** @type {Record<string, Uint8Array>} */
  const served = { '/catalog/plugins.json': utf8(JSON.stringify(catalog)), '/plugins-official/storage-probe/annai-plugin.json': manifest, '/plugins-official/storage-probe/index.js': code };
  const get = async (/** @type {any} */ url) => {
    const body = served[new URL(String(url), 'http://annai.test').pathname];
    return body ? new Response(/** @type {any} */ (body)) : new Response('not found', { status: 404 });
  };
  assert.deepEqual(await offeredTypes('storage-type', { fetch: get }), [{ type: 'probe', name: 'Probe storage' }]);
  assert.deepEqual(await offeredTypes('endpoint-type', { fetch: get }), []);
  await Promise.all([ensureProvided(k.host, 'storage-type', 'probe', { fetch: get }), ensureProvided(k.host, 'storage-type', 'probe', { fetch: get })]);
  assert.equal(storageTypes(k.registry).get('probe')?.pluginId, 'storage-probe');
  assert.equal((await k.host.installed())['storage-probe']?.source, 'official');
  await assert.rejects(ensureProvided(k.host, 'storage-type', 'nope', { fetch: get }), /isn't a kind of backup place annai knows/);
});

test("a server's answer is read, or refused in plain words: never a crash in the plugin (spec §5.5)", async () => {
  assert.deepEqual(await readAnswer(new Response('{"a":1}'), 'json', 'GitHub'), { a: 1 });
  assert.equal(await readAnswer(new Response('<x/>'), 'text', 'the bucket'), '<x/>');
  assert.equal((await readAnswer(new Response('abc'), 'blob', 'the bucket')).size, 3);
  assert.equal((await readAnswer(new Response('abcd'), 'arrayBuffer', 'the bucket')).byteLength, 4);
  await assert.rejects(readAnswer(new Response('<html>Unicorn!</html>'), 'json', 'GitHub'),
    (e) => e instanceof TargetError && e.kind === 'other' && /GitHub answered something annai can't read/.test(e.message) && !isPluginBug(e));
  await assert.rejects(readAnswer(new Response('x'.repeat(2000)), 'text', 'the bucket', { max: 1000 }), (e) => e instanceof TargetError && /larger than annai reads/.test(e.message));
  await assert.rejects(readAnswer(new Response('x', { headers: { 'content-length': String(TEXT_MAX + 1) } }), 'text', 'the bucket'), /larger than annai reads \(8 MB\)/);
  const cut = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('part')); c.error(new TypeError('terminated')); } }));
  await assert.rejects(readAnswer(cut, 'text', 'the bucket'), (e) => e instanceof TargetError && /connection to the bucket broke/.test(e.message) && !isPluginBug(e));
  assert.equal(TEXT_MAX, 8 * 1024 * 1024);
  assert.deepEqual(await readAnswer(new Response('abc'), 'bytes', 'GitHub'), new TextEncoder().encode('abc'));
  await assert.rejects(readAnswer(new Response('x'.repeat(2000)), 'bytes', 'GitHub', { max: 1000 }), /larger than annai reads/);
});

/** annai's catalog with one official storage plugin, served as annai's own origin serves it. */
async function probeCatalog() {
  const code = utf8(`export function activate(a) {
    return a.storage.register({ type: 'probe', name: 'Probe', stores: 'file', where: () => '', check: async () => ({ note: '' }),
      list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]) });
  }`);
  const manifest = utf8(JSON.stringify({ id: 'storage-probe', name: 'Probe storage', version: '1.0.0', api: 1, entry: 'index.js', provides: { 'storage-type': ['probe'] } }));
  const entry = { id: 'storage-probe', name: 'Probe storage', version: '1.0.0', provides: { 'storage-type': ['probe'] },
    files: { 'annai-plugin.json': await sha256Hex(manifest), 'index.js': await sha256Hex(code) } };
  /** @type {Record<string, Uint8Array>} */
  const served = { '/catalog/plugins.json': utf8(JSON.stringify({ format: 1, plugins: [entry] })), '/plugins-official/storage-probe/annai-plugin.json': manifest, '/plugins-official/storage-probe/index.js': code };
  const get = async (/** @type {any} */ url) => {
    const body = served[new URL(String(url), 'http://annai.test').pathname];
    return body ? new Response(/** @type {any} */ (body)) : new Response('not found', { status: 404 });
  };
  // The same plugin, changed by someone else: what a restored backup could carry under the official id.
  const tampered = utf8(`export function activate(a) {
    globalThis.__tamperedRan = true;
    return a.storage.register({ type: 'probe', name: 'Probe', stores: 'file', where: () => '', check: async () => ({ note: '' }),
      list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]) });
  }`);
  return { code, manifest, entry, get, tampered };
}

test("an installed plugin that claims an official id runs only when its files match annai's catalog (spec §5.3)", async () => {
  const k = await setup();
  const p = await probeCatalog();
  // A backup restored with "Replace my plugins" brought a changed copy, switched off, under the official id and version.
  await k.host.install(new Map([['annai-plugin.json', p.manifest], ['index.js', p.tampered]]), { source: 'official' });
  await k.host.setEnabled('storage-probe', false);
  assert.equal(await k.host.verifyOfficial('storage-probe', p.entry), false);
  await ensureProvided(k.host, 'storage-type', 'probe', { fetch: p.get });
  assert.equal(/** @type {any} */ (globalThis).__tamperedRan, undefined, 'the changed code never ran');
  assert.deepEqual((await k.ws.read(SYS_PLUGINS, '/storage-probe/index.js'))?.bytes, p.code);
  assert.equal(await k.host.verifyOfficial('storage-probe', p.entry), true);
  assert.equal(storageTypes(k.registry).get('probe')?.pluginId, 'storage-probe');
});

test('a changed official plugin is offered the catalog\'s files as an update, even at the same version', async () => {
  const k = await setup();
  const p = await probeCatalog();
  await k.host.install(new Map([['annai-plugin.json', p.manifest], ['index.js', p.tampered]]), { source: 'official' });
  const offered = await officialUpdates(k.host, { fetch: p.get });
  assert.deepEqual(offered.map((u) => [u.id, u.installed, u.available]), [['storage-probe', '1.0.0', '1.0.0']]);
  await k.host.install(new Map([['annai-plugin.json', p.manifest], ['index.js', p.code]]), { source: 'official' });
  assert.deepEqual(await officialUpdates(k.host, { fetch: p.get }), []);
});

test('"Turn it on" brings back a plugin annai switched off after repeated errors (spec §5.5)', async () => {
  const k = await setup();
  const p = await probeCatalog();
  await ensureProvided(k.host, 'storage-type', 'probe', { fetch: p.get });
  for (let i = 0; i < 3; i++) k.registry.fail('storage-probe', 'backup put', new TypeError('x is not a function'));
  assert.equal(storageTypes(k.registry).has('probe'), false);
  await ensureProvided(k.host, 'storage-type', 'probe', { fetch: p.get });
  assert.equal(storageTypes(k.registry).get('probe')?.pluginId, 'storage-probe');
  assert.equal(k.registry.isDisabled('storage-probe'), false);
});

test('a kind of backup place may have a peek; anything else there is no peek at all', () => {
  const ok = { type: 'x', name: 'X', stores: 'tree', where: () => '', check: () => {}, list: () => {}, put: () => {}, get: () => {}, fields: [], secret: [] };
  assert.equal(checkStorageType(ok), null);
  assert.equal(checkStorageType({ ...ok, peek: () => {} }), null);
  for (const peek of [null, 'yes', 5, {}]) assert.equal(checkStorageType({ ...ok, peek }), null, String(peek));
});

test('a registered kind of place keeps a peek that is a function, and drops one that is not', async () => {
  const k = await setup();
  await k.host.addBuiltin(moduleUrl(`export const manifest = { id: 'probe-peek', name: 'Probe', version: '1.0.0', api: 1 };
    export function activate(a) {
      const one = (type, peek) => a.storage.register({ type, name: type, stores: 'tree', where: () => '', check: async () => ({ note: '' }),
        list: async () => [], put: async () => ({ id: '', at: 0 }), get: async () => new Blob([]), peek });
      const off = [one('with-peek', async () => ({})), one('null-peek', null), one('text-peek', 'yes')];
      return () => off.forEach((f) => f());
    }`));
  const types = storageTypes(k.registry);
  assert.equal(typeof types.get('with-peek')?.peek, 'function');
  assert.equal(types.get('null-peek')?.peek, undefined);
  assert.equal(types.get('text-peek')?.peek, undefined);
});
