// A clock for tests of code that waits on timers (windows, quiet spells, limits), so that they do not depend on how fast the machine is.
import { createHook } from 'node:async_hooks';

/** The kinds of async resource that are a request to the runtime, to be answered once (a hash, a file read, a write); a handle stays open. */
const REQUEST = /(REQ|REQUEST|REQCALLBACK|REQPROMISE|REQWRAP|CONNECTWRAP|WRITEWRAP|SHUTDOWNWRAP)$/;

/**
 * Time that passes only when nothing else can run. setTimeout, setInterval and Date.now are replaced for the rest of the test
 * (t.after puts them back): a timer does not fire after its milliseconds of real time but when everything that can run has run, and
 * then Date.now() reads as far on as the timer's time. The code under test sees its windows and limits at exactly their lengths, in
 * their order, however slow the machine is, and a test that "waits 30 ms" waits for what the code does in the first 30 ms of its
 * clock, not for a machine to keep up with a stopwatch. A pause of 30 ms costs no real time at all.
 *
 * For code that touches no sockets or other processes: a timer is held back while a request of the runtime is in flight (a hash, a file
 * read: async_hooks says when one has been made and not yet answered), but a test with a live socket should keep the real clock, as its
 * server answers in real time.
 * @param {import('node:test').TestContext} t
 */
export function useClock(t) {
  const real = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, now: Date.now };
  let now = real.now();
  let next = 0;
  /** @type {{ at: number, id: number, fn: () => void, every: number, off?: boolean }[]} the timers, earliest first */
  const timers = [];
  /** @type {ReturnType<typeof setImmediate> | null} */
  let turn = null;

  /** @param {{ at: number, id: number }} a @param {{ at: number, id: number }} b */
  const before = (a, b) => a.at - b.at || a.id - b.id;
  /** @param {() => void} fn @param {number} ms @param {number} every */
  const add = (fn, ms, every) => {
    // As Node's own: 1 ms at least, and no more than 2^31 - 1.
    const delay = Number.isFinite(Number(ms)) ? Math.max(1, Math.min(Number(ms), 2 ** 31 - 1)) : 1;
    const timer = { at: now + delay, id: next++, fn, every };
    timers.push(timer);
    timers.sort(before);
    if (!turn) turn = real.setImmediate(run);
    return handle(timer);
  };
  /** The object a timer gives back: ref and unref are accepted, as Node's own take them. @param {{ id: number, off?: boolean }} timer */
  const handle = (timer) => ({
    ref() { return this; }, unref() { return this; }, hasRef: () => true, refresh() { return this; },
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
      if (!timers.length || busy()) return;
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
