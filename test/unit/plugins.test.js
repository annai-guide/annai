import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError, StorageFullError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost, PLUGIN_MAX_BYTES } from '../../src/core/plugins.js';
import { ZipWriter } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';

/** @param {string} dir @param {string} [prefix] */
async function fixture(dir, prefix = '') {
  const root = new URL(`../fixtures/plugins/${dir}/`, import.meta.url);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(root)) files.set(prefix + name, new Uint8Array(await readFile(new URL(name, root))));
  return files;
}

/** @param {{ store?: import("../../src/core/types.js").Store } & Record<string, any>} [opts] */
async function setup({ store = createMemoryStore(), ...hostOpts } = {}) {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => logged.push(ev) });
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  // In Node there is no service worker: load installed plugin files from the workspace as data: URLs.
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  const host = new PluginHost({ registry, workspace: ws, importModule, ...hostOpts });
  /** A new launch of annai on the same storage. */
  const relaunch = () => new PluginHost({ registry: new Registry(), workspace: ws, importModule });
  return { store, ws, registry, host, logged, importModule, relaunch };
}

test('registry: add, list, remove one, remove a plugin, onChange', () => {
  const r = new Registry();
  let changes = 0;
  r.onChange(() => changes++);
  const off = r.add('a', 'tool', { name: 't1' });
  r.add('a', 'tool', { name: 't2' });
  r.add('b', 'tool', { name: 't3' });
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t1', 't2', 't3']);
  off();
  r.removePlugin('b');
  assert.deepEqual(r.list('tool').map((t) => t.name), ['t2']);
  assert.equal(changes, 5);
});

test('registry: guard logs failures and switches a plugin off after three in a row', async () => {
  /** @type {any[]} */
  const logged = [];
  const r = new Registry({ log: (ev) => logged.push(ev) });
  r.add('flaky', 'tool', { name: 'x' });
  let fail = true;
  const fn = r.guard('flaky', 'tool x', async () => { if (fail) throw new Error('nope'); return 'ok'; });
  await assert.rejects(fn(), PluginError);
  fail = false;
  assert.equal(await fn(), 'ok'); // success resets the count
  fail = true;
  for (let i = 0; i < 3; i++) await assert.rejects(fn(), PluginError);
  assert.equal(r.isDisabled('flaky'), true);
  assert.deepEqual(r.list('tool'), []);
  assert.deepEqual(logged.map((e) => e.type), ['plugin.error', 'plugin.error', 'plugin.error', 'plugin.error', 'plugin.disabled']);
  await assert.rejects(fn(), /switched off/);
  r.enable('flaky');
  fail = false;
  assert.equal(await fn(), 'ok');
  assert.equal(r.list('tool').length, 1);
});

test('host: built-in core schemas take effect', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await assert.rejects(createTrip(ws, { title: 'Big Sur', start: 'not a date' }), ValidationError);
  const rows = await host.describe();
  assert.deepEqual(rows.map((r) => [r.id, r.builtin, r.active]), [['core-schemas', true, true]]);
});

test('host: install, start, turn off, turn on and uninstall a plugin', async () => {
  const { ws, host } = await setup();
  const manifest = await host.install(await fixture('hello'));
  assert.equal(manifest.id, 'hello');
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/hello/')).map((f) => f.path), ['/hello/annai-plugin.json', '/hello/index.js']);
  assert.equal((await host.installed()).hello.enabled, true);
  await host.start('hello');
  const trip = await createTrip(ws, { title: 'T' });
  await assert.rejects(ws.write(trip, '/hello/a.json', {}, { author: 'user' }), (e) => e instanceof ValidationError && /greeting/.test(e.message));
  await host.setEnabled('hello', false);
  await ws.write(trip, '/hello/a.json', {}, { author: 'user' });
  await host.setEnabled('hello', true);
  await assert.rejects(ws.write(trip, '/hello/b.json', {}, { author: 'user' }), ValidationError);
  await host.uninstall('hello');
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.equal((await host.installed()).hello, undefined);
  await ws.write(trip, '/hello/c.json', {}, { author: 'user' });
});

test('host: a package inside one folder installs too', async () => {
  const { host } = await setup();
  const m = await host.install(await fixture('hello', 'hello-1.0.0/'));
  assert.equal(m.id, 'hello');
});

