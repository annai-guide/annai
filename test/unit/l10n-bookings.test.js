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
