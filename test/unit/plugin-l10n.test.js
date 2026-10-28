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

test("a translation that fails a check is left out, saying why in a developer's line; the plugin installs all the same (fail working)", async () => {
  /** @type {[Map<string, Uint8Array>, RegExp][]} */
  const cases = [
    [pkg(TIDES({ l10n: ['ja_JP'] })), /"ja_JP" isn't a language tag/],
    [pkg(TIDES(), null), /l10n\/ja\.json, listed in l10n, is missing/],
    [pkg(TIDES(), '{ not json'), /l10n\/ja\.json is not valid JSON/],
    [pkg(TIDES(), JSON.stringify({ messages: { a: 'x'.repeat(L10N_MAX_BYTES) } })), /larger than 256 KiB/],
    [pkg(TIDES(), '[]'), /object with only manifest and messages/],
    [pkg(TIDES(), { ...JA, extra: {} }), /object with only manifest and messages/],
    [pkg(TIDES(), { manifest: { version: '2' } }), /translates version, which isn't a field a translation may give/],
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
    const p = await inspectPackage(f);
    assert.equal(p.id, 'acme-tides', String(why));
    assert.equal(p.left.length, 1, String(why));
    assert.match(p.left[0].why, why);
  }
  // Left out at use too: a stored package's bad translation shows its own words.
  setWords('ja', {});
  const bad = new TextEncoder().encode(JSON.stringify({ messages: { a: { one: '潮', other: '潮' } } }));
  assert.equal(wordsOf(TIDES(), () => bad).lang, 'en');
  // The list is part of the manifest: more than 50 is refused, and a language that is no tag at all.
  await assert.rejects(inspectPackage(pkg(TIDES({ l10n: Array.from({ length: 51 }, (_, i) => `x-${i}`) }))), /50/);
  assert.throws(() => checkManifest(TIDES({ language: 'en_US' })), /isn't a language tag/);
});

test('tags in another case are the same tag: "EN", "ja-jp" and "zh-hans" are accepted, and each file is read by its tag as written', async () => {
  const p = await inspectPackage(pkg(TIDES({ language: 'EN', l10n: ['ja-jp', 'ja-JP'] }), null).set('l10n/ja-jp.json', new TextEncoder().encode(JSON.stringify(JA))).set('l10n/ja-JP.json', new TextEncoder().encode(JSON.stringify(JA))));
  assert.deepEqual(p.left.map((x) => x.tag), ['ja-JP'], 'the same language twice: the second is left out');
  assert.equal(translationFor(TIDES({ l10n: ['zh-hans'] }), 'zh-Hans'), 'zh-hans');
  assert.equal(translationFor(TIDES({ language: 'EN', l10n: ['ja'] }), 'en'), null);
  setWords('zh-Hans', {});
  const zh = { manifest: { description: '你所在海岸的潮汐表。' } };
  const w = wordsOf(TIDES({ l10n: ['zh-hans'] }), (f) => (f === 'l10n/zh-hans.json' ? new TextEncoder().encode(JSON.stringify(zh)) : undefined));
  assert.equal(w.manifest.description, '你所在海岸的潮汐表。');
});

test("a third party's translated name is accepted and never shown: its name is as written in every language (decision 10)", async () => {
  const named = { manifest: { name: 'アクメ潮汐' } };
  const p = await inspectPackage(pkg(TIDES(), named));
  assert.deepEqual(p.left, []);
  assert.equal(p.name, 'Acme Tides');
  setWords('ja', {});
  const k = await hostKit();
  await k.host.install(pkg(TIDES(), named));
  assert.equal((await k.host.describe()).find((r) => r.id === 'acme-tides')?.name, 'Acme Tides');
});

test("an empty translation is no translation: the plugin's own words show", () => {
  setWords('ja', {});
  const w = wordsOver({ [key('Low tide.')]: '', [key('# tide\0# tides')]: { other: '' } });
  assert.equal(w.t`Low tide.`, 'Low tide.');
  assert.equal(w.plural(2, '# tide', '# tides'), '2 tides');
  const m = wordsOf(TIDES(), () => new TextEncoder().encode(JSON.stringify({ manifest: { description: '', keywords: [''] } }))).manifest;
  assert.equal(m.description, 'Tide tables for the coast you are on.');
  assert.deepEqual(m.keywords, ['tides']);
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
  k.host.connect({ notices: { card: (/** @type {any} */ c) => seen.push(c), toast: (/** @type {string} */ text, /** @type {{ lang: string }} */ o) => seen.push({ text, lang: o.lang }) } });
  await k.host.install(codePlugin('plain', "annai.ui.card({ title: 'Tides' }); annai.ui.toast('Low tide');"));
  setWords('ja', {});
  await k.host.start('plain');
  assert.deepEqual(seen.map((x) => x.lang), ['en', 'en']);
});

test('an address install brings the translations its manifest lists', async () => {
  const site = new Map([['https://x.example/p/annai-plugin.json', JSON.stringify(TIDES())], ['https://x.example/p/l10n/ja.json', JSON.stringify(JA)]]);
  const get = async (/** @type {string} */ url) => (site.has(url) ? new Response(site.get(url)) : new Response('', { status: 404 }));
  const got = await fetchPackage('https://x.example/p/annai-plugin.json', { fetch: get });
  assert.deepEqual([...got.keys()].sort(), ['annai-plugin.json', 'l10n/ja.json']);
  // A host without one of them installs all the same: it is left out.
  site.delete('https://x.example/p/l10n/ja.json');
  const without = await fetchPackage('https://x.example/p/annai-plugin.json', { fetch: get });
  assert.deepEqual([...without.keys()], ['annai-plugin.json']);
  assert.match((await inspectPackage(without)).left[0].why, /missing/);
  // A request that gets no answer (a network blip) is no answer that it isn't there: the install fails, to be tried again.
  site.set('https://x.example/p/l10n/ja.json', JSON.stringify(JA));
  const blip = async (/** @type {string} */ url) => { if (url.endsWith('/l10n/ja.json')) throw new TypeError('Failed to fetch'); return get(url); };
  // A file after the manifest is named: a 404 without CORS headers looks the same, and annai has just read the manifest from that site.
  await assert.rejects(fetchPackage('https://x.example/p/annai-plugin.json', { fetch: blip }), /annai couldn't read l10n\/ja.json from x.example, a file its annai-plugin.json names/);
  // A connection that drops mid-file is no answer either, and names the file too.
  const cut = async (/** @type {string} */ url) => {
    if (!url.endsWith('/l10n/ja.json')) return get(url);
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"messages":')); c.error(new TypeError('network error')); } }));
  };
  await assert.rejects(fetchPackage('https://x.example/p/annai-plugin.json', { fetch: cut }), /annai couldn't read l10n\/ja.json from x.example, a file its annai-plugin.json names/);
  // Only an answer that it isn't there (404, 410, or 403 as S3 says it) leaves it out; a busy site (503, 429) fails, as a blip does.
  for (const [status, out] of [[404, true], [410, true], [403, true], [503, false], [429, false], [500, false]]) {
    const answer = async (/** @type {string} */ url) => (url.endsWith('/l10n/ja.json') ? new Response('', { status: /** @type {number} */ (status) }) : get(url));
    const got = fetchPackage('https://x.example/p/annai-plugin.json', { fetch: answer });
    if (out) assert.deepEqual([...(await got).keys()], ['annai-plugin.json']);
    else await assert.rejects(got, new RegExp(`x.example answered ${status} for l10n/ja.json`));
  }
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

test("the catalog's words for the screens: none in English; an entry in their words, keywords added, or its English marked so", async () => {
  const { catalogWords, shownEntry } = await import('../../src/core/llm/official.js');
  /** @type {string[]} */
  const asked = [];
  const fetch = async (/** @type {string} */ url) => { asked.push(url); return new Response(JSON.stringify({ format: 1, plugins: { 'search-tavily': { description: 'AIエージェント向けのウェブ検索。', keywords: ['検索'] } } })); };
  assert.equal(await catalogWords({ fetch }), null);
  assert.deepEqual(asked, [], 'no download for English');
  setWords('ja', {});
  const words = await catalogWords({ fetch });
  assert.deepEqual(asked, ['/catalog/l10n/ja.json']);
  const entry = { id: 'search-tavily', name: 'Tavily Search', description: 'Web search made for AI agents.', keywords: ['Tavily'] };
  assert.deepEqual(shownEntry(entry, words), { ...entry, description: 'AIエージェント向けのウェブ検索。', keywords: ['Tavily', '検索'], lang: 'ja' });
  assert.equal(shownEntry({ ...entry, id: 'search-serper' }, words).lang, 'en');
  assert.equal(await catalogWords({ fetch: async () => new Response('', { status: 404 }) }), null, "words that can't be had: English");
});

test("annai.l10n.format is the four formats official plugins use, with the signatures docs/plugins.md gives", async () => {
  const k = await hostKit();
  await k.host.install(codePlugin('fmt', 'globalThis.__fmt = annai.l10n.format;'));
  await k.host.start('fmt');
  const f = /** @type {any} */ (globalThis).__fmt;
  assert.deepEqual(Object.keys(f).sort(), ['list', 'num', 'sentences', 'size']);
  assert.equal(f.num(1234.5), '1,234.5');
  assert.equal(f.num(0.25, { style: 'percent' }), '25%');
  assert.equal(f.size(2048), '2.0 kB');
  assert.equal(f.list(['a', 'b', 'c']), 'a, b, and c');
  assert.equal(f.list(['a', 'b'], 'or'), 'a or b');
  assert.equal(f.list(['a', 'b', 'c'], 'plain'), 'a, b, c');
  assert.equal(f.sentences('One.', '', 'Two.'), 'One. Two.');
});

test("an official plugin is named in the screens' words wherever it is named: Updates, its card, and what a plugin needs", async () => {
  const { officialName, officialPlugins } = await import('../../src/core/llm/official.js');
  const { offerWords } = await import('../../src/ui/plugin-updates.js');
  const { checkRequires } = await import('../../src/core/requires.js');
  setWords('ja', {});
  const served = new Map([['/catalog/l10n/ja.json', { format: 1, plugins: { 'remote-trace': { name: 'リモート記録（開発者向け）' } } }], ['/catalog/plugins.json', { format: 1, plugins: [] }]]);
  const fetch = async (/** @type {string} */ url) => new Response(JSON.stringify(served.get(url) ?? {}), { status: served.has(url) ? 200 : 404 });
  assert.equal(officialName('remote-trace', 'Remote trace (for developers)'), 'Remote trace (for developers)', 'before the catalog is read: its English');
  await officialPlugins({ fetch });
  assert.equal(officialName('remote-trace', 'Remote trace (for developers)'), 'リモート記録（開発者向け）');
  assert.match(offerWords({ id: 'remote-trace', name: 'Remote trace (for developers)', installed: '0.1.0', available: '0.2.0' }), /^リモート記録（開発者向け） 0\.1\.0 → 0\.2\.0$/);
  assert.equal(offerWords({ id: 'remote-trace', name: 'Their trace', installed: '1', available: '2', url: 'https://x.example/p' }), 'Their trace 1 → 2', "a third party's from an address: as written");
  const { waitingWords } = await import('../../src/ui/screens/settings.js');
  assert.match(String(waitingWords(false, [{ id: 'remote-trace', name: 'Remote trace (for developers)' }])), /リモート記録（開発者向け）/);
  const k = await hostKit();
  const entry = /** @type {any} */ ({ id: 'remote-trace', name: 'Remote trace (for developers)', version: '0.2.0', files: {} });
  await assert.rejects(checkRequires(k.host, [{ id: 'remote-trace', version: '^1' }], [entry], { who: 'Tides' }), (e) => /リモート記録（開発者向け）/.test(/** @type {any} */ (e).shown) && /Remote trace \(for developers\)/.test(/** @type {any} */ (e).message));
  // A catalog entry that isn't a model provider, named on the provider page's tap.
  const { installMissing } = await import('../../src/ui/provider-setup.js');
  await assert.rejects(installMissing({}, entry), /^Error: リモート記録（開発者向け） isn't a model provider/);
});

test("every place is named by its kind, as the screens name it: an old place and a new one alike, and a hold keeps only the kind (data, not words)", async () => {
  const { memoryPlace, device } = await import('./backup-kit.js');
  const { setTarget, getTarget } = await import('../../src/core/backup-targets.js');
  const { holdWords } = await import('../../src/core/backup.js');
  setWords('ja', {});
  const place = memoryPlace();
  // A kind named in the screens' words, as S3-compatible storage is: S3 互換ストレージ.
  Object.assign(place.type, { name: 'メモリー', stores: 'file' });
  const d = await device(place);
  const old = await d.backups.add('memory');
  await setTarget(d.ws, old, { name: 'Memory' }); // stored by an annai from before
  const id = await d.backups.add('memory');
  assert.deepEqual((await d.backups.list()).map((p) => p.name), ['メモリー', 'メモリー']);
  await setTarget(d.ws, id, { encrypt: true });
  await assert.rejects(d.backups.backUp(id), (e) => /メモリー/.test(/** @type {any} */ (e).shown) && !/メモリー/.test(/** @type {any} */ (e).message));
  const hold = /** @type {any} */ (await getTarget(d.ws, id))?.hold;
  assert.doesNotMatch(JSON.stringify(hold), /[\p{Script=Katakana}\p{Script=Han}]/u);
  assert.deepEqual(hold.said, { code: 'passphrase', type: 'memory' });
  const shown = /** @type {any} */ (await d.backups.get(id));
  assert.match(holdWords(shown.hold, shown.name), /メモリー/);
  setWords('en', null);
  assert.equal(holdWords(shown.hold, 'Memory'), 'Type the passphrase for the encrypted backups at Memory, then save.');
  // A hold from before, with a name in its said, shows by its kind too.
  assert.equal(holdWords({ ...shown.hold, said: { code: 'passphrase', name: 'S3-compatible storage' } }, 'Memory'), 'Type the passphrase for the encrypted backups at Memory, then save.');
});

test("a place whose plugin is installed but off is named by that plugin, not its id; annai's own by its own translation; the full-access warning names it", async () => {
  const { createBackups } = await import('../../src/core/backup.js');
  const { addTarget, setTargetSecret } = await import('../../src/core/backup-targets.js');
  const { keyNames } = await import('../../src/ui/screens/plugin-install.js');
  setWords('ja', {});
  const k = await hostKit();
  const place = (/** @type {string} */ id, /** @type {any} */ more = {}) => files({ 'annai-plugin.json': JSON.stringify({ id, name: 'Acme Vault', version: '1.0.0', api: 1, provides: { 'storage-type': [`${id}-kind`] }, ...more }) });
  await k.host.install(place('acme-vault'));
  const official = place('acme-own', { name: 'Own vault', l10n: ['ja'] });
  official.set('l10n/ja.json', new TextEncoder().encode(JSON.stringify({ manifest: { name: '自分の金庫' } })));
  await k.host.install(official, { source: 'official' });
  const backups = createBackups({ store: k.store, ws: k.ws, registry: k.registry, plugins: k.host, app: 'test', label: 'iPhone' });
  const a = await addTarget(k.ws, { type: 'acme-vault-kind' });
  const b = await addTarget(k.ws, { type: 'acme-own-kind' });
  assert.deepEqual((await backups.list()).map((p) => p.name), ['Acme Vault', '自分の金庫']);
  await setTargetSecret(k.store, a, { password: 'hunter2-hunter2' });
  assert.ok((await keyNames(k.host)).includes('Acme Vault'), 'the warning names the place by its kind');
  assert.ok(b);
});


test("an installed official plugin is named from its own translation on the device, running or off, with no request: pluginName", async () => {
  const { pluginName } = await import('../../src/core/llm/official.js');
  setWords('ja', {});
  const k = await hostKit();
  await k.host.install(pkg(TIDES({ entry: undefined }), { manifest: { name: 'アクメ潮汐' } }), { source: 'official' });
  const state = (await k.host.installed())['acme-tides'];
  assert.equal(await pluginName(k.host, state, 'acme-tides', 'Acme Tides'), 'アクメ潮汐', 'not running');
  await k.host.start('acme-tides');
  assert.equal(await pluginName(k.host, state, 'acme-tides', 'Acme Tides'), 'アクメ潮汐');
  assert.equal(await pluginName(k.host, { ...state, source: 'file' }, 'acme-tides', 'Acme Tides'), 'Acme Tides', "a third party's as written");
});

test("an update another plugin can't take names that plugin as the screens do: annai's own from its translation", async () => {
  const { refuseBreaking } = await import('../../src/core/requires.js');
  setWords('ja', {});
  const k = await hostKit();
  await k.host.install(pkg(TIDES({ entry: undefined, requires: [{ id: 'chat-completions', version: '^0' }] }), { manifest: { name: 'アクメ潮汐' } }), { source: 'official' });
  await assert.rejects(refuseBreaking(k.host, 'chat-completions', '1.0.0', 'Chat Completions'),
    (e) => /アクメ潮汐/.test(/** @type {any} */ (e).shown) && /Acme Tides/.test(/** @type {any} */ (e).message));
});

test("annai.l10n and helpers.addressShown are plugin API 2: annai runs API 1 and 2, refuses a newer one by its number, and each official plugin whose code uses them says API 2", async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const base = { id: 'acme-tides', name: 'Acme Tides', version: '1.0.0' };
  checkManifest({ ...base, api: 1 });
  checkManifest({ ...base, api: 2 });
  assert.throws(() => checkManifest({ ...base, api: 3 }), /was made for plugin API 3; this version of annai supports API 2 and older/);
  const root = new URL('../../plugins-official/', import.meta.url);
  for (const id of await readdir(root)) {
    const manifest = JSON.parse(await readFile(new URL(`${id}/annai-plugin.json`, root), 'utf8'));
    const code = (await readdir(new URL(`${id}/`, root), { recursive: true })).filter((f) => f.endsWith('.js'));
    const reads = (await Promise.all(code.map((f) => readFile(new URL(`${id}/${f}`, root), 'utf8')))).some((s) => /\bl10n\b|\baddressShown\b/.test(s));
    assert.equal(manifest.api, reads ? 2 : 1, `${id}: an older annai refuses it by its API, in words, rather than run it without annai.l10n`);
  }
});
