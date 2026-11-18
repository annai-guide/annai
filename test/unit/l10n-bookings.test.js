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

test("bookingFacts in ja: a flight's legs are a line each, in the screens' words and the traveller's time format, never JSON (small-next, round 2)", () => {
  const TOKYO = 'Asia/Tokyo';
  const flights = [
    { flight: 'AN 1', origin: 'HND', destination: 'ITM', departure: '2026-11-20T07:30', arrival: '2026-11-20T09:10', tz: TOKYO },
    { flight: 'AN 2', origin: 'ITM', destination: 'NRT', departure: '2026-11-20T11:30', arrival: { at: '2026-11-20T13:05', tz: TOKYO }, gate: null, seat: ' ' },
  ];
  const f = bookingFacts({ kind: 'flight', status: 'unverified', unsure: ['flights'], start: { at: '2026-11-20T07:30:00+09:00', tz: TOKYO }, end: { at: '2026-11-20T13:05:00+09:00', tz: TOKYO }, fields: { flights } });
  const start = f.find((x) => x.key === 'start')?.value;
  const legs = f.find((x) => x.key === 'flights');
  assert.equal(start, '11月20日(金) 7:30（JST）');
  assert.equal(legs?.label, 'フライト');
  assert.deepEqual(legs?.value.split('\n'), [
    `AN 1 · HND → ITM · ${start} – 11月20日(金) 9:10（JST）`,
    'AN 2 · ITM → NRT · 11月20日(金) 11:30（JST） – 11月20日(金) 13:05（JST）',
  ]);
  assert.equal(legs?.unsure, true);
  // An object that is no leg: its values that are there, joined the Japanese way.
  assert.equal(bookingFacts({ kind: 'flight', unsure: [], fields: { gate: { name: 'B', open: null, note: '混雑' } } })[0].value, 'B、混雑');
});
