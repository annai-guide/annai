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

// The coordinator's second security finding (milestone 8a): an update from an address that brings
// new parts asks first, listing them; new code asks with the install screen's full-trust words.
const KIT_ADDR = 'https://trails.example/kit/annai-plugin.json';
/** A served package: its manifest, plus each file it names, at KIT_ADDR's folder. @param {any} manifest @param {Record<string, string>} more */
const kitSite = (manifest, more) => async (/** @type {string} */ url) => {
  if (url === KIT_ADDR) return new Response(JSON.stringify(manifest));
  const name = url.slice(KIT_ADDR.length - 'annai-plugin.json'.length);
  return name in more ? new Response(more[name]) : new Response('', { status: 404 });
};
const KIT_V1 = { id: 'kit', name: 'Kit', version: '1.0.0', api: 1, skills: ['skills/trail-safety'] };
const SAFETY = { 'skills/trail-safety/SKILL.md': '---\nname: trail-safety\ndescription: Before a hike, what to check.\n---\nCarry water.' };
const fakeNotices = () => {
  /** @type {any[]} */
  const cards = [];
  /** @type {string[]} */
  const toasts = [];
  return { cards, toasts, card: (/** @type {any} */ c) => { cards.push(c); return () => {}; }, toast: (/** @type {string} */ t) => toasts.push(t) };
};

test('a package without code whose update adds code asks with the full-trust words, and changes nothing until the user agrees', async () => {
  let site = kitSite(KIT_V1, SAFETY);
  const get = (/** @type {string} */ url) => site(url);
  const { host } = await hostKit();
  await host.install(await fetchPackage(KIT_ADDR, { fetch: get }), { source: 'url', url: KIT_ADDR });
  await host.start('kit');
  site = kitSite({ ...KIT_V1, version: '1.1.0', entry: 'index.js' }, { ...SAFETY, 'index.js': 'export function activate() {}' });
  const offers = await pluginUpdates(host, { addressFetch: get, fetch: async () => new Response(JSON.stringify({ plugins: [] })) });
  assert.equal(offers[0].added?.code, true);
  const notices = fakeNotices();
  await applyUpdates({ plugins: host, notices }, offers, { addressFetch: get });
  assert.equal((await host.installed()).kit.version, '1.0.0');
  assert.deepEqual(notices.toasts, []);
  const [ask] = notices.cards;
  assert.match(ask.body, /Code that runs in annai/);
  assert.match(ask.body, /This plugin gets full access to your trips and API keys\./);
  assert.deepEqual(ask.actions.map((/** @type {any} */ a) => a.label), ['Update', 'Not now']);
  await ask.actions[0].run();
  assert.equal((await host.installed()).kit.version, '1.1.0');
});

test('an update from an address that adds a skill lists it before anything changes', async () => {
  let site = kitSite(KIT_V1, SAFETY);
  const get = (/** @type {string} */ url) => site(url);
  const { host } = await hostKit();
  await host.install(await fetchPackage(KIT_ADDR, { fetch: get }), { source: 'url', url: KIT_ADDR });
  site = kitSite({ ...KIT_V1, version: '1.1.0', skills: ['skills/trail-safety', 'skills/trail-maps'] },
    { ...SAFETY, 'skills/trail-maps/SKILL.md': '---\nname: trail-maps\ndescription: Reading a trail map.\n---\nNorth is up.' });
  const offers = await addressUpdates(host, { fetch: get });
  const notices = fakeNotices();
  await applyUpdates({ plugins: host, notices }, offers, { addressFetch: get });
  assert.equal((await host.installed()).kit.version, '1.0.0');
  assert.match(notices.cards[0].body, /Skill "trail-maps": Reading a trail map\./);
  assert.doesNotMatch(notices.cards[0].body, /full access/);
  await assert.rejects(updateFromAddress(host, 'kit', { fetch: get }), /adds parts you haven't agreed to/);
});

test('an update from an address with nothing new is applied as before', async () => {
  let site = kitSite(KIT_V1, SAFETY);
  const get = (/** @type {string} */ url) => site(url);
  const { host } = await hostKit();
  await host.install(await fetchPackage(KIT_ADDR, { fetch: get }), { source: 'url', url: KIT_ADDR });
  site = kitSite({ ...KIT_V1, version: '1.0.1' }, { 'skills/trail-safety/SKILL.md': SAFETY['skills/trail-safety/SKILL.md'].replace('Carry water.', 'Carry more water.') });
  const notices = fakeNotices();
  await applyUpdates({ plugins: host, notices }, await addressUpdates(host, { fetch: get }), { addressFetch: get });
  assert.deepEqual([notices.cards.length, notices.toasts], [0, ['Plugins updated.']]);
  assert.equal((await host.installed()).kit.version, '1.0.1');
});

// Fix pass 8a-1: a key in a package's address lives in the package's secret, never in installed.json.
const KEY = 'zap1a2b3c4d5e6f7g8h9';
const KEYED = `https://trails.example/s/${KEY}/tide-pools/SKILL.md`;
const SHOWN = 'https://trails.example/s/«key»/tide-pools/SKILL.md';
/** Every text annai keeps: files, log entries and stored content. @param {any} store */
const everything = (store) => store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
  const out = [];
  for (const s of await t.listScopes()) out.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
  for (const b of await t.listBlobs()) out.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
  return out.join('\n');
});
const addressSecret = (/** @type {any} */ store, id = 'tide-pools') => store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`package:${id}:address`));
/** Where annai kept that secret before Reset's fix pass (R1): among the plugin's own. */
const oldAddressSecret = (/** @type {any} */ store, id = 'tide-pools') => store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`plugin:${id}:address`));

