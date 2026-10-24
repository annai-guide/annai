import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { setWords, key } from '../../src/core/l10n.js';
import { stampCount } from '../../src/core/after/stamps.js';
import { backupText } from '../../src/ui/format.js';
import { LANGUAGE_WORDS as W } from '../../src/core/languages.js';
import { packWords } from '../../src/ui/offline-pack.js';

// The first areas spoken through t (localization L1): the Trips screen's helpers and the Languages section's words. Their English
// is what the app showed before; with words set, each message is translated whole.

beforeEach(() => setWords('en', null));
after(() => setWords('en', null));

test('stampCount is a plural: English as before, with the number formatted', () => {
  assert.deepEqual([0, 1, 2, 1000].map(stampCount), ['0 stamps', '1 stamp', '2 stamps', '1,000 stamps']);
  setWords('ja', { [key('# stamp\0# stamps')]: { other: 'スタンプ#個' } });
  assert.equal(stampCount(1), 'スタンプ1個');
  assert.equal(stampCount(3), 'スタンプ3個');
});

test('backupText is three whole messages, so a translation can put the time where its language does', () => {
  const now = Date.UTC(2026, 10, 25);
  const twoDays = now - 2 * 86400_000;
  assert.equal(backupText({ at: null, changed: false }, now), 'not backed up');
  assert.equal(backupText({ at: twoDays, changed: false }, now), 'backed up 2 days ago');
  assert.equal(backupText({ at: twoDays, changed: true }, now), 'backed up 2 days ago, changed since');
  setWords('ja', {
    [key('not backed up')]: '未バックアップ',
    [key('backed up {0}')]: '{0}にバックアップ済み',
    [key('backed up {0}, changed since')]: '{0}にバックアップ済み、その後に変更あり',
  });
  assert.equal(backupText({ at: null, changed: true }, now), '未バックアップ');
  assert.equal(backupText({ at: twoDays, changed: false }, now), '一昨日にバックアップ済み');
  assert.equal(backupText({ at: twoDays, changed: true }, now), '一昨日にバックアップ済み、その後に変更あり');
});

test('the Languages section\'s statuses are whole messages, each with its saved form; the English reads as before', () => {
  assert.deepEqual(W.added('Japanese'), ['Added Japanese', 'Added Japanese. Saved']);
  assert.deepEqual(W.moved('Japanese', 2), ['Japanese moved to 2', 'Japanese moved to 2. Saved']);
  assert.deepEqual(W.removed('Japanese'), ['Japanese removed', 'Japanese removed. Saved']);
  assert.deepEqual(W.removedAnswer('Japanese'), [
    'Japanese removed; Shiori answers in the language you speak to her again',
    'Japanese removed; Shiori answers in the language you speak to her again. Saved',
  ]);
  assert.deepEqual(W.answered('Japanese'), ['Shiori answers in Japanese', 'Shiori answers in Japanese. Saved']);
  assert.deepEqual(W.answeredFollow(), ['Shiori answers in the language you speak to her', 'Shiori answers in the language you speak to her. Saved']);
  assert.equal(W.removeLabel('Japanese'), 'Remove Japanese');
  assert.equal(W.moveUpLabel('Japanese'), 'Move Japanese up');
  assert.equal(W.moveDownLabel('Japanese'), 'Move Japanese down');
  assert.equal(W.option('Japanese', '日本語'), 'Japanese · 日本語');
});

test('a translated status reorders its values, and the saved form is its own message', () => {
  setWords('ja', {
    [key('{0} moved to {1}')]: '{0}を{1}番目に移動しました',
    [key('{0} moved to {1}. Saved')]: '{0}を{1}番目に移動し、保存しました',
  });
  assert.deepEqual(W.moved('日本語', 2), ['日本語を2番目に移動しました', '日本語を2番目に移動し、保存しました']);
});

test('the offline pack\'s counts are a list in the screens\' language: commas in English, 、 in Japanese', () => {
  const manifest = { at: '', bytes: 1_300_000, places: 1200, summaries: 40, files: [], guides: [{ title: 'Big Sur' }], failed: [], full: false, stopped: false };
  const pack = /** @type {any} */ ({ stops: 2, cut: 0, why: null, estimate: 0, running: null, manifest });
  assert.match(packWords(pack, 'wifi').lines[0], / · 1,200 places, 40 Wikipedia summaries, 1 Wikivoyage guide\.$/);
  setWords('ja', {
    [key('# place\0# places')]: { other: '#か所' },
    [key('# Wikipedia summary\0# Wikipedia summaries')]: { other: 'Wikipedia の要約#件' },
    [key('# Wikivoyage guide\0# Wikivoyage guides')]: { other: 'Wikivoyage のガイド#件' },
  });
  assert.match(packWords(pack, 'wifi').lines[0], / · 1,200か所、Wikipedia の要約40件、Wikivoyage のガイド1件\.$/);
});
