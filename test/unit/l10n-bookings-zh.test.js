// A booking's details on a Chinese screen (booking-next): one catalog per test file, set before the words are made.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setWords } from '../../src/core/l10n.js';

setWords('zh-Hans', JSON.parse(await readFile(new URL('../../l10n/zh-Hans.json', import.meta.url), 'utf8')));
after(() => setWords('en', null));
const { bookingFacts, fileLine } = await import('../../src/ui/format.js');

test("bookingFacts in zh-Hans: the keys of a booking's extras read as a Chinese airline's page puts them, never the key as written; a leg time's airport and terminal sit in full-width brackets beside its clock; a ferry's times are 出发 and 到达", () => {
  const f = bookingFacts({ kind: 'flight', unsure: [], fields: { bags: { checked: 2, carry_on: 1 }, meal: '素食', rooms: 1, total: '约 800 元', price: '每人 400 元' } });
  assert.deepEqual(f.map((x) => [x.label, x.value, x.lang]), [
    ['行李', '托运行李：2 · 手提行李：1', undefined], ['餐食', '素食', undefined], ['房间数', '1', undefined], ['总价', '约 800 元', undefined], ['价格', '每人 400 元', undefined],
  ]);
  const amadeus = { flight: 'CA 985', departure: { iataCode: 'SFO', terminal: 'I', at: '2026-11-20T11:05' }, arrival: { iataCode: 'PEK', terminal: '3', at: '2026-11-21T15:40' } };
  assert.match(bookingFacts({ kind: 'flight', unsure: [], fields: { flights: [amadeus] } })[0].value, /^CA 985 · 11月20日 11:05（iataCode：SFO · 航站楼：I） – 11月21日 15:40（iataCode：PEK · 航站楼：3）$/);
  const at = { at: '2026-11-20T19:00:00+08:00', tz: 'Asia/Shanghai' };
  for (const kind of ['rail', 'ferry', 'bus', 'coach']) assert.deepEqual(bookingFacts({ kind, unsure: [], start: at, end: at }).map((x) => x.label), ['出发', '到达'], kind);
  const b = (/** @type {string} */ k, /** @type {string} */ day) => ({ kind: /** @type {const} */ ('booking'), bookingKind: k, path: `/bookings/${k}${day}.json`, title: '', at: null, day });
  assert.equal(fileLine([b('ferry', '2026-11-20'), b('bus', '2026-11-21'), b('bus', '2026-11-22')]), '1 趟渡轮 · 2 趟巴士');
});
