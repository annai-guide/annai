// A booking's details on a Traditional Chinese screen (booking-next fix 1): one catalog per test file, set before the words are made.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

setWords('zh-Hant', JSON.parse(await readFile(new URL('../../l10n/zh-Hant.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
const { bookingFacts, fileLine } = await import('../../src/ui/format.js');

test("bookingFacts in zh-Hant: the keys of a booking's extras read as a Taiwan airline's page puts them, never the key as written; a leg time's airport and terminal sit in full-width brackets beside its clock; a ferry's times are 出發 and 抵達", () => {
  const f = bookingFacts({ kind: 'flight', unsure: [], fields: { bags: { checked: 2, carry_on: 1 }, meal: '素食', rooms: 1, total: '約 800 元', price: '每人 400 元', arrival: '桃園機場' } });
  assert.deepEqual(f.map((x) => [x.label, x.value, x.lang]), [
    ['行李', '託運行李：2 · 手提行李：1', undefined], ['餐點', '素食', undefined], ['房間數', '1', undefined], ['總價', '約 800 元', undefined], ['價格', '每人 400 元', undefined],
    ['抵達', '桃園機場', undefined],
  ]);
  const amadeus = { flight: 'CI 5', departure: { iataCode: 'SFO', terminal: 'I', at: '2026-11-20T11:05' }, arrival: { iataCode: 'TPE', terminal: '2', at: '2026-11-21T15:40' } };
  assert.match(bookingFacts({ kind: 'flight', unsure: [], fields: { flights: [amadeus] } })[0].value, /^CI 5 · 11月20日 11:05（iataCode：SFO · 航廈：I） – 11月21日 15:40（iataCode：TPE · 航廈：2）$/);
  // A leg time's from, to and flight keep their labels too (booking-next fix 1: they were drawn as the leg's route and number).
  assert.match(bookingFacts({ kind: 'flight', unsure: [], fields: { flights: [{ flight: 'CI 5', departure: { at: '2026-11-20T11:05', from: '第二航廈' } }] } })[0].value, /^CI 5 · 11月20日 11:05（出發地：第二航廈）$/);
  const at = { at: '2026-11-20T19:00:00+08:00', tz: 'Asia/Taipei' };
  for (const kind of ['rail', 'ferry', 'bus', 'coach']) assert.deepEqual(bookingFacts({ kind, unsure: [], start: at, end: at }).map((x) => x.label), ['出發', '抵達'], kind);
  // A name beside the heading's, saying something else.
  assert.deepEqual(bookingFacts({ kind: 'lodging', unsure: [], title: '飯店X', fields: { title: '飯店X 別館' } }).map((x) => [x.label, x.lang]), [['名稱', undefined]]);
  const b = (/** @type {string} */ k, /** @type {string} */ day) => ({ kind: /** @type {const} */ ('booking'), bookingKind: k, path: `/bookings/${k}${day}.json`, title: '', at: null, day });
  assert.equal(fileLine([b('ferry', '2026-11-20'), b('bus', '2026-11-21'), b('bus', '2026-11-22'), b('coach', '2026-11-22')]), '1 趟渡輪 · 2 趟巴士 · 1 趟長途客運');
});
