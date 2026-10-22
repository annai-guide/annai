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
 * with too little speech in it (a click, a door) is thrown away. A frame of near digital silence (under
 * SILENT_DB, or a quarter of it zeros: a microphone just opened, an iPhone's echo canceller) neither sets
 * nor moves the floor, and in speech it is quiet (the iPhone trace, 2026-10-22: a turn ran on for 29 s).
 * @typedef {{ type: 'speech' } | { type: 'segment', pcm: Float32Array, sampleRate: number, ms: number, cut: 'pause' | 'cap' | 'end', peakDb: number } | { type: 'discard' }} DetectorEvent
 *   cut: what ended it: its pause, maxMs, or end(); peakDb: its loudest frame
 * @typedef {{ frames: Float32Array[], dbs: number[], speech: number, quiet: number, peak: number }} Run  speech going on: its frames, their loudness, and counts
 */

export const FRAME_MS = 20;
const STEADY_FRAMES = 50; // one second
const STEADY_DB = 3;
const FLOOR_MIN_DB = -60;
const SILENT_DB = -90;

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
  /** Samples of the frame being filled that are digital silence. */
  #zeros = 0;
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

  /** How much of the speech going on was loud enough to be speech, in ms: under minSpeechMs, it may yet be a click. */
  get speechMs() {
    return (this.#seg?.speech ?? 0) * FRAME_MS;
  }

  /** The floor now, in dB; null before a frame with sound in it. */
  get floorDb() {
    return this.#floor;
  }

  /** The loudest frame of the speech going on, in dB; null with none. */
  get peakDb() {
    return this.#seg?.peak ?? null;
  }

  /** Forgets any speech going on and the frames before it; the floor too, with floor. @param {{ floor?: boolean }} [o] */
  reset({ floor = false } = {}) {
    if (floor) this.#floor = null;
    this.#seg = null;
    this.#before = [];
    this.#recent = [];
    this.level = 0;
  }

  /** @param {Float32Array} pcm @returns {DetectorEvent[]} */
  push(pcm) {
    /** @type {DetectorEvent[]} */
    const events = [];
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i];
      this.#cur[this.#n++] = x;
      if (Math.abs(x) < 1e-7) this.#zeros++;
      const y = this.#lp(this.#hp(x));
      this.#energy += y * y;
      if (this.#n === this.#frame) {
        const raw = this.#cur;
        const db = this.#zeros * 4 > this.#frame ? -Infinity : 10 * Math.log10(this.#energy / this.#frame + 1e-12);
        this.#cur = new Float32Array(this.#frame);
        this.#n = 0;
        this.#energy = 0;
        this.#zeros = 0;
        this.#step(raw, db, events);
      }
    }
    return events;
  }

  /** The microphone is closing: speech still going on becomes a segment, if there is enough of it. @returns {DetectorEvent[]} */
  end() {
    /** @type {DetectorEvent[]} */
    const events = [];
    if (this.#seg) this.#finish(events, 'end');
    this.level = 0;
    return events;
  }

  /** @param {Float32Array} raw @param {number} db @param {DetectorEvent[]} events */
  #step(raw, db, events) {
    if (db < SILENT_DB) {
      this.level = 0;
      const s = this.#seg;
      if (!s) return;
      s.frames.push(raw);
      s.quiet++;
      if (s.quiet >= this.pauseFrames || s.frames.length >= this.maxFrames) this.#finish(events);
      return;
    }
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
        this.#seg = { frames: this.#before, dbs: [], speech: 3, quiet: 0, peak: db };
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
    s.peak = Math.max(s.peak, db);
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

  /** @param {DetectorEvent[]} events @param {'pause' | 'cap' | 'end'} [cut] */
  #finish(events, cut) {
    const s = /** @type {Run} */ (this.#seg);
    this.#seg = null;
    if (s.speech < this.minSpeech) {
      events.push({ type: 'discard' });
      return;
    }
    const keep = s.frames.length - s.quiet + Math.min(s.quiet, this.tail);
    const pcm = new Float32Array(keep * this.#frame);
    for (let i = 0; i < keep; i++) pcm.set(s.frames[i], i * this.#frame);
    events.push({ type: 'segment', pcm, sampleRate: this.sampleRate, ms: Math.round((pcm.length / this.sampleRate) * 1000), cut: cut ?? (s.quiet >= this.pauseFrames ? 'pause' : 'cap'), peakDb: s.peak });
  }
}
