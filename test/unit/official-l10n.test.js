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
  await checkPlugins(after, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(k.words(), ['/catalog/l10n/zh-Hans.json'], 'its words are current: only the list is asked for');
  assert.deepEqual(await k.kept(), [`/${ID}/l10n/zh-Hans.json`]);
  // Back to English: every translation goes, with no request.
  setWords('en', null);
  k.s.asked.length = 0;
  await checkPlugins(after, { fetch: k.s.fetch }, { address: false });
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
  // A language the catalog no longer has for it: its words go once the catalog says so.
  delete k.s.translations.ja[ID];
  await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
  assert.deepEqual(await k.kept(), []);
  assert.equal(says(), 'Low tide.');
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
    await checkPlugins(k.host, { fetch: k.s.fetch }, { address: false });
    assert.deepEqual(k.words(), screens === 'ja' ? ['/catalog/l10n/ja.json'] : [], 'the same bytes: nothing downloaded');
    assert.deepEqual(await k.kept(), screens === 'ja' ? [`/${ID}/l10n/ja.json`] : []);
  }
});
