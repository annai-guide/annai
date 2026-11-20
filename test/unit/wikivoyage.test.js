import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingOrder, LANGUAGES } from '../../src/core/languages.js';
import { editionsOf, guideEditions, voyageApi, editionName, wikimediaTurn, isWikimedia, WIKIMEDIA_AT_ONCE } from '../../src/core/wiki.js';

/** The app settings with a list chosen. @param {string[]} spoken */
const speaks = (spoken) => ({ languages: { spoken, answer: 'follow' } });
const guides = (/** @type {string[]} */ spoken, locale = 'en-US') => guideEditions(editionsOf(readingOrder(speaks(spoken), locale)));

test("Wikivoyage's editions: English and each listed language's that has one, in the reading order; both Chinese rows read zh; a language without one is never asked", () => {
  assert.deepEqual(guides(['ko']), ['en'], 'Korean has no Wikivoyage');
  assert.deepEqual(guides(['zh-Hant']), ['zh', 'en']);
  assert.deepEqual(guides(['zh', 'zh-Hant', 'ja']), ['zh', 'ja', 'en']);
  assert.deepEqual(guides(['yue', 'fil', 'de']), ['de', 'en'], 'no Cantonese or Filipino Wikivoyage');
  assert.deepEqual(guides(['en', 'ja']), ['en', 'ja']);
  assert.deepEqual(guideEditions(editionsOf(readingOrder({}, 'et-EE'))), ['en'], 'a phone language annai does not list reads English');
  // The 24 hosts that 25 of annai's 42 languages read (Wikimedia's sitematrix, 2026-11-20), and the 17 without.
  const every = guideEditions(editionsOf(LANGUAGES));
  assert.deepEqual([...every].sort(), ['bn', 'cs', 'de', 'el', 'en', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'id', 'it', 'ja', 'nl', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'vi', 'zh']);
  const none = LANGUAGES.filter((l) => !every.includes(editionsOf([l])[0])).map((l) => l.id);
  assert.deepEqual(none, ['yue', 'ko', 'sk', 'hu', 'bg', 'hr', 'sr', 'sl', 'ar', 'ta', 'th', 'ms', 'fil', 'no', 'da', 'ca', 'sw']);
  assert.equal(voyageApi('ja'), 'https://ja.wikivoyage.org/w/api.php');
  assert.deepEqual(['en', 'ja', 'zh', 'de'].map(editionName), ['English', 'Japanese', 'Chinese', 'German']);
  // An edition's label the engine refuses (Intl.DisplayNames throws on zh-yue, in Node, Chromium and WebKit) is named by its language's row; a label with no row is itself.
  assert.deepEqual(['zh-yue', 'a'].map(editionName), ['Cantonese', 'a']);
});

