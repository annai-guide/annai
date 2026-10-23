// A clock for tests of code that waits on timers (windows, quiet spells, limits), so that they do not depend on how fast the machine is.
import { createHook } from 'node:async_hooks';

/** The kinds of async resource that are a request to the runtime, to be answered once (a hash, a file read, a write); a handle stays open. */
const REQUEST = /(REQ|REQUEST|REQCALLBACK|REQPROMISE|REQWRAP|CONNECTWRAP|WRITEWRAP|SHUTDOWNWRAP)$/;
/** How many turns of the event loop in a row must find nothing in flight before a timer fires: a chain of setImmediate this deep finishes first. */
const IDLE_TURNS = 16;

/**
 * Time that passes only when nothing else seems able to run. setTimeout, setInterval and Date.now are replaced for the rest of the test
 * (t.after puts them back): a timer does not fire after its milliseconds of real time but once the event loop has been idle for
 * IDLE_TURNS turns in a row with no request of the runtime in flight, and then Date.now() reads as far on as the timer's time. The code
 * under test sees its windows and limits at exactly their lengths, in their order, however slow the machine is, and a test that "waits
 * 30 ms" waits for what the code does in the first 30 ms of its clock, not for a machine to keep up with a stopwatch. A pause of 30 ms
 * costs no real time at all.
 *
 * What "nothing else can run" covers, and what it does not (so a test knows when to keep the real clock):
 * - Held back for: promises and microtasks (a timer fires from the event loop, after them); a chain of setImmediate up to IDLE_TURNS
 *   deep; and a request of the runtime in flight that async_hooks names as one (a name ending in REQ, REQUEST, REQCALLBACK, REQPROMISE,
 *   REQWRAP, CONNECTWRAP, WRITEWRAP or SHUTDOWNWRAP: a hash, a file read, a write, a connection being made).
 * - NOT held back for, so a timer may fire before they finish: a setImmediate chain deeper than IDLE_TURNS; work that goes through
 *   streams or native code with no request of those names (a Response over a Blob's stream, a CompressionStream: measured, a 20 s timer
 *   fired before a gzip finished); anything that waits on real time itself.
 * - Not replaced, so they stay on real time: new Date() without an argument, performance.now(), AbortSignal.timeout() and
 *   timers/promises. Code that times itself with those (a latency in ms, a timeout signal) does not see the clock.
 * - While a request is in flight the clock spins on the event loop at full speed (100% of a CPU) until it is answered.
 * - A request that only a fake timer can answer (an in-process server that delays with setTimeout, a stub that waits on a timer before
 *   it replies to a socket) deadlocks: the timer is held for the request, and the request waits for the timer. A test with a live socket
 *   or such a server keeps the real clock (the live Koe tests do).
 * - Make what the test reads from files (clip(), a fixture) before the code under test needs it, or let the clock wait for it as above.
 * @param {import('node:test').TestContext} t
 */
export function useClock(t) {
  const real = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, now: Date.now };
  let now = real.now();
  let next = 0;
  /** @type {{ at: number, id: number, fn: () => void, every: number, delay: number, off?: boolean }[]} the timers, earliest first */
  const timers = [];
  /** @type {ReturnType<typeof setImmediate> | null} */
  let turn = null;
  /** Turns of the event loop in a row on which nothing was in flight: a timer fires after IDLE_TURNS of them. */
  let quiet = 0;

  /** @param {{ at: number, id: number }} a @param {{ at: number, id: number }} b */
  const before = (a, b) => a.at - b.at || a.id - b.id;
  /** @param {() => void} fn @param {number} ms @param {number} every */
  const add = (fn, ms, every) => {
    // As Node's own: 1 ms at least, and no more than 2^31 - 1.
    const delay = Number.isFinite(Number(ms)) ? Math.max(1, Math.min(Number(ms), 2 ** 31 - 1)) : 1;
    const timer = { at: now + delay, id: next++, fn, every, delay };
    timers.push(timer);
    timers.sort(before);
    if (!turn) turn = real.setImmediate(run);
    return handle(timer);
  };
  /** The object a timer gives back: ref and unref are accepted, as Node's own take them; refresh() starts its time again from now. @param {typeof timers[number]} timer */
  const handle = (timer) => ({
    ref() { return this; }, unref() { return this; }, hasRef: () => true,
    refresh() {
      if (timer.off) return this;
      timer.at = now + (timer.every || timer.delay);
      timer.id = next++;
      if (!timers.includes(timer)) timers.push(timer);
      timers.sort(before);
      if (!turn) turn = real.setImmediate(run);
      return this;
    },
    [Symbol.toPrimitive]: () => timer.id, timer,
  });
  /** @param {any} h */
  const clear = (h) => {
    const timer = h?.timer;
    if (!timer) return;
    timer.off = true;
    const i = timers.indexOf(timer);
    if (i >= 0) timers.splice(i, 1);
  };
  /** The requests made to the runtime and not yet answered, by id. @type {Map<number, string>} */
  const inFlight = new Map();
  const hook = createHook({
    init(id, type) { if (REQUEST.test(type)) inFlight.set(id, type); },
    before(id) { inFlight.delete(id); },
    destroy(id) { inFlight.delete(id); },
  }).enable();
  const busy = () => inFlight.size > 0;
  function run() {
    turn = null;
    try {
      if (!timers.length) return;
      if (busy()) {
        quiet = 0;
        return;
      }
      if (++quiet < IDLE_TURNS) return;
      quiet = 0;
      const timer = /** @type {NonNullable<typeof timers[number]>} */ (timers.shift());
      now = Math.max(now, timer.at);
      if (timer.every) {
        timer.at = now + timer.every;
        timer.id = next++;
        timers.push(timer);
        timers.sort(before);
      }
      timer.fn();
    } finally {
      if (timers.length && !turn) turn = real.setImmediate(run);
    }
  }

  Object.assign(globalThis, {
    setTimeout: (/** @type {(...a: any[]) => void} */ fn, /** @type {number} */ ms = 0, /** @type {any[]} */ ...args) => add(() => fn(...args), ms, 0),
    setInterval: (/** @type {(...a: any[]) => void} */ fn, /** @type {number} */ ms = 0, /** @type {any[]} */ ...args) => add(() => fn(...args), ms, Math.max(1, Number(ms) || 1)),
    clearTimeout: clear,
    clearInterval: clear,
  });
  Date.now = () => now;
  t.after(() => {
    hook.disable();
    Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval });
    Date.now = real.now;
    if (turn) real.clearImmediate(turn);
  });
}
