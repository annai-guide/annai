import { biquad } from '../voice/pcm.js';
import { Detector } from '../voice/detector.js';

/**
 * A live session's microphone (the Koe and Kokoro design: realtime sessions stream no silence). annai's end-of-sentence
 * detector drives the API's manual turns (decision 9): at speech start, activityStart and the sound just before it;
 * then 100 ms chunks of 16-bit PCM at the session's rate; at the cut, the rest and activityEnd. While Koe plays, a
 * start needs bargeInDb more over the floor (decision 13): her own voice from the car's speakers is quieter than a passenger.
 */

/** Sound at another rate, piece by piece, as 16-bit PCM: the same samples as all at once (filtered, then read between samples, as resample()). */
export class StreamResampler {
  #pos = 0; // the next output's place in the input
  #base = 0; // where this piece starts in the input
  #last = 0; // the last piece's last sample, filtered
  #n = 0; // outputs so far
  #filter;

  /** @param {number} from @param {number} to */
  constructor(from, to) {
    this.step = from / to;
    const a = to < from ? biquad('lowpass', to * 0.45, from) : null;
    const b = to < from ? biquad('lowpass', to * 0.45, from) : null;
    this.#filter = a && b ? (/** @type {number} */ x) => b(a(x)) : (/** @type {number} */ x) => x;
  }

  /** @param {Float32Array} pcm @returns {Int16Array} */
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
      const v = Math.max(-1, Math.min(1, x[k] * (1 - f) + (f ? x[k + 1] : 0) * f));
      out.push(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff));
    }
    if (pcm.length) this.#last = x[pcm.length];
    this.#base += pcm.length;
    return Int16Array.from(out);
  }
}

export class LiveInput {
  /** Speech is being sent now. */
  active = false;
  /** @type {Detector | null} */
  #detector = null;
  /** @type {StreamResampler | null} */
  #resampler = null;
  /** @type {{ close(): void } | null} */
  #mic = null;
  #closed = false;
  /** The sound before speech starts, kept for the pre-roll. @type {Int16Array[]} */
  #before = [];
  #chunk;
  #n = 0;

  /**
   * @param {{ mic: import('../voice/platform.js').Mic, send: { activity(edge: 'start' | 'end'): void, audio(bytes: Uint8Array): void },
   *   rate?: number, pauseMs?: number, startDb?: number, preRollMs?: number, chunkMs?: number, bargeInDb?: number,
   *   speaking?: () => boolean, onLevel?: (x: number) => void, onError?: (e: Error) => void }} o
   *   rate: what the session takes; speaking: whether Koe's voice is playing; bargeInDb: Infinity turns cutting in by voice off
   */
  constructor({ mic, send, rate = 16_000, pauseMs = 700, startDb = 10, preRollMs = 300, chunkMs = 100, bargeInDb = 6, speaking = () => false, onLevel, onError }) {
    this.mic = mic;
    this.send = send;
    this.rate = rate;
    this.pauseMs = pauseMs;
    this.startDb = startDb;
    this.bargeInDb = bargeInDb;
    this.speaking = speaking;
    this.onLevel = onLevel;
    this.onError = onError;
    // What the detector keeps before speech, and the frames it takes to be sure of it.
    this.keep = Math.round(((preRollMs + 100) * rate) / 1000);
    this.#chunk = new Int16Array(Math.round((chunkMs * rate) / 1000));
  }

  /** Opens the microphone. */
  async start() {
    this.#mic = await this.mic.open({
      onFrames: (pcm, sampleRate) => this.#frames(pcm, sampleRate),
      onError: (e) => { if (!this.#closed) this.onError?.(e); },
    });
    if (this.#closed) this.#mic.close();
  }

  /** Closes the microphone; speech going on is ended. */
  stop() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.active) this.#end();
    this.#mic?.close();
    this.onLevel?.(0);
  }

  /** @param {Float32Array} pcm @param {number} sampleRate */
  #frames(pcm, sampleRate) {
    if (this.#closed) return;
    if (this.#detector?.sampleRate !== sampleRate) {
      this.#detector = new Detector({ sampleRate, pauseMs: this.pauseMs, startDb: this.startDb });
      this.#resampler = new StreamResampler(sampleRate, this.rate);
    }
    const d = this.#detector;
    d.startDb = this.startDb + (this.speaking() ? this.bargeInDb : 0);
    const out = /** @type {StreamResampler} */ (this.#resampler).push(pcm);
    const was = this.active;
    if (was) this.#add(out);
    else this.#hold(out);
    for (const e of d.push(pcm)) {
      if (e.type === 'speech' && !this.active) {
        this.active = true;
        this.send.activity('start');
        for (const b of this.#before.splice(0)) this.#add(b);
      } else if (e.type !== 'speech' && this.active) {
        this.#end(); // a cut, or a noise the detector threw away: the turn ends either way
      }
    }
    this.onLevel?.(d.level);
  }

  /** Keeps the newest sound for the pre-roll. @param {Int16Array} pcm */
  #hold(pcm) {
    this.#before.push(pcm);
    let n = this.#before.reduce((s, b) => s + b.length, 0);
    while (n - this.#before[0].length >= this.keep) n -= /** @type {Int16Array} */ (this.#before.shift()).length;
    if (n > this.keep) this.#before[0] = this.#before[0].subarray(n - this.keep);
  }

  /** Sends sound in whole chunks. @param {Int16Array} pcm */
  #add(pcm) {
    for (let i = 0; i < pcm.length;) {
      const take = Math.min(pcm.length - i, this.#chunk.length - this.#n);
      this.#chunk.set(pcm.subarray(i, i + take), this.#n);
      this.#n += take;
      i += take;
      if (this.#n === this.#chunk.length) this.#flush();
    }
  }

  #flush() {
    if (this.#n) this.send.audio(new Uint8Array(this.#chunk.slice(0, this.#n).buffer));
    this.#n = 0;
  }

  #end() {
    this.#flush();
    this.active = false;
    this.send.activity('end');
  }
}
