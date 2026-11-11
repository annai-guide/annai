/**
 * A heard line that is a yes, or a no, by annai's own strict word lists, with no model involved (the timeline design, "Decided by the user, after
 * the spec check": "Yes, a strict word list"). Every clause of the line (set apart by punctuation: "Yes, go ahead.") must be on the list, as one word
 * or two run together, as a transcript writes "yes go ahead" with no comma. No substring, so "yes but no", "okay, wait" and "yesterday" aren't;
 * three run together are a chant, and aren't either.
 * Each word has one meaning (the final review, 2026-11-10): off the yes list are いいです (to an offer it as often means "no thanks"), 嗯 (also
 * the filled pause, "嗯……", whose dots are stripped) and ええ (also surprise, "ええ！", and the start of ええと); うん stays (hesitation is うーん).
 * いいよ stays a yes said once; "いいよ、いいよ" waves an offer off as often, so it is neither.
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

/** A clause as the lists match it: punctuation and spaces out. @param {string} said */
const bare = (said) => said.replace(/[\p{P}\s]/gu, '');
/** Nothing but いいよ, more than once. */
const WAVED = /^(いいよ){2,}$/;
/** What sets clauses apart: all but letters, digits, marks, spaces, apostrophes and hyphens. */
const BETWEEN = /[^\p{L}\p{N}\p{M}\s'’-]+/u;

/** Whether a line is of the list: all of it one entry ("Yes, please"), or each clause one entry or two run together. @param {Set<string>} list @param {string} said NFKC, lower case */
const listed = (list, said) => {
  const one = (/** @type {string} */ c) => list.has(c) || [...c].some((_, i) => i > 0 && list.has(c.slice(0, i)) && list.has(c.slice(i)));
  const clauses = said.split(BETWEEN).map(bare).filter(Boolean);
  return list.has(bare(said)) || (clauses.length > 0 && clauses.every(one));
};

/**
 * Whether a heard line is a yes: NFKC, lower case, every clause on the yes list. One written as a question, anywhere in it, isn't: "はい？",
 * "好？" and "Yes?" are how "pardon?" is said. @param {string} text
 */
export const spokenYes = (text) => {
  const said = String(text ?? '').normalize('NFKC').toLowerCase();
  return !said.includes('?') && !WAVED.test(bare(said)) && listed(YES, said);
};

/** Whether a heard line is a no, matched as a yes is; a "No?" still declines, which is always safe. @param {string} text */
export const spokenNo = (text) => listed(NO, String(text ?? '').normalize('NFKC').toLowerCase());
