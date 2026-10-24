import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
/** The static and the dynamic imports of a file, as paths from the repository root. @param {string} file */
async function importsOf(file) {
  const src = await readFile(new URL(file, root), 'utf8');
  const at = (/** @type {string} */ spec) => new URL(spec, new URL(file, root)).pathname.slice(new URL(root).pathname.length);
  return {
    static: [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => at(m[1])),
    dynamic: [...src.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map((m) => at(m[1])),
    src,
  };
}

// "Words made before the catalog loads": anything evaluated before boot.js's setWords is English for good, so boot.js reaches
// nothing but the words themselves (localization plan, L1 risks).
test('boot.js imports only the words runtime, the list of languages, the pseudo-locales in development, and the app', async () => {
  const boot = await importsOf('src/app/boot.js');
  const reached = new Set();
  const walk = async (/** @type {string} */ file) => {
    if (reached.has(file)) return;
    reached.add(file);
    for (const next of (await importsOf(file)).static) await walk(next);
  };
  for (const file of boot.static) await walk(file);
  assert.deepEqual([...reached].sort(), ['src/core/l10n-list.js', 'src/core/l10n.js']);
  assert.deepEqual(boot.dynamic.sort(), ['src/app/main.js', 'src/core/l10n-pseudo.js']);
  const pseudo = await importsOf('src/core/l10n-pseudo.js');
  assert.deepEqual([...pseudo.static, ...pseudo.dynamic], [], 'the pseudo-locales need nothing');
  assert.match(boot.src, /\['localhost', '127\.0\.0\.1'\]\.includes\(location\.hostname\)[\s\S]*import\('\.\.\/core\/l10n-pseudo\.js'\)/, 'the pseudo-locales load in development only');
  assert.ok(boot.src.trimEnd().endsWith("await import('./main.js');"), 'the app comes last');
});

test('index.html starts annai through boot.js, and names main.js nowhere', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/app\/boot\.js"><\/script>/);
  assert.ok(!html.includes('main.js'));
});

test('a catalog that parses but is not an object is no catalog: boot.js falls to English and flags it', async () => {
  const { src } = await importsOf('src/app/boot.js');
  assert.match(src, /!words \|\| typeof words !== 'object' \|\| Array\.isArray\(words\)\) throw/);
  assert.ok(src.indexOf("Array.isArray(words)") < src.indexOf('setWords(tag, words)'), 'checked before the words are set');
});
