import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { check, update, extract, readMessages, readGlossary, glossaryWarnings, listFile, swWithLangs, bareEnglish, findWords, readsAsWords, readTsv, writeTsv, review, find } from '../../scripts/strings.mjs';
import { key } from '../../src/core/l10n.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/strings', import.meta.url));

/** A scratch copy of the fixture, since update writes. @param {(dir: string) => Promise<void>} run */
async function inCopy(run) {
  const dir = await mkdtemp(`${tmpdir()}/annai-strings-`);
  try {
    await cp(FIXTURE, dir, { recursive: true });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
/** @param {{ file: string, line: number, message: string }[]} list @param {string} file @param {number} line @param {RegExp} message */
const has = (list, file, line, message) => list.some((p) => p.file === file && p.line === line && message.test(p.message));

test('extract reads t, tc and plural, with their values', async () => {
  const { messages, problems } = await extract(FIXTURE);
  const m = (/** @type {string} */ k) => messages.get(k);
  assert.equal(m(key('Hello {0}.'))?.values[0], 'who');
  assert.equal(m(key('Open', 'verb'))?.context, 'verb');
  assert.equal(m(key('# stamp\0# stamps'))?.kind, 'plural');
  assert.equal(m(key('Saved to {0} for {1}'))?.line, 6);
  assert.equal(messages.size, 8);
});

test('extract says what it cannot read', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/src/broken.js`, "import { t, plural } from './dom.js';\n\nexport const a = (n, one) => plural(n, one, '# things');\nexport const b = t('Call me');\n");
    const { problems } = await extract(dir);
    assert.ok(has(problems, 'src/broken.js', 3, /plural needs its two forms as plain strings/));
    assert.ok(has(problems, 'src/broken.js', 4, /t is used as a function/));
  });
});

test('check reports every failure by file and line', async () => {
  const { problems, drafts } = await check(FIXTURE, []);
  assert.ok(has(problems, 'l10n/ja.tsv', 4, /placeholders \{0\}, the English has \{0\}\{1\}/), 'a placeholder missing');
  assert.ok(has(problems, 'l10n/ja.tsv', 5, /no "one" form: its categories are other/), 'a plural form Japanese lacks');
  assert.ok(has(problems, 'l10n/ja.tsv', 7, /no text yet for "Not yet"/), 'a new row');
  assert.ok(has(problems, 'l10n/ja.tsv', 8, /"Gone away" is no longer in the code/), 'a stale row');
  assert.ok(has(problems, 'src/a.mjs', 9, /no row for "Brand new"/), 'no row at all');
  assert.ok(has(problems, 'l10n/ja.json', 1, /isn't what l10n\/ja\.tsv makes/), 'a JSON file out of date');
  assert.ok(has(problems, 'src/core/l10n-list.js', 1, /isn't what l10n\/languages\.json makes/), 'the list out of date');
  assert.ok(!problems.some((p) => p.file === 'l10n/ja.tsv' && [2, 3, 6].includes(p.line)), 'the good rows are quiet');
  assert.deepEqual(drafts, { ja: { draft: 4, ok: 2 } });
});

test('bare English is found where a screen surely shows it, and /* en */ marks it on purpose', async () => {
  const found = bareEnglish('src/bare.mjs', await readFile(`${FIXTURE}/src/bare.mjs`, 'utf8'));
  assert.deepEqual(found.map((f) => [f.line, f.text]), [[3, 'Trips'], [4, 'Trips'], [5, 'Nothing here yet.'], [9, 'Not yours']]);
  const { problems } = await check(FIXTURE, ['src/bare.mjs']);
  assert.ok(has(problems, 'src/bare.mjs', 5, /bare English "Nothing here yet\."/));
});

test('a mark on the statement covers what is inside it', () => {
  const src = "import { h } from './dom.js';\n/* en: for a model */\nexport const a = [h('p', { text: 'Only for Shiori' })];\nexport const b = [h('p', { text: 'For you' })];\n";
  assert.deepEqual(bareEnglish('x.js', src).map((f) => f.line), [4]);
});

test('update adds a new row, drops the stale one, and ships only keys and texts', async () => {
  await inCopy(async (dir) => {
    const written = await update(dir);
    assert.deepEqual(written.sort(), ['l10n/ja.json', 'l10n/ja.tsv', 'src/core/l10n-list.js']);
    const rows = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8'));
    const by = new Map(rows.map((r) => [r.key, r]));
    assert.equal(by.get(key('Brand new'))?.state, 'new');
    assert.equal(by.get(key('Brand new'))?.where, 'src/a.mjs:9');
    assert.equal(by.get(key('Gone away')), undefined);
    assert.equal(by.get(`${key('# stamp\0# stamps')}#one`), undefined, 'Japanese has no one form');
    assert.match(/** @type {any} */ (by.get(key('Saved to {0} for {1}'))).note, /\{0\} = where; \{1\} = who/);
    assert.deepEqual(JSON.parse(await readFile(`${dir}/l10n/ja.json`, 'utf8')), {
      [key('Hello {0}.')]: 'こんにちは{0}。',
      [key('Open', 'verb')]: '開ける',
      [key('Saved to {0} for {1}')]: '{0}に保存',
      [key('# stamp\0# stamps')]: { other: 'スタンプ#個' },
    });
    assert.equal(await readFile(`${dir}/src/core/l10n-list.js`, 'utf8'), "// Written by scripts/strings.mjs from l10n/languages.json. Do not edit.\nexport const SHIPPED = Object.freeze(['en', 'ja']);\n/** @type {readonly string[]} */\nexport const EXPERIMENTAL = Object.freeze([]);\n");
    assert.deepEqual(await update(dir), [], 'a second run has nothing to write');
  });
});

