/**
 * A heard line that is a yes, or a no, by annai's own strict word lists, with no model involved (the timeline design, "Decided by the user, after
 * the spec check": "Yes, a strict word list"). The whole line must be one of these, once: no substring, so "yes but no" and "yesterday" aren't.
 * Each word has one meaning (the final review, 2026-11-10): off the yes list are いいです (to an offer it as often means "no thanks"), 嗯 (also
 * the filled pause, "嗯……", whose dots are stripped) and ええ (also surprise, "ええ！", and the start of ええと); うん stays (hesitation is うーん).
 */
const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'allow', 'allowit', 'goahead', 'yesplease',
  'はい', 'うん', 'いいよ', 'お願い', 'お願いします', 'どうぞ',
  '好', '好的', '可以', '行', '是', '是的']);
/**
 * Plain refusals and take-backs, in the yes list's languages; none is also a filler ("well", "um", "えっと", "那个" aren't), and none is a yes.
 * Left out as two-way, so on neither list: "大丈夫" ("it's fine": yes or no thanks), "不是" (a filler in speech) and いいです; nor are
 * 嗯 and ええ, off the yes list (a filled pause, surprise), refusals.
 */
const NO = new Set(['no', 'nope', 'nah', 'nono', 'nothanks', 'nothankyou', 'notnow', 'notyet', 'nowait', 'wait', 'waitwait', 'holdon', 'stop', 'cancel', 'dont', 'donot', 'nevermind',
  'いいえ', 'いえ', 'いや', 'ううん', 'だめ', 'ダメ', 'だめです', 'やめて', 'まって', '待って', 'ちょっとまって', 'ちょっと待って', 'ストップ', 'キャンセル', 'いらない', 'いりません', '結構です', 'けっこうです',
  '不', '不要', '不用', '不用了', '不了', '不行', '不可以', '算了', '等等', '等一下', '停', '别', '別', '取消']);

/** A line's words as both lists match them: NFKC, lower case, punctuation and spaces out. @param {string} said */
const bare = (said) => said.toLowerCase().replace(/[\p{P}\s]/gu, '');

/**
 * Whether a heard line is a yes: NFKC, lower case, punctuation and spaces out, then an exact match. One written down as a question isn't:
 * "はい？", "好？" and "Yes?" are how "pardon?" is said. @param {string} text
 */
export const spokenYes = (text) => {
  const said = String(text ?? '').normalize('NFKC');
  return !/\?[\p{P}\s]*$/u.test(said) && YES.has(bare(said));
};

/** Whether a heard line is a no, matched as a yes is; a "No?" still declines, which is always safe. @param {string} text */
export const spokenNo = (text) => NO.has(bare(String(text ?? '').normalize('NFKC')));
