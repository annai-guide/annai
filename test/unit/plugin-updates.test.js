import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS_PLUGINS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { sha256Hex } from '../../src/core/hash.js';
import { utf8 } from '../../src/core/bytes.js';
import { ensureType, officialUpdates, updateOfficial, installOfficial } from '../../src/core/llm/official.js';
import { offerCard, applyUpdates, checkPlugins, knownUpdates } from '../../src/ui/plugin-updates.js';
import { addressUpdates, updateFromAddress } from '../../src/core/package-updates.js';
import { fetchPackage } from '../../src/core/packages.js';
import { SKILL, hostKit } from './package-kit.js';
import { QUIET_MS } from '../../src/core/answer.js';
import { messageOf } from '../../src/ui/dom.js';
import { setWords } from '../../src/core/l10n.js';
import { dead, watch, turns } from './dead-kit.js';
import { Updates } from '../../src/ui/updates.js';

const root = new URL('../../', import.meta.url);

/**
 * A fetch serving this repository's catalog and plugin files; with `bump`, the scripted model's
 * manifest and catalog entry carry the next patch version, as if annai had shipped a new version; with `revise`, its code is another
 * file at the same version, as if annai had changed it without a new version.
 */
/** The scripted model's shipped version, and the next patch version. */
const NOW = JSON.parse(await readFile(new URL('plugins-official/scripted-model/annai-plugin.json', root), 'utf8')).version;
const NEXT = NOW.replace(/\d+$/, (/** @type {string} */ n) => String(Number(n) + 1));

