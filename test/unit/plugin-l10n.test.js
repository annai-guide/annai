import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPackage, checkManifest, translationFor, wordsOf, fetchPackage, L10N_MAX_BYTES } from '../../src/core/packages.js';
import { PluginError } from '../../src/core/registry.js';
import { setWords, wordsOver, key } from '../../src/core/l10n.js';
import { holdWords } from '../../src/core/backup.js';
import { files, hostKit, codePlugin } from './package-kit.js';

// A plugin's translations (localization L7, the design's section 8): what annai checks at install, accepted and refused; which
// translation the screens use; annai.l10n; and a plugin's refusal kept in a hold, shown in its words only in their language.

afterEach(() => setWords('en', null));

/** The tides plugin of the design's example: English, with Japanese. @param {any} [more] manifest changes */
const TIDES = (more = {}) => ({
  id: 'acme-tides', name: 'Acme Tides', version: '1.0.0', api: 1, language: 'en', l10n: ['ja'],
  description: 'Tide tables for the coast you are on.', keywords: ['tides'],
  settings: { type: 'object', properties: {
    station: { type: 'string', title: 'Station', description: "The station's id." },
    depth: { type: 'string', title: 'Depth', oneOf: [{ const: 'basic', title: 'Basic' }, { const: 'advanced', title: 'Advanced' }] },
  } },
  ...more,
});
const JA = {
  manifest: { description: '今いる海岸の潮汐表。', keywords: ['潮汐', '潮'], 'settings.properties.station.title': '観測地点', 'settings.properties.depth.oneOf.0.title': '基本' },
  messages: { [key('Low tide at {0}.')]: '{0}に干潮。', [key('# tide\0# tides')]: { other: '潮 #回' } },
};
/** The package's files: its manifest and its Japanese. @param {any} [manifest] @param {any} [ja] */
const pkg = (manifest = TIDES(), ja = JA) => files({ 'annai-plugin.json': JSON.stringify(manifest), ...(ja === null ? {} : { 'l10n/ja.json': typeof ja === 'string' ? ja : JSON.stringify(ja) }) });

test('a plugin with its language and a translation is accepted, and keeps its English manifest', async () => {
  const p = await inspectPackage(pkg());
  assert.equal(p.manifest.description, 'Tide tables for the coast you are on.');
  assert.deepEqual(p.manifest.l10n, ['ja']);
  // Without language, its words are English; a plural's forms for a language with two (English) are both allowed.
  await inspectPackage(pkg(TIDES({ language: undefined, l10n: ['en-GB'] }), null).set('l10n/en-GB.json', new TextEncoder().encode(JSON.stringify({ messages: { a: { one: 'x', other: 'y' } } }))));
});

