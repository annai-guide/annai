import { biquad } from './pcm.js';

/**
 * The end-of-sentence detector (spec §10.2). It measures energy in the speech band against a
 * background-noise floor that keeps adapting; speech followed by a pause (700 ms by default,
 * tunable) becomes a segment. It only cuts audio: it never decides to stop listening.
 *
 * Frames are 20 ms. Speech starts when 3 of 4 frames are startDb over the floor, and goes on while
 * frames stay keepDb over it. The floor falls fast and rises slowly. When the sound stays steady for
 * a second (an engine, a fan, a window opened) it becomes the new floor: speech rises and falls with
 * every syllable, steady noise doesn't. A segment keeps a little before the speech and after it; one
 * with too little speech in it (a click, a door) is thrown away.
 * @typedef {{ type: 'speech' } | { type: 'segment', pcm: Float32Array, sampleRate: number, ms: number } | { type: 'discard' }} DetectorEvent
 * @typedef {{ frames: Float32Array[], dbs: number[], speech: number, quiet: number }} Run  speech going on: its frames, their loudness, and counts
 */

export const FRAME_MS = 20;
const STEADY_FRAMES = 50; // one second
const STEADY_DB = 3;
const FLOOR_MIN_DB = -60;

/** @param {number[]} xs */
function spread(xs) {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { mean, std: Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length) };
}

export class Detector {
  /** How loud the sound is over the floor, 0..1, for the glow (spec §16.3). */
  level = 0;
  /** @type {number | null} dB */
  #floor = null;
  #hp;
  #lp;
  #frame;
  #cur;
  #n = 0;
  #energy = 0;
  /** Frames heard while waiting for speech, for the bit before it. @type {Float32Array[]} */
  #before = [];
  /** @type {boolean[]} */
  #recent = [];
  /** @type {Run | null} */
  #seg = null;

  /**
   * @param {{ sampleRate: number, pauseMs?: number, startDb?: number, keepDb?: number, prerollMs?: number, tailMs?: number,
   *   minSpeechMs?: number, maxMs?: number }} o
   */
  constructor({ sampleRate, pauseMs = 700, startDb = 10, keepDb = 6, prerollMs = 300, tailMs = 200, minSpeechMs = 250, maxMs = 30_000 }) {
    this.sampleRate = sampleRate;
    this.startDb = startDb;
    this.keepDb = keepDb;
    const frames = (/** @type {number} */ msOf) => Math.max(1, Math.round(msOf / FRAME_MS));
    this.pauseFrames = frames(pauseMs);
    this.preroll = frames(prerollMs);
    this.tail = frames(tailMs);
    this.minSpeech = frames(minSpeechMs);
    this.maxFrames = frames(maxMs);
    this.#frame = Math.round((sampleRate * FRAME_MS) / 1000);
    this.#cur = new Float32Array(this.#frame);
    this.#hp = biquad('highpass', 300, sampleRate);
    this.#lp = biquad('lowpass', 3400, sampleRate);
  }

  /** Whether speech is going on now. */
  get speaking() {
    return this.#seg !== null;
  }

  /** @param {Float32Array} pcm @returns {DetectorEvent[]} */
  push(pcm) {
    /** @type {DetectorEvent[]} */
    const events = [];
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      this.#cur[this.#n++] = x;
      const y = this.#lp(this.#hp(x));
      this.#energy += y * y;
      if (this.#n === this.#frame) {
        const raw = this.#cur;
        const db = 10 * Math.log10(this.#energy / this.#frame + 1e-12);
        this.#cur = new Float32Array(this.#frame);
        this.#n = 0;
        this.#energy = 0;
        this.#step(raw, db, events);
      }
    }
    return events;
  }

  /** The microphone is closing: speech still going on becomes a segment, if there is enough of it. @returns {DetectorEvent[]} */
  end() {
    /** @type {DetectorEvent[]} */
    const events = [];
    if (this.#seg) this.#finish(events);
    this.level = 0;
    return events;
  }

  /** @param {Float32Array} raw @param {number} db @param {DetectorEvent[]} events */
  #step(raw, db, events) {
    if (this.#floor === null) this.#floor = db;
    const over = db - this.#floor;
    this.level = Math.max(0, Math.min(1, over / 30));
    const s = this.#seg;
    if (!s) {
      this.#recent.push(over > this.startDb && db > FLOOR_MIN_DB);
      if (this.#recent.length > 4) this.#recent.shift();
      this.#before.push(raw);
      if (this.#before.length > this.preroll + 4) this.#before.shift();
      if (this.#recent.filter(Boolean).length >= 3) {
        this.#seg = { frames: this.#before, dbs: [], speech: 3, quiet: 0 };
        this.#before = [];
        this.#recent = [];
        events.push({ type: 'speech' });
      } else {
        this.#floor += (db - this.#floor) * (db < this.#floor ? 0.2 : 0.005);
      }
      return;
    }
    s.frames.push(raw);
    s.dbs.push(db);
    if (s.dbs.length >= STEADY_FRAMES) {
      const last = spread(s.dbs.slice(-STEADY_FRAMES));
      if (last.std < STEADY_DB) {
        // Steady sound: the new floor. With no rise and fall in the whole segment, it was never speech.
        this.#floor = last.mean - 1;
        if (spread(s.dbs).std < STEADY_DB + 1) {
          this.#seg = null;
          events.push({ type: 'discard' });
          return;
        }
      }
    }
    if (db - this.#floor > this.keepDb) {
      s.speech++;
      s.quiet = 0;
    } else {
      s.quiet++;
    }
    this.#floor += (db - this.#floor) * (db < this.#floor ? 0.2 : 0.002);
    if (s.quiet >= this.pauseFrames || s.frames.length >= this.maxFrames) this.#finish(events);
  }

  /** @param {DetectorEvent[]} events */
  #finish(events) {
    const s = /** @type {Run} */ (this.#seg);
    this.#seg = null;
    if (s.speech < this.minSpeech) {
      events.push({ type: 'discard' });
      return;
    }
    const keep = s.frames.length - s.quiet + Math.min(s.quiet, this.tail);
    const pcm = new Float32Array(keep * this.#frame);
    for (let i = 0; i < keep; i++) pcm.set(s.frames[i], i * this.#frame);
    events.push({ type: 'segment', pcm, sampleRate: this.sampleRate, ms: Math.round((pcm.length / this.sampleRate) * 1000) });
  }
}
