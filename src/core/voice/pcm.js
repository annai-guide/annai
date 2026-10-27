/**
 * PCM audio (spec §10.2): WAV files in and out (16-bit, mono), resampling, and the small filters
 * the end-of-sentence detector uses. Segments go to speech-in entries as 16 kHz WAV.
 */
export const SEND_RATE = 16_000;

/** @param {Uint8Array} b @param {number} at @param {string} s */
const tag = (b, at, s) => { for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i); };
/** @param {Uint8Array} b @param {number} at */
const tagAt = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** A 16-bit mono WAV file. Float samples outside -1..1 are clipped. @param {Float32Array | Int16Array} pcm @param {number} sampleRate @returns {Uint8Array} */
export function encodeWav(pcm, sampleRate) {
  const out = new Uint8Array(44 + pcm.length * 2);
  const dv = new DataView(out.buffer);
  tag(out, 0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  tag(out, 8, 'WAVE');
  tag(out, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(out, 36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  const whole = pcm instanceof Int16Array;
  for (let i = 0; i < pcm.length; i++) {
    const x = whole ? pcm[i] : Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, whole ? x : x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return out;
}

/** The format chunk and where the samples are. @param {Uint8Array} bytes */
function chunks(bytes) {
  if (bytes.length < 12 || tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'WAVE') /* en */ throw new Error('This is not a WAV file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {{ format: number, channels: number, sampleRate: number, bits: number } | null} */
  let fmt = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tagAt(bytes, at);
    const size = dv.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) /* en */ throw new Error('Only 16-bit PCM WAV files can be read.');
      return { dv, fmt, body, size: Math.min(size, bytes.length - body) };
    }
    at = body + size + (size % 2);
  }
  /* en */ throw new Error('This WAV file has no sound in it.');
}

/** The first channel of a 16-bit PCM WAV file. @param {Uint8Array} bytes @returns {{ sampleRate: number, pcm: Float32Array }} */
export function decodeWav(bytes) {
  const { dv, fmt, body, size } = chunks(bytes);
  const n = Math.floor(size / 2 / fmt.channels);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(body + i * 2 * fmt.channels, true) / 0x8000;
  return { sampleRate: fmt.sampleRate, pcm };
}

/** A WAV file's 16-bit samples (the first channel), read in place where they can be. @param {Uint8Array} bytes @returns {{ pcm: Int16Array, rate: number }} */
export function pcm16(bytes) {
  const { dv, fmt, body, size } = chunks(bytes);
  const n = Math.floor(size / 2 / fmt.channels);
  if (fmt.channels === 1 && (bytes.byteOffset + body) % 2 === 0) return { pcm: new Int16Array(bytes.buffer, bytes.byteOffset + body, n), rate: fmt.sampleRate };
  return { pcm: Int16Array.from({ length: n }, (_, i) => dv.getInt16(body + i * 2 * fmt.channels, true)), rate: fmt.sampleRate };
}

/** How long a WAV file plays, in seconds. @param {Uint8Array} bytes */
export function wavSeconds(bytes) {
  const { fmt, size } = chunks(bytes);
  return size / 2 / fmt.channels / fmt.sampleRate;
}

/** Sound at another sample rate, piece by piece: the same samples as all at once. Filtered first when going down, so nothing folds back, then read between samples. */
export class StreamResampler {
  #pos = 0; // the next output's place in the input
  #base = 0; // where this piece starts in the input
  #last = 0; // the last piece's last sample, filtered
  #n = 0; // outputs so far
  #filter;

  /**
   * Going down, a 24th-order Butterworth low-pass at 7/16 of the new rate (12 biquads): flat to 3.4 kHz at 8 kHz, and 40 dB
   * down a tenth past the new rate's half, so nothing above it folds back into speech (K6 review). @param {number} from @param {number} to
   */
  constructor(from, to) {
    this.step = from / to;
    const stages = to < from ? Array.from({ length: 12 }, (_, k) => biquad('lowpass', to * 0.4375, from, 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / 48)))) : [];
    this.#filter = (/** @type {number} */ x) => stages.reduce((y, f) => f(y), x);
  }

  /** @param {Float32Array} pcm @returns {Float32Array} */
  push(pcm) {
    const x = new Float32Array(pcm.length + 1); // x[0]: the sample before this piece
    x[0] = this.#last;
    for (let i = 0; i < pcm.length; i++) x[i + 1] = this.#filter(pcm[i]);
    /** @type {number[]} */
    const out = [];
    for (; this.#pos <= this.#base + pcm.length - 1; this.#pos = ++this.#n * this.step) {
      const j = Math.floor(this.#pos);
      const f = this.#pos - j;
      const k = j - this.#base + 1;
      out.push(x[k] * (1 - f) + (f ? x[k + 1] * f : 0));
    }
    if (pcm.length) this.#last = x[pcm.length];
    this.#base += pcm.length;
    return Float32Array.from(out);
  }
}

/** The same sound at another sample rate, all at once; its last sample is held to the length in time. @param {Float32Array} pcm @param {number} from @param {number} to */
export function resample(pcm, from, to) {
  if (from === to) return pcm;
  const out = new StreamResampler(from, to).push(pcm);
  const all = new Float32Array(Math.floor((pcm.length * to) / from));
  all.set(out.subarray(0, all.length));
  return all.fill(out[out.length - 1] ?? 0, Math.min(out.length, all.length));
}

/**
 * A two-pole filter (the RBJ cookbook's), as a function of one sample that keeps its state.
 * @param {'lowpass' | 'highpass'} kind @param {number} f0 corner frequency @param {number} fs sample rate @param {number} [q]
 * @returns {(x: number) => number}
 */
export function biquad(kind, f0, fs, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const [b0, b1, b2] = kind === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const c = [b0 / a0, b1 / a0, b2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}
