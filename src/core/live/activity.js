import { meters } from './geo.js';
import { SAME_DRIVE_MS } from './triggers.js';

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
 *   at: when it happened: leaving moving fast, when its hold ran out, not when annai found out;
 *   noFix: moving fast ended only because no reading could say in NO_FIX_BACK_MS, so voice has no hold after it
 *
 * Any gap in evidence (a reload, an unlock, an old record) takes one path: the activity stays, and the first reading that can say decides. One can't if too coarse, between walking and
 * moving fast, a GPS speed too rough to read, or no speed with a way too short or fast. Moving fast holds NO_FIX_BACK_MS on screen; from an old record, as long as it takes.
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
/** No fix this long after a slow last speed (#quiet) reads as still: a parked phone hardly sends fixes. A faster one keeps the activity through a gap (a tunnel). */
export const QUIET_STILL_MS = 120_000;
/** No fix this long reads as still whatever the last speed was (a garage, a dead GPS, a lone glitch): longer than any tunnel. */
export const NO_FIX_STILL_MS = 15 * 60_000;
/** Moving fast across a gap: silence after coming back says nothing of stopping (the GPS is finding itself, a roof), so it holds this long, on screen; over five minutes, so a five-minute gap and the fix after it aren't cut. */
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
  /** @type {Fix | null} the last evidence before a gap, until a reading says; past a bound's end too */
  #before = null;
  /** @type {number | null} when moving fast began to hold over a gap; moved on by each time off screen; Infinity: an old record's, with no bound */
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
    this.#maxAcc = Math.max(this.#maxAcc, fix.accuracy);
    if (fix.accuracy > 100) { // a cell tower's says nothing, and two of them would read as no way travelled
      this.#counts.none++;
      return null;
    }
    const gap = this.#lastAt === null ? 0 : fix.at - this.#lastAt;
    const before = this.#recent.filter((f) => f.at < fix.at);
    const near = before.filter((f) => fix.at - f.at <= RECENT_MS);
    this.#recent = [...(near.length ? near : before.slice(-1)), fix];
    this.#lastAt = fix.at;
    const from = this.#before;
    const way = from && fix.at - from.at >= SPAN_MS ? waySpeed(from, fix) : null; // null: too short to say
    const went = way !== null && way >= FAST_FROM;
    const speed = this.#speedAt(fix);
    if (speed === null) {
      this.#counts.none++; // nothing to read a speed from yet
      if (way !== null && fix.speed === null) { // but the way: a slow one says stopped; a fast one, that the drive went on, not that it goes on now
        if (went) {
          this.#before = fix;
          this.#leaving = null;
          this.#stillSeen = false;
        } else this.#gapOver(from, false);
      }
      return null;
    }
    this.speed = speed;
    this.#maxSpeed = Math.max(this.#maxSpeed, speed);
    const kind = speed < STILL_BELOW ? 'still' : speed < WALK_BELOW ? 'walking' : speed >= FAST_FROM ? 'fast' : 'between';
    this.#counts[kind]++;
    this.#seen = kind === 'fast' ? 'moving-fast' : kind === 'between' ? null : kind; // between: neither
    if (this.#seen === null) { // only that she is moving: the bound is for a GPS that gives nothing, so it starts again
      if (this.#backAt !== null) this.#backAt = Math.max(this.#backAt, fix.at);
    } else {
      // An old record, a fast speed, and the way says no: that drive ended unseen.
      const unseen = kind === 'fast' && this.#backAt === Infinity && from && way !== null && !went && fix.at - from.at >= SAME_DRIVE_MS;
      // Past a bound's end, on the road: moving fast is back at once.
      const back = kind === 'fast' && this.activity !== 'moving-fast' && from && (way === null || went);
      this.#gapOver(from, went);
      if (unseen) return this.#become('still', fix.at, gap);
      if (back) return this.#become('moving-fast', fix.at, gap);
    }
    return this.#decide(fix.at, gap);
  }

  /** A gap, if any, is over: a hold starts afresh if the drive went on, else leaving moving fast dates from the last evidence. @param {Fix | null} from @param {boolean} went */
  #gapOver(from, went) {
    if (went) {
      this.#leaving = null;
      this.#stillSeen = false;
    } else if (this.activity === 'moving-fast') this.#leaving ??= from?.at ?? null;
    this.#before = this.#backAt = null;
  }

  /**
   * Asked without a new fix (live mode's recheck): a held change completes on time; no fix for QUIET_STILL_MS after a slow last speed is still, and for NO_FIX_STILL_MS
   * after any. A gap's hold ends at its bound, with #before kept for the next reading.
   * @param {number} now @returns {Change | null}
   */
  tick(now) {
    if (this.#lastAt === null) return null;
    const gap = now - this.#lastAt;
    if (this.#backAt !== null) {
      if (now - this.#backAt < NO_FIX_BACK_MS) return null;
      this.#backAt = this.#leaving = null;
      return { ...this.#become('still', now, gap), noFix: true };
    }
    if ((this.#quiet() && gap >= QUIET_STILL_MS) || (this.activity !== 'still' && gap >= NO_FIX_STILL_MS)) return this.#become('still', now, gap);
    return this.#leaving === null ? null : this.#decide(now, gap); // only a fix starts a hold
  }

  /** annai started again, knowing the activity from before: no fix yet, and a gap counting from now. @param {Activity} activity @param {number} now @param {Fix | null} [from] the last place it knows @param {boolean} [old] too old to say so: a hold with no bound */
  restore(activity, now, from = null, old = false) {
    const fast = activity === 'moving-fast';
    this.activity = activity;
    this.#lastAt = now;
    this.#before = fast ? from : null;
    this.#backAt = !fast ? null : old ? Infinity : now;
  }

  /** What a quiet stretch rested on, for the trace: a change's why, and the largest speed and accuracy since. Starts those counts again. @param {number} now */
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

  /** Moving fast is held across a gap. */
  get holding() {
    return this.#backAt !== null;
  }

  /** No reading has said what became of the drive: held, or past a bound's end. */
  get unsure() {
    return this.#backAt !== null || this.#before !== null;
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
   * The GPS (re)started after annai was off screen: a gap counts from now, and the speed before says nothing of now. A change starts holding again with the next fix,
   * except leaving moving fast. Moving fast holds from now, or, held already, goes on: only time on screen counts towards NO_FIX_BACK_MS.
   * @param {number} now @param {number} [since] when annai went off screen
   */
  heard(now, since = now) {
    const last = this.#lastAt;
    const fast = this.activity === 'moving-fast';
    if (last !== null) this.#lastAt = Math.max(last, now);
    if (!fast) {
      this.#leaving = null;
      this.#stillSeen = false;
    }
    this.#target = null;
    this.#seen = null;
    if (fast) this.#before ??= this.#recent.at(-1) ?? null;
    this.#backAt = !fast ? null : this.#backAt === null ? now : this.#backAt + (now - since);
    this.#recent = [];
    this.speed = null; // a fast speed from before would hold moving fast through any silence
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