async function repo({ bump = false, revise = false } = {}) {
  const manifest = JSON.parse(await readFile(new URL('plugins-official/scripted-model/annai-plugin.json', root), 'utf8'));
  const bumped = utf8(JSON.stringify({ ...manifest, version: NEXT }, null, 2) + '\n');
  const revised = utf8(`${await readFile(new URL('plugins-official/scripted-model/index.js', root), 'utf8')}\n// revised\n`);
  const catalog = JSON.parse(await readFile(new URL('catalog/plugins.json', root), 'utf8'));
  const entry = catalog.plugins.find((/** @type {any} */ p) => p.id === 'scripted-model');
  if (bump) {
    entry.version = NEXT;
    entry.files['annai-plugin.json'] = await sha256Hex(bumped);
  }
  if (revise) entry.files['index.js'] = await sha256Hex(revised);
  return async (/** @type {any} */ url) => {
    const path = new URL(String(url), 'http://annai.test').pathname;
    if (path === '/catalog/plugins.json') return new Response(JSON.stringify(catalog));
    if (bump && path === '/plugins-official/scripted-model/annai-plugin.json') return new Response(/** @type {any} */ (bumped));
    if (revise && path === '/plugins-official/scripted-model/index.js') return new Response(/** @type {any} */ (revised));
    try {
      return new Response(/** @type {any} */ (new Uint8Array(await readFile(new URL(`.${path}`, root)))));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

/** Every update known after a check of both kinds. @param {any} host @param {any} env */
const pluginUpdates = async (host, env) => (await checkPlugins(host, env)).found;

/** Looks, and offers what it found on one card, as annai does at start (Updates.start). @param {any} ctx @param {any} env */
async function offerPluginUpdates(ctx, env) {
  const updates = await pluginUpdates(ctx.plugins, env);
  if (updates.length) offerCard(ctx, updates, env);
  return updates;
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

test("two updates that fail with words of their own (no stop) each end as a sentence on the card, so one plugin's error doesn't run into the next name", async () => {
  // A host whose every call throws a raw error, as a failed import of a plugin's module does: its message has no stop of its own.
  const host = new Proxy({}, { get: () => () => { throw new Error('boom'); } });
  /** @type {any[]} */
  const cards = [];
  const ctx = { plugins: host, notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; }, toast: () => {} } };
  const fail = async () => { throw new Error('boom'); };
  const updates = /** @type {any} */ ([{ id: 'a', name: 'Tide pools', url: 'https://x.example/a', added: null }, { id: 'b', name: 'Rock pools', url: 'https://x.example/b', added: null }]);
  await applyUpdates(/** @type {any} */ (ctx), updates, /** @type {any} */ ({ addressFetch: fail, fetch: fail }));
  assert.equal(cards[0].title, "Some plugins weren't updated");
  assert.equal(cards[0].body, 'Tide pools: boom. Rock pools: boom.');
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
  await applyUpdates({ plugins: host, notices: { card: (/** @type {any} */ c) => said.push(c.title), toast: (/** @type {string} */ t) => said.push(t) } }, offers, { addressFetch: get, reload: () => {} });
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
  await host.ws.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => t.putSecret('plugin:web:jina', 'jina-key-0123456789'));
  await applyUpdates({ plugins: host, notices }, offers, { addressFetch: get, reload: () => {} });
  assert.equal((await host.installed()).kit.version, '1.0.0');
  assert.deepEqual(notices.toasts, []);
  const [ask] = notices.cards;
  assert.match(ask.body, /Code that runs in annai/);
  assert.match(ask.body, /This plugin gets full access to your trips and API keys\. It can read every key saved in annai and send it anywhere: now your keys for Jina\./, 'whose keys, by name (fixes-ui 15)');
  assert.doesNotMatch(ask.body, /jina-key/, 'never a key');
  assert.deepEqual(ask.actions.map((/** @type {any} */ a) => a.label), ['Update anyway', 'Not now']);
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
  await applyUpdates({ plugins: host, notices }, offers, { addressFetch: get, reload: () => {} });
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
  await applyUpdates({ plugins: host, notices }, await addressUpdates(host, { fetch: get }), { addressFetch: get, reload: () => {} });
  assert.deepEqual([notices.cards.length, notices.toasts], [0, ['Plugins updated.']]);
  assert.equal((await host.installed()).kit.version, '1.0.1');
});

/** A provider description at an address. @param {string} baseUrl */
const LLM = (baseUrl) => ({ baseUrl, key: 'required', abilities: { chat: { kind: 'chat', type: 'scripted' } } });

test('an update from an address whose provider sends keys to a new origin asks first, and changes nothing until agreed (decision 11)', async () => {
  let site = kitSite({ ...KIT_V1, provider: LLM('https://llm.trails.example/v1') }, SAFETY);
  const get = (/** @type {string} */ url) => site(url);
  const { host } = await hostKit();
  await host.install(await fetchPackage(KIT_ADDR, { fetch: get }), { source: 'url', url: KIT_ADDR });
  site = kitSite({ ...KIT_V1, version: '1.1.0', provider: LLM('http://localhost:9931/v1') }, SAFETY);
  const offers = await addressUpdates(host, { fetch: get });
  assert.deepEqual(offers[0].added.origins, ['http://localhost:9931']);
  const notices = fakeNotices();
  await applyUpdates({ plugins: host, notices }, offers, { addressFetch: get, reload: () => {} });
  assert.equal((await host.installed()).kit.version, '1.0.0');
  const [ask] = notices.cards;
  assert.match(ask.body, /sends keys you give it to http:\/\/localhost:9931/);
  assert.doesNotMatch(ask.body, /full access/);
  // The screen names what it adds (shown); the log's English says that it adds parts.
  await assert.rejects(updateFromAddress(host, 'kit', { fetch: get }), (/** @type {any} */ e) => /haven't agreed to: a provider that sends keys to http:\/\/localhost:9931/.test(e.shown) && /haven't agreed to\. /.test(e.message));
  await ask.actions[0].run();
  assert.equal((await host.installed()).kit.version, '1.1.0');
  assert.deepEqual((await host.installed()).kit.origins, ['http://localhost:9931']);
});

test('an update from an address that now requires one of annai\'s plugins installs it on Update, from annai\'s catalog', async () => {
  let site = kitSite({ ...KIT_V1, provider: LLM('https://llm.trails.example/v1') }, SAFETY);
  const get = (/** @type {string} */ url) => site(url);
  const { host, registry } = await hostKit();
  await host.install(await fetchPackage(KIT_ADDR, { fetch: get }), { source: 'url', url: KIT_ADDR });
  site = kitSite({ ...KIT_V1, version: '1.0.1', provider: LLM('https://llm.trails.example/v1'), requires: [{ id: 'scripted-model', version: '^0' }] }, SAFETY);
  const notices = fakeNotices();
  await applyUpdates({ plugins: host, notices }, await addressUpdates(host, { fetch: get }), { addressFetch: get, fetch: await repo(), reload: () => {} });
  assert.deepEqual(notices.toasts, ['Plugins updated.']);
  assert.equal((await host.installed())['scripted-model']?.source, 'official');
  assert.ok(registry.list('endpoint-type').some((t) => t.type === 'scripted'));
  // Offline, nothing changes, and the words say why.
  site = kitSite({ ...KIT_V1, version: '1.0.2', provider: LLM('https://llm.trails.example/v1'), requires: [{ id: 'storage-webdav', version: '^0' }] }, SAFETY);
  await assert.rejects(updateFromAddress(host, 'kit', { fetch: get, official: { fetch: async () => { throw new TypeError('Failed to fetch'); } } }), /couldn't be loaded/);
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

test("an Update whose address's site goes dead ends after QUIET_MS on the failed updates' card, saying the site stopped answering, and the update after it goes on (addr-limit-next: it waited until annai was restarted, and every update after it in the list with it)", async (t) => {
  const GONE = 'https://gone.example/tide-pools/SKILL.md';
  const LIVE = 'https://trails.example/rock-pools/SKILL.md';
  const rock = SKILL.replace('name: tide-pools', 'name: rock-pools');
  /** @type {Record<string, string>} */
  const served = { [GONE]: SKILL, [LIVE]: rock };
  let gone = false;
  /** @type {string[]} */
  const asked = [];
  const get = (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    asked.push(url);
    if (gone && url === GONE) return dead(init, 'never');
    return Promise.resolve(url in served ? new Response(served[url]) : new Response('', { status: 404 }));
  };
  const { host } = await hostKit();
  await host.install(await fetchPackage(GONE, { fetch: get }), { source: 'url', url: GONE });
  await host.install(await fetchPackage(LIVE, { fetch: get }), { source: 'url', url: LIVE });
  served[GONE] = SKILL.replace('version: "1.2"', 'version: "1.3"');
  served[LIVE] = rock.replace('version: "1.2"', 'version: "1.3"');
  const offers = await addressUpdates(host, { fetch: get });
  assert.deepEqual(offers.map((u) => u.id), ['tide-pools', 'rock-pools']);
  gone = true;
  asked.length = 0;
  const notices = fakeNotices();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = watch(applyUpdates({ plugins: host, notices }, offers, { addressFetch: get, reload: () => {} }));
  await turns(() => asked.includes(GONE));
  t.mock.timers.tick(QUIET_MS - 1);
  await turns(() => w.state !== 'pending', 50);
  assert.equal(w.state, 'pending', 'still waiting just short of the limit');
  assert.ok(!asked.includes(LIVE), 'the update after it waits its turn');
  t.mock.timers.tick(1);
  await turns(() => w.state !== 'pending');
  assert.equal(w.state, 'done', w.error ? messageOf(w.error) : 'still waiting');
  assert.deepEqual(notices.cards.map((/** @type {any} */ c) => [c.title, c.body]), [["Some plugins weren't updated", 'tide-pools: gone.example stopped answering. Check the connection and try again.']]);
  const installed = await host.installed();
  assert.deepEqual([installed['tide-pools'].version, installed['rock-pools'].version], ['1.2.0', '1.3.0'], 'the update after it went on');
});

test("a check whose address's site is dead keeps the update an earlier check found and says it couldn't check it; an address that now holds another package drops it (addr-limit-next: the dead site's end after QUIET_MS dropped it, as a check that ran to its own limit never did)", async (t) => {
  const ADDRESS = 'https://gone.example/tide-pools/SKILL.md';
  /** @type {'serves' | 'dead' | 'another'} */
  let site = 'serves';
  let served = SKILL;
  let asked = 0;
  const get = (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
    asked++;
    if (site === 'dead') return dead(init, 'never');
    return Promise.resolve(new Response(site === 'another' ? SKILL.replace('name: tide-pools', 'name: rock-pools') : served));
  };
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDRESS, { fetch: get }), { source: 'url', url: ADDRESS });
  served = SKILL.replace('version: "1.2"', 'version: "1.3"');
  const shown = (/** @type {{ found: any[] }} */ r) => r.found.map((u) => [u.id, u.installed, u.available]);
  const first = await checkPlugins(host, { addressFetch: get }, { official: false });
  assert.deepEqual(shown(first), [['tide-pools', '1.2.0', '1.3.0']]);
  site = 'dead';
  asked = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const second = watch(checkPlugins(host, { addressFetch: get }, { official: false }));
  await turns(() => asked > 0);
  t.mock.timers.tick(QUIET_MS);
  await turns(() => second.state !== 'pending');
  assert.equal(second.state, 'done', second.error ? messageOf(second.error) : 'still waiting');
  assert.deepEqual(second.value?.failed, ["tide-pools couldn't be checked: gone.example stopped answering. Check the connection and try again."]);
  assert.deepEqual(shown(/** @type {any} */ (second.value)), [['tide-pools', '1.2.0', '1.3.0']], 'the offer an earlier check found stays while its site is down');
  // A check that can say it is another package now drops the offer: it was checked, and what it offered is not there.
  site = 'another';
  const third = await checkPlugins(host, { addressFetch: get }, { official: false });
  assert.deepEqual(third.failed, []);
  assert.deepEqual(shown(third), []);
});

test("an offer an earlier check found stays through any check that couldn't get its package, and says why (404, 410, 403, a file that isn't a skill, 429, 503, offline, a cut answer, a linked file's 503, a linked file that can't be reached); a site that is back is checked again (update-check-next: a definite answer dropped it, which a browser can't tell from no answer when the site sends a 404 without the headers that let web apps read it)", async () => {
  const ADDRESS = 'https://gone.example/tide-pools/SKILL.md';
  const LINKED = 'https://gone.example/tide-pools/references/safety.md';
  const NEW = SKILL.replace('version: "1.2"', 'version: "1.3"');
  /** The site now: what each address answers, by status, as a thrown error (offline) or a body that errors at once (cut); the rest serves served. @type {Record<string, number | 'offline' | 'cut'>} */
  let now = {};
  let served = SKILL;
  const get = async (/** @type {string} */ url) => {
    if (now[url] === 'offline') throw new TypeError('Failed to fetch');
    if (now[url] === 'cut') return new Response(new ReadableStream({ start: (c) => c.error(new TypeError('network error')) }));
    return now[url] ? new Response('', { status: /** @type {number} */ (now[url]) }) : new Response(served);
  };
  const { host } = await hostKit();
  await host.install(await fetchPackage(ADDRESS, { fetch: get }), { source: 'url', url: ADDRESS });
  const check = () => checkPlugins(host, { addressFetch: get }, { official: false });
  const shown = (/** @type {{ found: any[] }} */ r) => r.found.map((u) => [u.id, u.installed, u.available]);
  const cases = /** @type {[string, Record<string, number | 'offline' | 'cut'>, string | null, RegExp][]} */ ([
    ['404', { [ADDRESS]: 404 }, null, /^tide-pools couldn't be checked: gone\.example answered 404\.$/],
    ['410', { [ADDRESS]: 410 }, null, /answered 410\./],
    ['403', { [ADDRESS]: 403 }, null, /answered 403\./],
    ['the address now holds something that is not a skill', {}, '<html>moved</html>', /SKILL\.md/],
    ['429', { [ADDRESS]: 429 }, null, /answered 429\./],
    ['503', { [ADDRESS]: 503 }, null, /answered 503\./],
    ['offline', { [ADDRESS]: 'offline' }, null, /annai couldn't reach gone\.example/],
    ['an answer that is cut off', { [ADDRESS]: 'cut' }, null, /gone\.example's answer was cut off\./],
    ['a linked file answers 503', { [LINKED]: 503 }, null, /gone\.example answered 503 for references\/safety\.md/],
    ['a linked file is unreachable', { [LINKED]: 'offline' }, null, /annai couldn't read references\/safety\.md from gone\.example/],
  ]);
  for (const [what, site, body, why] of cases) {
    // An offer is there, or is found again: the site serves the new version.
    now = {};
    served = NEW;
    const back = await check();
    assert.deepEqual(back.failed, [], what);
    assert.deepEqual(shown(back), [['tide-pools', '1.2.0', '1.3.0']], `${what}: found, or found again with the site back`);
    now = site;
    if (body) served = body;
    const r = await check();
    assert.equal(r.failed.length, 1, `${what}: ${r.failed.join(' | ')}`);
    assert.match(r.failed[0], why, what);
    assert.deepEqual(shown(r), [['tide-pools', '1.2.0', '1.3.0']], `${what}: the offer stays`);
  }
  // Back, with the version it has: checked, and nothing to offer.
  now = {};
  served = SKILL;
  const same = await check();
  assert.deepEqual([same.failed, shown(same)], [[], []], 'checked and up to date: the offer goes');
});

test("an offer of annai's own that an earlier check found stays through a check whose catalog answers 503 or can't be reached, and says the catalog's line; an address part that throws keeps the addresses' offers; the catalog back is checked again (update-check-next: one rule keeps the offers of both kinds, and nothing pinned the official half)", async () => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  let served = SKILL;
  const get = async () => new Response(served);
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  served = SKILL.replace('version: "1.2"', 'version: "1.3"');
  const bumped = await repo({ bump: true });
  /** The installed records' reads, counted: the one that fails, if any, is the nth. */
  let reads = 0;
  let failRead = 0;
  const flaky = new Proxy(host, {
    get: (target, key) => {
      if (key === 'installed') return () => (++reads === failRead ? Promise.reject(new Error('the store failed')) : target.installed());
      const v = /** @type {any} */ (target)[key];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  /** @param {Parameters<typeof checkPlugins>[1]} env @param {Parameters<typeof checkPlugins>[2]} [kinds] */
  const check = (env, kinds) => checkPlugins(/** @type {any} */ (flaky), { addressFetch: get, ...env }, kinds);
  const shown = (/** @type {{ found: any[] }} */ r) => r.found.map((u) => [u.id, u.installed, u.available]);
  const both = [['scripted-model', NOW, NEXT], ['tide-pools', '1.2.0', '1.3.0']];
  const first = await check({ fetch: bumped });
  assert.deepEqual([first.failed, shown(first)], [[], both], 'found: annai\'s own and an address\'s');
  const r503 = await check({ fetch: async () => new Response('', { status: 503 }) });
  assert.deepEqual(r503.failed, ["annai's list of plugins couldn't be loaded (HTTP 503). Try again later."]);
  assert.deepEqual(shown(r503), both, 'a catalog that answers 503: annai\'s own offer stays, and the address is checked');
  const gone = await check({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(gone.failed, ["annai's list of plugins couldn't be loaded. Check the connection and try again."]);
  assert.deepEqual(shown(gone), both, 'a catalog that can\'t be reached: it stays');
  // The address part's own read of the installed records fails: the first of this check's three (the part's, its package's url, the list's).
  reads = 0;
  failRead = 1;
  const thrown = await check({ fetch: bumped }, { official: false });
  assert.deepEqual(shown(thrown), both, 'an address part that throws: the addresses\' offers stay');
  failRead = 0;
  const back = await check({ fetch: await repo() });
  assert.deepEqual([back.failed, shown(back)], [[], [['tide-pools', '1.2.0', '1.3.0']]], 'the catalog back, at the version installed: checked, and annai\'s own offer goes');
});

test("an offer stands only while the install it was found against does: a package installed again from its address, or an official plugin installed again as the catalog's copy, leaves no offer, however it was installed between checks (update-check-next: an offer of the same version stood after an install that was not an Update and not during a check, \"(changed)\" for what was installed)", async () => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  let served = SKILL;
  const get = async () => new Response(served);
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  // Both changed at the version installed: annai's catalog holds other files for its plugin, the address for the package.
  served = SKILL.replace('# Tide pools', '# Tide pools, revised');
  const revised = await repo({ revise: true });
  const shown = async () => (await knownUpdates(host)).map((u) => [u.id, u.installed, u.available]);
  const found = await checkPlugins(host, { fetch: revised, addressFetch: get });
  assert.deepEqual(found.found.map((u) => [u.id, u.installed, u.available]), [['scripted-model', NOW, NOW], ['tide-pools', '1.2.0', '1.2.0']], 'both are offered as changed');
  // Add again from the same address (the install screen's Install, with "Version 1.2.0 is installed now. Installing replaces it.").
  await host.install(await fetchPackage(ADDR, { fetch: get }), { source: 'url', url: ADDR });
  assert.deepEqual(await shown(), [['scripted-model', NOW, NOW]], 'the address one is installed as the address holds it: its offer goes, annai\'s stays');
  // A provider's setup that finds the copy isn't the catalog's installs the catalog's (ensureType, when the plugin isn't running). Its start
  // is refused here, as this host ran the old code already: the files and the record are written before it.
  await installOfficial(host, found.found[0].entry, { fetch: revised }).catch(() => {});
  assert.deepEqual(await shown(), [], 'the catalog\'s copy is installed: its offer goes');
  // Nothing is offered again by a check that finds them as they are, and a later change is found.
  assert.deepEqual((await checkPlugins(host, { fetch: revised, addressFetch: get })).found, []);
  served = SKILL.replace('version: "1.2"', 'version: "1.3"');
  assert.deepEqual((await checkPlugins(host, { fetch: revised, addressFetch: get })).found.map((u) => [u.id, u.installed, u.available]), [['tide-pools', '1.2.0', '1.3.0']]);
});

test("offers are listed in the order their plugins were installed, not by name and not in the order the checks found them (a kept offer does not jump the queue)", async () => {
  const at = (/** @type {string} */ name) => `https://${name}.example/${name}/SKILL.md`;
  const skill = (/** @type {string} */ name, version = '1.2') => SKILL.replace('name: tide-pools', `name: ${name}`).replace('version: "1.2"', `version: "${version}"`);
  /** @type {Record<string, string>} */
  const served = { [at('zeta')]: skill('zeta'), [at('alpha')]: skill('alpha') };
  let alphaDead = false;
  const get = async (/** @type {string} */ url) => {
    if (alphaDead && url === at('alpha')) throw new TypeError('Failed to fetch');
    return url in served ? new Response(served[url]) : new Response('', { status: 404 });
  };
  const { host } = await hostKit();
  // zeta first, so install order is neither alphabetical nor the order the checks find them in below.
  for (const n of ['zeta', 'alpha']) await host.install(await fetchPackage(at(n), { fetch: get }), { source: 'url', url: at(n) });
  served[at('alpha')] = skill('alpha', '1.3');
  const ids = (/** @type {{ found: any[] }} */ r) => r.found.map((u) => u.id);
  assert.deepEqual(ids(await checkPlugins(host, { addressFetch: get }, { official: false })), ['alpha']);
  served[at('zeta')] = skill('zeta', '1.3');
  alphaDead = true;
  assert.deepEqual(ids(await checkPlugins(host, { addressFetch: get }, { official: false })), ['zeta', 'alpha'], 'alpha stays offered while its site is down, after zeta, which was installed first (not by name, not as the checks found them)');
});

test("a check asks annai's catalog with its translations beside the addresses: a catalog that answers late and translations that go silent never hold the addresses, and a live address's update is found (addr-limit-next: the addresses were asked after them, so their silences added up past the check's 45 s)", async (t) => {
  const GONE = 'https://gone.example/tide-pools/SKILL.md';
  const LIVE = 'https://trails.example/rock-pools/SKILL.md';
  const rock = SKILL.replace('name: tide-pools', 'name: rock-pools');
  /** @type {Record<string, string>} */
  const served = { [GONE]: SKILL, [LIVE]: rock };
  let gone = false;
  /** @type {string[]} */
  const asked = [];
  const get = (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    asked.push(url);
    if (gone && url === GONE) return dead(init, 'never');
    return Promise.resolve(url in served ? new Response(served[url]) : new Response('', { status: 404 }));
  };
  setWords('ja', {});
  try {
    const { host } = await setup();
    await ensureType(host, 'scripted', { fetch: await repo() });
    await host.install(await fetchPackage(GONE, { fetch: get }), { source: 'url', url: GONE });
    await host.install(await fetchPackage(LIVE, { fetch: get }), { source: 'url', url: LIVE });
    served[LIVE] = rock.replace('version: "1.2"', 'version: "1.3"');
    gone = true;
    asked.length = 0;
    const own = await repo();
    /** The catalog answers late; its translations (the screens' language) never answer. */
    /** @type {() => void} */
    let answer = () => {};
    const late = new Promise((r) => { answer = () => r(undefined); });
    /** @type {string[]} */
    const ownAsked = [];
    const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      ownAsked.push(url);
      if (url.includes('/catalog/l10n/')) return dead(init, 'never');
      if (url.endsWith('/catalog/plugins.json')) await late;
      return own(url);
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = watch(checkPlugins(host, { fetch, addressFetch: get }));
    await turns(() => asked.includes(GONE) && asked.includes(LIVE) && ownAsked.length > 0, 1000);
    assert.deepEqual([asked.includes(GONE), asked.includes(LIVE)], [true, true], 'the addresses are asked while the catalog has not answered');
    t.mock.timers.tick(5_000);
    answer(); // the catalog answers at 5 s, and its translations then go silent, until 25 s
    await turns(() => ownAsked.some((u) => u.includes('/catalog/l10n/')));
    t.mock.timers.tick(QUIET_MS - 5_000 - 1);
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', 'the translations are still waited for');
    t.mock.timers.tick(1); // the dead address ends at 20 s
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', 'the translations are still waited for');
    t.mock.timers.tick(5_000); // and the translations at 25 s
    await turns(() => w.state !== 'pending');
    assert.equal(w.state, 'done', w.error ? messageOf(w.error) : 'still waiting');
    assert.deepEqual(w.value?.failed, ["tide-pools couldn't be checked: gone.example stopped answering. Check the connection and try again."]);
    assert.deepEqual(w.value?.found.map((u) => [u.id, u.installed, u.available]), [['rock-pools', '1.2.0', '1.3.0']], "the live address's update is found");
  } finally {
    setWords('en', null);
  }
});

test("a check whose annai's catalog answers 15 s late, its list of words in the screens' language 15 s after that, and the plugin's own words never, ends once they have, with annai's own update found, listed and on a card (update-check-next: the check's 45 s ended it with \"The check took too long\", nothing found and no card)", async (t) => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() }); // in English: no words in Japanese are kept
  setWords('ja', {});
  try {
    const own = await repo({ bump: true });
    /** @type {string[]} */
    const asked = [];
    const late = (/** @type {string} */ url) => new Promise((r) => { setTimeout(() => r(own(url)), 15_000); });
    const fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      asked.push(url);
      if (url.endsWith('/catalog/plugins.json') || url.endsWith('/catalog/l10n/ja.json')) return late(url);
      if (url.includes('/catalog/l10n/ja/')) return dead(init, 'never');
      return own(url);
    };
    const notices = fakeNotices();
    const updates = new Updates({ host, env: { fetch }, online: () => true });
    updates.notices = notices;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const w = watch(updates.start());
    await turns(() => asked.some((u) => u.endsWith('/catalog/plugins.json')));
    t.mock.timers.tick(15_000); // the catalog answers
    await turns(() => asked.some((u) => u.endsWith('/catalog/l10n/ja.json')));
    t.mock.timers.tick(15_000); // its words' list, at 30 s
    await turns(() => asked.some((u) => u.includes('/catalog/l10n/ja/')));
    t.mock.timers.tick(15_000);
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', "at 45 s the plugin's words are still waited for");
    t.mock.timers.tick(QUIET_MS - 15_000 - 1);
    await turns(() => w.state !== 'pending', 50);
    assert.equal(w.state, 'pending', 'still waiting just short of their silence limit');
    t.mock.timers.tick(1); // 50 s: the plugin's words end by their site's silence
    await turns(() => w.state !== 'pending');
    assert.equal(w.state, 'done', w.error ? messageOf(w.error) : 'still waiting');
    const shown = (/** @type {any[]} */ l) => l.map((u) => [u.id, u.installed, u.available]);
    assert.deepEqual(w.value?.failed, [], 'words that never came are no update, and never fail');
    assert.deepEqual(shown(w.value?.found ?? []), [['scripted-model', NOW, NEXT]], 'found');
    assert.deepEqual(shown(await updates.plugins()), [['scripted-model', NOW, NEXT]], 'listed in Settings');
    assert.deepEqual(notices.cards.map((/** @type {any} */ c) => c.title), ['Plugin updates are ready'], 'on a card');
  } finally {
    setWords('en', null);
  }
});

test("Settings → Plugins and a plugin's page show the update the last checks found, as Settings → Updates does, and ask annai's catalog nothing; a catalog that lists a new version shows there once a check has found it (update-check-next: they asked annai's catalog at every draw, a second answer beside the checks' that could disagree with it)", async () => {
  const { updateFor } = await import('../../src/ui/screens/plugins.js');
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  const bumped = await repo({ bump: true });
  let asked = 0;
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ url) => { asked++; return bumped(url); });
  try {
    const ctx = { plugins: host };
    assert.equal(await updateFor(ctx, 'scripted-model'), undefined, 'no check has found it yet');
    await checkPlugins(host, { fetch: bumped }, { address: false });
    const u = await updateFor(ctx, 'scripted-model');
    assert.deepEqual([u?.id, u?.installed, u?.available], ['scripted-model', NOW, NEXT]);
    assert.equal(asked, 0, "the screen asked annai's catalog nothing");
  } finally {
    globalThis.fetch = real;
  }
});

test("an official plugin installed again while the check's catalog request is in flight is not offered when the check ends (update-check-next's touch re-read: the official kind's mid-check case)", async () => {
  const { host } = await setup();
  await ensureType(host, 'scripted', { fetch: await repo() });
  const bumped = await repo({ bump: true });
  let installedDuringCheck = false;
  const during = async (/** @type {any} */ url) => {
    if (new URL(String(url), 'http://annai.test').pathname === '/catalog/plugins.json' && !installedDuringCheck) {
      installedDuringCheck = true;
      const catalog = await (await bumped(url)).json();
      await installOfficial(host, catalog.plugins.find((/** @type {any} */ p) => p.id === 'scripted-model'), { fetch: bumped }).catch(() => {});
    }
    return bumped(url);
  };
  const r = await checkPlugins(host, { fetch: during }, { address: false });
  assert.equal(installedDuringCheck, true, 'the install landed while the catalog was being asked');
  assert.deepEqual(r.found, [], 'what is installed now is not offered');
});
