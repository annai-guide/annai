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
