/**
 * When a streamed voice may start playing (G3, "Never stutters"). The stream player schedules each piece
 * as it arrives, with nothing held back, so a voice arriving slower than it plays would leave gaps
 * mid-word. Playing starts once the rest, at the rate it is arriving, will be in before playback reaches
 * it: arriving at a rate r of real time, a clip of T seconds needs (1 − r) × T in hand, T taken a fifth
 * longer to be safe. On a good connection that is the cushion, about half a second from the request;
 * on a weak one it waits, up to the whole clip, and then plays without a gap.
 */

/** Characters spoken about 7 a second: kana, Chinese characters and Hangul (a syllable or a word each). */
const DENSE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/gu;

/** How long a text takes to say, roughly: 15 characters a second, Japanese, Chinese and Korean ones 7 (fix pass). @param {string} text */
export function estimateSeconds(text) {
  const dense = text.match(DENSE)?.length ?? 0;
  return dense / 7 + ([...text].length - dense) / 15;
}

/**
 * Whether to start playing now. bufferedS: the seconds in hand, not yet played; receivedS: the seconds
 * that arrived during elapsedS (the rate); estimatedS: the clip's length from its words; ended: all of it is in.
 * The rate is trusted only once measured over windowS: pieces handled back to back on a busy phone come
 * as a burst that looks many times faster than they arrive (fix pass).
 * @param {{ bufferedS: number, receivedS: number, elapsedS: number, estimatedS: number, ended: boolean, cushionS?: number, windowS?: number }} o
 */
export function readyToStart({ bufferedS, receivedS, elapsedS, estimatedS, ended, cushionS = 0.3, windowS = 0.25 }) {
  if (ended) return true;
  if (!(receivedS > 0) || !(elapsedS >= windowS) || !(elapsedS > 0)) return false;
  const rate = receivedS / elapsedS;
  // What is in already is at least the clip's length, when the estimate was short.
  return bufferedS >= Math.max(cushionS, (1 - rate) * Math.max(estimatedS, bufferedS) * 1.2);
}
