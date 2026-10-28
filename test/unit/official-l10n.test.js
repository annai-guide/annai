import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, key } from '../../src/core/l10n.js';
import { SYS_PLUGINS } from '../../src/core/scopes.js';
import { utf8 } from '../../src/core/bytes.js';
import { installOfficial, updateOfficial, officialUpdates, fetchTranslations } from '../../src/core/llm/official.js';
import { addFromCatalog } from '../../src/core/requires.js';
import { checkPlugins } from '../../src/ui/plugin-updates.js';
import { hostKit } from './package-kit.js';
import { site } from './provider-kit.js';

// annai's own plugins carry no translations in their packages (plugin-l10n-fetch): a phone fetches its official plugins' words in the
// screens' language from beside the catalog, checked against the hash catalog/l10n/<tag>.json lists, and keeps them with the plugin.

afterEach(() => setWords('en', null));

const ID = 'tide-tables';
/** An official plugin whose code says its words when asked, as a running plugin makes words at the time it shows them. @param {string} [version] */
const TIDES = (version = '1.0.0') => ({
  'annai-plugin.json': JSON.stringify({ id: ID, name: 'Tide tables', version, api: 2, entry: 'index.js', description: 'Tide tables for the coast.' }),
  'index.js': 'export function activate(annai) { globalThis.tideSays = () => annai.l10n.t`Low tide.`; }',
});
const JA = { manifest: { description: '海岸の潮汐表。' }, messages: { [key('Low tide.')]: '干潮。' } };
const ZH = { manifest: { description: '海岸的潮汐表。' }, messages: { [key('Low tide.')]: '低潮。' } };
const says = () => /** @type {any} */ (globalThis).tideSays();

/** A device, annai's catalog with Japanese and Simplified Chinese words for the plugin, and what the device keeps of them. */
async function kit() {
  const k = await hostKit();
  const s = await site({ [ID]: TIDES() }, { ja: { [ID]: JA }, 'zh-Hans': { [ID]: ZH } });
  /** The translations kept with the plugin, by path. */
  const kept = async () => (await k.ws.list(SYS_PLUGINS, `/${ID}/l10n/`)).map((f) => f.path).sort();
  /** The requests for translations. */
  const words = () => s.asked.filter((p) => p.startsWith('/catalog/l10n/'));
  return { ...k, s, kept, words, entry: s.entries[0] };
}

test('installed under Japanese screens, an official plugin fetches its Japanese only, checked, and starts in it', async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  assert.deepEqual(k.words(), ['/catalog/l10n/ja.json', `/catalog/l10n/ja/${ID}.json`], 'its language only');
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  assert.equal(k.host.shownOf(ID).description, '海岸の潮汐表。');
  assert.equal(k.host.langOf(ID), 'ja');
  assert.equal(says(), '干潮。', 'its code speaks it from the start');
  assert.equal(await k.host.verifyOfficial(ID, k.entry), true);
  // Added from the catalog (the Add screen's way, with what it requires) it is fetched the same way.
  const other = await kit();
  await addFromCatalog(other.host, ID, { fetch: other.s.fetch });
  assert.deepEqual(other.words(), ['/catalog/l10n/ja.json', `/catalog/l10n/ja/${ID}.json`]);
  assert.equal(other.host.shownOf(ID).description, '海岸の潮汐表。');
  // Removing it removes its words too.
  await k.host.uninstall(ID);
  assert.deepEqual(await k.kept(), []);
});

test('an English phone fetches no translation, and keeps none', async () => {
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(k.words(), []);
  assert.deepEqual(await k.kept(), []);
  assert.equal(k.host.shownOf(ID).description, 'Tide tables for the coast.');
  assert.equal(k.host.langOf(ID), 'en');
  assert.equal(says(), 'Low tide.');
});

