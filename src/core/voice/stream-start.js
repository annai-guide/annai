/**
 * When a streamed voice may start playing (G3, "Never stutters"). The stream player schedules each piece
 * as it arrives, with nothing held back, so a voice arriving slower than it plays would leave gaps
 * mid-word. Playing starts once the rest, at the rate it is arriving, will be in before playback reaches
 * it: arriving at a rate r of real time, a clip of T seconds needs (1 − r) × T in hand, T taken a fifth
 * longer to be safe. On a good connection that is the cushion, about half a second from the request;
 * on a weak one it waits, up to the whole clip, and then plays without a gap.
 */

/** How long a text takes to say, roughly: 15 characters a second. @param {string} text */
export const estimateSeconds = (text) => text.length / 15;

/**
 * Whether to start playing now. bufferedS: the seconds in hand, not yet played; receivedS: the seconds
 * that arrived during elapsedS (the rate); estimatedS: the clip's length from its words; ended: all of it is in.
 * @param {{ bufferedS: number, receivedS: number, elapsedS: number, estimatedS: number, ended: boolean, cushionS?: number }} o
 */
export function readyToStart({ bufferedS, receivedS, elapsedS, estimatedS, ended, cushionS = 0.3 }) {
  if (ended) return true;
  if (!(receivedS > 0) || !(elapsedS > 0)) return false;
  const rate = receivedS / elapsedS;
  // What is in already is at least the clip's length, when the estimate was short.
  return bufferedS >= Math.max(cushionS, (1 - rate) * Math.max(estimatedS, bufferedS) * 1.2);
}
