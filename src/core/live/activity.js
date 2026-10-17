import { meters } from './geo.js';

/**
 * The activity sensor's reasoning (spec §11.2): still, walking or moving fast, from GPS speed,
 * with 30–60 s hysteresis. GPS can't tell driving from riding a bus; both are moving fast, and
 * voice Auto treats them the same (§10.5).
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {import('./geo.js').Fix} Fix
 */

/** m/s: below this, still. */
export const STILL_BELOW = 0.5;
/** m/s: below this, walking (a run included). */
export const WALK_BELOW = 3;
/** m/s: from this, moving fast (18 km/h). Between WALK_BELOW and this, nothing changes. */
export const FAST_FROM = 5;
/** A new activity must hold this long… */
export const SETTLE_MS = 30_000;
/** …and leaving moving fast this long (a red light isn't the end of a drive). */
export const LEAVE_FAST_MS = 60_000;
/** Without the GPS's own speed, it is worked out from the oldest point at least this far back… */
const SPAN_MS = 15_000;
/** …and at most this far: the longer the span, the less GPS jitter looks like walking. */
const RECENT_MS = 60_000;

export class ActivityTracker {
  /** @type {Activity} */
  activity = 'unknown';
  /** The speed last worked out, m/s. @type {number | null} */
  speed = null;
  /** @type {{ activity: Activity, since: number } | null} what the speed has said lately, and since when */
  #candidate = null;
  /** @type {Fix[]} */
  #recent = [];

  /** @param {Fix} fix @returns {{ from: Activity, to: Activity, at: number } | null} the change, when there is one */
  feed(fix) {
    this.#recent = [...this.#recent.filter((f) => f.at < fix.at && fix.at - f.at <= RECENT_MS), fix];
    const speed = this.#speedAt(fix);
    if (speed === null) return null;
    this.speed = speed;
    /** @type {Activity | null} */
    const seen = speed < STILL_BELOW ? 'still' : speed < WALK_BELOW ? 'walking' : speed >= FAST_FROM ? 'moving-fast' : null;
    if (seen === null) return null; // between walking and moving fast: it says neither
    if (seen === this.activity) {
      this.#candidate = null;
      return null;
    }
    if (this.#candidate?.activity !== seen) this.#candidate = { activity: seen, since: fix.at };
    const hold = this.activity === 'moving-fast' ? LEAVE_FAST_MS : SETTLE_MS;
    if (fix.at - this.#candidate.since < hold) return null;
    const change = { from: this.activity, to: seen, at: fix.at };
    this.activity = seen;
    this.#candidate = null;
    return change;
  }

  /** Forgets everything: live mode went off. */
  reset() {
    this.activity = 'unknown';
    this.speed = null;
    this.#candidate = null;
    this.#recent = [];
  }

  /** m/s: the GPS's own, when it gives one with a usable fix; else over the last 15 to 60 s, less what the accuracy could explain. @param {Fix} fix */
  #speedAt(fix) {
    if (fix.speed !== null && fix.accuracy <= 50) return fix.speed;
    const old = this.#recent.find((f) => fix.at - f.at >= SPAN_MS); // the oldest kept, at most RECENT_MS back
    if (!old) return null;
    const d = Math.max(0, meters(old, fix) - (old.accuracy + fix.accuracy) / 2);
    return d / ((fix.at - old.at) / 1000);
  }
}
