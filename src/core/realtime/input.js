import { StreamResampler } from '../voice/pcm.js';
import { Detector } from '../voice/detector.js';

/**
 * A live session's microphone (spec §10.8: realtime sessions stream no silence). annai's end-of-sentence detector drives the API's
 * manual turns (decision 9): once a run has minSpeechMs of speech in it, activityStart and everything since just before it; then
 * 100 ms chunks of 16-bit PCM at the session's rate; at the cut, the rest and activityEnd. A noise thrown away sooner sends nothing.
 * Half-duplex and full duplex: spec §10.4. Full duplex only where duplex() says, and there a start needs bargeInDb more over the floor (decision 13).
 * A turn lasts maxMs at most, and cut() ends one the model has stopped transcribing; onTurn hears why each ended, in numbers.
 * @typedef {'pause' | 'cap' | 'transcript' | 'close' | 'voice' | 'noise' | 'kept'} TurnEnd  voice: Koe's began (half-duplex); noise: thrown away once sent; kept: no turn, the level check's count as the microphone closes
 */

/** How far past her voice's tail speech that began in it must go on to be the user's. */
const GO_ON_MS = 60;
/** Speech in her voice's tail with no quiet this long since she stopped was going on as she did: begun over her. */
const GAP_MS = 80;
/** Speech let go as begun over her that goes on this long past her end is the user talking over her (onOver); her echo is shorter. */
const OVER_MS = 600;
/** Since a turn's end, this many frames over the floor outside speech, or a run thrown away, make the room noisy (a word's start is 4 at most). */
const NOISY_FRAMES = 6;

export class LiveInput {
  /** Speech is being sent now. */
  active = false;
  /** Hears the sound outside a turn, piece by piece (voice.js's samples of what the level check keeps out). @type {((pcm: Int16Array) => void) | undefined} */
  onOutside;
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
  /** Speech going on now is the user's, not begun over her: a tap stopped her voice, or what was let go ended in a quiet. */
  #theirs = false;
  /** She played in the last frames, and when she last did (the clock); speech let go as begun over her: 1, not yet counted, 2: counted. */
  #was = false;
  #herEnd = 0;
  #letGo = 0;
  /** The minimum in force as the turn going on began; the frames the minimum had kept out when the last turn ended. @type {number | null} */
  #turnMin = null;
  #keptMark = 0;
  /** Runs thrown away before they were sent, and the detector's blips and those runs when the last turn ended. */
  #thrown = 0;
  #mark = 0;
  /** The gate as half-duplex sets it, on any route. */
  #herGate = 0;
  /**
   * The run going on, or the last, may be hers (annai's card arms nothing on it): begun while her voice plays, or before the gate after it. Not
   * half-duplex's "unless a quiet came between": that tells her echo is over where it is 60 ms late (the phone's speaker); where annai hears while
   * she speaks, her voice comes back later than her last frame (the real-voice check's car: 400 ms), after a quiet, so a short "Okay." of hers
   * was heard as the user's. A run needs 250 ms of speech (minSpeechMs), so the gate's 360 ms covers a loop of up to 610 ms; no real car's was
   * measured. Half-duplex never sends such a run.
   */
  overHer = false;

