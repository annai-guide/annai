import { meters } from './geo.js';

/**
 * The activity sensor's reasoning (spec §11.2): still, walking or moving fast, from GPS speed,
 * with 30–60 s hysteresis. GPS can't tell driving from riding a bus; both are moving fast, and
 * voice Auto treats them the same (§10.5).
 *
 * An activity ends once no speed has said it for the hold, and what follows is what the last speed
 * said. The slow speeds on the way need not agree: at a stop they wander across STILL_BELOW, and
 * each change of mind starting the hold again kept "moving fast" for minutes after parking (second drive).
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {{ from: Activity, to: Activity, at: number }} Change
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
/** No fix this long after a last speed that was slow (below walking, while moving fast; below moving fast otherwise) reads as still: a parked phone hardly sends fixes. A faster last speed keeps the activity through a gap (a tunnel). */
export const QUIET_STILL_MS = 120_000;
/** Without the GPS's own speed, it is worked out from the oldest point at least this far back… */
const SPAN_MS = 15_000;
/** …and at most this far, the longer the span, the less GPS jitter looks like walking; or from the fix before, when there is none so near. */
const RECENT_MS = 60_000;

export class ActivityTracker {
  /** @type {Activity} */
  activity = 'unknown';
  /** The speed last worked out, m/s. @type {number | null} */
  speed = null;
  /** @type {number | null} since when the speeds have said something other than the activity */
  #leaving = null;
  /** @type {Fix[]} */
  #recent = [];
  /** @type {number | null} when the last fix came */
  #lastAt = null;
  /** @type {Activity | null} what the last speed said (null: between walking and moving fast) */
  #seen = null;

  /** @param {Fix} fix @returns {Change | null} the change, when there is one */
  feed(fix) {
    const before = this.#recent.filter((f) => f.at < fix.at);
    const near = before.filter((f) => fix.at - f.at <= RECENT_MS);
    this.#recent = [...(near.length ? near : before.slice(-1)), fix];
    this.#lastAt = fix.at;
    const speed = this.#speedAt(fix);
    if (speed !== null) {
      this.speed = speed;
      this.#seen = speed < STILL_BELOW ? 'still' : speed < WALK_BELOW ? 'walking' : speed >= FAST_FROM ? 'moving-fast' : null; // between: neither
    }
    return this.#decide(fix.at);
  }

  /**
   * Asked without a new fix (live mode's recheck): a held change completes on time, the last speed seen
   * counting as still holding; no fix for QUIET_STILL_MS after a slow last speed is still.
   * @param {number} now @returns {Change | null}
   */
  tick(now) {
    if (this.#lastAt === null) return null;
    if (this.#quiet() && now - this.#lastAt >= QUIET_STILL_MS) return this.#become('still', now);
    return this.#leaving === null ? null : this.#decide(now); // only a fix starts a hold: a last speed from before a quiet GPS says nothing new
  }

  /** When tick could next change something, or null. @returns {number | null} */
  due() {
    if (this.#lastAt === null) return null;
    const held = this.#leaving !== null && this.#seen !== null ? this.#leaving + this.#hold() : Infinity;
    const t = Math.min(held, this.#quiet() ? this.#lastAt + QUIET_STILL_MS : Infinity);
    return t === Infinity ? null : t;
  }

  /** The GPS (re)started, after annai was off screen: a gap counts from now, a change starts holding again with the next fix, and the way travelled meanwhile says nothing of the speed now. @param {number} now */
  heard(now) {
    if (this.#lastAt !== null) this.#lastAt = Math.max(this.#lastAt, now);
    this.#leaving = null;
    this.#recent = [];
  }

  /** @param {number} at @returns {Change | null} */
  #decide(at) {
    const seen = this.#seen;
    if (seen === null) return null;
    if (seen === this.activity) {
      this.#leaving = null;
      return null;
    }
    this.#leaving ??= at;
    if (at - this.#leaving < this.#hold()) return null;
    return this.#become(seen, at);
  }

  /** @param {Activity} to @param {number} at @returns {Change} */
  #become(to, at) {
    const change = { from: this.activity, to, at };
    this.activity = to;
    this.#leaving = null;
    return change;
  }

  #hold() {
    return this.activity === 'moving-fast' ? LEAVE_FAST_MS : SETTLE_MS;
  }

  /** The last speed was a slow one (while moving fast, below walking: slow traffic before a tunnel isn't a stop), and the activity isn't still yet. */
  #quiet() {
    return this.speed !== null && this.speed < (this.activity === 'moving-fast' ? WALK_BELOW : FAST_FROM) && this.activity !== 'still';
  }

  /** Forgets everything: live mode went off. */
  reset() {
    this.activity = 'unknown';
    this.speed = null;
    this.#leaving = null;
    this.#recent = [];
    this.#lastAt = null;
    this.#seen = null;
  }

  /**
   * m/s: the GPS's own, when it gives one with a usable fix; else over the last 15 to 60 s (or the gap since the last fix), less what
   * the accuracy of both ends could explain: each can be off by its accuracy, so jitter at a stop
   * reads as no speed at all.
   * @param {Fix} fix
   */
  #speedAt(fix) {
    if (fix.speed !== null && fix.accuracy <= 50) return fix.speed;
    const old = this.#recent.find((f) => fix.at - f.at >= SPAN_MS); // the oldest kept, at most RECENT_MS back
    if (!old) return null;
    const d = Math.max(0, meters(old, fix) - (old.accuracy + fix.accuracy));
    return d / ((fix.at - old.at) / 1000);
  }
}