test("8a-1: a key in a package's address is kept in its secret: installed.json, its history and the log show «key»; updates still find it; Remove forgets it", async () => {
  let served = SKILL;
  const get = async (/** @type {string} */ url) => (url === KEYED ? new Response(served) : new Response('', { status: 404 }));
  const { host, store } = await hostKit();
  await host.install(await fetchPackage(KEYED, { fetch: get }), { source: 'url', url: KEYED });
  assert.equal((await host.installed())['tide-pools'].url, SHOWN);
  assert.deepEqual(await addressSecret(store), { address: KEYED, keys: [KEY] });
  assert.equal(/** @type {any} */ ((await host.describe()).find((r) => r.id === 'tide-pools'))?.url, SHOWN);
  served = SKILL.replace('version: "1.2"', 'version: "1.3"');
  const [u] = await addressUpdates(host, { fetch: get });
  assert.deepEqual([u.available, u.url], ['1.3.0', SHOWN]);
  await updateFromAddress(host, 'tide-pools', { fetch: get });
  assert.equal((await host.installed())['tide-pools'].version, '1.3.0');
  assert.doesNotMatch(await everything(store), new RegExp(KEY));
  await host.uninstall('tide-pools');
  assert.equal(await addressSecret(store), undefined);
});

test('Reset R1: an address secret kept under its old name, among the plugin\'s own, moves at the next read or start, as one a backup from then brings back does', async () => {
  const get = async (/** @type {string} */ url) => (url === KEYED ? new Response(SKILL.replace('version: "1.2"', 'version: "1.3"')) : new Response('', { status: 404 }));
  for (const when of ['read', 'start']) {
    const k = await hostKit();
    await k.host.install(await fetchPackage(KEYED, { fetch: async () => new Response(SKILL) }), { source: 'url', url: KEYED });
    // As annai kept it before this fix.
    await k.store.tx(['secrets'], 'readwrite', async (/** @type {any} */ t) => {
      await t.putSecret('plugin:tide-pools:address', await t.getSecret('package:tide-pools:address'));
      await t.deleteSecret('package:tide-pools:address');
    });
    const host = when === 'start' ? k.relaunch() : k.host;
    if (when === 'start') await host.startInstalled();
    else assert.equal(await host.address('tide-pools'), KEYED, when);
    assert.deepEqual(await addressSecret(k.store), { address: KEYED, keys: [KEY] }, when);
    assert.equal(await oldAddressSecret(k.store), undefined, when);
    assert.equal(await updateFromAddress(host, 'tide-pools', { fetch: get }), 'started', when);
    assert.equal((await host.installed())['tide-pools'].version, '1.3.0', when);
  }
});

test('8a-1: a plain address still works; a raw one kept before this fix moves into the secret at its next read, or at the next start', async () => {
  const get = async (/** @type {string} */ url) => (url === KEYED || url === ADDR ? new Response(SKILL.replace('version: "1.2"', 'version: "1.3"')) : new Response('', { status: 404 }));
  // A plain address: kept as it is, and no secret.
  const plain = await hostKit();
  await plain.host.install(await fetchPackage(ADDR, { fetch: async () => new Response(SKILL) }), { source: 'url', url: ADDR });
  assert.equal((await plain.host.installed())['tide-pools'].url, ADDR);
  assert.equal(await addressSecret(plain.store), undefined);
  assert.equal((await addressUpdates(plain.host, { fetch: get }))[0]?.available, '1.3.0');
  for (const when of ['read', 'start']) {
    const k = await hostKit();
    await k.host.install(await fetchPackage(ADDR, { fetch: async () => new Response(SKILL) }), { source: 'url', url: ADDR });
    // As installed.json was before this fix: the address with its key, raw.
    await k.ws.patch(SYS_PLUGINS, '/installed.json', { 'tide-pools': { url: KEYED } }, { author: 'system' });
    const host = when === 'start' ? k.relaunch() : k.host;
    if (when === 'start') await host.startInstalled();
    else assert.equal((await addressUpdates(host, { fetch: get }))[0]?.available, '1.3.0', when);
    assert.equal((await host.installed())['tide-pools'].url, SHOWN, when);
    assert.deepEqual(await addressSecret(k.store), { address: KEYED, keys: [KEY] }, when);
    assert.doesNotMatch(await everything(k.store), new RegExp(KEY), when);
    assert.equal(await updateFromAddress(host, 'tide-pools', { fetch: get }), 'started', when);
    assert.equal((await host.installed())['tide-pools'].version, '1.3.0', when);
  }
});
