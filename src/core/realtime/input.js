import { StreamResampler } from '../voice/pcm.js';
import { Detector } from '../voice/detector.js';

/**
 * A live session's microphone (the Koe and Kokoro design: realtime sessions stream no silence). annai's end-of-sentence
 * detector drives the API's manual turns (decision 9): once a run has minSpeechMs of speech in it, activityStart and
 * everything since just before it; then 100 ms chunks of 16-bit PCM at the session's rate; at the cut, the rest and
 * activityEnd. A click or a door slam, thrown away sooner, sends nothing: no turn to pay for, no sound off the phone.
 * Half-duplex (spec §10.4): while Koe plays, nothing heard starts a turn or is kept, and the detector's floor doesn't learn her
 * voice; the phone's speaker is loud at its own microphone, and she cut herself off (the iPhone trace, 2026-10-22). For tailMs
 * after (her echo, the speaker's latency), what is heard is kept, but speech that began then starts a turn only if it goes on
 * at least GO_ON_MS past it: her echo dies inside it, and a quick "yes" right after her question is sent whole. Speech going on as she
 * stops, with no quiet before it, began over her: half-duplex heard none of its start, so all of it is let go, until a real pause
 * (onOver; the realtime check, 2026-10-22: its tail went as a turn, and was answered). Full duplex only where duplex() says (headphones or the car, cutting in by voice on): there a
 * start needs bargeInDb more over the floor (decision 13), as her voice from the car's speakers is quieter than a passenger.
 * A turn lasts maxMs at most, and cut() ends one the model has stopped transcribing; onTurn hears why each ended, in numbers.
 * @typedef {'pause' | 'cap' | 'transcript' | 'close' | 'voice' | 'noise'} TurnEnd  voice: Koe's began (half-duplex); noise: thrown away once sent
 */

