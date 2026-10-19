import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8 } from '../../src/core/bytes.js';
import { sha256Hex } from '../../src/core/hash.js';
import { satisfies, checkRequires, installWith, addFromCatalog, prune, dependents } from '../../src/core/requires.js';
import { updateOfficial } from '../../src/core/llm/official.js';
import { files, hostKit } from './package-kit.js';

/** A protocol plugin: code that registers one endpoint type. @param {string} id @param {string} type @param {string} version */
const PROTO = (id, type, version) => ({
  'annai-plugin.json': JSON.stringify({ id, name: `Proto ${type}`, version, api: 1, entry: 'index.js', provides: { 'endpoint-type': [type] } }),
  'index.js': `export function activate(annai) { return annai.providers.register({ type: '${type}', name: '${type}', run: async function* () { yield { type: 'text', text: 'hi' }; } }); }`,
});
/** A data-only provider plugin needing requires, with a chat ability per type. @param {string} id @param {any[]} requires @param {string[]} types @param {string} [version] */
const PROVIDER = (id, requires, types, version = '1.0.0') => ({
  'annai-plugin.json': JSON.stringify({
    id, name: `Provider ${id}`, version, api: 1, requires,
    provider: { baseUrl: 'https://llm.example/v1', key: 'required', abilities: Object.fromEntries(types.map((t, i) => [`chat-${i}`, { kind: 'chat', type: t }])) },
  }),
});

/**
 * annai's catalog and official plugin files, stood in for: what fetch asked for is kept; failNext makes the next request
 * for one path fail as a dropped connection does; offline makes every request fail.
 * @param {Record<string, Record<string, string>>} plugins by id, each its files
 */
async function site(plugins) {
  const entries = [];
  for (const [id, f] of Object.entries(plugins)) {
    const m = JSON.parse(f['annai-plugin.json']);
    /** @type {Record<string, string>} */
    const hashes = {};
    for (const [name, text] of Object.entries(f)) hashes[name] = await sha256Hex(utf8(text));
    entries.push({ id, name: m.name, version: m.version, provides: m.provides ?? {}, requires: m.requires ?? [], files: hashes });
  }
  const s = {
    /** @type {string[]} */ asked: [],
    /** @type {Set<string>} */ failing: new Set(),
    offline: false,
    /** @param {string} path */ failNext: (path) => { s.failing.add(path); },
    /** @param {any} url */
    fetch: async (url) => {
      const path = new URL(String(url), 'http://annai.test').pathname;
      s.asked.push(path);
      if (s.offline) throw new TypeError('Failed to fetch');
      if (s.failing.delete(path)) throw new TypeError('Failed to fetch');
      if (path === '/catalog/plugins.json') return new Response(JSON.stringify({ format: 1, plugins: entries }));
      const m = /^\/plugins-official\/([^/]+)\/(.+)$/.exec(path);
      const text = m ? plugins[m[1]]?.[m[2]] : undefined;
      return text === undefined ? new Response('not found', { status: 404 }) : new Response(text);
    },
    entries,
  };
  return s;
}

const CATALOG = () => site({
  'proto-a': PROTO('proto-a', 'type-a', '0.3.0'),
  'proto-b': PROTO('proto-b', 'type-b', '0.2.0'),
  'provider-x': PROVIDER('provider-x', [{ id: 'proto-a', version: '^0' }, { id: 'proto-b', version: '^0' }], ['type-a', 'type-b']),
});

test('satisfies: ^N is the same major', () => {
  assert.equal(satisfies('0.3.1', '^0'), true);
  assert.equal(satisfies('1.0.0', '^0'), false);
  assert.equal(satisfies('2.4.0', '^2'), true);
  assert.equal(satisfies('2.4.0-beta.1', '^2'), true);
  assert.equal(satisfies('2.4.0', '>=2'), false, 'only ^N is a range');
});

