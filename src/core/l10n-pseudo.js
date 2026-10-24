/**
 * The pseudo-locales (localization design, "Tests"): made at load from the English, in development only, so they cost the shell
 * nothing. en-XA accents every letter, pads each message by 40% with · (in runs of six) and brackets it in ⟦ ⟧, so a word that escaped t shows
 * plain and a layout that can't hold longer words breaks. ar-XB reverses the letters of every word, and is right to left.
 * {0}… and # are kept: they are the message's values.
 */
const FROM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TO = 'áƀçðéƒĝĥíĵķļɱñóṕǫŕśţúṽŵẋýžÁḂÇÐÉḞĜĤÍĴĶĻṀŃÓṔǪŔŠŢÚṼŴẊÝŽ';
const ACCENT = new Map([...FROM].map((c, i) => [c, TO[i]]));
const HOLES = /(\{\d+\}|#)/;

/** Applies a function to the words of a message, leaving the values alone. @param {string} s @param {(text: string) => string} fn */
const apart = (s, fn) => s.split(HOLES).map((part, i) => (i % 2 ? part : fn(part))).join('');

/** @param {string} s */
export function accented(s) {
  const letters = [...s.replace(/\{\d+\}|#/g, '')].length;
  const body = apart(s, (text) => [...text].map((c) => ACCENT.get(c) ?? c).join(''));
  // In runs of six, so the padding wraps as words do: one run as long as 40% of a long message would push a phone's screen wider.
  return `⟦${body}${s.trim() ? ` ${'·'.repeat(Math.ceil(letters * 0.4)).replace(/·{6}(?=·)/g, '$& ')}` : ''}⟧`;
}
/** @param {string} s */
export const mirrored = (s) => apart(s, (text) => text.replace(/\p{L}+/gu, (word) => [...word].reverse().join('')));

/** The transform for a pseudo-locale's tag. @param {string} tag */
export const pseudoFor = (tag) => (tag === 'ar-XB' ? mirrored : accented);
