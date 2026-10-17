import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sentences, LONG } from '../../src/core/voice/sentences.js';

test('sentences come out as soon as they are complete, while the text streams in (spec §10.1)', () => {
  const s = new Sentences('en');
  const all = 'Bixby Bridge is two miles ahead. When it opened in 1932, it was tall! Want a stop?';
  assert.deepEqual(s.take('Bixby Bridge is two mi'), []);
  assert.deepEqual(s.take('Bixby Bridge is two miles ahead. When it op'), ['Bixby Bridge is two miles ahead.']);
  assert.deepEqual(s.take(all), ['When it opened in 1932, it was tall!']);
  assert.deepEqual(s.take(all), []);
  assert.deepEqual(s.take(all, true), ['Want a stop?']);
  assert.deepEqual(s.take(all, true), []);
});

test('numbers stay inside their sentence; other scripts work', () => {
  assert.deepEqual(new Sentences('en').take('It is 2.5 miles to the café. Then 12 more.', true), ['It is 2.5 miles to the café.', 'Then 12 more.']);
  assert.deepEqual(new Sentences('ja').take('橋はもうすぐです。写真を撮りますか？', true), ['橋はもうすぐです。', '写真を撮りますか？']);
});

test('a long run with no end in sight is spoken up to its last comma, so speaking starts sooner', () => {
  const long = `The road follows the cliffs past the lighthouse, ${'the cannery and the pier, '.repeat(8)}and on`;
  assert.ok(long.length > LONG);
  const s = new Sentences('en');
  const [first, ...more] = s.take(long);
  assert.deepEqual(more, []);
  assert.ok(first.endsWith(','));
  assert.ok(first.length <= LONG + 1);
  assert.deepEqual(s.take(`${long} to Carmel.`, true), [`${long.slice(first.length).trim()} to Carmel.`]);
});

test('blank text gives nothing; a locale the platform does not know falls back', () => {
  assert.deepEqual(new Sentences('en').take('   ', true), []);
  assert.deepEqual(new Sentences('not a locale!').take('Hi. There.', true), ['Hi.', 'There.']);
});
