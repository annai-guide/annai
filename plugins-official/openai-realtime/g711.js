/**
 * G.711 (ITU-T G.711), the telephone's 8 kHz audio at one byte a sample, which OpenAI Realtime takes and gives as
 * audio/pcmu (μ-law) and audio/pcma (A-law). annai's sessions speak 16-bit PCM; this plugin codes it at the wire.
 */

/** μ-law's bias, and the largest sample it codes. */
const BIAS = 0x84;
const CLIP = 32635;

/** 16-bit PCM as μ-law. @param {Int16Array} pcm @returns {Uint8Array} */
export function muLaw(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i];
    const sign = s < 0 ? 0x80 : 0;
    s = Math.min(sign ? -s : s, CLIP) + BIAS;
    let exp = 7;
    while (exp > 0 && !(s & (0x80 << exp))) exp--;
    out[i] = ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
  }
  return out;
}

/** μ-law as 16-bit PCM. @param {Uint8Array} bytes @returns {Int16Array} */
export function fromMuLaw(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const s = ((((u & 0x0f) << 3) + BIAS) << ((u >> 4) & 7)) - BIAS;
    out[i] = u & 0x80 ? -s : s;
  }
  return out;
}

/** 16-bit PCM as A-law. @param {Int16Array} pcm @returns {Uint8Array} */
export function aLaw(pcm) {
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
export function fromALaw(bytes) {
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
