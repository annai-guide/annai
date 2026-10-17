import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYS_PLUGINS } from '../../src/core/scopes.js';
import { PluginError } from '../../src/core/registry.js';
import { text } from '../../src/core/bytes.js';
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
