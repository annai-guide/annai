import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYS_PLUGINS, SYS_SETTINGS, createTrip } from '../../src/core/scopes.js';
import { setToolSwitch } from '../../src/core/agent/tools.js';
import { readAppSettings } from '../../src/core/settings.js';
import { PluginError } from '../../src/core/registry.js';
import { text, utf8 } from '../../src/core/bytes.js';
import { files, SKILL, KIT, hostKit } from './package-kit.js';

test('host: a bare skill installs as a package; at start Shiori has it, its text and files read from storage', async () => {
  const { host, registry, ws } = await hostKit();
  const m = await host.install(files({ 'tide-pools/SKILL.md': SKILL, 'tide-pools/references/safety.md': 'Watch the waves.' }), { source: 'url', url: 'https://trails.example/tide-pools/SKILL.md' });
  assert.equal(m.id, 'tide-pools');
  const state = (await host.installed())['tide-pools'];
  assert.deepEqual([state.kind, state.source, state.url, state.version, state.enabled], ['skill', 'url', 'https://trails.example/tide-pools/SKILL.md', '1.2.0', true]);
  assert.match(state.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/tide-pools/')).map((f) => f.path), ['/tide-pools/SKILL.md', '/tide-pools/references/safety.md']);
  await host.start('tide-pools');
  const s = registry.list('skill').find((x) => x.name === 'tide-pools');
  assert.equal(s.description, 'Tide pools: when they are safe to visit.');
  assert.match(await s.text(), /^# Tide pools\n/);
  assert.deepEqual(await s.files(), ['references/safety.md']);
  assert.equal(text((await s.read('references/safety.md')).bytes), 'Watch the waves.');
  assert.equal(await s.read('../installed.json'), null);
  assert.equal(await s.read('missing.md'), null);
  const row = (await host.describe()).find((r) => r.id === 'tide-pools');
  assert.deepEqual([row?.kind, row?.version, row?.shownVersion, row?.source, row?.skills], ['skill', '1.2.0', '1.2', 'url', ['tide-pools']]);
});

test("host: a package's skills, personalities and templates join the registry at start and leave when it stops", async () => {
  const { host, registry } = await hostKit();
  await host.install(KIT());
  await host.start('trail-kit');
  assert.deepEqual(registry.list('skill').map((s) => s.name), ['trail-safety']);
  assert.deepEqual(registry.list('personality').map((p) => [p.name, p.text]), [['ranger', '# Ranger\nCalm and practical.']]);
  assert.deepEqual(registry.list('template').map((t) => t.id), ['trail-llm']);
  await host.setEnabled('trail-kit', false);
  assert.deepEqual([registry.list('skill'), registry.list('personality'), registry.list('template')], [[], [], []]);
});

test('host: a package keeps no history; installing again replaces its files outright, and the log says so', async () => {
  const { host, ws, log } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL, 'references/old.md': 'old' }), { source: 'file', file: 'tide-pools.zip' });
  await host.install(files({ 'SKILL.md': SKILL.replace('# Tide pools', '# Tide pools, new') }), { source: 'file', file: 'tide-pools.zip' });
  assert.deepEqual((await ws.list(SYS_PLUGINS, '/tide-pools/')).map((f) => f.path), ['/tide-pools/SKILL.md']);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tide-pools/references/old.md'), []);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tide-pools/SKILL.md'), []);
  assert.deepEqual((await log()).filter((e) => e.type.startsWith('plugin.')).map((e) => [e.type, e.data.plugin, e.data.from]), [['plugin.install', 'tide-pools', 'file'], ['plugin.update', 'tide-pools', 'file']]);
  assert.equal((await host.installed())['tide-pools'].file, 'tide-pools.zip');
});

test("host: names already taken are refused: annai's own parts, a skill Shiori has, a package of the other kind", async () => {
  const { host, registry } = await hostKit();
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  registry.add('skills', 'skill', { name: 'plan-a-trip', description: 'x', text: 'x' });
  host.builtins.set('skills', { id: 'skills', name: 'Built-in skills' });
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'plan-a-trip') })), /already has a skill called plan-a-trip, built into annai/);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'core-schemas') })), /core-schemas: is a name annai uses for one of its own parts/);
  await host.install(KIT());
  await host.start('trail-kit');
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-safety') })), /already has a skill called trail-safety, from Trail kit/);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-kit') })), /trail-kit: is installed already as a plugin\. Remove it first/);
  await host.install(KIT()); // the same package again replaces itself
  assert.equal((await host.inspect(KIT())).replaces?.version, '1.0.0');
});

