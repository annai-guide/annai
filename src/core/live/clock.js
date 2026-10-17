/**
 * Clocks for live mode (spec §11.2: one timer, for the next due watch): the real one; a manual one
 * for tests and for a simulation stepped as fast as it can go; and one running faster than real
 * time, for a simulation watched on screen (§18: 10×).
 * @typedef {{ now: () => number, set: (fn: () => void, ms: number) => any, clear: (handle: any) => void }} Clock
 */

/** The longest wait setTimeout holds (about 24.8 days); a longer one fires at once. */
const LONGEST = 2 ** 31 - 1;

/** @returns {Clock} */
export function realClock() {
  return {
    now: () => Date.now(),
    // A wait longer than setTimeout holds is waited in steps.
    set: (fn, ms) => {
      const h = { t: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined) };
      const end = Date.now() + ms;
      const step = () => {
        const left = end - Date.now();
        h.t = left > LONGEST ? setTimeout(step, LONGEST) : setTimeout(fn, Math.max(0, left));
      };
      step();
      return h;
    },
    clear: (h) => clearTimeout(h?.t),
  };
}

/** A clock that moves only when told. */
export class ManualClock {
  #now;
  /** @type {Map<number, { at: number, fn: () => void }>} */
  #timers = new Map();
  #seq = 0;
  /** @param {number} start */
  constructor(start) {
    this.#now = start;
  }
  now = () => this.#now;
  /** @param {() => void} fn @param {number} ms */
  set = (fn, ms) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn });
    return id;
  };
  /** @param {any} id */
  clear = (id) => {
    this.#timers.delete(id);
  };
  /** How many timers wait. */
  get pending() {
    return this.#timers.size;
  }
  /**
   * Moves to t, running each timer that comes due on the way, in order, and waiting for settle()
   * after each. @param {number} t @param {() => Promise<unknown>} [settle]
   */
  async advanceTo(t, settle = async () => {}) {
    for (;;) {
      /** @type {[number, { at: number, fn: () => void }] | null} */
      let next = null;
      for (const [id, x] of this.#timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
      await settle();
    }
    this.#now = Math.max(this.#now, t);
  }
}

/**
 * A clock speed times faster than real time, from start (spec §18: a trip simulation at 10×).
 * @param {number} start @param {number} speed @param {Clock} [base] @returns {Clock}
 */
export function scaledClock(start, speed, base = realClock()) {
  const t0 = base.now();
  return { now: () => start + (base.now() - t0) * speed, set: (fn, ms) => base.set(fn, Math.max(0, ms) / speed), clear: (h) => base.clear(h) };
}

/**
 * A clock that plays time at a speed from a moment, and can pause, change speed or move (spec §13:
 * the replay's playback at adjustable speed; §18: a simulation at 10×). Its timers are in its own
 * time: when it pauses, changes speed or moves, they wait again from there, and one it moved past
 * runs at once. Long waits are the base clock's to hold (the real one waits in steps).
 */
export class PlayClock {
  /** @type {Clock} */
  #base;
  /** Its time when it last started, paused, moved or changed speed… */
  #pos;
  /** …and the base's time then. */
  #t0;
  #speed;
  #playing;
  /** @type {Map<number, { at: number, fn: () => void, h: any }>} */
  #timers = new Map();
  #seq = 0;
  /** @type {Set<() => void>} */
  #listeners = new Set();

  /** @param {number} start @param {{ speed?: number, base?: Clock, playing?: boolean }} [o] */
  constructor(start, { speed = 1, base = realClock(), playing = true } = {}) {
    this.#base = base;
    this.#pos = start;
    this.#t0 = base.now();
    this.#speed = speed;
    this.#playing = playing;
  }

  now = () => (this.#playing ? this.#pos + (this.#base.now() - this.#t0) * this.#speed : this.#pos);

  /** @param {() => void} fn @param {number} ms of its own time */
  set = (fn, ms) => {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.now() + Math.max(0, ms), fn, h: null });
    this.#arm(id);
    return id;
  };

  /** @param {any} id */
  clear = (id) => {
    const t = this.#timers.get(id);
    if (t && t.h !== null) this.#base.clear(t.h);
    this.#timers.delete(id);
  };

  get speed() {
    return this.#speed;
  }

  set speed(v) {
    if (!(v > 0) || v === this.#speed) return;
    this.#mark();
    this.#speed = v;
    this.#changed();
  }

  get playing() {
    return this.#playing;
  }

  play() {
    if (this.#playing) return;
    this.#t0 = this.#base.now();
    this.#playing = true;
    this.#changed();
  }

  pause() {
    if (!this.#playing) return;
    this.#mark();
    this.#playing = false;
    this.#changed();
  }

  /** Moves to t. @param {number} t */
  seek(t) {
    this.#pos = t;
    this.#t0 = this.#base.now();
    this.#changed();
  }

  /** @param {() => void} fn @returns {() => void} */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  #mark() {
    this.#pos = this.now();
    this.#t0 = this.#base.now();
  }

  /** @param {number} id */
  #arm(id) {
    const t = this.#timers.get(id);
    if (!t || !this.#playing) return;
    t.h = this.#base.set(() => {
      t.h = null;
      if (!this.#timers.has(id)) return;
      if (this.now() + 1 < t.at) {
        this.#arm(id); // woken a little early: wait the rest
        return;
      }
      this.#timers.delete(id);
      t.fn();
    }, Math.max(0, (t.at - this.now()) / this.#speed));
  }

  #changed() {
    for (const [id, t] of this.#timers) {
      if (t.h !== null) this.#base.clear(t.h);
      t.h = null;
      this.#arm(id);
    }
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a clock listener failed', e);
      }
    }
  }
}
