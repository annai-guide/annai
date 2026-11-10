import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenYes } from '../../src/core/agent/spoken-yes.js';

// A spoken yes for reading another trip (the timeline design: "Yes, a strict word list"): annai's own list, the whole line, no model.

test('a yes, as heard in each language: case, punctuation, spaces and full-width forms aside', () => {
  for (const said of ['yes', 'Yes.', 'YES!', ' yeah ', 'OK', 'Okay.', 'Sure!', 'Go ahead.', 'Allow it', 'Yes, please.', 'はい。', 'はい', 'お願いします', 'いいよ！', '好的', '好的。', '可以', '是的', '嗯', 'ｙｅｓ', 'Yes　please']) {
    assert.equal(spokenYes(said), true, said);
  }
});

test('not a yes: more than the word, a word that holds it, the word said three times, nothing', () => {
  for (const said of ['yes but no', 'not yes', 'yesterday', 'おはい', 'yes yes yes', 'no', 'nope', 'yes, read the other one', 'I said yes', '', '...', 'allowance', '好不好']) {
    assert.equal(spokenYes(said), false, said);
  }
});