/** How far past her voice's tail speech that began in it must go on to be the user's. */
const GO_ON_MS = 60;
/** Speech in her voice's tail with no quiet this long since she stopped was going on as she did: begun over her. */
const GAP_MS = 80;

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
  /** Samples heard, at the microphone's rate; and until when, after her voice, speech must go on to start a turn (half-duplex). */
  #clock = 0;
  #gate = 0;
  /** The run of speech going on began before the gate. */
  #tailRun = false;
  /** The floor when the turn going on began, in dB. @type {number | null} */
  #startFloor = null;
  /** Samples sent in the turn going on. */
  #sent = 0;
  /** A tap stopped her voice: speech going on now is the user's. */
  #tapped = false;

  /**
   * @param {{ mic: import('../voice/platform.js').Mic, send: { activity(edge: 'start' | 'end'): void, audio(bytes: Uint8Array): void, audioIn?: { rate: number } },
   *   rate?: number, pauseMs?: number, startDb?: number, minSpeechMs?: number, preRollMs?: number, chunkMs?: number, bargeInDb?: number,
   *   speaking?: () => boolean, duplex?: () => boolean, tailMs?: number, maxMs?: number, onLevel?: (x: number) => void, onError?: (e: Error) => void, onOver?: () => void,
   *   onTurn?: (t: { end: TurnEnd, ms: number, floorDb: number | null, peakDb: number | null }) => void }} o
   *   rate: what the session takes (send's audioIn, K6); speaking: whether Koe's voice is playing; duplex: whether the user may cut her off by
   *   speaking now (else half-duplex); tailMs: how long after her voice half-duplex still hears nothing (her echo, the speaker's latency);
   *   maxMs: a turn's longest (the iPhone trace: one ran on for 29 s); onOver: speech begun over her was let go
   */
  constructor({ mic, send, rate = send.audioIn?.rate ?? 16_000, pauseMs = 700, startDb = 10, minSpeechMs = 250, preRollMs = 300, chunkMs = 100, bargeInDb = 6,
    speaking = () => false, duplex = () => false, tailMs = 300, maxMs = 15_000, onLevel, onError, onTurn, onOver }) {
    this.mic = mic;
    this.send = send;
    this.rate = rate;
    this.pauseMs = pauseMs;
    this.startDb = startDb;
    this.minSpeechMs = minSpeechMs;
    this.bargeInDb = bargeInDb;
    this.speaking = speaking;
    this.duplex = duplex;
    this.tailMs = tailMs;
    this.maxMs = maxMs;
    this.onLevel = onLevel;
    this.onError = onError;
    this.onTurn = onTurn;
    this.onOver = onOver;
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

  /** Speech has begun: held until it is surely speech, or being sent. */
  get hearing() {
    return this.active || this.#held;
  }

  /** How long the turn going on has had no frame keepDb over the floor it began on, in ms: a detector whose floor fell may still call it speech. */
  get quietMs() {
    return this.active ? this.#detector?.sinceMarkMs ?? 0 : 0;
  }

  /** A tap stopped her voice: what is said at once is the user's, never begun over her. */
  tapped() {
    this.#tapped = true;
  }

  /** The turn going on ends now (its transcript stalled); the floor goes back to where it began. @param {TurnEnd} why */
  cut(why) {
    if (!this.active || this.#closed) return;
    this.#end(why);
    this.#held = false;
    this.#before = [];
    this.#detector?.reset({ floor: this.#startFloor });
  }

  /** @param {Float32Array} pcm @param {number} sampleRate */
  #frames(pcm, sampleRate) {
    if (this.#closed) return;
    if (this.#detector?.sampleRate !== sampleRate) {
      this.#detector = new Detector({ sampleRate, pauseMs: this.pauseMs, startDb: this.startDb, minSpeechMs: this.minSpeechMs, maxMs: this.maxMs });
      this.#resampler = new StreamResampler(sampleRate, this.rate);
    }
    const d = this.#detector;
    const playing = this.speaking();
    this.#clock += pcm.length;
    if (this.duplex()) this.#gate = 0;
    else if (playing) {
      this.#gate = this.#clock + Math.round(((this.tailMs + GO_ON_MS) * sampleRate) / 1000);
      this.#tapped = false;
      return this.#deaf(d);
    }
    d.startDb = this.startDb + (playing ? this.bargeInDb : 0);
    const out = Int16Array.from(/** @type {StreamResampler} */ (this.#resampler).push(pcm), (v) => Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 0x8000 : 0x7fff)));
    if (this.active) this.#add(out);
    else this.#hold(out);
    this.#events(d.push(pcm));
    // Speech that began in her voice's tail starts a turn only once it is still going on past the gate.
    if (this.#held && d.speechMs >= this.minSpeechMs && (!this.#tailRun || (this.#clock >= this.#gate && d.quietMs < 100))) {
      if (!this.#tailRun || this.#tapped || d.gapMs >= GAP_MS) this.#start();
      else {
        this.#held = false; // the run is let go, to its pause
        this.onOver?.();
      }
      this.#tapped = false;
    }
    this.onLevel?.(d.level);
  }

  /**
   * Half-duplex, her voice playing: what the microphone hears is hers, so it is dropped, with the pre-roll; speech that was being
   * sent ends where her voice began (else her voice would go as the user's). @param {import('../voice/detector.js').Detector} d
   */
  #deaf(d) {
    if (this.active) this.#end('voice');
    this.#held = false;
    this.#before = [];
    d.reset();
    this.onLevel?.(0);
  }

  /** @param {import('../voice/detector.js').DetectorEvent[]} events */
  #events(events) {
    for (const e of events) {
      if (e.type === 'speech') {
        this.#held = !this.active;
        this.#tailRun = this.#clock < this.#gate;
      } else if (this.active || (this.#held && e.type === 'segment' && !this.#tailRun)) {
        if (!this.active) this.#start();
        // The cut; or a noise thrown away once already sent: the turn ends either way.
        this.#end(e.type === 'discard' ? 'noise' : e.cut === 'end' ? 'close' : e.cut, e.type === 'segment' ? e.peakDb : null);
        // At the cap the floor has crept up with the speech: back to where it was, so what follows is heard as speech.
        if (e.type === 'segment' && e.cut === 'cap' && this.#startFloor !== null && this.#detector) this.#detector.floorDb = this.#startFloor;
      } else this.#held = false; // thrown away before it was sent: nothing at all
    }
  }

  #start() {
    this.#held = false;
    this.active = true;
    this.#sent = 0;
    const d = /** @type {Detector} */ (this.#detector);
    this.#startFloor = d.floorDb;
    d.mark(this.#startFloor === null ? null : this.#startFloor + d.keepDb);
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
    this.#sent += this.#n;
    this.#n = 0;
  }

  /** @param {TurnEnd} why @param {number | null} [peak] the run's, once the detector has let go of it */
  #end(why, peak = this.#detector?.peakDb ?? null) {
    this.#flush();
    this.active = false;
    this.send.activity('end');
    const db = (/** @type {number | null} */ x) => (x === null ? null : Math.round(x * 10) / 10);
    this.onTurn?.({ end: why, ms: Math.round((this.#sent / this.rate) * 1000), floorDb: db(this.#detector?.floorDb ?? null), peakDb: db(peak) });
  }
}