test('a message whose English changed by a little carries its translation over as a draft', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/src/a.mjs`, (await readFile(`${dir}/src/a.mjs`, 'utf8')).replace('Hello ${who}.', 'Hello there ${who}.'));
    await update(dir);
    const by = new Map(readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8')).map((r) => [r.key, r]));
    const carried = by.get(key('Hello there {0}.'));
    assert.equal(carried?.state, 'draft');
    assert.equal(carried?.text, 'こんにちは{0}。');
    assert.match(carried?.note ?? '', /English was: Hello \{0\}\./);
    assert.equal(by.get(key('Hello {0}.')), undefined);
    assert.equal(by.get(key('Brand new'))?.state, 'new', 'English that is not close starts new');
    await update(dir);
    const again = new Map(readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8')).map((r) => [r.key, r]));
    assert.match(again.get(key('Hello there {0}.'))?.note ?? '', /English was: Hello \{0\}\./, 'the note stays while it is a draft');
  });
});

test('two messages with one key are reported', async () => {
  // FNV-1a over 32 bits: a birthday search finds a pair in a few tens of thousands of short strings.
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {[string, string] | null} */
  let pair = null;
  let x = 12345;
  for (let i = 0; !pair && i < 600000; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const s = `w${x.toString(36)}${(x ^ i).toString(36)}`;
    const k = key(s);
    const was = seen.get(k);
    if (was) pair = [was, s];
    else seen.set(k, s);
  }
  assert.ok(pair, 'a pair was found');
  const [a, b] = /** @type {[string, string]} */ (pair);
  await inCopy(async (dir) => {
    await mkdir(`${dir}/src`, { recursive: true });
    await writeFile(`${dir}/src/clash.js`, `import { t } from './dom.js';\nexport const x = t\`${a}\`;\nexport const y = t\`${b}\`;\n`);
    const { problems } = await extract(dir);
    assert.ok(has(problems, 'src/clash.js', 3, new RegExp(`the key ${key(a)} is also src/clash.js:2`)));
  });
});

test('a file that does not import t, tc or plural from the runtime has no messages', () => {
  const { messages, errors } = readMessages('x.js', "const t = (x) => x;\nexport const a = t('hi');\nexport const b = String.raw`two ${1}`;\n");
  assert.deepEqual([messages.length, errors.length], [0, 0]);
});

