import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { check, update, extract, readMessages, readGlossary, glossaryWarnings, glossaryNames, shippedJson, listFile, swWithLangs, bareEnglish, findWords, readsAsWords, readTsv, writeTsv, review, find, pluginJson } from '../../scripts/strings.mjs';
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

test('a folder in EXTRACTED is every file under it (L5h: all of src/)', async () => {
  const { problems } = await check(FIXTURE, ['src/']);
  assert.ok(has(problems, 'src/bare.mjs', 5, /bare English "Nothing here yet\."/));
  assert.ok(!problems.some((p) => /is listed in EXTRACTED/.test(p.message)));
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
  // A hash link made of parts, and CSS functions, are code too.
  for (const s of ['#/trip/ /replay', 'translate( px,  px) scale( )', 'translateY( px)']) assert.equal(readsAsWords(s), false, s);
  // A name in code, or a brand's, is one word with a capital inside it; a word on its own with one capital is still words.
  for (const s of ['TimeoutError', 'NotFoundError', 'OpusHead', 'OggS']) assert.equal(readsAsWords(s), false, s);
  assert.equal(readsAsWords('Wikipedia'), true);
  const src = "import { h } from './dom.js';\nconst a = 'Hello there';\nconst b = x === 'Not words here';\n/* en */ const c = 'Kept English';\nconst d = h('p', { class: 'a-b' }, `Sentence ${a}`);\n";
  assert.deepEqual(findWords('src/ui/x.js', src).map((w) => [w.line, w.text]), [[2, 'Hello there'], [5, 'Sentence']]);
  // A class chosen by a condition, and an SVG attribute's value, are code wherever the choice is made.
  const code = "import { h } from './dom.js';\nh('b', { class: on ? 'btn' : 'btn pri' });\nh('b', { class: ['btn pri', x || 'chip warn'] });\nsvg('svg', { preserveAspectRatio: 'xMidYMid meet', viewBox: `0 0 ${w} ${h}` });\n";
  assert.deepEqual(findWords('src/ui/x.js', code), []);
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

test("--find leaves out a plural's forms and a context, which are the message's, and lists English in its values", () => {
  const src = `${IMPORT}export const a = (n, who) => plural(n, '{0} keeps # turn until it expires.', '{0} keeps # turns until they expire.', who ? 'Someone else' : 'The provider');\n`;
  assert.deepEqual(findWords('x.js', src).map((b) => b.text), ['Someone else', 'The provider']);  const context = `${IMPORT}export const a = tc('tool group')\`Files\`;\n`;
  assert.deepEqual(findWords('x.js', context), [], 'a context is no words either');
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

test('a translator\'s note ("Note: …") stays when the script writes the row again, and goes with a carried draft', async () => {
  await inCopy(async (dir) => {
    const tsv = `${dir}/l10n/ja.tsv`;
    await writeFile(tsv, (await readFile(tsv, 'utf8')).replace('{0} = where; {1} = who', '{0} = old; Note: 保存 as the phones say it').replace(/(\tsrc\/a\.mjs:4\t\{0\} = who)$/m, '$1; Note: a greeting'));
    await update(dir);
    const by = new Map(readTsv(await readFile(tsv, 'utf8')).map((r) => [r.key, r]));
    assert.equal(by.get(key('Saved to {0} for {1}'))?.note, '{0} = where; {1} = who; Note: 保存 as the phones say it', "the script's part is written again, the translator's kept");
    // The English changes a little: the draft carries its note, after what the English was.
    await writeFile(`${dir}/src/a.mjs`, (await readFile(`${dir}/src/a.mjs`, 'utf8')).replace('Hello ${who}.', 'Hello there ${who}.'));
    await update(dir);
    const carried = readTsv(await readFile(tsv, 'utf8')).find((r) => r.en === 'Hello there {0}.');
    assert.equal(carried?.note, '{0} = who; English was: Hello {0}.; Note: a greeting');
    await update(dir);
    assert.equal(readTsv(await readFile(tsv, 'utf8')).find((r) => r.en === 'Hello there {0}.')?.note, '{0} = who; English was: Hello {0}.; Note: a greeting', 'and keeps both on the next run');
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

test('a row a reviewer accepted is not warned about the glossary again: only drafts are (localization L6)', () => {
  const g = readGlossary(GLOSSARY);
  const row = (/** @type {string} */ state) => ({ key: 'k', state, en: 'Start a trip', text: '出発を始める', where: '', note: 'Note: 出発 reads better here.', line: 2 });
  assert.equal(glossaryWarnings(g, 'ja', [row('draft')]).length, 1);
  assert.equal(glossaryWarnings(g, 'ja', [row('ok')]).length, 0);
  // After a glossary word changes, every row is read again on asking (--glossary-all; L6 review 7).
  assert.equal(glossaryWarnings(g, 'ja', [row('ok')], { all: true }).length, 1);
});

test('strings --check --glossary-all warns about accepted rows too; plain --check only about drafts (L6 review 7)', async () => {
  const dir = await mkdtemp(`${tmpdir()}/annai-strings-`);
  try {
    await cp(FIXTURE, dir, { recursive: true });
    await update(dir);
    await writeFile(`${dir}/l10n/glossary.tsv`, `${GLOSSARY}\n`);
    const rows = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8'));
    const named = rows.find((r) => /\bHello\b/.test(r.en));
    assert.ok(named);
    await writeFile(`${dir}/l10n/glossary.tsv`, `${GLOSSARY}\nhello\tthing\tやあ\t你好\tsrc/a.mjs:1\t\n`);
    await writeFile(`${dir}/l10n/ja.tsv`, writeTsv(rows.map((r) => (r.key === named.key ? { ...r, state: 'ok', text: 'こんにちは {0}' } : r))));
    const plain = (await check(dir)).warnings.filter((w) => w.file === 'l10n/ja.tsv' && /"hello"/.test(w.message));
    const all = (await check(dir, undefined, { glossaryAll: true })).warnings.filter((w) => w.file === 'l10n/ja.tsv' && /"hello"/.test(w.message));
    assert.equal(plain.length, 0);
    assert.equal(all.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('the glossary is matched as it is written: a Capitalised name only where a name stands, a lowercase thing in either case', () => {
  const g = readGlossary(['en\tkind\tja\tzh-Hans\twhere\tnote', 'Now\tscreen\t今\t现在\t\t', 'About\tscreen\t情報\t关于\t\t', 'Voice\tscreen\t音声\t语音\t\t', 'Plan\tscreen\t計画\t计划\t\t',
    'trip\tthing\t旅\t行程\t\t', 'Ask\tscreen\t質問\t提问\t\t'].join('\n'));
  const w = (/** @type {string} */ en) => glossaryWarnings(g, 'ja', [{ key: 'k', state: 'draft', en, text: 'x', where: '', note: '', line: 2 }]).length;
  for (const fine of ['{0} just now', 'about {0}', 'Restart now', "Shiori's voice", 'Plan your day', 'Ask Shiori', 'Voice is off now']) assert.equal(w(fine), 0, fine);
  assert.equal(w('Now'), 1, 'the name alone');
  assert.equal(w('Open Voice'), 1, 'a name in the middle of a sentence');
  assert.equal(w('Go to the Plan.'), 1);
  assert.equal(w('Start a trip'), 1, 'a thing, lowercase');
  assert.equal(w('Trip name'), 1, 'and at the start of a sentence');
  assert.equal(w('Your trips'), 1);
});

test('a name kept as written is held to it at the start of a message too: "Shiori answers in…" must keep Shiori', () => {
  const g = readGlossary(GLOSSARY);
  const w = (/** @type {string} */ en, /** @type {string} */ text) => glossaryWarnings(g, 'ja', [{ key: 'k', state: 'draft', en, text, where: '', note: '', line: 2 }]).length;
  assert.equal(w('Shiori answers in {0}', 'しおりは{0}で答えます'), 1, 'her name written in kana');
  assert.equal(w('Shiori answers in {0}', 'Shiori は{0}で答えます'), 0);
});

test('the screens\' names for Shiori are the glossary\'s rows a traveller is told of, in its order, and ship in the catalog under @glossary (localization L6)', () => {
  const g = readGlossary(`${GLOSSARY}\nSpeech in\tthing\t聞き取り\t语音识别\tsrc/a.mjs:1\t\nTrace\tscreen\t記録\t记录\tsrc/a.mjs:1\t\nkey\tthing\tキー\t密钥\tsrc/a.mjs:1\t`);
  assert.equal(glossaryNames(g, 'ja'), 'Trips (旅), Speech in (聞き取り)', 'not Trace, a developer\'s screen, nor a platform word or a lowercase thing');
  assert.equal(glossaryNames(g, 'zh-Hans'), 'Trips (行程), Speech in (语音识别)');
  const rows = [{ key: 'b', state: 'ok', en: 'Hi', text: 'やあ', where: '', note: '' }];
  assert.deepEqual(JSON.parse(shippedJson(rows, 'Trips (旅)')), { b: 'やあ', '@glossary': 'Trips (旅)' });
  assert.deepEqual(JSON.parse(shippedJson(rows)), { b: 'やあ' });
});

test('the line Shiori is told of the screens names at most 31 names in every language, which measured 275 cl100k tokens at most (L6 review 4)', async () => {
  const g = readGlossary(await readFile(new URL('../../l10n/glossary.tsv', import.meta.url), 'utf8'));
  for (const tag of ['ja', 'zh-Hans']) assert.ok(glossaryNames(g, tag).split('), ').length <= 31, tag);
});

/** An official plugin in a copy of the fixture: its manifest (l10n listed, or not) and code using annai.l10n. @param {string} dir @param {any} [more] */
async function officialPlugin(dir, more = {}) {
  await mkdir(`${dir}/plugins-official/demo-tides/l10n`, { recursive: true });
  await writeFile(`${dir}/plugins-official/demo-tides/annai-plugin.json`, JSON.stringify({
    id: 'demo-tides', name: 'Tide tables', version: '1.0.0', api: 1, l10n: ['ja'], description: 'Tides where you are.', keywords: ['tides', 'sea'],
    settings: { type: 'object', properties: { depth: { type: 'string', title: 'Depth', oneOf: [{ const: 'a', title: 'Basic' }] } } }, ...more,
  }, null, 2));
  await writeFile(`${dir}/plugins-official/demo-tides/index.js`, "export function activate(annai) {\n  const { l10n } = annai;\n  const { t } = l10n;\n  return [l10n.t`Low tide at ${'4:12'}.`, annai.l10n.both`No station.`, l10n.plural(2, '# tide', '# tides'), l10n.tc('verb')`Open`, t`High tide.`];\n}\n");
}

test("an official plugin's words are rows of the same files, keyed by its id: its manifest's fields and its code's annai.l10n (localization L7)", async () => {
  await inCopy(async (dir) => {
    await officialPlugin(dir);
    const { messages, problems } = await extract(dir);
    assert.deepEqual(problems, []);
    const mine = [...messages.values()].filter((m) => m.key.startsWith('demo-tides:'));
    assert.deepEqual(mine.map((m) => [m.key, m.source]), [
      ['demo-tides:@name', 'Tide tables'], ['demo-tides:@description', 'Tides where you are.'], ['demo-tides:@keywords.0', 'tides'], ['demo-tides:@keywords.1', 'sea'],
      ['demo-tides:@settings.properties.depth.title', 'Depth'], ['demo-tides:@settings.properties.depth.oneOf.0.title', 'Basic'],
      [`demo-tides:${key('Low tide at {0}.')}`, 'Low tide at {0}.'], [`demo-tides:${key('No station.')}`, 'No station.'], [`demo-tides:${key('# tide\0# tides')}`, '# tide\0# tides'], [`demo-tides:${key('Open', 'verb')}`, 'Open'],
      [`demo-tides:${key('High tide.')}`, 'High tide.'],
    ]);
    assert.equal(mine[1].file, 'plugins-official/demo-tides/annai-plugin.json');
    assert.ok(mine[1].line > 1, 'the line its English is on');
    assert.equal(mine.at(-2)?.context, 'verb');
    // One that doesn't list l10n doesn't speak annai's languages yet: none of its words are rows.
    await officialPlugin(dir, { l10n: undefined });
    assert.equal([...(await extract(dir)).messages.keys()].filter((k) => k.startsWith('demo-tides:')).length, 0);
  });
});

test("update writes each official plugin's translation from the rows, which annai's own catalog leaves out; check says when it is stale or its l10n isn't annai's languages", async () => {
  await inCopy(async (dir) => {
    await officialPlugin(dir);
    await update(dir);
    const rows = readTsv(await readFile(`${dir}/l10n/ja.tsv`, 'utf8'));
    const filled = rows.map((r) => (r.key.startsWith('demo-tides:') ? { ...r, state: 'draft', text: r.key.endsWith('@description') ? '今いる場所の潮。' : r.key.includes('@keywords.') ? '潮' : `訳:${r.en.replace('{0}', '{0}')}` } : r));
    await writeFile(`${dir}/l10n/ja.tsv`, writeTsv(filled));
    await update(dir);
    const own = JSON.parse(await readFile(`${dir}/plugins-official/demo-tides/l10n/ja.json`, 'utf8'));
    assert.equal(own.manifest.description, '今いる場所の潮。');
    assert.deepEqual(own.manifest.keywords, ['潮'], 'once each');
    assert.equal(own.manifest['settings.properties.depth.oneOf.0.title'], '訳:Basic');
    assert.equal(own.messages[key('Low tide at {0}.')], '訳:Low tide at {0}.');
    assert.deepEqual(own.messages[key('# tide\0# tides')], { other: '訳:# tides' });
    assert.ok(!Object.keys(JSON.parse(await readFile(`${dir}/l10n/ja.json`, 'utf8'))).some((k) => k.includes(':')), "annai's catalog has none of a plugin's rows");
    assert.equal(pluginJson(filled, 'demo'), `${JSON.stringify({ manifest: {}, messages: {} }, null, 2)}\n`, 'another id is another plugin');
    assert.ok(!(await check(dir, [])).problems.some((p) => p.file.startsWith('plugins-official/')));
    await writeFile(`${dir}/plugins-official/demo-tides/l10n/ja.json`, '{}\n');
    await officialPlugin(dir, { l10n: ['ja', 'zh-Hans'] });
    const { problems } = await check(dir, []);
    assert.ok(problems.some((p) => p.file === 'plugins-official/demo-tides/l10n/ja.json' && /isn't what l10n\/ja\.tsv makes: run npm run strings, then npm run catalog/.test(p.message)));
    assert.ok(problems.some((p) => p.file === 'plugins-official/demo-tides/annai-plugin.json' && /its l10n must be \["ja"\]/.test(p.message)));
  });
});
