import { meters } from './geo.js';

/**
 * The activity sensor's reasoning (spec §11.2): still, walking or moving fast, from GPS speed,
 * with 30–60 s hysteresis. GPS can't tell driving from riding a bus; both are moving fast, and
 * voice treats them the same (§10.5).
 *
 * An activity ends once no speed has said it for the hold. Leaving moving fast, the slow speeds need not agree (at a stop they wander across
 * STILL_BELOW): any that said still in the hold makes it still, else it is what the last speed said. A hold towards another activity starts
 * again when the speeds say a third one.
 * @typedef {'still' | 'walking' | 'moving-fast' | 'unknown'} Activity
 * @typedef {import('./geo.js').Fix} Fix
 * @typedef {{ heldS: number, gapS: number, readings: Record<string, number>, heards: number }} Why  what a change rested on, for the trace
 * @typedef {{ from: Activity, to: Activity, at: number, why: Why, noFix?: boolean }} Change
 *   at: when it happened: leaving moving fast, when its hold ran out, not when annai found out (a locked phone);
 *   noFix: moving fast ended only because no good fix came back in NO_FIX_BACK_MS: the way to the next one says whether it was the same drive
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
/** No fix this long reads as still whatever the last speed was (a garage, a dead GPS, a lone glitch): longer than any tunnel. */
export const NO_FIX_STILL_MS = 15 * 60_000;
/**
 * Moving fast across a reload or an unlock, with no good fix since: silence right after coming back says nothing of stopping (the GPS is finding itself, or a phone in a
 * car under a roof), so it holds this long. A little over five minutes, so a five-minute gap and the fix after it aren't cut. Then it ends, dated from the last fix.
 */
export const NO_FIX_BACK_MS = 330_000;
/** Without the GPS's own speed, it is worked out from the oldest point at least this far back… */
const SPAN_MS = 15_000;
/** …and at most this far, the longer the span, the less GPS jitter looks like walking; or from the fix before, when there is none so near. */
const RECENT_MS = 60_000;

/** m/s from a to b, less what the accuracy of both could explain: jitter at a stop reads as no speed. @param {Fix} a @param {Fix} b */
export const waySpeed = (a, b) => (b.at > a.at ? Math.max(0, meters(a, b) - (a.accuracy + b.accuracy)) / ((b.at - a.at) / 1000) : 0);

export class ActivityTracker {
  /** @type {Activity} */
  activity = 'unknown';
  /** The speed last worked out, m/s; null: none since annai started or came back, which reads as slow. @type {number | null} */
  speed = null;
  /** @type {number | null} since when the speeds have said something other than the activity */
  #leaving = null;
  /** @type {Fix[]} */
  #recent = [];
  /** @type {Fix | null} the last fix before annai went off screen, until a good one back */
  #before = null;
  /** @type {number | null} when annai came back moving fast, until a good fix decides */
  #backAt = null;
  /** @type {number | null} when the last fix came */
  #lastAt = null;
  /** @type {Activity | null} what the last speed said (null: between walking and moving fast) */
  #seen = null;
  /** @type {Activity | null} what the hold is towards (when leaving anything but moving fast) */
  #target = null;
  /** Whether a speed in the hold said still. */
  #stillSeen = false;
  /** @type {Record<'still' | 'walking' | 'between' | 'fast' | 'none', number>} */
  #counts = zero();
  /** Times the GPS restarted since the last change. */
  #heards = 0;
  /** The largest speed and accuracy read since the last change or beat. */
  #maxSpeed = 0;
  #maxAcc = 0;

