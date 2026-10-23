/**
 * A live voice's player, on the audio thread (spec §10.8; the pops investigation, 2026-10-23): one continuous sound for a
 * stream of 16-bit PCM pieces, whatever their sizes and however they come. Loaded by the voice-browser plugin with addModule,
 * from annai's own origin, as the capture worklet is.
 * - It resamples to the context's rate itself, linearly, carrying its place across pieces: a piece's edge is no edge in the
 *   sound. (A buffer a piece, each resampled alone, left a wrong sample at many edges: a crackle at 44.1 kHz.)
 * - It starts once PRE_MS of sound is in, or the stream has ended; and so again after running dry.
 * - About to run dry, it fades out over the sound it still has, and fades in when it plays again: a hole has no edges.
 * - 'stop' fades out over STOP_MS, then it is silent and done; 'end' plays to the last sample, then it is done (unless it
 *   had already run dry and faded out: then what was left of the fade is let go).
 * Messages in: an Int16Array (its buffer transferred), 'end', 'stop', and { sync } (answered at once with itself, once all
 * posted before it is in: the browser suite renders offline with it). Out: a report (Report in index.js) every REPORT_MS
 * while it lives, and at once when it starts playing, runs dry or is done.
 */
const audio = /** @type {any} */ (globalThis);

/**
 * Sound held before it starts. From 255 past Gemini turns (the pops investigation's table): with none, a 100 ms stall in
 * the connection would have left a hole in 85 of them; with 150 ms, in 8. Her first sound comes later by a median of 0 ms and
 * a p90 of 35 ms (it mostly is in already by her first word); 200 ms gains little more.
 */
const PRE_MS = 150;
/** The fades, running dry and starting again; and stop's. */
const FADE_MS = 5;
const STOP_MS = 12;
const REPORT_MS = 50;

class Player extends audio.AudioWorkletProcessor {
  /** @param {{ processorOptions: { rate: number } }} options */
  constructor(options) {
    super();
    const rate = options.processorOptions.rate;
    const out = audio.sampleRate;
    this.step = rate / out; // samples in for each frame out
    this.pre = Math.round((PRE_MS * rate) / 1000);
    this.fade = Math.round((FADE_MS * out) / 1000);
    this.stopFade = Math.round((STOP_MS * out) / 1000);
    this.every = Math.round((REPORT_MS * out) / 1000);
    /** The sound not yet played: buf[0] is sample number base; written samples came in all; pos is where it reads. */
    this.buf = new Float32Array(rate * 2);
    this.base = 0;
    this.written = 0;
    this.pos = 0;
    this.gain = 0;
    this.target = 0;
    this.dg = 0;
    /** wait: until enough is in; play; stop: fading out for good; done */
    this.state = 'wait';
    this.ended = false;
    /** Frames of sound played; the loudness since the last report. */
    this.played = 0;
    this.sum = 0;
    this.since = 0;
    /** For the trace: when the first sound came and how long it waited to play (frames); the holes, and their frames. */
    this.firstAt = -1;
    this.waited = 0;
    this.holes = 0;
    this.holeFrames = 0;
    this.dryAt = -1;
    this.dryWritten = -1;
    this.port.onmessage = (/** @type {MessageEvent} */ e) => this.take(e.data);
  }

  /** @param {any} d */
  take(d) {
    if (d === 'end') this.ended = true;
    else if (d === 'stop') this.stop();
    else if (d instanceof Int16Array) this.write(d);
    else if (d && d.sync !== undefined) this.port.postMessage({ sync: d.sync });
  }

  stop() {
    if (this.state === 'done' || this.state === 'stop') return;
    if (this.state === 'wait' || this.gain === 0) this.state = 'done';
    else {
      this.state = 'stop';
      this.ramp(0, this.stopFade);
    }
  }

