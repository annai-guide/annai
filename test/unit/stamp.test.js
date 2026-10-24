import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { stamp } from '../../scripts/stamp.mjs';

test('stamp writes a hash of the shell into sw.js, and the check catches a stale one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-stamp-'));
  try {
    await writeFile(join(dir, 'sw.js'), "const VERSION = '0.1.0';\nconst BUILD = 'dev';\nconst SHELL = [\n  '/',\n  '/index.html',\n  '/src/a.js',\n];\n");
    await writeFile(join(dir, 'index.html'), '<p>hi</p>');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n');
    const root = pathToFileURL(dir + '/');
    assert.equal((await stamp(root, { check: true })).ok, false);
    await stamp(root);
    assert.equal((await stamp(root, { check: true })).ok, true);
    const first = await readFile(join(dir, 'sw.js'), 'utf8');
    assert.match(first, /^const BUILD = '[0-9a-f]{12}';$/m);
    await writeFile(join(dir, 'src/a.js'), 'export const a = 2;\n');
    assert.equal((await stamp(root, { check: true })).ok, false);
    await stamp(root);
    assert.notEqual(await readFile(join(dir, 'sw.js'), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stamp writes shell.json beside sw.js: the build, and the hash of each shell file, which the check holds to the files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-stamp-'));
  try {
    await writeFile(join(dir, 'sw.js'), "const BUILD = 'dev';\nconst SHELL = [\n  '/',\n  '/index.html',\n  '/src/a.js',\n];\n");
    await writeFile(join(dir, 'index.html'), '<p>hi</p>');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/a.js'), 'export const a = 1;\n');
    const root = pathToFileURL(dir + '/');
    const { build } = await stamp(root);
    const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
    const manifest = await readFile(join(dir, 'shell.json'), 'utf8');
    assert.deepEqual(JSON.parse(manifest), { build, files: { '/': sha('<p>hi</p>'), '/index.html': sha('<p>hi</p>'), '/src/a.js': sha('export const a = 1;\n') } });
    assert.match(manifest, /\n {4}"\/src\/a\.js": "[0-9a-f]{12}"\n/, 'one file a line, so a release diff shows which changed');
    assert.equal((await stamp(root, { check: true })).ok, true);
    await writeFile(join(dir, 'shell.json'), '{}');
    assert.equal((await stamp(root, { check: true })).ok, false, 'a stale manifest fails the check');
    await rm(join(dir, 'shell.json'));
    assert.equal((await stamp(root, { check: true })).ok, false, 'and so does a missing one');
    await stamp(root);
    assert.equal(await readFile(join(dir, 'shell.json'), 'utf8'), manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the shell.json in the repository is the one stamp writes', async () => {
  const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../../shell.json', import.meta.url), 'utf8'));
  assert.equal(manifest.build, /const BUILD = '([^']+)';/.exec(sw)?.[1]);
  assert.deepEqual(Object.keys(manifest.files), [...(/const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '').matchAll(/'(\/[^']*)'/g)].map((m) => m[1]));
});

test("a translation changing alone makes a new build: the catalogs of LANGS are hashed with the shell", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-stamp-'));
  try {
    await writeFile(join(dir, 'sw.js'), "const BUILD = 'dev';\nconst SHELL = [\n  '/',\n];\nconst LANGS = ['ja', 'zh-Hans'];\n");
    await writeFile(join(dir, 'index.html'), '<p>hi</p>');
    await mkdir(join(dir, 'l10n'));
    await writeFile(join(dir, 'l10n/ja.json'), '{"a":"b"}');
    await writeFile(join(dir, 'l10n/zh-Hans.json'), '{"a":"c"}');
    const root = pathToFileURL(dir + '/');
    const first = (await stamp(root)).build;
    assert.equal((await stamp(root, { check: true })).ok, true);
    await writeFile(join(dir, 'l10n/zh-Hans.json'), '{"a":"d"}');
    assert.equal((await stamp(root, { check: true })).ok, false, 'a fixed translation is a new build');
    assert.notEqual((await stamp(root)).build, first);
    await rm(join(dir, 'l10n/ja.json'));
    await assert.rejects(stamp(root), /ENOENT/, 'a listed catalog that is missing is an error, not a quiet gap');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the service worker's cache is named by version and build, so any change to the shell ships", async () => {
  const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /^const BUILD = '[0-9a-f]{12}';$/m);
  assert.match(sw, /const CACHE = `annai-shell-\$\{VERSION\}-\$\{BUILD\}`;/);
});