test('host: a package without code needs no restart after an update; one whose code ran does', async () => {
  const { host } = await hostKit();
  await host.install(KIT());
  await host.start('trail-kit');
  await host.install(KIT({ version: '1.1.0' }));
  assert.equal(host.needsRestart('trail-kit'), false);
  await host.start('trail-kit');
});

test('host: a stored skill is read again before it starts', async () => {
  const { host, ws } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL }));
  await ws.write(SYS_PLUGINS, '/tide-pools/SKILL.md', 'no front matter', { author: 'system' });
  await assert.rejects(host.start('tide-pools'), (e) => e instanceof PluginError && /front matter/.test(e.message));
  assert.match(String((await host.describe()).find((r) => r.id === 'tide-pools')?.problem), /front matter/);
});

test("host: a running plugin's tool names are kept in its state, for removing its switches later", async () => {
  const { host } = await hostKit();
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { return annai.tools.register({ name: 'tide_times', description: 'Tides.', input: { type: 'object' }, run: () => 'low 05:40' }); }",
  }));
  await host.start('tides');
  assert.deepEqual((await host.installed()).tides.tools, ['tide_times']);
});

// The coordinator's security finding (milestone 8a): a skill name is checked against every
// installed package and annai's own skills, not only against what runs now.

test("host: a skill name that belongs to a package that is switched off is refused", async () => {
  const { host } = await hostKit();
  await host.install(KIT());
  await host.start('trail-kit');
  await host.setEnabled('trail-kit', false);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-safety') })), /already has a skill called trail-safety, from Trail kit/);
  const never = await hostKit();
  await never.host.install(KIT()); // installed, never started
  await assert.rejects(never.host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'trail-safety') })), /already has a skill called trail-safety, from Trail kit/);
});

test("host: a built-in skill's name is refused even when annai's own skills didn't load", async () => {
  const { host, registry } = await hostKit();
  await host.addBuiltin(new URL('../../src/plugins/skills/index.js', import.meta.url).href); // in Node its files can't be fetched: nothing registers
  assert.deepEqual(registry.list('skill'), []);
  await assert.rejects(host.install(files({ 'SKILL.md': SKILL.replace('tide-pools', 'driving-companion') })), /already has a skill called driving-companion, built into annai/);
});

test('host: at start, a second package with a taken skill name never shadows the first, whatever order they load in', async () => {
  for (const order of [['tide-pools', 'kit'], ['kit', 'tide-pools']]) {
    const { host, ws, relaunch } = await hostKit();
    await host.install(files({ 'SKILL.md': SKILL }));
    // A second package claiming the same name, as an imported backup could bring it, installed later.
    const kit = { 'annai-plugin.json': JSON.stringify({ id: 'kit', name: 'Kit', version: '1.0.0', api: 1, skills: ['skills/tide'] }), 'skills/tide/SKILL.md': SKILL.replace('# Tide pools', '# Kit tide pools') };
    for (const [n, t] of Object.entries(kit)) await ws.write(SYS_PLUGINS, `/kit/${n}`, t, { author: 'system' });
    const state = await host.installed();
    state.kit = { version: '1.0.0', name: 'Kit', kind: 'plugin', enabled: true, installed: state['tide-pools'].installed + 1, source: 'file', skills: ['tide-pools'] };
    await ws.write(SYS_PLUGINS, '/installed.json', Object.fromEntries(order.map((id) => [id, state[id]])), { author: 'system' });
    const next = relaunch();
    const failures = await next.startInstalled();
    const skills = next.registry.entries('skill').map((e) => [e.pluginId, e.item.name]);
    assert.deepEqual(skills, [['tide-pools', 'tide-pools']], order.join(' then '));
    assert.deepEqual(failures.map((f) => f.id), ['kit']);
    assert.match(String(/** @type {any} */ (failures[0].error).message), /its skill tide-pools can't be used: tide-pools has a skill by that name already/);
  }
});

test("host: a code plugin can't register a skill whose name is taken", async () => {
  const { host } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL }));
  await host.start('tide-pools');
  await host.install(files({
    'annai-plugin.json': JSON.stringify({ id: 'sneaky', name: 'Sneaky', version: '1.0.0', api: 1, entry: 'index.js' }),
    'index.js': "export function activate(annai) { return annai.register('skill', { name: 'tide-pools', description: 'Mine now.', text: 'x' }); }",
  }));
  await assert.rejects(host.start('sneaky'), /its skill tide-pools can't be used: tide-pools has a skill by that name already/);
});

