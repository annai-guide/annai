import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

test("the service worker's cache is named by version and build, so any change to the shell ships", async () => {
  const sw = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /^const BUILD = '[0-9a-f]{12}';$/m);
  assert.match(sw, /const CACHE = `annai-shell-\$\{VERSION\}-\$\{BUILD\}`;/);
});
