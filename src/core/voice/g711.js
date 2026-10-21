/**
 * G.711 (ITU-T G.711): the telephone's audio at a byte a sample, μ-law and A-law, coded as the
 * reference g711.c does (μ-law in its 14-bit domain, A-law in its 13-bit one). annai speaks 16-bit
 * PCM; plugins code it at the wire through annai.helpers.g711: OpenAI Realtime takes and gives
 * audio/pcmu and audio/pcma, and Gemini's voices send audio/mulaw and audio/alaw (G3).
 */

/** μ-law's bias. */
const BIAS = 0x84;

/** 16-bit PCM as μ-law. @param {Int16Array} pcm @returns {Uint8Array} */
export function pcmToUlaw(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] >> 2;
    const s = Math.min(Math.abs(v), 8159) + (BIAS >> 2);
    let seg = 0;
    while (seg < 8 && s >= 0x40 << seg) seg++;
    out[i] = (seg >= 8 ? 0x7f : (seg << 4) | ((s >> (seg + 1)) & 0x0f)) ^ (v < 0 ? 0x7f : 0xff);
  }
  return out;
}

/** μ-law as 16-bit PCM. @param {Uint8Array} bytes @returns {Int16Array} */
export function ulawToPcm(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const s = ((((u & 0x0f) << 3) + BIAS) << ((u >> 4) & 7)) - BIAS;
    out[i] = u & 0x80 ? -s : s;
  }
  return out;
}

/** 16-bit PCM as A-law. @param {Int16Array} pcm @returns {Uint8Array} */
export function pcmToAlaw(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i] >> 3; // 13 bits
    const mask = s >= 0 ? 0xd5 : 0x55;
    if (s < 0) s = -s - 1;
    let seg = 0;
    while (seg < 8 && s >= 0x20 << seg) seg++;
    out[i] = (seg >= 8 ? 0x7f : (seg << 4) | ((s >> (seg < 2 ? 1 : seg)) & 0x0f)) ^ mask;
  }
  return out;
}

/** A-law as 16-bit PCM. @param {Uint8Array} bytes @returns {Int16Array} */
export function alawToPcm(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const a = bytes[i] ^ 0x55;
    const seg = (a & 0x70) >> 4;
    const t = ((a & 0x0f) << 4) + (seg ? 0x108 : 8);
    const s = seg > 1 ? t << (seg - 1) : t;
    out[i] = a & 0x80 ? s : -s;
  }
  return out;
}

/** The four coders, as plugins get them. */
export const g711 = Object.freeze({ pcmToUlaw, ulawToPcm, pcmToAlaw, alawToPcm });