test("each of the design's checks refuses, saying why in plain words", async () => {
  /** @type {[Map<string, Uint8Array>, RegExp][]} */
  const cases = [
    [pkg(TIDES({ language: 'EN' })), /"EN" isn't a language tag as written canonically/],
    [pkg(TIDES({ l10n: ['ja_JP'] })), /"ja_JP" isn't a language tag/],
    [pkg(TIDES({ l10n: ['ja', 'ja'] })), /lists a language twice/],
    [pkg(TIDES({ l10n: Array.from({ length: 51 }, (_, i) => `x-${i}`) })), /at most 50|maxItems|50/],
    [pkg(TIDES(), null), /l10n\/ja\.json, listed in l10n, is missing/],
    [pkg(TIDES(), '{ not json'), /l10n\/ja\.json is not valid JSON/],
    [pkg(TIDES(), JSON.stringify({ messages: { a: 'x'.repeat(L10N_MAX_BYTES) } })), /larger than 256 KiB/],
    [pkg(TIDES(), '[]'), /object with only manifest and messages/],
    [pkg(TIDES(), { ...JA, extra: {} }), /object with only manifest and messages/],
    [pkg(TIDES(), { manifest: { name: 'アクメ潮汐' } }), /translates name, which isn't a field a translation may give/],
    [pkg(TIDES(), { manifest: { version: '2' } }), /translates version/],
    [pkg(TIDES(), { manifest: { 'settings.properties.wind.title': '風' } }), /translates settings\.properties\.wind\.title, which this manifest doesn't have/],
    [pkg(TIDES(), { manifest: { featured: '潮' } }), /translates featured, which this manifest doesn't have/],
    [pkg(TIDES(), { manifest: { description: 'あ'.repeat(501) } }), /description must be text of up to 500 characters/],
    [pkg(TIDES(), { manifest: { description: 5 } }), /description must be text/],
    [pkg(TIDES(), { manifest: { keywords: ['あ'.repeat(41)] } }), /keywords must be text of up to 40 characters, up to 20/],
    [pkg(TIDES(), { manifest: { keywords: 'tides' } }), /keywords must be text/],
    [pkg(TIDES(), { messages: { a: 5 } }), /message a must be text, or plural forms of ja \(other\)/],
    [pkg(TIDES(), { messages: { a: { one: '潮', other: '潮' } } }), /message a must be text, or plural forms of ja/],
    [pkg(TIDES(), { messages: { a: 'あ'.repeat(2001) } }), /up to 2000 characters/],
  ];
  for (const [f, why] of cases) {
    await assert.rejects(inspectPackage(f), (e) => e instanceof PluginError && why.test(/** @type {Error} */ (e).message), String(why));
  }
  // The tags are checked with the rest of the manifest, so a stored one is checked again as it starts.
  assert.throws(() => checkManifest(TIDES({ language: 'en_US' })), /isn't a language tag/);
});

test("annai's own plugins may translate their descriptive names; a third party's name is shown as written (decision 10)", async () => {
  const named = { manifest: { name: 'アクメ潮汐' } };
  await assert.rejects(inspectPackage(pkg(TIDES(), named)), /translates name/);
  const p = await inspectPackage(pkg(TIDES(), named), { official: true });
  assert.equal(p.name, 'Acme Tides');
});

test('which translation the screens use: none in its own language, else the one listed for the language', () => {
  assert.equal(translationFor(TIDES(), 'en'), null);
  assert.equal(translationFor(TIDES(), 'ja'), 'ja');
  assert.equal(translationFor(TIDES(), 'zh-Hans'), null);
  assert.equal(translationFor(TIDES({ l10n: ['zh'] }), 'zh-Hans'), 'zh', 'the same language and script');
  assert.equal(translationFor(TIDES({ l10n: ['zh-Hant'] }), 'zh-Hans'), null, 'Traditional is not Simplified');
  assert.equal(translationFor(TIDES({ language: 'ja', l10n: ['en'] }), 'ja'), null, 'written in Japanese');
  assert.equal(translationFor(TIDES({ language: 'ja', l10n: ['en'] }), 'en'), 'en');
});

test('its words for the screens: translated fields laid over a copy, keywords added, the language they are in', () => {
  const read = (/** @type {string} */ path) => (path === 'l10n/ja.json' ? new TextEncoder().encode(JSON.stringify(JA)) : undefined);
  const m = TIDES();
  setWords('ja', {});
  const w = wordsOf(m, read);
  assert.equal(w.lang, 'ja');
  assert.equal(w.manifest.description, '今いる海岸の潮汐表。');
  assert.deepEqual(w.manifest.keywords, ['tides', '潮汐', '潮']);
  assert.equal(w.manifest.settings.properties.station.title, '観測地点');
  assert.equal(w.manifest.settings.properties.station.description, "The station's id.", 'a field it has no word for stays English');
  assert.equal(w.manifest.settings.properties.depth.oneOf[0].title, '基本');
  assert.equal(m.description, 'Tide tables for the coast you are on.', 'the manifest itself stays English');
  // Chinese screens: it has no Chinese, so its own words, in English.
  setWords('zh-Hans', {});
  const zh = wordsOf(m, read);
  assert.equal(zh.lang, 'en');
  assert.equal(zh.manifest, m);
  // A translation that can't be read leaves its own words.
  setWords('ja', {});
  assert.equal(wordsOf(m, () => new TextEncoder().encode('{')).lang, 'en');
});

test("annai.l10n's words: a translation only where its placeholders are the source's, plural forms of the language, and both", () => {
  setWords('ja', {});
  const w = wordsOver({ ...JA.messages, [key('Station {0}')]: '観測地点' });
  assert.equal(w.t`Low tide at ${'4:12'}.`, '4:12に干潮。');
  assert.equal(w.t`Station ${'9413450'}`, 'Station 9413450', 'placeholders not the source\'s: its English');
  assert.equal(w.t`High tide.`, 'High tide.', 'no word for it: its English');
  assert.equal(w.plural(3, '# tide', '# tides'), '潮 3回');
  assert.deepEqual(w.both`Low tide at ${'4:12'}.`, { message: 'Low tide at 4:12.', shown: '4:12に干潮。' });
  // A plugin with no translation for the screens: its own words, counted the English way.
  const own = wordsOver(null);
  assert.equal(own.plural(1, '# tide', '# tides'), '1 tide');
  assert.deepEqual(own.both`High tide.`, { message: 'High tide.', shown: 'High tide.' });
});

test("a running plugin gets annai.l10n with its own words in the screens' language, and the screens know their language", async () => {
  setWords('ja', {});
  const k = await hostKit();
  const body = "globalThis.__tides = { t: annai.l10n.t`Low tide at ${'4:12'}.`, lang: annai.l10n.lang, size: annai.l10n.format.size(2048) };";
  const withJa = codePlugin('tides', body, { l10n: ['ja'] });
  withJa.set('l10n/ja.json', new TextEncoder().encode(JSON.stringify({ messages: JA.messages })));
  await k.host.install(withJa);
  await k.host.start('tides');
  const got = /** @type {any} */ (globalThis).__tides;
  assert.equal(got.t, '4:12に干潮。');
  assert.equal(got.lang, 'ja');
  assert.match(got.size, /KB|kB|キロ/);
  assert.equal(k.host.langOf('tides'), 'ja');
  await k.host.install(codePlugin('plain', 'globalThis.__plain = annai.l10n.t`Low tide.`;'));
  await k.host.start('plain');
  assert.equal(/** @type {any} */ (globalThis).__plain, 'Low tide.');
  assert.equal(k.host.langOf('plain'), 'en', 'no Japanese: its words are marked English');
  const rows = await k.host.describe();
  assert.equal(rows.find((r) => r.id === 'plain')?.lang, 'en');
  assert.equal(rows.find((r) => r.id === 'tides')?.lang, 'ja');
});

test("a plugin's card and toast carry its words' language", async () => {
  const k = await hostKit();
  /** @type {any[]} */
  const seen = [];
  k.host.connect({ notices: { card: (/** @type {any} */ c) => seen.push(c), toast: (/** @type {string} */ text, /** @type {string} */ lang) => seen.push({ text, lang }) } });
  await k.host.install(codePlugin('plain', "annai.ui.card({ title: 'Tides' }); annai.ui.toast('Low tide');"));
  setWords('ja', {});
  await k.host.start('plain');
  assert.deepEqual(seen.map((x) => x.lang), ['en', 'en']);
});

test('an address install brings the translations its manifest lists', async () => {
  const site = new Map([['https://x.example/p/annai-plugin.json', JSON.stringify(TIDES())], ['https://x.example/p/l10n/ja.json', JSON.stringify(JA)]]);
  const got = await fetchPackage('https://x.example/p/annai-plugin.json', { fetch: async (url) => (site.has(url) ? new Response(site.get(url)) : new Response('', { status: 404 })) });
  assert.deepEqual([...got.keys()].sort(), ['annai-plugin.json', 'l10n/ja.json']);
});

test("a plugin's refusal is kept in its English, its words beside it with their language, shown only in that language", () => {
  setWords('ja', {});
  const h = { message: "GitHub didn't accept the access token.", said: null, shown: 'GitHubがアクセストークンを受け付けませんでした。', lang: 'ja' };
  assert.equal(holdWords(h), h.shown);
  setWords('zh-Hans', {});
  assert.equal(holdWords(h), h.message, 'a backup brought it to Chinese screens: its English, never the Japanese as their own');
  setWords('en', null);
  assert.equal(holdWords(h), h.message);
});

test("a backup place's plugin refusing in the screens' words: the hold keeps its English, with those words and their language", async () => {
  const { memoryPlace, device, placeOn } = await import('./backup-kit.js');
  const { TargetError } = await import('../../src/core/storage-types.js');
  const place = memoryPlace();
  const d = await device(place);
  const id = await placeOn(d);
  setWords('ja', {});
  place.failNext(new TargetError('auth', 'The token was refused.', { shown: 'トークンが拒否されました。' }));
  await assert.rejects(d.backups.backUp(id), (e) => /** @type {any} */ (e).shown === 'トークンが拒否されました。' && /** @type {any} */ (e).message === 'The token was refused.');
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.deepEqual([hold.message, hold.said, hold.shown, hold.lang], ['The token was refused.', null, 'トークンが拒否されました。', 'ja']);
  // Words the same as its English (a plugin with no Japanese) are not kept twice.
  place.failNext(new TargetError('auth', 'The token was refused.', { shown: 'The token was refused.' }));
  await assert.rejects(d.backups.backUp(id));
  assert.equal('shown' in /** @type {any} */ ((await d.backups.get(id))?.hold), false);
});
