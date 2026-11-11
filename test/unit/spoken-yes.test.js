import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenYes, spokenNo } from '../../src/core/agent/spoken-yes.js';

// A spoken yes for reading another trip (the timeline design: "Yes, a strict word list"): annai's own list, the whole line, no model.

test('a yes, as heard in each language: case, punctuation, spaces and full-width forms aside', () => {
  for (const said of ['yes', 'Yes.', 'YES!', ' yeah ', 'OK', 'Okay.', 'Sure!', 'Go ahead.', 'Allow it', 'Yes, please.', 'はい。', 'はい', 'お願いします', 'いいよ！', '好的', '好的。', '可以', '是的', 'うん', 'うん。', 'ｙｅｓ', 'Yes　please']) {
    assert.equal(spokenYes(said), true, said);
  }
});

test('not a yes: one said as a question, which is how "pardon?" is said', () => {
  for (const said of ['はい？', 'はい?', '嗯？', 'ええ？', 'Yes?', 'Okay?', 'Sure?!', '好？', 'yes ?']) {
    assert.equal(spokenYes(said), false, said);
  }
});

test('not a yes: a word that has another meaning as often (いいです: "no thanks" too; 嗯: the filled pause; ええ: surprise, and ええと), on neither list', () => {
  for (const said of ['いいです', 'いいです。', '嗯', '嗯。', '嗯……', 'ええ', 'ええ。', 'ええ！', 'ええと']) {
    assert.equal(spokenYes(said), false, said);
    assert.equal(spokenNo(said), false, said);
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

// A line of several clauses (set apart by punctuation, or run together as a speech-to-text server writes "yes, go ahead"): every clause on the list.

test('a yes of two or more clauses, as each language is written: every clause on the yes list, with or without the comma a transcript leaves out', () => {
  for (const said of ['Yes, go ahead.', 'yes go ahead', 'Yes sure', 'ok go ahead', 'Yes okay', 'Yes, sure, go ahead.', 'Okay, go ahead!', 'Yes, yes.', 'yes please go ahead',
    'はい、お願いします', 'はい お願いします', 'はい、お願いします。', 'うん、いいよ', 'うんうん', 'はい、どうぞ',
    '好的，可以', '好的 可以', '好的，可以。', '是的，好', '行，可以', '可以，好的']) {
    assert.equal(spokenYes(said), true, said);
    assert.equal(spokenNo(said), false, said);
  }
});

test('not a yes: any clause that is no yes word, a clause set as a question, three words run together, or a no among them', () => {
  for (const said of ['Yes, but no', 'Okay, wait', 'yes go ahead but not that one', 'Yes, go ahead?', 'Yes? Go ahead.', 'yes yes yes', 'Yes, no.', 'Yes, stop.', 'Yes, go ahead, thanks.', 'okay wait',
    'はい、いいえ', 'はい、お願いします？', 'はい、でも', 'はい、待って', '好的，不要', '好的，但是', '好的，可以？', '可以，等一下']) {
    assert.equal(spokenYes(said), false, said);
  }
});

test('a no of two or more clauses: every clause on the no list; a yes among them makes it neither', () => {
  for (const said of ['No, no.', 'no no', 'No, wait, hold on.', 'Nope, stop.', 'No wait', 'いいえ、結構です', 'いや、やめて', 'だめ、待って', '不要，算了', '不用 算了', '不行，等一下']) {
    assert.equal(spokenNo(said), true, said);
    assert.equal(spokenYes(said), false, said);
  }
  for (const said of ['No, go ahead.', 'wait, yes', 'no but yes', 'stop, okay', 'いいえ、はい', 'いや、お願いします', '不要，好', '算了，可以']) {
    assert.equal(spokenNo(said), false, said);
    assert.equal(spokenYes(said), false, said);
  }
});

test('いいよ said once is a yes; said twice or more ("いいよ、いいよ", "いいよいいよ"), as it is to wave an offer off, it is neither a yes nor a no', () => {
  for (const said of ['いいよ', 'いいよ。', 'いいよ！', 'うん、いいよ']) assert.equal(spokenYes(said), true, said);
  for (const said of ['いいよ、いいよ', 'いいよいいよ', 'いいよ いいよ', 'いいよ！いいよ！', 'いいよ、いいよ、いいよ']) {
    assert.equal(spokenYes(said), false, said);
    assert.equal(spokenNo(said), false, said);
  }
});