test('an official requirement is installed from the catalog, hash-checked, with no question; one installed in range is left alone', async () => {
  const { host, registry } = await hostKit();
  const s = await CATALOG();
  await addFromCatalog(host, 'proto-a', { fetch: s.fetch });
  s.asked.length = 0;
  await addFromCatalog(host, 'provider-x', { fetch: s.fetch });
  const installed = await host.installed();
  assert.deepEqual(Object.keys(installed).sort(), ['proto-a', 'proto-b', 'provider-x']);
  assert.ok(Object.values(installed).every((p) => p.source === 'official'));
  assert.ok(!s.asked.some((p) => p.startsWith('/plugins-official/proto-a/')), 'proto-a, in range, is left alone');
  assert.deepEqual(registry.list('endpoint-type').map((t) => t.type).sort(), ['type-a', 'type-b']);
  assert.deepEqual(registry.list('provider').map((p) => p.plugin), ['provider-x']);
  // Installed and current: it is started, nothing is downloaded.
  s.asked.length = 0;
  await addFromCatalog(host, 'provider-x', { fetch: s.fetch });
  assert.deepEqual(s.asked, ['/catalog/plugins.json']);
  // A tampered file is refused: nothing new is installed.
  const { host: other } = await hostKit();
  const bad = await CATALOG();
  bad.entries[1].files['index.js'] = '0'.repeat(64);
  await assert.rejects(addFromCatalog(other, 'provider-x', { fetch: bad.fetch }), /doesn't match annai's catalog/);
  assert.deepEqual(Object.keys(await other.installed()), []);
});

test('a third-party requirement that is not installed stops the install and names it, with its homepage; nothing is installed', async () => {
  const { host } = await hostKit();
  const s = await CATALOG();
  const acme = files(PROVIDER('acme-provider', [{ id: 'acme-proto', version: '^2', homepage: 'https://acme.example/annai' }], ['acme']));
  await assert.rejects(installWith(host, acme, { source: 'url', url: 'https://acme.example/p/annai-plugin.json' }, { fetch: s.fetch }), /needs acme-proto.*https:\/\/acme\.example\/annai/s);
  assert.deepEqual(Object.keys(await host.installed()), []);
  // Once it is installed, in range, the provider installs.
  await host.install(files(PROTO('acme-proto', 'acme', '2.1.0')), { source: 'file' });
  await installWith(host, acme, { source: 'url', url: 'https://acme.example/p/annai-plugin.json' }, { fetch: s.fetch });
  assert.deepEqual(Object.keys(await host.installed()).sort(), ['acme-proto', 'acme-provider']);
  // Out of range: annai can't update a third party's, so it says which version is there.
  const { host: old } = await hostKit();
  await old.install(files(PROTO('acme-proto', 'acme', '1.4.0')), { source: 'file' });
  await assert.rejects(installWith(old, acme, { source: 'file' }, { fetch: s.fetch }), /acme-proto.*\^2.*1\.4\.0/s);
});

