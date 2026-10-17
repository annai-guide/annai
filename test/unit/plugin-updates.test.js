import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';
import { ensureType, officialUpdates, updateOfficial } from '../../src/core/llm/official.js';
import { offerPluginUpdates, applyUpdates, pluginUpdates } from '../../src/ui/plugin-updates.js';
import { addressUpdates, updateFromAddress } from '../../src/core/package-updates.js';
import { fetchPackage } from '../../src/core/packages.js';
import { SKILL, hostKit } from './package-kit.js';

const root = new URL('../../', import.meta.url);

/**
 * A fetch serving this repository's catalog and plugin files; with `bump`, the scripted model's
 * manifest and catalog entry carry the next patch version, as if annai had shipped a new version.
 */
/** The scripted model's shipped version, and the next patch version. */
const NOW = JSON.parse(await readFile(new URL('plugins-official/scripted-model/annai-plugin.json', root), 'utf8')).version;
const NEXT = NOW.replace(/\d+$/, (/** @type {string} */ n) => String(Number(n) + 1));

async function repo({ bump = false } = {}) {
  const manifest = JSON.parse(await readFile(new URL('plugins-official/scripted-model/annai-plugin.json', root), 'utf8'));
  const bumped = utf8(JSON.stringify({ ...manifest, version: NEXT }, null, 2) + '\n');
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  if (bump) {
    const entry = catalog.plugins.find((/** @type {any} */ p) => p.id === 'scripted-model');
    entry.version = NEXT;
    entry.files['annai-plugin.json'] = await sha256Hex(bumped);
  }
  return async (/** @type {any} */ url) => {
    const path = new URL(String(url), 'http://annai.test').pathname;
    if (path === '/catalog/plugins.json') return new Response(JSON.stringify(catalog));
    if (bump && path === '/plugins-official/scripted-model/annai-plugin.json') return new Response(/** @type {any} */ (bumped));
    try {
      return new Response(/** @type {any} */ (new Uint8Array(await readFile(new URL(`.${path}`, root)))));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

async function setup() {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const importModule = async (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    if (!m) return import(url);
    const code = await ws.readText(SYS_PLUGINS, `/${decodeURIComponent(m[1])}/${m[2]}`);
    return import(`data:text/javascript;base64,${Buffer.from(code ?? '').toString('base64')}`);
  };
  return { ws, registry, importModule, host: new PluginHost({ registry, workspace: ws, importModule }) };
}

test("official plugins whose catalog version differs are offered; others aren't (spec §5.3)", async () => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  assert.deepEqual(await officialUpdates(host, { fetch: await repo() }), []);
  const updates = await officialUpdates(host, { fetch: await repo({ bump: true }) });
  assert.deepEqual(updates.map((u) => [u.id, u.installed, u.available]), [['scripted-model', NOW, NEXT]]);
});

test('updating: old code that already ran needs a restart; code that never ran starts now; the on/off choice is kept', async () => {
  const { host, ws, importModule } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  const [u] = await officialUpdates(host, { fetch: await repo({ bump: true }) });
  assert.equal(await updateOfficial(host, u.entry, { fetch: await repo({ bump: true }) }), 'restart');
  assert.equal((await host.installed())['scripted-model'].version, NEXT);
  assert.deepEqual(await officialUpdates(host, { fetch: await repo({ bump: true }) }), []);

  const fresh = await setup();
  await ensureType(fresh.host, 'scripted', { fetch: await repo() });
  await fresh.host.setEnabled('scripted-model', false);
  const later = new PluginHost({ registry: new Registry(), workspace: fresh.ws, importModule: fresh.importModule });
  const [v] = await officialUpdates(later, { fetch: await repo({ bump: true }) });
  assert.equal(await updateOfficial(later, v.entry, { fetch: await repo({ bump: true }) }), 'started');
  assert.equal((await later.installed())['scripted-model'].enabled, false, 'a plugin the user turned off stays off');
  void ws; void importModule;
});

test('the card offers updates, applies them on Update, and offers a restart; offline it stays quiet', async () => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} */
  const toasts = [];
  let reloaded = false;
  const ctx = { plugins: host, notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; }, toast: (/** @type {string} */ t) => toasts.push(t) } };
  const env = { fetch: await repo({ bump: true }), reload: () => { reloaded = true; } };
  const offered = await offerPluginUpdates(ctx, env);
  assert.equal(offered.length, 1);
  assert.equal(cards[0].title, 'Plugin updates are ready');
  assert.ok(cards[0].body.includes(`Scripted model ${NOW} → ${NEXT}`), cards[0].body);
  // Updating stops the running version, so the cards say so (spec §5.3).
  assert.match(cards[0].body, /off until annai restarts/);
  await applyUpdates(ctx, offered, env);
  assert.equal(cards[1].title, 'Restart annai to use the new versions');
  assert.equal(cards[1].tone, 'warn');
  assert.match(cards[1].body, /Until then, Scripted model can't be used\./);
  cards[1].actions[0].run();
  assert.equal(reloaded, true);
  assert.deepEqual(await offerPluginUpdates(ctx, { fetch: async () => { throw new TypeError('offline'); } }), []);
  assert.equal(cards.length, 2);
});

