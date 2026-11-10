import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenYes, spokenNo } from '../../src/core/agent/spoken-yes.js';

// A spoken yes for reading another trip (the timeline design: "Yes, a strict word list"): annai's own list, the whole line, no model.

test('a yes, as heard in each language: case, punctuation, spaces and full-width forms aside', () => {
  for (const said of ['yes', 'Yes.', 'YES!', ' yeah ', 'OK', 'Okay.', 'Sure!', 'Go ahead.', 'Allow it', 'Yes, please.', 'はい。', 'はい', 'お願いします', 'いいよ！', '好的', '好的。', '可以', '是的', '嗯', 'ｙｅｓ', 'Yes　please']) {
    assert.equal(spokenYes(said), true, said);
  }
});

test('not a yes: one said as a question, which is how "pardon?" is said', () => {
  for (const said of ['はい？', 'はい?', '嗯？', 'ええ？', 'Yes?', 'Okay?', 'Sure?!', '好？', 'yes ?']) {
    assert.equal(spokenYes(said), false, said);
  }
});

test('not a yes: more than the word, a word that holds it, the word said three times, nothing', () => {
  for (const said of ['yes but no', 'not yes', 'yesterday', 'おはい', 'yes yes yes', 'no', 'nope', 'yes, read the other one', 'I said yes', '', '...', 'allowance', '好不好']) {
    assert.equal(spokenYes(said), false, said);
  }
});

// A spoken no (the voice-yes design): a plain refusal or take-back, matched as strictly; it declines annai's card, which is always safe.

test('a no, as heard in each language: case, punctuation, spaces and full-width forms aside, a question mark too', () => {
  for (const said of ['no', 'No.', 'NO!', 'Nope.', 'No thanks.', 'No, thank you.', 'Not now.', 'No, wait.', 'Wait.', 'Wait, wait.', 'Hold on.', 'Stop!', 'Cancel.', "Don't.", 'Never mind.', 'No?',
    'いいえ。', 'いや。', 'ううん', 'だめ', 'ダメ！', 'ちょっと待って。', '待って', 'やめて', 'キャンセル', '結構です。', '不。', '不要', '不用了', '不行', '算了', '等一下', '停', '别', '取消', 'Ｎｏ']) {
    assert.equal(spokenNo(said), true, said);
  }
});

test('not a no: more than the word, a word that holds it, a filler, a yes, nothing', () => {
  for (const said of ['no but yes', 'not that one', 'nobody', 'know', 'No, go ahead.', 'I said no', 'wait what', 'えっと', 'あの', '那个', '不是', '好不好', '大丈夫です', 'いいです', 'yes', '', '...']) {
    assert.equal(spokenNo(said), false, said);
  }
});

test('no line is both a yes and a no', () => {
  for (const said of ['yes', 'no', 'ok', 'wait', 'はい', 'いいえ', 'いいです', '好', '不', '嗯', 'sure', 'stop']) assert.ok(!(spokenYes(said) && spokenNo(said)), said);
});