test('host: refuses bad packages and writes nothing', async () => {
  const { ws, host } = await setup();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  const good = await fixture('hello');
  const manifest = JSON.parse(new TextDecoder().decode(good.get('annai-plugin.json')));
  const variant = (/** @type {any} */ changes, /** @type {Record<string, string>} */ extra = {}) => {
    const files = new Map(good);
    files.set('annai-plugin.json', utf8(JSON.stringify({ ...manifest, ...changes })));
    for (const [k, v] of Object.entries(extra)) files.set(k, utf8(v));
    return files;
  };
  const cases = [
    new Map([['index.js', utf8('export {}')]]),
    new Map([['annai-plugin.json', utf8('{not json')]]),
    variant({ id: 'Hello World' }),
    variant({ api: 2 }),
    variant({ entry: 'missing.js' }),
    variant({ id: 'core-schemas' }),
    variant({}, { '../evil.js': 'export {}' }),
  ];
  for (const files of cases) await assert.rejects(host.install(files), PluginError);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.deepEqual(await host.installed(), {});
});

test('host: a plugin whose activate throws is not started and is logged', async () => {
  const { host, logged } = await setup();
  await host.install(await fixture('broken'));
  await assert.rejects(host.start('broken'), PluginError);
  assert.equal(host.active.has('broken'), false);
  assert.equal(logged.at(-1).type, 'plugin.error');
  const failures = await host.startInstalled();
  assert.deepEqual(failures.map((f) => f.id), ['broken']);
});

/** A one-file plugin package. @param {string} id @param {string} code @param {Record<string, any>} [extra] manifest fields */
function inline(id, code, extra = {}) {
  return new Map([
    ['annai-plugin.json', utf8(JSON.stringify({ id, name: id, version: '1.0.0', api: 1, entry: 'index.js', ...extra }))],
    ['index.js', utf8(code)],
  ]);
}

