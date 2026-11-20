// Opt-in: asks Wikipedia (three editions) and Nominatim one real question each, as nearby, geocode and reverse ask them in the traveller's
// languages (about eight requests, one at a time, a second apart; free services, so run it rarely). Notices an edition that stopped
// answering a web app's request (its CORS, the Api-User-Agent header annai names itself with) before a traveller does.
//   ANNAI_LIVE_PLACES=1 npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearUrl, articlesOf, merged, agentHeader } from '../../src/core/wiki.js';
import { nominatimLanguages } from '../../src/core/nominatim.js';
import { readingOrder } from '../../src/core/languages.js';

const skip = process.env.ANNAI_LIVE_PLACES ? false : 'ANNAI_LIVE_PLACES is not set';
const ORIGIN = 'https://annai.guide';
const KIYOMIZU = /** @type {[number, number]} */ ([34.9949, 135.785]);
const gap = () => new Promise((r) => setTimeout(r, 1100));

test("Wikipedia's editions answer nearby's query from annai's origin, with its header, and the same article in two editions is one by its Wikidata id (清水寺 and Kiyomizu-dera)", { skip }, async () => {
  /** @type {Record<string, any[]>} */
  const got = {};
  for (const e of ['ja', 'zh', 'en']) {
    // A browser asks first, at the request's own address (with origin=*, which Wikimedia's CORS answers), whether annai may send Api-User-Agent.
    const pre = await fetch(nearUrl(e, KIYOMIZU, 1000, 30), { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET', 'access-control-request-headers': 'api-user-agent' } });
    assert.ok(pre.status >= 200 && pre.status < 300, `${e}: preflight ${pre.status}`);
    assert.match(String(pre.headers.get('access-control-allow-headers')), /api-user-agent|\*/i, `${e}: Api-User-Agent allowed`);
    await gap();
    const res = await fetch(nearUrl(e, KIYOMIZU, 1000, 30), { headers: { ...agentHeader('0.0.0'), origin: ORIGIN } });
    assert.equal(res.status, 200, e);
    assert.match(String(res.headers.get('access-control-allow-origin')), /^\*$/, `${e}: the answer is readable from annai`);
    got[e] = articlesOf(await res.json(), e);
    assert.ok(got[e].length > 0 && got[e].every((a) => a.id && /^Q\d+$/.test(a.id)), `${e}: articles with Wikidata ids`);
    await gap();
  }
  const both = merged([...got.ja, ...got.en], ['ja', 'en']);
  assert.ok(both.length < got.ja.length + got.en.length, 'some articles are in both');
  // Japanese's 清水寺 and English's Kiyomizu-dera carry one id, Q221716: merged, it is the Japanese one.
  assert.ok(got.ja.some((a) => a.id === 'Q221716' && a.title === '清水寺') && got.en.some((a) => a.id === 'Q221716' && a.title === 'Kiyomizu-dera'), 'the same Wikidata item in both');
  assert.equal(both.filter((a) => a.id === 'Q221716').length, 1);
  assert.ok(both.some((a) => a.id === 'Q221716' && a.edition === 'ja'), '清水寺 is Kiyomizu-dera');
});

test('Nominatim names places in the languages it is sent, search and reverse', { skip }, async () => {
  const lang = nominatimLanguages(readingOrder({ languages: { spoken: ['ja'], answer: 'follow' } }, 'en-US'));
  // A browser names itself by its own User-Agent and annai's origin as the Referer (Nominatim's usage policy); Node's default is refused.
  const headers = { accept: 'application/json', origin: ORIGIN, referer: `${ORIGIN}/`, 'user-agent': 'annai/live-test (https://annai.guide)' };
  const found = await (await fetch(`https://nominatim.openstreetmap.org/search?q=Kiyomizu-dera&format=jsonv2&limit=5&extratags=1&accept-language=${encodeURIComponent(lang)}`, { headers })).json();
  assert.ok(Array.isArray(found) && found.some((f) => /清水寺/.test(f.display_name)), JSON.stringify(found).slice(0, 300));
  await gap();
  const here = await (await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${KIYOMIZU[0]}&lon=${KIYOMIZU[1]}&format=jsonv2&zoom=18&extratags=1&accept-language=${encodeURIComponent(lang)}`, { headers })).json();
  assert.match(String(here.display_name), /京都/);
});
