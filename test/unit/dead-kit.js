// A connection that goes dead, for the tests of official.js's limit on silence (QUIET_MS), which run on fake timers: requests that
// end only when their signal aborts, and a watch on work while the fake timers hold it.

/**
 * A request on a connection that went dead, ending only as a browser's fetch ends when its signal aborts (Chromium's and WebKit's,
 * probed 2026-11-17; Node's fetch alike against a real server, official-download.test.js). never: nothing comes; headers: the answer
 * and 1 KB of its body come, then nothing. @param {RequestInit | undefined} init @param {'never' | 'headers'} how @returns {Promise<Response>}
 */
export function dead(init, how) {
  // With no signal it waits for good, as a fetch on a dead connection does.
  const signal = init?.signal;
  if (how === 'never') return new Promise((_, fail) => signal?.addEventListener('abort', () => fail(signal.reason), { once: true }));
  const body = new ReadableStream({
    start: (c) => {
      c.enqueue(new Uint8Array(1024));
      signal?.addEventListener('abort', () => c.error(signal.reason), { once: true });
    },
  });
  return Promise.resolve(new Response(body));
}

/** Work's state, read as it goes. @template T @param {Promise<T>} work */
export function watch(work) {
  const w = { state: /** @type {'pending' | 'done' | 'failed'} */ ('pending'), value: /** @type {T | undefined} */ (undefined), error: /** @type {any} */ (undefined) };
  work.then((value) => Object.assign(w, { state: 'done', value }), (error) => Object.assign(w, { state: 'failed', error }));
  return w;
}

/**
 * Lets promises and real input and output run (fake timers hold every timer) until done() holds, for up to ms of real time. The 5 s
 * default: work in memory or over this machine's loopback takes a few ms, and 5 s leaves room for a loaded host. A check that work is
 * still waiting gives 50 ms: an abort ends a fetch at once (within 1 ms in the probe), so a limit that fired early shows by then.
 * @param {() => boolean} done @param {number} [ms]
 */
export async function turns(done, ms = 5000) {
  const end = performance.now() + ms;
  while (!done() && performance.now() < end) await new Promise(setImmediate);
}
