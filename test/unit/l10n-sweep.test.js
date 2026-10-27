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
  assert.deepEqual(hold.said, { code: 'unreadable', where: 'the bucket' });
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

// Review 1: one said vocabulary for servers (answer.js), kept by holds and a pack's failures, and an export's failure (archive.js).
const { tracedFetch } = await import('../../src/core/agent/net.js');
const { downloadPack } = await import('../../src/core/pack/download.js');
const { packTrip } = await import('./pack-kit.js');
const down = async () => { throw new TypeError('Failed to fetch'); };

test("a storage plugin's server that can't be reached while the phone is online: the hold keeps what it was, and says it in Japanese", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  place.failNext(await tracedFetch(d.store, SYS, { tool: 'backup' }, down)('https://dav.example.com/x').catch((x) => x));
  await d.backups.backUp(id).catch(() => {});
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.equal(hold.message, "annai couldn't reach dav.example.com (Failed to fetch). Is the device offline?");
  assert.deepEqual(hold.said, { code: 'unreachable', where: 'dav.example.com', info: 'Failed to fetch' });
  assert.equal(holdWords(hold), 'annai は dav.example.com につながりませんでした（Failed to fetch）。この端末はオフラインですか？annai はあとでもう一度試します。');
});

test("an offline pack whose servers can't be reached: its failure keeps what it was, and the panel says it in Japanese", async () => {
  const { ws, trip } = await packTrip();
  const m = await downloadPack({ ws, scope: trip, fetch: tracedFetch(ws.store, trip, { tool: 'offline-pack' }, down), version: '9.9.9', gapMs: 0, busyMs: 1 });
  const [f] = m.failed;
  assert.equal(f.said?.code, 'osm');
  assert.deepEqual(/** @type {any} */ (f.said).inner, { code: 'unreachable', where: 'overpass.private.coffee', info: 'Failed to fetch' });
  assert.match(failWords(/** @type {any} */ (f.said)), /^OpenStreetMap が応答しませんでした（annai は overpass\.private\.coffee につながりませんでした（Failed to fetch）。この端末はオフラインですか？）。$/);
});

test("an export that fails while backing up: the hold keeps what it was in data, English in message, and its card says it in Japanese", async () => {
  const place = memoryPlace();
  const d = await device(place);
  const id = await d.backups.add('memory');
  await d.ws.write(d.trip, '/notes/a.md', 'Tea at four.', { author: 'user' });
  const hash = (await d.ws.read(d.trip, '/notes/a.md'))?.entry.hash;
  await d.store.tx(['blobs'], 'readwrite', (t) => t.deleteBlob(/** @type {string} */ (hash)));
  const e = await d.backups.backUp(id).catch((x) => x);
  assert.match(messageOf(e), /の内容がストレージにないため/);
  const hold = /** @type {any} */ ((await d.backups.get(id))?.hold);
  assert.equal(hold.message, 'The content of /notes/a.md is missing from storage.');
  assert.deepEqual(hold.said, { code: 'content-missing', path: '/notes/a.md' });
  assert.match(holdWords(hold), /^\/notes\/a\.md の内容がストレージにないため/);
});

test("a hold whose said this annai doesn't know is shown as an old hold, never as 'this device is offline'", async () => {
  const { oldHold } = await import('../../src/core/backup.js');
  const later = { kind: 'error', message: 'Something a later annai said.', said: { code: 'from-later' }, at: 1, count: 1, retryAt: 2, needsYou: false };
  assert.equal(oldHold(later), true);
  assert.equal(holdWords(/** @type {any} */ (later)), 'Something a later annai said.');
});

test("review 2: an ability its description doesn't name keeps the kind's English for models and the log; the screens name the kind", async () => {
  const { providerOf, abilityName } = await import('../../src/core/llm/config.js');
  const rec = /** @type {any} */ ({ id: 'p1', plugin: 'provider-x', template: { values: { name: 'X', abilities: { chat: { kind: 'chat', type: 'openai-chat' }, talk: { kind: 'chat', type: 'openai-chat', name: 'Talk' } } } }, user: {} });
  const { chat, talk } = providerOf(rec).abilities;
  assert.equal(chat.name, 'Chat', "what a model and the log read: annai's English");
  assert.equal(abilityName(chat), 'チャット');
  assert.equal(abilityName(talk), 'Talk', "a description's own name, as written");
});

test("review 3 and 4: a failed attempt's words come from what it was, in the Try panel's line, explain, and the Conversation's line", async () => {
  const { explain } = await import('../../src/core/llm/contract.js');
  const { attemptWhy } = await import('../../src/core/llm/fallback.js');
  const late = new ProviderError('timeout', 'No output started in time.', { said: { code: 'late' } });
  assert.equal(attemptWhy({ name: 'Haiku', outcome: late.kind, error: late.message, said: late.said }), '時間内に出力が始まりませんでした。');
  assert.equal(explain(late), '時間内に出力が始まりませんでした。');
  // A said set with no shown (resolve.js's, voice.js's): its own words, not a generic line.
  const formats = Object.assign(new ProviderError('bad-request', 'Haiku takes no audio format this phone makes (wav).'), { said: /** @type {any} */ ({ code: 'formats', name: 'Haiku', formats: ['wav'] }), shown: undefined });
  assert.equal(explain(formats), 'Haiku はこのスマートフォンで作れる音声形式を受け付けません（wav）。');
  const why = whyOf(late);
  assert.deepEqual(why.said, { code: 'late' }, 'the error event keeps what it was');
  assert.equal(whyWords(why), '時間内に出力が始まりませんでした。');
  assert.equal(whyWords(why, true), 'The model took too long to start answering.');
});

test("review 8: models held for a reload say so in the screens' words, from what it was, with no English matched", async () => {
  const { explain } = await import('../../src/core/llm/contract.js');
  const { attemptWhy } = await import('../../src/core/llm/fallback.js');
  const EN = "annai needs a reload: it opened without its offline service, so its plugins can't start.";
  const held = new ProviderError('type-missing', EN, { said: { code: 'held' } });
  assert.equal(held.message, EN);
  assert.match(explain(held), KANA);
  assert.match(attemptWhy({ name: 'Haiku', outcome: 'type-missing', error: EN, said: { code: 'held' } }), KANA);
  assert.equal(attemptWhy({ name: 'Haiku', outcome: 'type-missing', error: EN, said: { code: 'held' } }, { plain: true }), EN);
});