test('the translator\'s file keeps tabs, line breaks and backslashes', () => {
  const rows = [{ key: 'a', state: 'ok', en: 'One\tTwo\nThree\\n', text: 'x\\ty\n', where: 'src/x.js:1', note: '' }];
  const back = readTsv(writeTsv(rows));
  assert.deepEqual({ ...back[0], line: 0 }, { ...rows[0], line: 0 });
  assert.equal(writeTsv(rows).split('\n').length, 3, 'a header, a row and the final line break');
});

test('--find lists what reads as words and is not marked', () => {
  assert.equal(readsAsWords('Last backup'), true);
  assert.equal(readsAsWords('Saved'), true);
  assert.equal(readsAsWords('btn pri'), true);
  for (const s of ['btn', 'application/json', 'https://example.com/x', 'dateStyle', '', '→', '#/trip/', 'MAX_SIZE', 'rgba(0,0,0,.5)']) assert.equal(readsAsWords(s), false, s);
  const src = "import { h } from './dom.js';\nconst a = 'Hello there';\nconst b = x === 'Not words here';\n/* en */ const c = 'Kept English';\nconst d = h('p', { class: 'a-b' }, `Sentence ${a}`);\n";
  assert.deepEqual(findWords('src/ui/x.js', src).map((w) => [w.line, w.text]), [[2, 'Hello there'], [5, 'Sentence']]);
});

test('--find reads files and folders, and says who it guesses reads them', async () => {
  const lines = await find(FIXTURE, ['src/bare.mjs']);
  assert.ok(lines.some((l) => l.startsWith('src/bare.mjs:5\t') && l.endsWith('\tNothing here yet.')));
});

test('--review is a Markdown table of the drafts', async () => {
  const table = await review(FIXTURE, 'ja');
  assert.match(table, /^\| English \| Draft \| Where \|\n\| --- \| --- \| --- \|\n\| Open \| 開ける \| src\/a\.mjs:5 \|/);
  assert.ok(!table.includes('Gone away'), 'only drafts');
});

// ---- the fix pass: imports, templates, concatenation, marks, helpers, CRLF ----

const IMPORT = "import { h, t, tc, plural, field, savedField, radios, savedRadios, jsonField } from './dom.js';\n";

test('a namespace import of the words is followed: L.t`…` is a message, and L.t(…) a mistake', () => {
  const src = "import * as L from '../../core/l10n.js';\nexport const a = (n, who) => [L.t`Hello ${who}`, L.tc('verb')`Open`, L.plural(n, '# stamp', '# stamps')];\nexport const b = () => L.t('no');\n";
  const { messages, errors } = readMessages('x.js', src);
  assert.deepEqual(messages.map((m) => m.kind + m.source.replace('\0', '|')), ['tHello {0}', 'tOpen', 'plural# stamp|# stamps']);
  assert.equal(messages[1].context, 'verb');
  assert.ok(errors.some((e) => e.line === 3 && /used as a function/.test(e.message)));
});

