import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { check, update, extract, readMessages, bareEnglish, findWords, readsAsWords, readTsv, writeTsv, review, find } from '../../scripts/strings.mjs';
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
  const src = "import { h } from './dom.js';\n/* en: for a model */\nexport const a = () => h('p', { text: 'Only for Shiori' });\nexport const b = () => h('p', { text: 'For you' });\n";
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
    assert.equal(await readFile(`${dir}/src/core/l10n-list.js`, 'utf8'), "// Written by scripts/strings.mjs from l10n/languages.json: the languages annai ships, English first. Do not edit.\nexport const SHIPPED = Object.freeze(['en', 'ja']);\n");
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
