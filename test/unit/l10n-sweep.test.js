import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

// The last sweep (localization L5h): errors annai writes in files no batch had listed. Under Japanese screens, what a model, the log or a
// hold keeps is annai's English (message, plain words), and the screens show the Japanese made from shown or from what was kept as data.

setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
const { officialPlugins, ensureProvided } = await import('../../src/core/llm/official.js');
const { PluginError } = await import('../../src/core/registry.js');
const { messageOf } = await import('../../src/ui/dom.js');
const { holdWords } = await import('../../src/core/backup.js');
const { readAnswer } = await import('../../src/core/storage-types.js');
const { SYS } = await import('../../src/core/scopes.js');
const { ProviderError } = await import('../../src/core/llm/contract.js');
const { failedText, whyOf, whyWords, AllFailedError } = await import('../../src/core/llm/fallback.js');
const { addressProblem, addressShown } = await import('../../src/core/llm/provider-desc.js');
const { pricesProblem, pricesShown } = await import('../../src/core/llm/cost.js');
const { answerJSON } = await import('../../src/core/answer.js');
const { partWords, failWords } = await import('../../src/core/pack/download.js');
const { memoryPlace, device } = await import('./backup-kit.js');

const KANA = /[぀-ヿ一-鿿]/;
const offline = async () => { throw new TypeError('Failed to fetch'); };

test("official.js's refusals keep annai's English in message, and the screens' words in shown", async () => {
  const e = await officialPlugins({ fetch: offline }).catch((x) => x);
  assert.ok(e instanceof PluginError);
  assert.match(e.message, /^catalog: annai's list of plugins couldn't be loaded\./);
  assert.doesNotMatch(e.message, KANA);
  assert.match(messageOf(e), KANA);
  const unknown = await ensureProvided(/** @type {any} */ ({ registry: { list: () => [], owner: () => undefined }, builtins: new Map(), installed: async () => ({}) }),
    'storage-type', 'nowhere', { fetch: async () => new Response(JSON.stringify({ plugins: [] })) }).catch((x) => x);
  assert.match(unknown.message, /isn't a kind of backup place annai knows/);
  assert.equal(messageOf(unknown), 'annai が知らない種類のバックアップ先です。それを提供するプラグインをインストールしてください。');
});

test("an official plugin's refusal met while backing up: the hold and backup.error keep English, the screen shows Japanese", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  place.failNext(await officialPlugins({ fetch: offline }).catch((x) => x));
  const e = await d.backups.backUp(id).catch((x) => x);
  assert.doesNotMatch(e.message, KANA);
  assert.match(messageOf(e), KANA, 'the screen shows its words');
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.equal(hold.kind, 'error');
  assert.doesNotMatch(hold.message, KANA, 'the hold travels in backups: English');
  const [logged] = await d.store.tx(['events'], 'readonly', (t) => t.listEvents(SYS, { types: ['backup.error'] }));
  assert.doesNotMatch(logged.data.message, KANA);
});

test("a server's answer a storage plugin can't read: the hold keeps what it was, and its card says it in Japanese", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  place.failNext(await readAnswer(new Response('{not json'), 'json', 'the bucket').catch((x) => x));
  await d.backups.backUp(id).catch(() => {});
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.equal(hold.message, "the bucket answered something annai can't read. annai tries again later.");
  assert.deepEqual(hold.said, { code: 'unreadable', name: 'the bucket' });
  assert.equal(holdWords(hold), 'the bucket から annai が読めない応答が届きました。annai はあとでもう一度試します。');
});

test("a provider error annai writes keeps what it was: a card makes Japanese from it, a model and the log read English", () => {
  const gone = new ProviderError('not-found', 'That model no longer exists.', { said: { code: 'model-gone' } });
  assert.equal(messageOf(gone), 'そのモデルはもうありません。');
  const why = whyOf(new AllFailedError([{ model: 'm1', name: 'Haiku', outcome: gone.kind, ms: 0, error: gone.message, said: gone.said }]));
  assert.deepEqual(JSON.parse(JSON.stringify(why)).attempts[0].said, { code: 'model-gone' }, 'the event keeps data');
  assert.equal(whyWords(why), 'Haiku：そのモデルはもうありません。');
  assert.equal(whyWords(why, true), 'Haiku: That model no longer exists.');
  // A provider's own words stay as given; an attempt kept before L5h (no said) shows what it kept.
  assert.equal(failedText([{ name: 'Haiku', outcome: 'server', error: 'Internal error' }]), 'Haiku：Internal error.');
});

test("a typed address, prices and a server's answer: the screens' words, and English for a description's errors and the log", async () => {
  assert.equal(addressProblem('example.com'), "example.com isn't a web address: give it with https:// in front.");
  assert.equal(addressShown('example.com'), 'example.com は Web アドレスではありません：先頭に https:// を付けてください。');
  assert.equal(addressShown('https://example.com'), null);
  assert.equal(pricesProblem({ input: -1 }), 'input is not a price: it is a number, not below 0.');
  assert.equal(pricesShown({ input: -1 }), 'input は料金ではありません：0 以上の数値にしてください。');
  const e = await answerJSON(new Response('nope', { status: 503 }), 'en.wikipedia.org').catch((x) => x);
  assert.equal(e.message, 'en.wikipedia.org answered 503.');
  assert.equal(messageOf(e), 'en.wikipedia.org が 503 を返しました。');
});

test("an offline pack's failure: which part and why, in Japanese from the data it keeps", () => {
  assert.equal(partWords({ source: 'osm', place: { how: 'between', names: ['Bixby', 'Nepenthe'] } }), 'Bixby と Nepenthe のあいだの OpenStreetMap');
  assert.equal(failWords({ code: 'osm', inner: { code: 'status', where: 'overpass.example', status: 504 }, message: 'x' }), 'OpenStreetMap が応答しませんでした（overpass.example が 504 を返しました）。');
});
