import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

// The details' labels in Japanese: one catalog per test file, set before the words are made.
setWords('ja', JSON.parse(await readFile(new URL('../../l10n/ja.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
const { bookingFacts } = await import('../../src/ui/format.js');

test('bookingFacts in ja: the labels are words, not keys', () => {
  const f = bookingFacts({ kind: 'flight', unsure: [], fields: { from: 'Seattle', to: 'Anchorage', seat: '14C', bags: 1, wifi: 'yes' }, confirmation: 'TESTQ1' });
  const labels = Object.fromEntries(f.map((x) => [x.key, x.label]));
  for (const key of ['route', 'seat', 'bags', 'confirmation']) assert.match(labels[key], /[぀-ヿ一-鿿]/, key);
  // A key annai has no words for is shown as written, marked English.
  assert.deepEqual([labels.wifi, f.find((x) => x.key === 'wifi')?.lang], ['wifi', 'en']);
});

test("bookingFacts in ja: a rental's `car` is its model, a train's is its coach, and on any other kind it is a car (the same key, labelled by the booking's kind)", () => {
  const label = (/** @type {string} */ kind) => bookingFacts({ kind, unsure: [], fields: { car: 'Compact' } }).find((x) => x.key === 'car')?.label;
  assert.equal(label('car'), '車種');
  assert.equal(label('rail'), '号車');
  for (const kind of ['flight', 'lodging', 'event', 'restaurant', 'other']) assert.equal(label(kind), '車', kind);
  // A booking with no kind at all is not a train either.
  assert.equal(bookingFacts({ unsure: [], fields: { car: 'Compact' } }).find((x) => x.key === 'car')?.label, '車');
});

test("bookingFacts in ja: a flight's legs are a line each, in the screens' words, each time as it is written with the day in Japanese and no zone note, never JSON (small-next, round 3: round 2 drew each time in the booking's format with 「（JST）」, which a leg's time never names)", () => {
  const TOKYO = 'Asia/Tokyo';
  const flights = [
    { flight: 'AN 1', origin: 'HND', destination: 'ITM', departure: '2026-11-20T07:30', arrival: '2026-11-20T09:10', tz: TOKYO },
    { flight: 'AN 2', origin: 'ITM', destination: 'NRT', departure: '2026-11-20T11:30', arrival: { at: '2026-11-22T13:05', tz: TOKYO }, gate: null, seat: ' ', terminal: '2' },
  ];
  const f = bookingFacts({ kind: 'flight', status: 'unverified', unsure: ['flights'], start: { at: '2026-11-20T07:30:00+09:00', tz: TOKYO }, end: { at: '2026-11-22T13:05:00+09:00', tz: TOKYO }, fields: { flights } });
  const legs = f.find((x) => x.key === 'flights');
  assert.equal(f.find((x) => x.key === 'start')?.value, '11月20日(金) 7:30（JST）', "the booking's own Departs keeps its zone");
  assert.equal(legs?.label, 'フライト');
  // The range's dash is held to the clock after it (U+2060); a leg that arrives another day is each time in full, joined by " – ".
  assert.deepEqual(legs?.value.split('\n'), [
    'AN 1 · HND → ITM · 11月20日 07:30–⁠09:10',
    'AN 2 · ITM → NRT · 11月20日 11:30 – 11月22日 13:05 · ターミナル：2',
  ]);
  assert.equal(legs?.unsure, true);
  // An object that is no leg: one line, each value with its key (annai's word where it has one).
  assert.equal(bookingFacts({ kind: 'flight', unsure: [], fields: { gate: { name: 'B', open: null, note: '混雑', bags: 2 } } })[0].value, 'name：B · note：混雑 · 手荷物：2');
});

test("bookingFacts in ja (booking-next): the keys of a booking's extras read as a Japanese airline's own page puts them, never the key as written; a leg time's airport and terminal sit in full-width brackets beside its clock; a train's and a ferry's times are 出発 and 到着", async () => {
  const { fileLine } = await import('../../src/ui/format.js');
  const f = bookingFacts({ kind: 'flight', unsure: [], fields: { bags: { checked: 2, carry_on: 1 }, meal: 'ベジタリアン', rooms: 1, total: '約12,000円', price: '1人6,000円', arrival: '大阪' } });
  assert.deepEqual(f.map((x) => [x.label, x.value, x.lang]), [
    ['手荷物', '預け入れ手荷物：2 · 機内持ち込み手荷物：1', undefined], ['食事', 'ベジタリアン', undefined], ['部屋数', '1', undefined],
    ['合計金額', '約12,000円', undefined], ['料金', '1人6,000円', undefined], ['到着地', '大阪', undefined],
  ]);
  assert.doesNotMatch(f.map((x) => x.label + x.value).join(), /checked|carry_on|meal|rooms|total|price|arrival/);
  const amadeus = { flight: 'NH 7', departure: { iataCode: 'SFO', terminal: 'I', at: '2026-11-20T11:05' }, arrival: { iataCode: 'NRT', terminal: '1', at: '2026-11-21T15:40' } };
  assert.equal(bookingFacts({ kind: 'flight', unsure: [], fields: { flights: [amadeus] } })[0].value, 'NH 7 · 11月20日 11:05（iataCode：SFO · ターミナル：I） – 11月21日 15:40（iataCode：NRT · ターミナル：1）');
  // A name beside the heading's, saying something else: 名称, not "title".
  assert.deepEqual(bookingFacts({ kind: 'lodging', unsure: [], title: 'ホテルX', fields: { title: 'ホテルX 別館' } }).map((x) => [x.label, x.lang]), [['名称', undefined]]);
  const at = { at: '2026-11-20T19:00:00+09:00', tz: 'Asia/Tokyo' };
  for (const kind of ['rail', 'ferry', 'bus', 'coach']) assert.deepEqual(bookingFacts({ kind, unsure: [], start: at, end: at }).map((x) => x.label), ['出発', '到着'], kind);
  const b = (/** @type {string} */ k, /** @type {string} */ day) => ({ kind: /** @type {const} */ ('booking'), bookingKind: k, path: `/bookings/${k}${day}.json`, title: '', at: null, day });
  assert.equal(fileLine([b('ferry', '2026-11-20'), b('bus', '2026-11-21'), b('bus', '2026-11-22'), b('coach', '2026-11-22')]), 'フェリー1便 · バス2便 · 長距離バス1便');
});