test("a language change fetches the new language's words before the restart; after it, the old one's are dropped and nothing is fetched again", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  k.s.asked.length = 0;
  // Settings → Languages, choosing 简体中文: fetched while the screens are still Japanese, which keep their words until the restart.
  await fetchTranslations(k.host, { tag: 'zh-Hans', fetch: k.s.fetch });
  assert.deepEqual(k.words(), ['/catalog/l10n/zh-Hans.json', `/catalog/l10n/zh-Hans/${ID}.json`]);
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`]);
  assert.equal(k.host.shownOf(ID).description, '海岸の潮汐表。');
  // The restart, in Chinese: it starts in Chinese, and the start's check drops the Japanese, with no download.
  setWords('zh-Hans', {});
  const after = k.relaunch();
  assert.deepEqual(await after.startInstalled(), []);
  assert.equal(after.shownOf(ID).description, '海岸的潮汐表。');
  assert.equal(says(), '低潮。');
  k.s.asked.length = 0;
  await checkPlugins(after, { fetch: k.s.fetch, next: () => 'zh-Hans' }, { address: false });
  assert.deepEqual(k.words(), ['/catalog/l10n/zh-Hans.json'], 'its words are current: only the list is asked for');
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/zh-Hans.json`]);
  // Back to English: every translation goes, with no request.
  setWords('en', null);
  k.s.asked.length = 0;
  await checkPlugins(after, { fetch: k.s.fetch, next: () => 'en' }, { address: false });
  assert.deepEqual(k.words(), []);
  assert.deepEqual(await k.kept(), []);
});

test("a translation whose hash changes in the catalog is fetched alone, at the next check: no update is offered, nothing restarts, and the running plugin speaks it", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  k.s.translations.ja[ID] = { manifest: { description: '海岸の潮見表。' }, messages: { [key('Low tide.')]: '干潮です。' } };
  k.s.asked.length = 0;
  const { found, failed } = await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(found, [], 'no update');
  assert.deepEqual(failed, []);
  assert.deepEqual([...k.s.asked].sort(), ['/catalog/l10n/ja.json', `/catalog/l10n/ja/${ID}.json`, '/catalog/plugins.json'], 'that one file, and no package file');
  assert.equal(k.host.needsRestart(ID), false);
  assert.equal(k.host.shownOf(ID).description, '海岸の潮見表。');
  assert.equal(says(), '干潮です。', 'its code speaks the new words from now on');
  // A plugin annai's catalog no longer lists words for (one it retired) keeps those it has.
  delete k.s.translations.ja[ID];
  await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  assert.equal(says(), '干潮です。');
});

test('a translation that fails to come, or comes changed, leaves English and installs anyway; a later check gets it', async () => {
  setWords('ja', {});
  const k = await kit();
  k.s.failNext(`/catalog/l10n/ja/${ID}.json`);
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  assert.ok(k.host.active.has(ID), 'installed and started');
  assert.deepEqual(await k.kept(), []);
  assert.equal(k.host.langOf(ID), 'en', 'its English, marked so');
  assert.equal(k.host.shownOf(ID).description, 'Tide tables for the coast.');
  assert.equal(says(), 'Low tide.');
  // Other bytes than the catalog lists are never kept.
  k.s.tampered.add(`/catalog/l10n/ja/${ID}.json`);
  await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(await k.kept(), []);
  k.s.tampered.clear();
  await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  assert.equal(says(), '干潮。');
  // The catalog's list itself can't be had: the install goes on all the same.
  const other = await kit();
  other.s.failNext('/catalog/l10n/ja.json');
  await installOfficial(other.host, other.entry, { fetch: other.s.fetch });
  assert.ok(other.host.active.has(ID));
  // Offline, nothing changes: the words on the device stay.
  k.s.offline = true;
  await fetchTranslations(k.host, { fetch: k.s.fetch });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  assert.equal(k.host.shownOf(ID).description, '海岸の潮汐表。');
});