test('host: a plugin that never finishes starting is given up on, and annai carries on', async () => {
  const { host, logged } = await setup({ startTimeout: 50 });
  await host.install(await fixture('hang'));
  const failures = await host.startInstalled();
  assert.deepEqual(failures.map((f) => f.id), ['hang']);
  assert.match(String(/** @type {any} */ (failures[0].error)?.message), /didn't finish starting/);
  assert.equal(host.active.has('hang'), false);
  assert.equal(logged.at(-1).type, 'plugin.error');
});

test('host: what a plugin sets up after it timed out is taken down again', async () => {
  const { host, registry } = await setup({ startTimeout: 20 });
  await host.install(inline('late', `export async function activate(annai) {
    await new Promise((r) => setTimeout(r, 60));
    annai.register('thing', { from: 'late' });
    return () => { globalThis.lateDisposed = true; };
  }`));
  await assert.rejects(host.start('late'), /didn't finish starting/);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(registry.list('thing'), []);
  assert.equal(/** @type {any} */ (globalThis).lateDisposed, true);
});

test('host: a stored plugin is checked again before it starts', async () => {
  const { ws, host } = await setup();
  const put = (/** @type {string} */ path, /** @type {any} */ content) => ws.write(SYS_PLUGINS, path, content, { author: 'system' });
  await put('/evil/index.js', 'export function activate() {}');
  await put('/installed.json', { evil: { version: '1.0.0', name: 'Evil', enabled: true, installed: 1, source: 'x' } });
  /** @type {[any, RegExp][]} */
  const cases = [
    [{ id: 'evil', name: 'Evil', version: '1.0.0', api: 99, entry: 'index.js' }, /API 99/],
    [{ id: 'evil', name: 'Evil', version: '1.0.0', api: 1, entry: '../../whatever.js' }, /entry/],
    [{ id: 'other', name: 'Evil', version: '1.0.0', api: 1, entry: 'index.js' }, /folder/],
  ];
  for (const [manifest, why] of cases) {
    await put('/evil/annai-plugin.json', manifest);
    await assert.rejects(host.start('evil'), (e) => e instanceof PluginError && why.test(e.message), String(why));
    assert.equal(host.active.has('evil'), false);
    assert.match(String((await host.describe()).find((r) => r.id === 'evil')?.problem), why);
  }
});

test('host: reinstalling a plugin that already ran asks for a restart instead of running old code', async () => {
  const { host, relaunch } = await setup();
  await host.install(await fixture('hello'));
  await host.install(await fixture('hello')); // never ran yet: nothing stale
  assert.equal(host.needsRestart('hello'), false);
  await host.start('hello');
  await host.install(await fixture('hello'));
  assert.equal(host.needsRestart('hello'), true);
  await assert.rejects(host.start('hello'), /Restart annai/);
  assert.equal(host.active.has('hello'), false);
  assert.equal((await host.describe()).find((r) => r.id === 'hello')?.restart, true);
  const next = relaunch();
  await next.start('hello');
  assert.equal(next.active.has('hello'), true);
});

test('host: a plugin that fails to start on three launches in a row is turned off', async () => {
  const { host, relaunch } = await setup();
  await host.install(await fixture('broken'));
  for (let launch = 1; launch <= 3; launch++) {
    const failures = await relaunch().startInstalled();
    assert.deepEqual(failures.map((f) => [f.id, f.disabled]), [['broken', launch === 3]], `launch ${launch}`);
  }
  assert.equal((await host.installed()).broken.enabled, false);
  assert.deepEqual(await relaunch().startInstalled(), []);
  await assert.rejects(host.setEnabled('broken', true), PluginError); // turning it back on is a fresh start
  assert.equal((await host.installed()).broken.startFailures, 0);
});

test('host: an install that runs out of space leaves nothing behind', async () => {
  const inner = createMemoryStore();
  let full = false;
  /** @type {import('../../src/core/types.js').Store} */
  const store = {
    close() {},
    tx(stores, mode, fn) {
      let blobs = 0;
      return inner.tx(stores, mode, (t) => fn({ ...t, putBlob: async (rec) => {
        if (full && ++blobs === 2) throw new DOMException('no space', 'QuotaExceededError');
        return t.putBlob(rec);
      } }));
    },
  };
  const { ws, host } = await setup({ store });
  full = true;
  await assert.rejects(host.install(await fixture('hello')), StorageFullError);
  full = false;
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/hello/'), []);
  assert.deepEqual(await host.installed(), {});
});

test('host: plugin packages are limited to 64 MB unpacked', async () => {
  assert.equal(PLUGIN_MAX_BYTES, 64 * 1024 * 1024);
  const { host } = await setup({ maxPackageBytes: 4000 });
  const z = new ZipWriter();
  for (const [name, bytes] of await fixture('hello')) await z.add(name, bytes);
  await z.add('big.txt', utf8('x'.repeat(5000)));
  const zip = new Uint8Array(await z.finish().arrayBuffer());
  await assert.rejects(host.installZip(zip), (e) => e instanceof PluginError && /too large/.test(e.message));
  await assert.rejects(host.installZip(utf8('not a zip')), PluginError);
  assert.equal((await (await setup()).host.installZip(zip)).id, 'hello'); // fine under the real limit
});

test('host: a tool keeps its own "this" when annai runs it', async () => {
  const { host, registry } = await setup();
  await host.install(inline('tooly', `export function activate(annai) {
    annai.tools.register({ name: 'greet', description: 'Greets.', input: { type: 'object' }, prefix: 'hi ', run(x) { return this.prefix + x; } });
  }`));
  await host.start('tooly');
  assert.equal(await registry.list('tool')[0].run('there'), 'hi there');
});

test("host: a tool's own errors are answers Shiori sees, not crashes; a crash counts against the plugin (spec §5.5, §6.7)", async () => {
  const { host, registry } = await setup();
  await host.install(inline('picky', `export function activate(annai) {
    annai.tools.register({ name: 'picky', description: 'Refuses.', input: { type: 'object' }, run() { throw new Error('No such file: /trip/x.md'); } });
    annai.tools.register({ name: 'buggy', description: 'Crashes.', input: { type: 'object' }, run() { return undefined.x; } });
  }`));
  await host.start('picky');
  const [picky, buggy] = registry.list('tool');
  for (let i = 0; i < 5; i++) await assert.rejects(picky.run({}), /No such file/);
  assert.equal(registry.isDisabled('picky'), false);
  for (let i = 0; i < 3; i++) await assert.rejects(buggy.run({}), PluginError);
  assert.equal(registry.isDisabled('picky'), true);
});

test("host: a fetch that fails because the device is offline is the tool's answer, not a crash (spec §17)", async () => {
  const { host, registry } = await setup();
  await host.install(inline('online', `export function activate(annai) {
    annai.tools.register({ name: 'online', description: 'Needs the network.', input: { type: 'object' }, run() { throw new TypeError('Failed to fetch'); } });
    annai.tools.register({ name: 'safari', description: 'Needs the network.', input: { type: 'object' }, run() { throw new TypeError('Load failed'); } });
  }`));
  await host.start('online');
  const [chrome, safari] = registry.list('tool');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(chrome.run({}), /Failed to fetch/);
    await assert.rejects(safari.run({}), /Load failed/);
  }
  assert.equal(registry.isDisabled('online'), false);
});