test('an import shape of the words the script cannot follow is refused, and so is a re-export outside dom.js', () => {
  const refused = (/** @type {string} */ src, /** @type {string} */ file = 'x.js') => readMessages(file, src).errors.map((e) => e.message);
  assert.match(refused("import words from '../core/l10n.js';\n")[0], /can't follow/);
  assert.match(refused("export { t } from '../core/l10n.js';\n")[0], /can't follow/);
  assert.match(refused("export * from './dom.js';\n")[0], /can't follow/);
  assert.deepEqual(refused("export { t, tc, plural } from '../core/l10n.js';\n", 'src/ui/dom.js'), [], 'dom.js is where the words are re-exported');
  assert.deepEqual(refused("import { t as tr } from './dom.js';\nexport const a = tr`Hi`;\n"), []);
});

test('English inside a message\'s ${} is bare English, in the check and in --find', () => {
  const src = `${IMPORT}export const a = (ok) => h('p', {}, t\`Saved \${ok ? 'Everything was kept' : 'Nothing was kept'}\`);\n`;
  assert.deepEqual(bareEnglish('x.js', src).map((b) => b.text), ['Everything was kept', 'Nothing was kept']);
  assert.deepEqual(findWords('x.js', src).map((b) => b.text), ['Everything was kept', 'Nothing was kept']);
  const other = `${IMPORT}export const a = (ok) => svg\`<g>\${ok ? 'Everything was kept' : 'Nothing'}</g>\`;\n`;
  assert.deepEqual(findWords('x.js', other).map((b) => b.text), ['Everything was kept', 'Nothing']);
  const plain = `${IMPORT}export const a = (n) => plural(n, '# stamp', '# stamps', 'Kept for good');\n`;
  assert.deepEqual(bareEnglish('x.js', plain).map((b) => b.text), ['Kept for good']);
});

test('English joined on in a shown place is bare English', () => {
  const src = `${IMPORT}export const a = (ctx) => [h('p', { text: 'Trips for ' + ctx.name }), h('p', {}, ctx.n + ' trips'), h('p', {}, String('Nothing ' + ctx.x))];\n`;
  assert.deepEqual(bareEnglish('x.js', src).map((b) => b.text), ['Trips for', 'trips', 'Nothing']);
});

test('a mark above a function or class does not cover its body; a mark on an ordinary statement does', () => {
  const body = "  return h('p', { text: 'Trips' });\n";
  assert.equal(bareEnglish('x.js', `${IMPORT}/* en */\nexport async function render() {\n${body}}\n`).length, 1);
  assert.equal(bareEnglish('x.js', `${IMPORT}/* en */\nexport const render = () => {\n${body}};\n`).length, 1);
  assert.equal(bareEnglish('x.js', `${IMPORT}/* en */\nexport class A {\n  render() {\n  ${body}  }\n}\n`).length, 1);
  assert.equal(bareEnglish('x.js', `${IMPORT}export function render() {\n  /* en */\n${body}}\n`).length, 0, 'a mark inside, on the statement');
  assert.equal(bareEnglish('x.js', `${IMPORT}/* en */\nexport const rows = [h('p', { text: 'Trips' })];\n`).length, 0, 'a mark on a statement that is data');
  assert.equal(bareEnglish('x.js', `${IMPORT}export const say = (s) => /* en */ (s ? '' : h('p', { text: 'Trips' }));\n`).length, 0, 'a mark on an arrow\'s expression');
});

test('the label helpers of dom.js show their words too', () => {
  const src = `${IMPORT}export const a = () => [savedField('Name', 1, 2, 3), jsonField('Schema', 'id', {}), radios('Pick one', [['a', 'First'], ['b', 'Second']], 'a'), savedRadios('Mode', [['x', 'Quick']], 'x', () => {})];\n`;
  assert.deepEqual(bareEnglish('x.js', src).map((b) => b.text), ['Name', 'Schema', 'Pick one', 'First', 'Second', 'Mode', 'Quick']);
});

test('a translator\'s file saved with CRLF reads and ships without the \\r', () => {
  const rows = readTsv('key\tstate\ten\ttext\twhere\tnote\r\nabc\tok\tHello\tこんにちは\tsrc/a.js:1\t\r\n\r\n');
  assert.deepEqual(rows.map((r) => [r.key, r.text, r.note, r.where]), [['abc', 'こんにちは', '', 'src/a.js:1']]);
});

test('a plural\'s note names its first argument, and a carried draft\'s note does not start with a semicolon', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/src/a.mjs`, (await readFile(`${dir}/src/a.mjs`, 'utf8')).replace('plural(n,', 'plural(stamps.length,'));
    await update(dir);
    const rows = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8'));
    assert.match(rows.find((r) => r.key.startsWith(key('# stamp\0# stamps')))?.note ?? '', /^plural; # = stamps\.length;/);
    // A message with no values has an empty note: carried over, the note is only what the English was.
    await writeFile(`${dir}/src/a.mjs`, (await readFile(`${dir}/src/a.mjs`, 'utf8')).replace('t`Not yet`', 't`Not yet now`'));
    await writeFile(`${dir}/l10n/ja.tsv`, (await readFile(`${dir}/l10n/ja.tsv`, 'utf8')).replace(/^(\S+)\tnew\tNot yet\t/m, '$1\tdraft\tNot yet\tまだ'));
    await update(dir);
    const carried = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8')).find((r) => r.en === 'Not yet now');
    assert.equal(carried?.note, 'English was: Not yet');
  });
});

// ---- localization L4: experimental languages, the languages sw.js caches, the glossary ----

test('an unfinished (experimental) language fails the check for a new row, as a shipped one does', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/l10n/languages.json`, JSON.stringify([{ tag: 'ja', status: 'experimental' }]));
    const { problems, warnings } = await check(dir, []);
    assert.ok(has(problems, 'l10n/ja.tsv', 7, /no text yet for "Not yet"/), 'a new row fails while experimental');
    assert.ok(has(problems, 'src/a.mjs', 9, /no row for "Brand new"/));
    assert.ok(!warnings.some((w) => w.file === 'l10n/ja.tsv'), 'and is not just a warning');
    // Not listed at all, the same rows are only warnings.
    await writeFile(`${dir}/l10n/languages.json`, '[]');
    const unlisted = await check(dir, []);
    assert.ok(!unlisted.problems.some((p) => p.file === 'l10n/ja.tsv'));
    assert.ok(unlisted.warnings.some((w) => w.file === 'l10n/ja.tsv' && /no text yet for "Not yet"/.test(w.message)));
  });
});

