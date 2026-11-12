// Where her sound's last loud stretch ends, kept as it arrives: a turn of hers counts as heard whole once it is all made and played past that
// point, since what follows it is a quiet tail (real Gemini's replies end with about 0.3 s of near-silence that her player still holds), not words.

/**
 * A 20 ms frame of her sound is loud at this rms or above, in dBFS (16-bit PCM, full scale 32768). From 222 real Gemini note replies
 * (2026-11-12, headphones, the PCM annai pushed to the player, a frame per chunk), computed from the records: every level from -50 to -34 gave the same
 * result on the 93 answers aimed at the end of a note and the 40 cuts: the 54 duplicate cards (50 answers begun in her quiet tail, 4 within 5 ms of
 * play-out) are removed, and none of the 28 real cuts, none of the 35 noise cuts is wrongly counted whole; -30 begins to count real cuts whole. Run as
 * built on real Gemini (36 aimed answers): 0 duplicate cards in the 24 begun past the last loud frame, all 12 with loud sound left cut. The level matters only for
 * a last soft syllable: -40 keeps 4 of the 5 quiet final consonant bursts measured ("ahead", "side", "lifted", a released final d at -35 to -39) as
 * her sound, where -34 would count them past her last loud sample, so -40 errs toward showing the card, not toward losing a word. The tail frames at
 * -41 to -46 dBFS are her own fades and bursts, not noise (the audio is the model's, not the room's), so no margin over the tail's peak is kept.
 * The tail after the last loud frame is a median 300 ms (p95 about 360).
 */
export const LOUD_DBFS = -40;

/** The length of a frame, as the measurement framed it. */
const FRAME_S = 0.02;

/** @typedef {{ samples: number, end: number }} Loud  samples: how many have come; end: where the last loud frame ends, in samples (0: none yet) */

/** @returns {Loud} */
export const newLoud = () => ({ samples: 0, end: 0 });

/**
 * One chunk of a turn's sound arrives: its frames of 20 ms from its start (a chunk is almost always a whole number of them: 142 of 56,477 frames
 * were short), the last one shorter if it ends part-way, each judged on its own samples. @param {Loud} loud @param {Int16Array} pcm @param {number} rate
 */
export function pushLoud(loud, pcm, rate) {
  const frame = Math.max(1, Math.round(rate * FRAME_S));
  const floor = (10 ** (LOUD_DBFS / 20) * 0x8000) ** 2; // as a mean square
  for (let from = 0; from < pcm.length; from += frame) {
    const to = Math.min(pcm.length, from + frame);
    let sum = 0;
    for (let i = from; i < to; i++) sum += pcm[i] * pcm[i];
    if (sum / (to - from) >= floor) loud.end = loud.samples + to;
  }
  loud.samples += pcm.length;
}

/**
 * The end of the last loud frame, in whole ms (as the player's heard ms are rounded). With no loud frame (none of the 222 real replies had none:
 * her level ran -25 to -11 dBFS) there is no last loud sample to play past, so the end is the whole of her sound so far: it is heard whole only
 * once played through, not as soon as it is all made. @param {Loud} loud @param {number} rate
 */
export const loudMs = (loud, rate) => Math.round(((loud.end || loud.samples) / rate) * 1000);
