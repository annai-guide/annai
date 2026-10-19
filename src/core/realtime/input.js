import { StreamResampler } from '../voice/pcm.js';
import { Detector } from '../voice/detector.js';

/**
 * A live session's microphone (the Koe and Kokoro design: realtime sessions stream no silence). annai's end-of-sentence
 * detector drives the API's manual turns (decision 9): once a run has minSpeechMs of speech in it, activityStart and
 * everything since just before it; then 100 ms chunks of 16-bit PCM at the session's rate; at the cut, the rest and
 * activityEnd. A click or a door slam, thrown away sooner, sends nothing: no turn to pay for, no sound off the phone.
 * While Koe plays, a start needs bargeInDb more over the floor (decision 13): her own voice from the car's speakers is
 * quieter than a passenger.
 */

export class LiveInput {
  /** Speech is being sent now. */
  active = false;
  /** Speech began, and is held until it has enough in it to be sure. */
  #held = false;
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
   * @param {{ mic: import('../voice/platform.js').Mic, send: { activity(edge: 'start' | 'end'): void, audio(bytes: Uint8Array): void, audioIn?: { rate: number } },
   *   rate?: number, pauseMs?: number, startDb?: number, minSpeechMs?: number, preRollMs?: number, chunkMs?: number, bargeInDb?: number,
   *   speaking?: () => boolean, onLevel?: (x: number) => void, onError?: (e: Error) => void }} o
   *   rate: what the session takes (send's audioIn, K6); speaking: whether Koe's voice is playing; bargeInDb: Infinity turns cutting in by voice off
   */
  constructor({ mic, send, rate = send.audioIn?.rate ?? 16_000, pauseMs = 700, startDb = 10, minSpeechMs = 250, preRollMs = 300, chunkMs = 100, bargeInDb = 6, speaking = () => false, onLevel, onError }) {
    this.mic = mic;
    this.send = send;
    this.rate = rate;
    this.pauseMs = pauseMs;
    this.startDb = startDb;
    this.minSpeechMs = minSpeechMs;
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

  /** Closes the microphone; speech going on is ended, if it was enough to be speech. */
  stop() {
    if (this.#closed) return;
    this.#closed = true;
    this.#events(this.#detector?.end() ?? []);
    this.#mic?.close();
    this.onLevel?.(0);
  }

  /** @param {Float32Array} pcm @param {number} sampleRate */
  #frames(pcm, sampleRate) {
    if (this.#closed) return;
    if (this.#detector?.sampleRate !== sampleRate) {
      this.#detector = new Detector({ sampleRate, pauseMs: this.pauseMs, startDb: this.startDb, minSpeechMs: this.minSpeechMs });
      this.#resampler = new StreamResampler(sampleRate, this.rate);
    }
    const d = this.#detector;
    d.startDb = this.startDb + (this.speaking() ? this.bargeInDb : 0);
    const out = Int16Array.from(/** @type {StreamResampler} */ (this.#resampler).push(pcm), (v) => Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 0x8000 : 0x7fff)));
    if (this.active) this.#add(out);
    else this.#hold(out);
    this.#events(d.push(pcm));
    if (this.#held && d.speechMs >= this.minSpeechMs) this.#start();
    this.onLevel?.(d.level);
  }

  /** @param {import('../voice/detector.js').DetectorEvent[]} events */
  #events(events) {
    for (const e of events) {
      if (e.type === 'speech') this.#held = !this.active;
      else if (this.active || (this.#held && e.type === 'segment')) {
        if (!this.active) this.#start();
        this.#end(); // the cut; or a noise thrown away once already sent: the turn ends either way
      } else this.#held = false; // thrown away before it was sent: nothing at all
    }
  }

  #start() {
    this.#held = false;
    this.active = true;
    this.send.activity('start');
    for (const b of this.#before.splice(0)) this.#add(b);
  }

  /** Keeps the newest sound for the pre-roll, and all of it while speech is held. @param {Int16Array} pcm */
  #hold(pcm) {
    this.#before.push(pcm);
    if (this.#held) return;
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
