import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keys, parseLines } from '../../scripts/realtime/keys.mjs';

const FILE = ['AIza-one-0000000000000000', 'AIza-two-1111111111111111', '', 'AIza-four-33333333333333', 'AIza-five-44444444444444'].join('\n');

test('parseLines reads "3", "1-11" and "1,3-4"; it refuses anything else', () => {
  assert.deepEqual(parseLines('3'), [3]);
  assert.deepEqual(parseLines('1-3'), [1, 2, 3]);
  assert.deepEqual(parseLines('1,3-4'), [1, 3, 4]);
  for (const bad of ['', '0', '2-1', 'a', '1-', '1,,2', '-3']) assert.throws(() => parseLines(bad), /lines/i, bad);
});

test('keys come from the lines asked for, in order; an empty line is skipped; a missing one is an error', () => {
  const k = Keys.fromFile(FILE, '1-4');
  assert.deepEqual(k.lines, [1, 2, 4]);
  assert.equal(k.line, 1);
  assert.throws(() => Keys.fromFile(FILE, '6-7'), /no key/i);
});

test('only the lines asked for are ever read: a line outside the range is not in the object at all', () => {
  const k = Keys.fromFile(FILE, '1-2');
  assert.ok(!JSON.stringify(k).includes('four'));
  assert.ok(!k.scrub('x AIza-four-33333333333333 y').includes('«key»'));
});

test('advance() moves to the next key and says when there is none', () => {
  const k = Keys.fromFile(FILE, '1-2');
  assert.equal(k.advance(), true);
  assert.equal(k.line, 2);
  assert.equal(k.advance(), false);
  assert.equal(k.line, 2);
});

test('scrub blanks every key it holds, and assertClean refuses text with one in it without repeating it', () => {
  const k = Keys.fromFile(FILE, '1-2');
  assert.equal(k.scrub('a AIza-one-0000000000000000 b AIza-two-1111111111111111'), 'a «key» b «key»');
  assert.doesNotThrow(() => k.assertClean('nothing here'));
  assert.throws(() => k.assertClean('url?key=AIza-two-1111111111111111', 'the report'), (/** @type {any} */ e) => /the report/.test(e.message) && !e.message.includes('AIza'));
});

test('a key from the environment is the only one, on no line', () => {
  const k = Keys.fromEnvironment({ GEMINI_KEY: 'AIza-env-2222222222222222' });
  assert.equal(k.line, null);
  assert.equal(k.advance(), false);
  assert.equal(k.key, 'AIza-env-2222222222222222');
  assert.throws(() => Keys.fromEnvironment({}), /GEMINI_KEY/);
});

test('JSON.stringify and util.inspect of a Keys never show a key', async () => {
  const { inspect } = await import('node:util');
  const k = Keys.fromFile(FILE, '1-2');
  assert.ok(!JSON.stringify(k).includes('AIza'));
  assert.ok(!inspect(k).includes('AIza'));
});
