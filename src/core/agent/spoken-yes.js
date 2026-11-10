/**
 * A heard line that is a yes, by annai's own strict word list, with no model involved (the timeline design, "Decided by the user, after
 * the spec check": "Yes, a strict word list"). The whole line must be one of these, once: no substring, so "yes but no" and "yesterday" aren't.
 */
const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'allow', 'allowit', 'goahead', 'yesplease',
  'はい', 'ええ', 'うん', 'いいよ', 'いいです', 'お願い', 'お願いします', 'どうぞ',
  '好', '好的', '可以', '行', '是', '是的', '嗯']);

/**
 * Whether a heard line is a yes: NFKC, lower case, punctuation and spaces out, then an exact match. One written down as a question isn't:
 * "はい？", "嗯？" and "Yes?" are how "pardon?" is said. @param {string} text
 */
export const spokenYes = (text) => {
  const said = String(text ?? '').normalize('NFKC');
  return !/\?[\p{P}\s]*$/u.test(said) && YES.has(said.toLowerCase().replace(/[\p{P}\s]/gu, ''));
};