test("verifyOfficial counts only the package's own files: translations, any number, never make it look changed; an update keeps current words without fetching them", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  await k.ws.write(SYS_PLUGINS, `/${ID}/l10n/zh-Hant.json`, utf8('{}'), { author: 'system' });
  assert.equal(await k.host.verifyOfficial(ID, k.entry), true);
  assert.deepEqual(await officialUpdates(k.host, { fetch: k.s.fetch }), []);
  // A changed package file still shows.
  await k.ws.write(SYS_PLUGINS, `/${ID}/index.js`, 'export function activate() {}', { author: 'system' });
  assert.equal(await k.host.verifyOfficial(ID, k.entry), false);
  // A new version: the package is replaced, the Japanese it has is kept, and not downloaded again.
  const next = await site({ [ID]: TIDES('1.0.1') }, { ja: { [ID]: JA } });
  await updateOfficial(k.host, next.entries[0], { fetch: next.fetch });
  assert.ok(!next.asked.includes(`/catalog/l10n/ja/${ID}.json`));
  assert.ok(next.asked.includes('/catalog/l10n/ja.json'));
  assert.ok((await k.kept()).includes(`/${ID}/l10n/ja.json`));
  assert.equal(await k.host.verifyOfficial(ID, next.entries[0]), true);
  // Files under l10n/ handed to an official install (a rollback hands back what was stored) are not its package.
  const files = new Map(Object.entries(TIDES('1.0.1')).map(([n, x]) => [n, utf8(x)]));
  files.set('l10n/ko.json', utf8('{}'));
  await k.host.install(files, { source: 'official' });
  assert.ok(!(await k.kept()).includes(`/${ID}/l10n/ko.json`));
});

test('a device whose official plugins carry every language in their packages (before this change) keeps only the screens\' language, and downloads nothing it has', async () => {
  for (const screens of ['ja', 'en']) {
    if (screens === 'ja') setWords('ja', {});
    else setWords('en', null);
    const k = await kit();
    // As an older annai installed it: the package with its translations, its manifest listing them.
    const old = { ...TIDES(), 'annai-plugin.json': JSON.stringify({ ...JSON.parse(TIDES()['annai-plugin.json']), l10n: ['ja', 'zh-Hans'] }) };
    await k.ws.writeMany(SYS_PLUGINS, [
      ...Object.entries(old).map(([n, x]) => ({ path: `/${ID}/${n}`, content: utf8(x) })),
      { path: `/${ID}/l10n/ja.json`, content: utf8(JSON.stringify(JA)) }, { path: `/${ID}/l10n/zh-Hans.json`, content: utf8(JSON.stringify(ZH)) },
      { path: '/installed.json', content: { [ID]: { version: '0.9.0', name: 'Tide tables', enabled: true, installed: 1, source: 'official' } } },
    ], { author: 'system' });
    assert.deepEqual(await k.host.startInstalled(), []);
    assert.equal(k.host.shownOf(ID).description, screens === 'ja' ? '海岸の潮汐表。' : 'Tide tables for the coast.');
    await checkPlugins(k.host, { fetch: k.s.fetch, next: () => screens }, { address: false });
    assert.deepEqual(k.words(), screens === 'ja' ? ['/catalog/l10n/ja.json'] : [], 'the same bytes: nothing downloaded');
    assert.deepEqual(await k.kept(), screens === 'ja' ? [`/${ID}/l10n/ja.json`] : []);
  }
});

// The fix pass on the review (plugin-l10n-fetch): skew between the installed version and the catalog's, the language the next start
// opens in, a card's language mark, and one request for the language's catalog.

const DEPTH = { type: 'object', properties: { depth: { type: 'string', title: 'Depth' } } };
/** The plugin's next version, which adds a setting whose title is translated. */
const NEXT = () => ({ ...TIDES('1.1.0'), 'annai-plugin.json': JSON.stringify({ ...JSON.parse(TIDES()['annai-plugin.json']), version: '1.1.0', settings: DEPTH }) });
const JA_NEXT = { manifest: { ...JA.manifest, 'settings.properties.depth.title': '水深' }, messages: JA.messages };