const ADDR = 'https://trails.example/tide-pools/SKILL.md';

test('a package from an address is checked there, offered when it changed, and changes only on Update (spec §5.3)', async () => {
  let served = SKILL;
  const get = async (/** @type {string} */ url) => (url === ADDR ? new Response(served) : new Response('', { status: 404 }));
  const { host, registry } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  await host.start('tide-pools');
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  served = SKILL.replace('version: "1.2"', 'version: "1.3"').replace('# Tide pools', '# Tide pools, new');
  const offers = await pluginUpdates(host, { addressFetch: get, fetch: async () => new Response(JSON.stringify({ plugins: [] })) });
  assert.deepEqual(offers.map((u) => [u.id, u.installed, u.available, u.url]), [['tide-pools', '1.2.0', '1.3.0', ADDR]]);
  const skill = () => registry.list('skill').find((s) => s.name === 'tide-pools');
  assert.match(await skill().text(), /^# Tide pools\n/);
  /** @type {any[]} */
  const said = [];
  await applyUpdates({ plugins: host, notices: { card: (/** @type {any} */ c) => said.push(c.title), toast: (/** @type {string} */ t) => said.push(t) } }, offers, { addressFetch: get });
  assert.deepEqual(said, ['Plugins updated.']);
  assert.match(await skill().text(), /^# Tide pools, new/);
  assert.equal((await host.installed())['tide-pools'].version, '1.3.0');
});

test('a changed skill with the same version is offered as changed', async () => {
  let served = SKILL;
  const get = async () => new Response(served);
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  served = SKILL.replace('# Tide pools', '# Tide pools, reworded');
  const [u] = await addressUpdates(host, { fetch: get });
  assert.deepEqual([u.installed, u.available, u.changed], ['1.2.0', '1.2.0', true]);
});

test('an address that is offline, broken or now holds another package offers nothing; Update says why; an off package stays off', async () => {
  let answer = /** @type {() => Promise<Response>} */ (async () => new Response(SKILL));
  const get = () => answer();
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  answer = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  answer = async () => new Response('---\nbroken');
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  answer = async () => new Response(SKILL.replace('name: tide-pools', 'name: other-skill'));
  assert.deepEqual(await addressUpdates(host, { fetch: get }), []);
  await assert.rejects(updateFromAddress(host, 'tide-pools', { fetch: get }), /now holds another package \(other-skill\)/);
  answer = async () => new Response(SKILL.replace('version: "1.2"', 'version: "2"'));
  await host.setEnabled('tide-pools', false);
  assert.equal(await updateFromAddress(host, 'tide-pools', { fetch: get }), 'started');
  const s = (await host.installed())['tide-pools'];
  assert.deepEqual([s.version, s.enabled], ['2.0.0', false]);
});