  /**
   * @param {{ mic: import('../voice/platform.js').Mic, send: { activity(edge: 'start' | 'end'): void, audio(bytes: Uint8Array): void, audioIn?: { rate: number } },
   *   rate?: number, pauseMs?: number, startDb?: number, minSpeechMs?: number, preRollMs?: number, chunkMs?: number, bargeInDb?: number,
   *   speaking?: () => boolean, duplex?: () => boolean, deaf?: () => boolean, tailMs?: number, maxMs?: number, onLevel?: (x: number) => void, onError?: (e: Error) => void, onOver?: () => void,
   *   minDb?: (floorDb: number) => number | null, onKept?: () => void, floorDb?: number | null,
   *   onTurn?: (t: { end: TurnEnd, ms: number, floorDb: number | null, peakDb: number | null, minDb: number | null, keptFrames: number, keptPeakDb: number | null }) => void }} o
   *   rate: what the session takes (send's audioIn); speaking: whether Koe's voice is playing; duplex: whether the user may cut her off by
   *   speaking now (else half-duplex); deaf: whether nothing heard is the user's now (an urgent line of hers, said whole); tailMs: how long after her voice half-duplex still hears nothing (her echo, the speaker's latency);
   *   maxMs: a turn's longest; onOver: speech begun over her was let go; minDb: the level check's minimum; onKept: a frame over the floor was just kept out by it
   *   to begin a turn (voice/level.js); floorDb: the floor learned earlier on this microphone; onTurn with end 'kept': the microphone closes, with sound the minimum kept out since the last turn
   */
  constructor({ mic, send, rate = send.audioIn?.rate ?? 16_000, pauseMs = 700, startDb = 10, minSpeechMs = 250, preRollMs = 300, chunkMs = 100, bargeInDb = 6,
    speaking = () => false, duplex = () => false, deaf = () => false, tailMs = 300, maxMs = 15_000, onLevel, onError, onTurn, onOver, minDb, onKept, floorDb = null }) {
    this.mic = mic;
    this.send = send;
    this.rate = rate;
    this.pauseMs = pauseMs;
    this.startDb = startDb;
    this.minSpeechMs = minSpeechMs;
    this.bargeInDb = bargeInDb;
    this.speaking = speaking;
    this.duplex = duplex;
    this.deaf = deaf;
    this.tailMs = tailMs;
    this.maxMs = maxMs;
    this.onLevel = onLevel;
    this.onError = onError;
    this.onTurn = onTurn;
    this.onOver = onOver;
    this.minDb = minDb;
    this.onKept = onKept;
    this.floorDb = floorDb;
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
    if ((this.#detector?.keptFrames ?? 0) > this.#keptMark) this.#told('kept', null);
    this.#mic?.close();
    this.onLevel?.(0);
  }

  /** Speech has begun: held until it is surely speech, or being sent. */
  get hearing() {
    return this.active || this.#held;
  }

  /** Noise since the last turn ended: frames over the floor that never became speech, or runs thrown away. */
  get noisy() {
    return (this.#detector?.blips ?? 0) + this.#thrown - this.#mark >= NOISY_FRAMES;
  }

  /** How long nothing has been over the floor (its keep margin), in ms: a word begun is louder before it is surely speech. */
  get stillMs() {
    return this.#detector?.stillMs ?? Infinity;
  }

  /** How long the turn going on has had no frame keepDb over the floor it began on, in ms: a detector whose floor fell may still call it speech. */
  get quietMs() {
    return this.active ? this.#detector?.sinceMarkMs ?? 0 : 0;
  }

  /** A tap stopped her voice: what is said at once is the user's, never begun over her (her tail ends with it: overHer too). */
  tapped() {
    this.#theirs = true;
    this.#herGate = 0;
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
      this.#detector = new Detector({ sampleRate, pauseMs: this.pauseMs, startDb: this.startDb, minSpeechMs: this.minSpeechMs, maxMs: this.maxMs, ...(this.minDb ? { minDb: this.minDb } : {}), floorDb: this.floorDb });
      this.#resampler = new StreamResampler(sampleRate, this.rate);
    }
    const d = this.#detector;
    if (this.deaf()) {
      this.#was = this.speaking();
      return this.#deaf(d);
    }
    const playing = this.speaking();
    // Her voice's first frames, if speech had begun just before (held, or loud frames in the last 40 ms, which her voice can't be yet:
    // she is let go, at the cap or in a noisy room, as a word begins), are still heard: the user's.
    const first = playing && !this.#was && (this.#held || d.stillMs < 40);
    this.#was = playing;
    this.#clock += pcm.length;
    if (playing) {
      this.#herEnd = this.#clock;
      this.#herGate = this.#clock + Math.round(((this.tailMs + GO_ON_MS) * sampleRate) / 1000);
      if (this.duplex() && (this.active || this.#held)) this.overHer = true;
    }
    if (this.duplex()) this.#gate = 0;
    else if (playing) {
      this.#gate = this.#herGate;
      this.#theirs = false;
      this.#letGo = 0;
      if (!first) return this.#deaf(d);
    }
    d.startDb = this.startDb + (playing ? this.bargeInDb : 0);
    const out = Int16Array.from(/** @type {StreamResampler} */ (this.#resampler).push(pcm), (v) => Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 0x8000 : 0x7fff)));
    if (this.active) this.#add(out);
    else this.#hold(out);
    const kept = d.keptFrames;
    this.#events(d.push(pcm));
    if (d.keptFrames > kept) this.onKept?.();
    // Speech that began in her voice's tail starts a turn only once it is still going on past the gate.
    if (this.#held && d.speechMs >= this.minSpeechMs && (!this.#tailRun || (this.#clock >= this.#gate && d.quietMs < 100))) {
      if (!this.#tailRun || this.#theirs || d.gapMs >= GAP_MS) this.#start();
      else {
        this.#held = false; // the run is let go
        this.#letGo = 1;
      }
      this.#theirs = false;
    }
    if (first && !this.duplex()) {
      if (!this.active && !(this.#held && d.speechMs)) return this.#deaf(d); // speech the detector isn't sure of yet (over a guessed floor) is not the user's
      if (this.#held) this.#start(); // the user's turn, which cuts her
    }
    // What was let go ends at its first quiet: her echo is over, and what follows is fresh. Going on OVER_MS past her end, it is the user
    // talking over her, let go to its pause (a quiet in it then is a breath).
    if (this.#letGo === 1 && d.stillMs >= GAP_MS) {
      d.reset();
      this.#letGo = 0;
      this.#theirs = true;
    } else if (this.#letGo === 1 && this.#clock - this.#herEnd >= (OVER_MS * sampleRate) / 1000) {
      this.#letGo = 2;
      this.onOver?.();
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
        this.overHer = this.duplex() && this.#clock < this.#herGate;
      } else if (this.active || (this.#held && e.type === 'segment' && !this.#tailRun)) {
        if (!this.active) this.#start();
        // The cut; or a noise thrown away once already sent: the turn ends either way.
        this.#end(e.type === 'discard' ? 'noise' : e.cut === 'end' ? 'close' : e.cut, e.type === 'segment' ? e.peakDb : null);
        // At the cap the floor has crept up with the speech: back to where it was, so what follows is heard as speech.
        if (e.type === 'segment' && e.cut === 'cap' && this.#startFloor !== null && this.#detector) this.#detector.floorDb = this.#startFloor;
      } else {
        if (e.type === 'discard') this.#thrown += NOISY_FRAMES;
        this.#held = false; // thrown away before it was sent: nothing at all
      }
    }
  }

  #start() {
    this.#held = false;
    this.active = true;
    this.#sent = 0;
    const d = /** @type {Detector} */ (this.#detector);
    this.#startFloor = d.floorDb;
    this.#turnMin = d.minNow;
    d.mark(this.#startFloor === null ? null : this.#startFloor + d.keepDb);
    this.send.activity('start');
    for (const b of this.#before.splice(0)) this.#add(b);
  }

  /** Keeps the newest sound for the pre-roll, and all of it while speech is held. @param {Int16Array} pcm */
  #hold(pcm) {
    this.onOutside?.(pcm);
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
    this.#mark = (this.#detector?.blips ?? 0) + this.#thrown;
    this.active = false;
    this.send.activity('end');
    this.#told(why, peak);
  }

  /** Why a turn ended, in numbers, with what the level check did since the last. @param {TurnEnd | 'kept'} why @param {number | null} peak */
  #told(why, peak) {
    const d = this.#detector;
    const db = (/** @type {number | null} */ x) => (x === null ? null : Math.round(x * 10) / 10);
    const kept = (d?.keptFrames ?? 0) - this.#keptMark;
    this.#keptMark = d?.keptFrames ?? 0;
    this.onTurn?.({ end: /** @type {TurnEnd} */ (why), ms: why === 'kept' ? 0 : Math.round((this.#sent / this.rate) * 1000), floorDb: db(d?.floorDb ?? null), peakDb: db(peak), minDb: db(this.#turnMin), keptFrames: kept, keptPeakDb: db(kept ? d?.keptPeakDb ?? null : null) });
    if (d) d.keptPeakDb = null;
    this.#turnMin = null;
  }
}