/** Starts n jobs on url through the gate, each held until released; notes how many run at once. @param {string} url @param {number} n */
function hold(url, n) {
  let running = 0;
  let most = 0;
  /** @type {string[]} */
  const order = [];
  /** @type {(() => void)[]} */
  const release = [];
  const results = Array.from({ length: n }, (_, k) => wikimediaTurn(url, () => {
    running++;
    most = Math.max(most, running);
    order.push(`job ${k}`);
    return new Promise((resolve) => release.push(() => {
      running--;
      resolve(k);
    }));
  }));
  return { results, release, order, most: () => most, running: () => running };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('Wikimedia gets 3 requests at once from annai at most (its published rule), in the order asked: a fourth waits until one ends', async () => {
  assert.equal(WIKIMEDIA_AT_ONCE, 3);
  const h = hold('https://ja.wikipedia.org/w/api.php?action=query', 8);
  await tick();
  assert.deepEqual(h.order, ['job 0', 'job 1', 'job 2']);
  assert.equal(h.running(), 3);
  // Wikivoyage's hosts share the same turns, and Wikidata's (Wikimedia's too: the limit counts the client across its sites).
  let voyage = false;
  const v = wikimediaTurn('https://en.wikivoyage.org/w/api.php', async () => { voyage = true; return 'v'; });
  let data = false;
  const d = wikimediaTurn('https://www.wikidata.org/w/api.php?action=wbgetentities', async () => { data = true; return 'd'; });
  await tick();
  assert.equal(voyage, false, 'a Wikivoyage request waits too');
  assert.equal(data, false, 'a Wikidata request waits too');
  // Only Wikidata's own host: one that only looks like it is any other host's.
  assert.equal(isWikimedia('https://www.wikidata.org/w/api.php'), true);
  assert.equal(isWikimedia('https://query.wikidata.org/sparql'), false);
  assert.equal(isWikimedia('https://www.wikidata.org.example.com/w/api.php'), false);
  // One ends: the next in order starts, and a request asked at that moment takes no turn ahead of it.
  h.release.shift()?.();
  const late = wikimediaTurn('https://en.wikipedia.org/w/api.php', async () => 'late');
  await tick();
  assert.deepEqual(h.order, ['job 0', 'job 1', 'job 2', 'job 3']);
  assert.equal(h.running(), 3);
  while (h.release.length) {
    h.release.shift()?.();
    await tick();
    await tick();
  }
  assert.deepEqual(await Promise.all(h.results), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(await v, 'v');
  assert.equal(await d, 'd');
  assert.equal(await late, 'late');
  assert.equal(h.most(), 3, 'never a fourth');
});

test("a request waiting for its turn ends with its signal, and gives its turn up; a stopped job's turn passes on at once; another host's request never waits", async () => {
  const h = hold('https://zh.wikipedia.org/w/api.php', 3);
  await tick();
  const stop = new AbortController();
  let ran = false;
  const waiting = wikimediaTurn('https://zh.wikipedia.org/w/api.php', async () => { ran = true; }, stop.signal);
  stop.abort(new DOMException('No answer in time.', 'TimeoutError'));
  await assert.rejects(waiting, { name: 'TimeoutError' });
  assert.equal(ran, false);
  // Not Wikimedia: at once, whatever is waiting.
  assert.equal(await wikimediaTurn('https://overpass-api.de/api/interpreter', async () => 'osm'), 'osm');
  assert.equal(await wikimediaTurn('https://nominatim.openstreetmap.org/search', async () => 'nominatim'), 'nominatim');
  // A job whose signal aborts holds no turn, though it never settles (a fetch stopped is no request).
  const gone = new AbortController();
  const stuck = wikimediaTurn('https://zh.wikipedia.org/w/api.php', () => new Promise(() => {}), gone.signal);
  for (const r of h.release.splice(0)) r();
  await Promise.all(h.results);
  await tick();
  const more = hold('https://zh.wikipedia.org/w/api.php', 3);
  await tick();
  assert.deepEqual(more.order, ['job 0', 'job 1'], 'the stuck one still holds a turn');
  gone.abort();
  await tick();
  assert.deepEqual(more.order, ['job 0', 'job 1', 'job 2'], 'its signal gave it up');
  for (const r of more.release.splice(0)) r();
  assert.deepEqual(await Promise.all(more.results), [0, 1, 2]);
  void stuck;
});

test("a turn ended by its signal passes to the request waiting first, though another is asked in the same moment: never a fourth at once", async () => {
  const url = 'https://ja.wikivoyage.org/w/api.php';
  const stop = new AbortController();
  let running = 0;
  let most = 0;
  /** @type {string[]} */
  const order = [];
  /** @type {(() => void)[]} */
  const release = [];
  const job = (/** @type {string} */ name) => () => {
    running++;
    most = Math.max(most, running);
    order.push(name);
    return new Promise((resolve) => release.push(() => (running--, resolve(name))));
  };
  const first = wikimediaTurn(url, () => new Promise(() => {}), stop.signal); // a stopped fetch that never settles
  const held = [wikimediaTurn(url, job('b')), wikimediaTurn(url, job('c'))];
  const waiting = wikimediaTurn(url, job('waiting'));
  await tick();
  assert.deepEqual(order, ['b', 'c']);
  // Its signal ends the first turn, and a request is asked at once, before anything else runs.
  stop.abort();
  const later = wikimediaTurn(url, job('later'));
  await tick();
  assert.deepEqual(order, ['b', 'c', 'waiting'], 'the turn went to the one waiting');
  assert.equal(most, 2 + 1);
  for (const r of release.splice(0)) r();
  await tick();
  assert.deepEqual(order, ['b', 'c', 'waiting', 'later']);
  for (const r of release.splice(0)) r();
  assert.deepEqual(await Promise.all([...held, waiting, later]), ['b', 'c', 'waiting', 'later']);
  assert.ok(most <= 3);
  void first;
});
