import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { precompress, shippedText } from '../../scripts/build-release.mjs';

const words = (/** @type {string} */ s) => `${s}\n${'Low tide is at 5:40, and the road to the point opens an hour later.\n'.repeat(30)}`;

test('a release gets x.br beside each text file annai fetches, and no file of its own changes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  /** @type {Record<string, string>} */
  const files = {
    'sw.js': `const LANGS = ['ja'];\nconst SHELL = [\n  '/',\n  '/index.html',\n  '/src/app.js',\n  '/src/ui/base.css',\n  '/LICENSE',\n  '/assets/icon.png',\n];\n${words('// sw')}`,
    'index.html': words('<!doctype html>'),
    'src/app.js': words('// app'),
    'src/ui/base.css': words('/* base */'),
    'src/not-shipped.js': words('// not in SHELL'),
    LICENSE: words('AGPL'),
    'assets/icon.png': words('not really a png'),
    'l10n/ja.json': words('{}'),
    'catalog/plugins.json': words('{}'),
    'plugins-official/gemini-api/index.js': words('// a plugin'),
    'plugins-official/gemini-api/annai-plugin.json': words('{}'),
    'scripts/serve.mjs': words('// a script'),
    'docs/vision.md': words('# vision'),
    'tiny.txt': 'x',
  };
  files['sw.js'] = files['sw.js'].replace("  '/LICENSE',\n", "  '/LICENSE',\n  '/tiny.txt',\n");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const shipped = ['sw.js', 'index.html', 'src/app.js', 'src/ui/base.css', 'LICENSE', 'tiny.txt', 'l10n/ja.json', 'catalog/plugins.json',
    'plugins-official/gemini-api/annai-plugin.json', 'plugins-official/gemini-api/index.js'];
  assert.deepEqual((await shippedText(dir)).sort(), [...shipped].sort());

  const sizes = await precompress(dir);
  for (const name of shipped.filter((n) => n !== 'tiny.txt')) {
    const own = await readFile(join(dir, name));
    assert.equal(own.toString(), files[name], `${name} is unchanged`);
    assert.deepEqual(brotliDecompressSync(await readFile(join(dir, `${name}.br`))), own, `${name}.br`);
  }
  // A brotli form that isn't smaller than the file isn't kept: the server sends the file itself.
  const all = await readdir(dir, { recursive: true });
  assert.ok(!all.some((n) => n.startsWith('tiny.txt.')));
  assert.ok(!all.some((n) => n.endsWith('.gz')));
  // Pictures, fonts and what annai never fetches are left alone.
  for (const name of ['assets/icon.png', 'src/not-shipped.js', 'scripts/serve.mjs', 'docs/vision.md']) assert.ok(!all.includes(`${name}.br`), name);
  assert.equal(sizes.files, shipped.length);
  assert.equal(sizes.raw, shipped.reduce((n, name) => n + Buffer.byteLength(files[name]), 0));
  assert.ok(sizes.br < sizes.raw);

  // Run again (a release folder built twice): the same bytes, nothing compressed twice.
  const before = await readFile(join(dir, 'src/app.js.br'));
  assert.deepEqual(await precompress(dir), sizes);
  assert.deepEqual(await readFile(join(dir, 'src/app.js.br')), before);
  assert.ok(!(await readdir(join(dir, 'src'))).some((n) => n.endsWith('.br.br')));
});