test('the list names the unfinished languages apart from the shipped, and sw.js lists every language and the shipped ones apart', () => {
  const list = /** @type {const} */ ([{ tag: 'ja', status: 'experimental' }, { tag: 'zh-Hans', status: 'shipped' }]);
  const text = listFile([...list]);
  assert.match(text, /export const SHIPPED = Object\.freeze\(\['en', 'zh-Hans'\]\);\n\/\*\* @type \{readonly string\[\]\} \*\/\nexport const EXPERIMENTAL = Object\.freeze\(\['ja'\]\);\n$/);
  assert.equal(swWithLangs("const A = 1;\nconst LANGS = [];\nconst SHIPPED_LANGS = [];\nconst SHELL = [];\n", [...list]), "const A = 1;\nconst LANGS = ['ja', 'zh-Hans'];\nconst SHIPPED_LANGS = ['zh-Hans'];\nconst SHELL = [];\n");
  assert.equal(swWithLangs("const LANGS = ['ja'];\nconst SHIPPED_LANGS = ['ja'];\n", []), 'const LANGS = [];\nconst SHIPPED_LANGS = [];\n');
  assert.equal(swWithLangs('const SHELL = [];\n', [...list]), null, 'no LANGS line, nothing to write');
  assert.equal(swWithLangs('const LANGS = [];\n', [...list]), null, 'and no SHIPPED_LANGS line either');
});

test('update writes sw.js\'s LANGS and SHIPPED_LANGS, and the check says when they are out of date', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/sw.js`, "// worker\nconst LANGS = [];\nconst SHIPPED_LANGS = [];\nconst SHELL = [];\n");
    const stale = await check(dir, []);
    assert.ok(has(stale.problems, 'sw.js', 2, /LANGS isn't what l10n\/languages\.json makes/));
    const written = await update(dir);
    assert.ok(written.includes('sw.js'));
    assert.equal(await readFile(`${dir}/sw.js`, 'utf8'), "// worker\nconst LANGS = ['ja'];\nconst SHIPPED_LANGS = ['ja'];\nconst SHELL = [];\n");
    assert.ok(!(await check(dir, [])).problems.some((p) => p.file === 'sw.js'));
    await writeFile(`${dir}/l10n/languages.json`, JSON.stringify([{ tag: 'ja', status: 'experimental' }]));
    await update(dir);
    assert.match(await readFile(`${dir}/sw.js`, 'utf8'), /const LANGS = \['ja'\];\nconst SHIPPED_LANGS = \[\];/);
    await writeFile(`${dir}/sw.js`, 'const SHELL = [];\n');
    assert.ok(has((await check(dir, [])).problems, 'sw.js', 1, /no `const LANGS/));
  });
});