test("words made for another version of annai's own plugin still give every field this version has; a field it hasn't is skipped", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  // The next version's words, kept with this one (an update whose own fetch failed leaves the reverse: old words, new manifest).
  await k.host.keepTranslations(ID, new Map([['ja', utf8(JSON.stringify(JA_NEXT))]]));
  assert.equal(k.host.shownOf(ID).description, '海岸の潮汐表。');
  assert.equal(says(), '干潮。');
  assert.equal(k.host.langOf(ID), 'ja');
  // A third party's translation that names a field its manifest hasn't is still left out whole, as L7 has it.
  const { wordsOf } = await import('../../src/core/packages.js');
  const m = JSON.parse(TIDES()['annai-plugin.json']);
  assert.equal(wordsOf({ ...m, l10n: ['ja'] }, () => utf8(JSON.stringify(JA_NEXT))).lang, 'en');
});

test("a plugin with an update waiting keeps its words at a check; the update brings the new version's", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  const next = await site({ [ID]: NEXT() }, { ja: { [ID]: JA_NEXT } });
  const { found } = await checkPlugins(k.host, { fetch: next.fetch, next: () => 'ja' }, { address: false });
  assert.deepEqual(found.map((u) => u.available), ['1.1.0']);
  assert.ok(!next.asked.includes(`/catalog/l10n/ja/${ID}.json`), 'its words stay as they are');
  assert.equal(says(), '干潮。');
  await updateOfficial(k.host, next.entries[0], { fetch: next.fetch });
  assert.ok(next.asked.includes(`/catalog/l10n/ja/${ID}.json`));
  const after = k.relaunch();
  await after.startInstalled();
  assert.equal(after.shownOf(ID).settings.properties.depth.title, '水深');
});

test('a plugin with an update waiting and no words kept gets the catalog\'s: the fields its version has show', async () => {
  setWords('ja', {});
  const k = await kit();
  k.s.failNext(`/catalog/l10n/ja/${ID}.json`);
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  const next = await site({ [ID]: NEXT() }, { ja: { [ID]: JA_NEXT } });
  await checkPlugins(k.host, { fetch: next.fetch, next: () => 'ja' }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  assert.equal(k.host.shownOf(ID).description, '海岸の潮汐表。');
});

test("the language the next start opens in is kept, and fetched when missing: after Don't restart, and when the screens' words failed", async () => {
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  await fetchTranslations(k.host, { tag: 'zh-Hans', next: 'zh-Hans', fetch: k.s.fetch });
  // Don't restart: the screens stay Japanese, and a check later in this run keeps the Chinese the next start uses.
  await checkPlugins(k.host, { fetch: k.s.fetch, next: () => 'zh-Hans' }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`]);
  setWords('zh-Hans', {});
  k.s.asked.length = 0;
  const after = k.relaunch();
  await after.startInstalled();
  assert.equal(after.shownOf(ID).description, '海岸的潮汐表。');
  // The screens' words failed to load, so this run is English; the saved choice, Japanese, is what the next start uses.
  setWords('en', null);
  await checkPlugins(after, { fetch: k.s.fetch, next: () => 'ja' }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`], 'Japanese kept (fetched again had it gone), the rest dropped');
  await k.ws.writeMany(SYS_PLUGINS, [{ path: `/${ID}/l10n/ja.json`, content: null }], { author: 'system' });
  await checkPlugins(after, { fetch: k.s.fetch, next: () => 'ja' }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`]);
  // An install knows nothing of the next start: it fetches, and drops nothing.
  setWords('ja', {});
  await fetchTranslations(after, { tag: 'zh-Hans', fetch: k.s.fetch });
  await fetchTranslations(after, { fetch: k.s.fetch, ids: [ID] });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`]);
});

