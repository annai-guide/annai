import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPackage, fingerprint, isJunk } from '../../src/core/packages.js';
import { PluginError } from '../../src/core/registry.js';
import { files, SKILL } from './package-kit.js';

const MANIFEST = (/** @type {any} */ more = {}) => JSON.stringify({ id: 'trail-kit', name: 'Trail kit', version: '1.0.0', api: 1, description: 'Skills for trails.', ...more });

test('a bare skill: at the top or in one folder, with the junk zips carry left out', async () => {
  for (const top of ['', 'tide-pools-main/']) {
    const pkg = await inspectPackage(files({ [`${top}SKILL.md`]: SKILL, [`${top}references/safety.md`]: 'Watch the waves.', [`${top}.DS_Store`]: 'x', '__MACOSX/._SKILL.md': 'x', [`${top}references/`]: '' }));
    assert.deepEqual([pkg.kind, pkg.id, pkg.name, pkg.version, pkg.shownVersion, pkg.code, pkg.author], ['skill', 'tide-pools', 'tide-pools', '1.2.0', '1.2', false, 'Example Trails']);
    assert.deepEqual([...pkg.files.keys()].sort(), ['SKILL.md', 'references/safety.md']);
    assert.deepEqual(pkg.skills, [{ name: 'tide-pools', description: 'Tide pools: when they are safe to visit.', folder: '' }]);
    assert.equal(pkg.manifest.id, 'tide-pools');
    assert.match(pkg.fingerprint, /^[0-9a-f]{64}$/);
  }
  assert.equal((await inspectPackage(files({ 'SKILL.md': SKILL.replace(/metadata:[\s\S]*?---/, '---') }))).shownVersion, '');
});

test('a plugin package: its code, the skills it lists, personalities, templates and files', async () => {
  const pkg = await inspectPackage(files({
    'trail-kit/annai-plugin.json': MANIFEST({ entry: 'index.js', files: ['index.js', 'lib.js'], skills: ['skills/trail-safety'], personalities: ['personalities/ranger.md'], templates: ['templates.json'], author: 'Trails', homepage: 'https://trails.example/' }),
    'trail-kit/index.js': 'export function activate() {}', 'trail-kit/lib.js': 'export const x = 1;',
    'trail-kit/skills/trail-safety/SKILL.md': '---\nname: trail-safety\ndescription: Before a hike, what to check.\n---\nCarry water.',
    'trail-kit/personalities/ranger.md': '# Ranger\nCalm and practical.',
    'trail-kit/templates.json': JSON.stringify({ endpoints: [{ id: 'trail-llm', version: 1, type: 'chat-completions', name: 'Trail LLM', baseUrl: 'https://llm.example/v1' }] }),
  }));
  assert.deepEqual([pkg.kind, pkg.id, pkg.version, pkg.shownVersion, pkg.code, pkg.author, pkg.homepage], ['plugin', 'trail-kit', '1.0.0', '1.0.0', true, 'Trails', 'https://trails.example/']);
  assert.deepEqual(pkg.skills.map((s) => [s.name, s.folder]), [['trail-safety', 'skills/trail-safety']]);
  assert.deepEqual(pkg.personalities, [{ name: 'ranger', path: 'personalities/ranger.md' }]);
  assert.deepEqual(pkg.templates.map((t) => t.id), ['trail-llm']);
  assert.ok(pkg.files.has('annai-plugin.json'));
});

test('packages annai refuses, each with the reason', async () => {
  /** @type {[Record<string, string>, RegExp][]} */
  const cases = [
    [{ 'readme.txt': 'hi' }, /no annai-plugin\.json or SKILL\.md/],
    [{ 'a/SKILL.md': SKILL, 'b/SKILL.md': SKILL }, /several skills/],
    [{ 'SKILL.md': SKILL.replace('name: tide-pools', 'name: t') }, /at least 2 characters/],
    [{ 'SKILL.md': '# none' }, /front matter/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['skills/none'] }) }, /skills\/none.*SKILL\.md/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['a', 'b'] }), 'a/SKILL.md': SKILL, 'b/SKILL.md': SKILL }, /two skills called tide-pools/],
    [{ 'annai-plugin.json': MANIFEST({ skills: ['../up'] }) }, /isn't a folder inside/],
    [{ 'annai-plugin.json': MANIFEST({ personalities: ['ranger.txt'] }), 'ranger.txt': 'x' }, /personality.*\.md/],
    [{ 'annai-plugin.json': MANIFEST({ personalities: ['Ranger Bob.md'] }), 'Ranger Bob.md': 'x' }, /personality's file name/],
    [{ 'annai-plugin.json': MANIFEST({ templates: ['t.json'] }), 't.json': '{"endpoints":[{"id":1}]}' }, /template/],
    [{ 'annai-plugin.json': MANIFEST({ templates: ['t.json'] }), 't.json': 'not json' }, /t\.json isn't valid JSON/],
    [{ 'annai-plugin.json': MANIFEST({ files: ['gone.js'] }) }, /gone\.js.*missing/],
    [{ 'annai-plugin.json': MANIFEST(), 'a\\b.js': 'x' }, /"a\\b\.js" isn't allowed/],
    [{ 'annai-plugin.json': MANIFEST({ entry: 'index.js' }) }, /entry file index\.js is missing/],
  ];
  for (const [f, why] of cases) await assert.rejects(inspectPackage(files(f)), (e) => e instanceof PluginError && why.test(/** @type {Error} */ (e).message), String(why));
  await assert.rejects(inspectPackage(files({ 'SKILL.md': SKILL, 'big.txt': 'x'.repeat(5000) }), { maxBytes: 4000 }), /too large/);
});

test('the fingerprint changes when any file or name does, and only then', async () => {
  const a = await fingerprint(files({ 'SKILL.md': SKILL, 'b.md': 'b' }));
  assert.equal(await fingerprint(files({ 'b.md': 'b', 'SKILL.md': SKILL })), a);
  assert.notEqual(await fingerprint(files({ 'SKILL.md': SKILL, 'b.md': 'c' })), a);
  assert.notEqual(await fingerprint(files({ 'SKILL.md': SKILL, 'c.md': 'b' })), a);
  assert.deepEqual(['__MACOSX/x', 'a/.DS_Store', 'Thumbs.db', 'a/desktop.ini', 'a/', 'a/b.md'].map(isJunk), [true, true, true, true, true, false]);
});