test('a requirement whose download fails halfway, or a catalog that cannot be reached: plain words, nothing half-installed, and the next try works (Review Focus 3)', async () => {
  const { host } = await hostKit();
  const s = await CATALOG();
  s.failNext('/plugins-official/proto-b/index.js');
  await assert.rejects(addFromCatalog(host, 'provider-x', { fetch: s.fetch }), /couldn't be downloaded/);
  assert.deepEqual(Object.keys(await host.installed()), []);
  s.offline = true;
  await assert.rejects(addFromCatalog(host, 'provider-x', { fetch: s.fetch }), /couldn't be loaded.*connection/);
  assert.deepEqual(Object.keys(await host.installed()), []);
  s.offline = false;
  await addFromCatalog(host, 'provider-x', { fetch: s.fetch });
  assert.deepEqual(Object.keys(await host.installed()).sort(), ['proto-a', 'proto-b', 'provider-x']);
});

test('a provider that fails to start after its requirements installed: what this install added is removed again', async () => {
  const { host } = await hostKit();
  const s = await site({ 'proto-a': PROTO('proto-a', 'type-a', '0.3.0'), 'provider-y': { 'annai-plugin.json': JSON.stringify({ id: 'provider-y', name: 'Y', version: '1.0.0', api: 1, entry: 'index.js', requires: [{ id: 'proto-a', version: '^0' }] }), 'index.js': 'export function activate() { throw new Error("broken"); }' } });
  await assert.rejects(addFromCatalog(host, 'provider-y', { fetch: s.fetch }), /broken/);
  assert.deepEqual(Object.keys(await host.installed()), []);
});

test('no version in range: the install stops and says which and what annai has', async () => {
  const { host } = await hostKit();
  const s = await site({ 'proto-a': PROTO('proto-a', 'type-a', '0.3.0'), 'provider-z': PROVIDER('provider-z', [{ id: 'proto-a', version: '^1' }], ['type-a']) });
  await assert.rejects(addFromCatalog(host, 'provider-z', { fetch: s.fetch }), /needs Proto type-a \^1.*0\.3\.0/s);
  assert.deepEqual(Object.keys(await host.installed()), []);
  await assert.rejects(checkRequires(host, [{ id: 'proto-q', version: '^0' }], s.entries), /needs proto-q, which isn't installed/);
});

test("an update that changes requires installs what it needs on Update; an update of a protocol to a major an installed plugin doesn't accept stops and names that plugin", async () => {
  const { host } = await hostKit();
  const s = await site({ 'proto-a': PROTO('proto-a', 'type-a', '0.3.0'), 'provider-w': PROVIDER('provider-w', [{ id: 'proto-a', version: '^0' }], ['type-a']) });
  await addFromCatalog(host, 'provider-w', { fetch: s.fetch });
  const next = await site({
    'proto-a': PROTO('proto-a', 'type-a', '1.0.0'), 'proto-b': PROTO('proto-b', 'type-b', '0.2.0'),
    'provider-w': PROVIDER('provider-w', [{ id: 'proto-a', version: '^0' }, { id: 'proto-b', version: '^0' }], ['type-a', 'type-b'], '1.1.0'),
  });
  const entry = (/** @type {string} */ id) => /** @type {any} */ (next.entries.find((e) => e.id === id));
  await assert.rejects(updateOfficial(host, entry('proto-a'), { fetch: next.fetch }), /Provider provider-w.*\^0/s);
  assert.equal((await host.installed())['proto-a'].version, '0.3.0');
  // provider-w 1.1.0 needs proto-b too, and proto-a ^0: proto-a stays at 0.3.0, which is in range.
  assert.equal(await updateOfficial(host, entry('provider-w'), { fetch: next.fetch }), 'started');
  const installed = await host.installed();
  assert.deepEqual([installed['provider-w'].version, installed['proto-b']?.version, installed['proto-a'].version], ['1.1.0', '0.2.0', '0.3.0']);
});

test('prune removes official protocol plugins nothing requires and no ability uses; a third-party protocol plugin stays', async () => {
  const { host } = await hostKit();
  const s = await site({
    'proto-a': PROTO('proto-a', 'type-a', '0.3.0'), 'proto-b': PROTO('proto-b', 'type-b', '0.2.0'), 'proto-c': PROTO('proto-c', 'type-c', '0.1.0'),
    'provider-v': PROVIDER('provider-v', [{ id: 'proto-a', version: '^0' }], ['type-a']),
  });
  for (const id of ['provider-v', 'proto-b', 'proto-c']) await addFromCatalog(host, id, { fetch: s.fetch });
  await host.install(files(PROTO('proto-mine', 'type-mine', '1.0.0')), { source: 'file' });
  assert.deepEqual(await prune(host, new Set(['type-c'])), ['proto-b']);
  assert.deepEqual(Object.keys(await host.installed()).sort(), ['proto-a', 'proto-c', 'proto-mine', 'provider-v']);
  await host.uninstall('provider-v');
  assert.deepEqual(await prune(host, new Set()), ['proto-a', 'proto-c']);
  assert.deepEqual(Object.keys(await host.installed()), ['proto-mine']);
});

test("dependents names the installed plugins that require one; an official install over a third-party package with that id is refused, saying so", async () => {
  const { host } = await hostKit();
  const s = await CATALOG();
  await addFromCatalog(host, 'provider-x', { fetch: s.fetch });
  assert.deepEqual(await dependents(host, 'proto-a'), [{ id: 'provider-x', name: 'Provider provider-x' }]);
  assert.deepEqual(await dependents(host, 'provider-x'), []);
  const { host: other } = await hostKit();
  await other.install(files(PROTO('proto-a', 'type-a', '0.3.0')), { source: 'file' });
  await assert.rejects(addFromCatalog(other, 'provider-x', { fetch: s.fetch }), /proto-a.*isn't annai's own/s);
  assert.deepEqual(Object.keys(await other.installed()), ['proto-a']);
  await other.install(files(PROVIDER('provider-x', [], ['type-a'])), { source: 'file' });
  await assert.rejects(addFromCatalog(other, 'provider-x', { fetch: s.fetch }), /provider-x.*isn't annai's own/s);
});