  /** @param {Int16Array} pcm */
  write(pcm) {
    if (this.state === 'done' || this.state === 'stop' || !pcm.length) return;
    if (this.firstAt < 0) this.firstAt = audio.currentFrame;
    const keep = Math.max(0, Math.floor(this.pos) - this.base); // played already: let go
    const live = this.written - this.base - keep;
    if (live + pcm.length > this.buf.length - keep) {
      let size = this.buf.length;
      while (live + pcm.length > size) size *= 2;
      const b = size === this.buf.length ? this.buf : new Float32Array(size);
      b.set(this.buf.subarray(keep, keep + live)); // set copies as if through a temporary: overlap is safe
      this.buf = b;
      this.base += keep;
    }
    const at = this.written - this.base;
    for (let i = 0; i < pcm.length; i++) this.buf[at + i] = pcm[i] / 0x8000;
    this.written += pcm.length;
  }

  /** @param {number} to @param {number} frames */
  ramp(to, frames) {
    this.target = to;
    this.dg = (to - this.gain) / Math.max(1, frames);
  }

  /** @param {Float32Array[][]} _ @param {Float32Array[][]} outputs */
  process(_, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const now = audio.currentFrame;
    const ahead = this.written - this.pos;
    // Ended while it waits: done once nothing is left, or when nothing came since it ran dry (the faded tail is let go).
    if (this.state === 'wait' && this.ended && (ahead < 1 || this.written === this.dryWritten)) this.state = 'done';
    if (this.state === 'done') {
      this.report(now);
      return false;
    }
    let tell = false;
    const low = (this.fade + n) * this.step + 2; // what a fade-out and this quantum take
    if (this.state === 'wait' && (ahead >= this.pre || (this.ended && ahead >= 1))) {
      this.state = 'play';
      this.ramp(1, this.fade);
      tell = true;
      if (this.dryAt >= 0) {
        this.holes++;
        this.holeFrames += now - this.dryAt;
        this.dryAt = -1;
      } else if (this.played === 0) this.waited = now - this.firstAt;
    }
    if (this.state === 'play' && !this.ended) {
      if (this.target === 1 && ahead < low) this.ramp(0, this.fade); // about to run dry
      else if (this.target === 0 && ahead >= low + this.fade * this.step) this.ramp(1, this.fade); // more came in time
    }
    for (let k = 0; k < n; k++) {
      if (this.state === 'wait' || this.state === 'done') {
        out[k] = 0;
        continue;
      }
      const i = Math.floor(this.pos);
      // The last sample is played only once nothing more is coming; else the next is needed to reach past it.
      if (i >= this.written || (i + 1 >= this.written && !this.ended)) {
        out[k] = 0;
        this.ranOut(now + k);
        tell = true;
        continue;
      }
      const a = this.buf[i - this.base];
      const b = i + 1 < this.written ? this.buf[i + 1 - this.base] : 0;
      const v = (a + (b - a) * (this.pos - i)) * this.gain;
      out[k] = v;
      this.sum += v * v;
      this.played++;
      this.pos += this.step;
      if (this.gain !== this.target) {
        this.gain += this.dg;
        if ((this.dg > 0 && this.gain >= this.target) || (this.dg < 0 && this.gain <= this.target)) this.gain = this.target;
        if (this.gain === 0) {
          this.ranOut(now + k + 1);
          tell = true;
        }
      }
    }
    this.since += n;
    if (tell || this.since >= this.every) this.report(now + n);
    return this.state !== 'done';
  }

  /** Silent now: done when stopped or played out, else waiting for more (a hole, if more comes). @param {number} at its frame */
  ranOut(at) {
    this.gain = 0;
    this.target = 0;
    if (this.state === 'stop' || (this.ended && this.written - this.pos < 1)) this.state = 'done';
    else {
      this.state = 'wait';
      this.dryAt = at;
      this.dryWritten = this.written;
    }
  }

  /** @param {number} frame the context's frame it is true at */
  report(frame) {
    this.port.postMessage({
      frame, played: this.played, read: Math.floor(this.pos), written: this.written, level: this.since ? Math.sqrt(this.sum / this.since) : 0,
      playing: this.state === 'play', dry: this.state === 'wait' && this.dryAt >= 0, done: this.state === 'done', holes: this.holes, holeFrames: this.holeFrames,
      waited: Math.max(0, this.waited),
    });
    this.since = 0;
    this.sum = 0;
  }
}

audio.registerProcessor('annai-player', Player);