const GLOSSARY = ['en\tkind\tja\tzh-Hans\twhere\tnote', 'Trips\tscreen\t旅\t行程\tsrc/a.mjs:1\t', 'trip\tthing\t旅\t行程\tsrc/a.mjs:1\t', 'Shiori\tnever\t\t\tsrc/a.mjs:1\tstays Latin',
  'Add to Home Screen\tplatform\tホーム画面に追加\t添加到主屏幕\tsrc/a.mjs:1\t', 'Home Screen\tplatform\tホーム画面\t主屏幕\tsrc/a.mjs:1\t', 'Koe\tmode\tKoe\t\tsrc/a.mjs:1\t'].join('\n');

test('readGlossary reads the columns by their names', () => {
  const g = readGlossary(`${GLOSSARY}\n`);
  assert.equal(g.length, 6);
  assert.deepEqual(g[0], { en: 'Trips', kind: 'screen', terms: { ja: '旅', 'zh-Hans': '行程' }, where: 'src/a.mjs:1', note: '' });
  assert.equal(g[2].terms.ja, '');
});

test('a message that names a glossary term in English, whose translation does not use the language\'s word, is a warning', () => {
  const g = readGlossary(GLOSSARY);
  const row = (/** @type {string} */ en, /** @type {string} */ text, line = 2, state = 'draft') => ({ key: 'k', state, en, text, where: '', note: '', line });
  const w = (/** @type {string} */ tag, /** @type {ReturnType<typeof row>[]} */ rows) => glossaryWarnings(g, tag, rows);
  assert.deepEqual(w('ja', [row('Start a trip', '旅を始める'), row('{0} trips', '{0}件の旅')]), [], 'the term is used');
  const bad = w('ja', [row('Start a trip', '出発を始める', 5)]);
  assert.equal(bad.length, 1);
  assert.deepEqual([bad[0].file, bad[0].line], ['l10n/ja.tsv', 5]);
  assert.match(bad[0].message, /"Start a trip" names the glossary's "trip", which is "旅" in ja, and the text doesn't use it/);
  assert.equal(w('zh-Hans', [row('Go to Trips', '去行程')]).length, 0);
  assert.equal(w('zh-Hans', [row('Go to Trips', '去旅行')]).length, 1, 'each language has its own word');
  assert.equal(w('ja', [row('Open Shiori', '開く')]).length, 1, 'a never term must stay as written');
  assert.equal(w('ja', [row('Open Shiori', 'Shioriを開く')]).length, 0);
  assert.equal(w('zh-Hans', [row('Koe is a voice', '声音')]).length, 0, 'a term with no word for the language is not checked');
  assert.equal(w('ja', [row('Tripwire', 'x'), row('Tripping', 'x')]).length, 0, 'whole words only');
  assert.equal(w('ja', [row('Brand new', '', 2, 'new'), row('Start a trip', '', 3, 'draft')]).length, 0, 'a row with no text yet is the check\'s own business');
  // The longest term first: "Add to Home Screen" is one term, and its words are not "Home Screen" again.
  assert.equal(w('ja', [row('Add to Home Screen', 'ホーム画面に追加')]).length, 0);
  assert.equal(w('ja', [row('Add to Home Screen', 'ホーム画面へ')]).length, 1);
});

test('the check warns, and does not fail, for the glossary', async () => {
  await inCopy(async (dir) => {
    await writeFile(`${dir}/src/g.mjs`, "import { t } from './dom.js';\nexport const x = () => t`Start a trip`;\n");
    await update(dir);
    const rows = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8'));
    const at = rows.find((r) => r.en === 'Start a trip');
    assert.ok(at);
    at.state = 'draft';
    at.text = '出発を始める';
    await writeFile(`${dir}/l10n/ja.tsv`, writeTsv(rows.map(({ line, ...r }) => r)));
    await writeFile(`${dir}/l10n/glossary.tsv`, `${GLOSSARY}\n`);
    const { warnings, problems } = await check(dir, []);
    assert.ok(warnings.some((x) => x.file === 'l10n/ja.tsv' && /"Start a trip" names the glossary's "trip"/.test(x.message)));
    assert.ok(!problems.some((x) => /glossary/.test(x.message)), 'a warning is not a failure');
    // Without the glossary there is nothing to warn of.
    await rm(`${dir}/l10n/glossary.tsv`);
    assert.ok(!(await check(dir, [])).warnings.some((x) => /glossary/.test(x.message)));
  });
});