  /** @param {Fix} fix @returns {Change | null} the change, when there is one */
  feed(fix) {
    if (this.#backAt !== null) {
      if (fix.accuracy > 100) { // a cell tower's says nothing of a drive, and two of them read as no way travelled
        this.#lastAt = fix.at;
        this.#maxAcc = Math.max(this.#maxAcc, fix.accuracy);
        this.#counts.none++;
        return null;
      }
      this.#backAt = null;
    }
    const gap = this.#lastAt === null ? 0 : fix.at - this.#lastAt;
    if (this.#before) {
      if (this.activity === 'moving-fast' && waySpeed(this.#before, fix) >= FAST_FROM) { // the drive went on
        this.#leaving = null;
        this.#stillSeen = false;
      }
      if (fix.accuracy <= 100) this.#before = null;
    }
    const before = this.#recent.filter((f) => f.at < fix.at);
    const near = before.filter((f) => fix.at - f.at <= RECENT_MS);
    this.#recent = [...(near.length ? near : before.slice(-1)), fix];
    this.#lastAt = fix.at;
    this.#maxAcc = Math.max(this.#maxAcc, fix.accuracy);
    const speed = this.#speedAt(fix);
    if (speed === null) {
      this.#counts.none++; // nothing to read a speed from yet: it says nothing, and nothing is decided
      return null;
    }
    this.speed = speed;
    this.#maxSpeed = Math.max(this.#maxSpeed, speed);
    const kind = speed < STILL_BELOW ? 'still' : speed < WALK_BELOW ? 'walking' : speed >= FAST_FROM ? 'fast' : 'between';
    this.#counts[kind]++;
    this.#seen = kind === 'fast' ? 'moving-fast' : kind === 'between' ? null : kind; // between: neither
    return this.#decide(fix.at, gap);
  }

  /**
   * Asked without a new fix (live mode's recheck): a held change completes on time, the last speed seen
   * counting as still holding; no fix for QUIET_STILL_MS after a slow last speed is still, and for NO_FIX_STILL_MS after any.
   * Moving fast across a reload or an unlock holds until a good fix decides, for at most NO_FIX_BACK_MS.
   * @param {number} now @returns {Change | null}
   */
  tick(now) {
    if (this.#lastAt === null) return null;
    const gap = now - this.#lastAt;
    if (this.#backAt !== null) {
      if (now - this.#backAt < NO_FIX_BACK_MS) return null;
      this.#backAt = null;
      this.#leaving ??= this.#before?.at ?? null; // dated from the last fix, as a hold that began there
      return { ...this.#become('still', now, gap), noFix: true };
    }
    if ((this.#quiet() && gap >= QUIET_STILL_MS) || (this.activity !== 'still' && gap >= NO_FIX_STILL_MS)) return this.#become('still', now, gap);
    return this.#leaving === null ? null : this.#decide(now, gap); // only a fix starts a hold: a last speed from before a quiet GPS says nothing new
  }

  /** annai started again and knows the activity from before: that, with no fix yet, and a gap counting from now. @param {Activity} activity @param {number} now @param {Fix | null} [from] the last place it knows */
  restore(activity, now, from = null) {
    this.activity = activity;
    this.#lastAt = now;
    this.#before = from;
    this.#backAt = activity === 'moving-fast' ? now : null;
  }

  /** What a quiet stretch rested on, for the trace: as a change's why, and the largest speed and accuracy since the last change or beat. Starts those counts again. @param {number} now */
  beat(now) {
    const data = {
      heldS: this.#leaving === null ? 0 : Math.round((now - this.#leaving) / 1000), gapS: this.#lastAt === null ? 0 : Math.round((now - this.#lastAt) / 1000),
      readings: this.#counts, heards: this.#heards, maxSpeed: Math.round(this.#maxSpeed * 10) / 10, maxAccuracy: Math.round(this.#maxAcc),
    };
    this.#counts = zero();
    this.#heards = 0;
    this.#maxSpeed = this.#maxAcc = 0;
    return data;
  }

  /** When tick could next change something, or null. @returns {number | null} */
  due() {
    if (this.#lastAt === null) return null;
    if (this.#backAt !== null) return this.#backAt + NO_FIX_BACK_MS;
    const held = this.#leaving !== null && this.#seen !== null ? this.#leaving + this.#hold() : Infinity;
    const t = Math.min(held, this.#quiet() ? this.#lastAt + QUIET_STILL_MS : Infinity, this.activity === 'still' ? Infinity : this.#lastAt + NO_FIX_STILL_MS);
    return t === Infinity ? null : t;
  }

  /**
   * The GPS (re)started after annai was off screen: a gap counts from now, and the speed and way before it say nothing of the speed now.
   * A change starts holding again with the next fix, except leaving moving fast, which goes on (counting from the last fix if none had begun) unless the drive went on.
   * @param {number} now
   */
  heard(now) {
    const last = this.#lastAt;
    if (last !== null) this.#lastAt = Math.max(last, now);
    this.#leaving = this.activity === 'moving-fast' ? this.#leaving ?? last : null;
    if (this.#leaving === null) this.#stillSeen = false;
    this.#target = null;
    this.#seen = null;
    this.#before ??= this.#recent.at(-1) ?? null;
    this.#backAt = this.activity === 'moving-fast' ? now : null;
    this.#recent = [];
    this.speed = null; // a fast speed from before the gap would hold moving fast through any silence after it
    this.#heards++;
  }

  /** @param {number} at @param {number} gap ms since the fix before @returns {Change | null} */
  #decide(at, gap) {
    const seen = this.#seen;
    if (seen === null) return null;
    if (seen === this.activity) {
      this.#leaving = null;
      this.#stillSeen = false;
      return null;
    }
    const fast = this.activity === 'moving-fast';
    // Leaving moving fast, every slow speed is the same hold; towards anything else, the hold is for what the speeds say.
    if (this.#leaving === null || (!fast && seen !== this.#target)) {
      this.#leaving = at;
      this.#stillSeen = false;
    }
    this.#target = seen;
    if (seen === 'still') this.#stillSeen = true;
    if (at - this.#leaving < this.#hold()) return null;
    return this.#become(fast && this.#stillSeen ? 'still' : seen, at, gap);
  }

  /** @param {Activity} to @param {number} at @param {number} gap ms since the fix before @returns {Change} */
  #become(to, at, gap) {
    const why = { heldS: this.#leaving === null ? 0 : Math.round((at - this.#leaving) / 1000), gapS: Math.round(gap / 1000), readings: this.#counts, heards: this.#heards };
    const ended = this.activity === 'moving-fast' && this.#leaving !== null ? Math.min(at, this.#leaving + LEAVE_FAST_MS) : at;
    const change = { from: this.activity, to, at: ended, why };
    this.#counts = zero();
    this.#heards = 0;
    this.#maxSpeed = this.#maxAcc = 0;
    this.activity = to;
    this.#leaving = null;
    this.#stillSeen = false;
    return change;
  }

  #hold() {
    return this.activity === 'moving-fast' ? LEAVE_FAST_MS : SETTLE_MS;
  }

  /** The last speed was a slow one, or there is none (while moving fast, below walking: slow traffic before a tunnel isn't a stop), and the activity isn't still yet. */
  #quiet() {
    return (this.speed === null || this.speed < (this.activity === 'moving-fast' ? WALK_BELOW : FAST_FROM)) && this.activity !== 'still';
  }

  /** Forgets everything: live mode went off. */
  reset() {
    this.activity = 'unknown';
    this.speed = null;
    this.#leaving = null;
    this.#recent = [];
    this.#before = null;
    this.#backAt = null;
    this.#lastAt = null;
    this.#seen = null;
    this.#target = null;
    this.#stillSeen = false;
    this.#counts = zero();
    this.#heards = 0;
    this.#maxSpeed = this.#maxAcc = 0;
  }

  /**
   * m/s: the GPS's own, when it gives one with a usable fix; else over the last 15 to 60 s (or the gap since the last fix).
   * @param {Fix} fix
   */
  #speedAt(fix) {
    if (fix.speed !== null && fix.accuracy <= 50) return fix.speed;
    const old = this.#recent.find((f) => fix.at - f.at >= SPAN_MS); // the oldest kept, at most RECENT_MS back
    return old ? waySpeed(old, fix) : null;
  }
}

/** @returns {Record<'still' | 'walking' | 'between' | 'fast' | 'none', number>} */
const zero = () => ({ still: 0, walking: 0, between: 0, fast: 0, none: 0 });
