import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace, ValidationError } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry, PluginError } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { utf8 } from '../../src/core/bytes.js';

/** @param {string} dir @param {string} [prefix] */
async function fixture(dir, prefix = '') {
  const root = new URL(`../fixtures/plugins/${dir}/`, import.meta.url);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const name of await readdir(root)) files.set(prefix + name, new Uint8Array(await readFile(new URL(name, root))));
  return files;
}

async function setup() {
  const store = createMemoryStore();
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
  const host = new PluginHost({ registry, workspace: ws, importModule });
  return { store, ws, registry, host, logged };
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