test('a card or a toast a plugin shows carries the language its words are in now, not at its start', async () => {
  setWords('ja', {});
  const k = await kit();
  const files = { ...TIDES(), 'index.js': 'export function activate(annai) { globalThis.tideToast = () => annai.ui.toast(annai.l10n.t`Low tide.`); }' };
  const s = await site({ [ID]: files }, { ja: { [ID]: JA } });
  /** @type {[string, string | undefined][]} */
  const toasts = [];
  k.host.connect({ notices: { toast: (/** @type {string} */ text, /** @type {any} */ o) => toasts.push([text, o?.lang]), card: () => {} } });
  s.failNext(`/catalog/l10n/ja/${ID}.json`);
  await installOfficial(k.host, s.entries[0], { fetch: s.fetch });
  /** @type {any} */ (globalThis).tideToast();
  await checkPlugins(k.host, { fetch: s.fetch }, { address: false });
  /** @type {any} */ (globalThis).tideToast();
  assert.deepEqual(toasts, [['Low tide.', 'en'], ['干潮。', 'ja']]);
});

// Fix round 2 (plugin-l10n-fetch): the env annai gives Updates holds next as a function, and a language change takes a while.

test("an Update tap, through the card and the env annai gives Updates, keeps every language kept and asks only for language files", async () => {
  const { offerCard } = await import('../../src/ui/plugin-updates.js');
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  await fetchTranslations(k.host, { tag: 'zh-Hans', next: 'zh-Hans', fetch: k.s.fetch });
  const next = await site({ [ID]: NEXT() }, { ja: { [ID]: JA_NEXT }, 'zh-Hans': { [ID]: ZH } });
  // As main.js builds it: next is a function (nextScreens); Updates spreads the env into the card's (updates.js).
  const env = { fetch: next.fetch, next: () => 'zh-Hans' };
  const { found } = await checkPlugins(k.host, env, { address: false });
  /** @type {any[]} */
  const cards = [];
  const ctx = { plugins: k.host, notices: { card: (/** @type {any} */ c) => { cards.push(c); return () => {}; }, toast: () => {} } };
  const applied = new Promise((resolve) => { offerCard(ctx, found, { ...env, reload: () => {}, applied: () => resolve(undefined) }); });
  cards[0].actions[0].run();
  await applied;
  assert.equal((await k.host.installed())[ID].version, '1.1.0');
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`], "the next start's language survives the tap");
  const words = next.asked.filter((p) => p.startsWith('/catalog/l10n/'));
  assert.ok(words.length > 0);
  assert.deepEqual(words.filter((p) => !/^\/catalog\/l10n\/(ja|zh-Hans|zh-Hant)(\/[a-z0-9-]+)?\.json$/.test(p)), [], 'no address made from anything but a language');
});

test("while Settings changes the screens' language, a check keeps the words fetched for it, until the choice is kept or the change fails", async () => {
  const { changingScreens, nextScreens } = await import('../../src/ui/languages.js');
  setWords('ja', {});
  const k = await kit();
  await installOfficial(k.host, k.entry, { fetch: k.s.fetch });
  const before = nextScreens();
  const done = changingScreens('zh-Hans');
  assert.equal(nextScreens(), 'zh-Hans');
  // As Settings fetches: no next, so it drops nothing while the change may yet fail.
  await fetchTranslations(k.host, { tag: 'zh-Hans', fetch: k.s.fetch });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`]);
  // A check comes back meanwhile (coming back to the screen, the day's, a slow start's), with the env annai gives it.
  await checkPlugins(k.host, { fetch: k.s.fetch, next: nextScreens }, { address: false });
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/ja.json`, `/${ID}/l10n/zh-Hans.json`]);
  // A second change to the same language while the first runs: the first one's end leaves the second's mark.
  const again = changingScreens('zh-Hans');
  done();
  assert.equal(nextScreens(), 'zh-Hans', "the second change's mark outlives the first's end");
  again();
  assert.equal(nextScreens(), before, 'over: the device\'s copy of the choice says again');
});