const TIDES = files({
  'annai-plugin.json': JSON.stringify({ id: 'tides', name: 'Tides', version: '1.0.0', api: 1, entry: 'index.js' }),
  'index.js': `export async function activate(annai) {
    await annai.settings.set({ station: 'Monterey' });
    await annai.secrets.set('key', 'tide-secret-123456');
    await annai.events.append('sys', 'tides.cache', {}, { texts: [['table', 'x'.repeat(3000)]] });
    return annai.tools.register({ name: 'tide_times', description: 'Tides.', input: { type: 'object' }, run: () => 'low 05:40' });
  }`,
});

test('host: removing a package removes everything it stored and gives the space back; what it wrote in a trip stays (choice 4)', async () => {
  const { host, ws, store, registry, log } = await hostKit();
  await host.install(TIDES);
  await host.start('tides');
  await setToolSwitch(ws, 'tide_times', false);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  await ws.write(trip, '/notes/tides.md', 'from the plugin', { author: 'plugin:tides' });
  const { bytes } = await host.uninstall('tides');
  assert.ok(bytes >= 3000);
  assert.equal((await host.installed()).tides, undefined);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/tides/'), []);
  assert.deepEqual(await ws.history(SYS_PLUGINS, '/tides/index.js'), []);
  assert.equal(await ws.read(SYS_SETTINGS, '/plugin-settings/tides.json'), undefined);
  assert.deepEqual(await ws.history(SYS_SETTINGS, '/plugin-settings/tides.json'), []);
  assert.equal(await store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:tides:key')), undefined);
  assert.equal((await readAppSettings(ws)).tools?.tide_times, undefined);
  const sys = await log();
  assert.equal(sys.filter((e) => e.type === 'tides.cache').length, 0);
  assert.deepEqual(sys.filter((e) => e.type === 'plugin.remove').map((e) => [e.data.plugin, e.data.bytes]), [['tides', bytes]]);
  assert.equal(await ws.readText(trip, '/notes/tides.md'), 'from the plugin');
  assert.deepEqual(registry.list('tool'), []);
});

test('host: removing a package that is off still removes its tool switches', async () => {
  const { host, ws } = await hostKit();
  await host.install(TIDES);
  await host.start('tides');
  await setToolSwitch(ws, 'tide_times', false);
  await host.setEnabled('tides', false);
  await host.uninstall('tides');
  assert.equal((await readAppSettings(ws)).tools?.tide_times, undefined);
});

test('host: removing a skill takes it from Shiori and frees its files', async () => {
  const { host, registry, ws } = await hostKit();
  await host.install(files({ 'SKILL.md': SKILL, 'references/safety.md': 'Watch the waves.' }));
  await host.start('tide-pools');
  await host.uninstall('tide-pools');
  assert.deepEqual(registry.list('skill'), []);
  assert.deepEqual(await ws.list(SYS_PLUGINS, '/tide-pools/'), []);
});

test('host: what a new version of an installed package adds is known before it is installed', async () => {
  const { host } = await hostKit();
  await host.install(KIT());
  const next = KIT({ version: '1.1.0', entry: 'index.js', skills: ['skills/trail-safety', 'skills/trail-maps'] });
  next.set('index.js', utf8('export function activate() {}'));
  next.set('skills/trail-maps/SKILL.md', utf8('---\nname: trail-maps\ndescription: Reading a trail map.\n---\nNorth is up.'));
  const added = (await host.inspect(next)).replaces?.added;
  assert.deepEqual([added?.code, added?.skills.map((s) => s.name), added?.personalities, added?.templates], [true, ['trail-maps'], [], []]);
  assert.deepEqual((await host.inspect(KIT({ version: '1.0.1' }))).replaces?.added, { code: false, skills: [], personalities: [], templates: [] });
});
