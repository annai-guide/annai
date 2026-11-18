// A connection that goes dead, for the tests of the limit on a server's silence (QUIET_MS, answer.js's quietly), which run on fake
// timers: requests that end only when their signal aborts, a server on this machine, and a watch on work while the fake timers hold it.
import http from 'node:http';

/**
 * A request on a connection that went dead, ending only as a browser's fetch ends when its signal aborts (Chromium's and WebKit's,
 * probed 2026-11-17; Node's fetch alike against a real server, siteOn). never: nothing comes; headers: the answer
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

/**
 * A site on this machine, each request answered by answer(path, res): one that writes nothing leaves the request waiting, as a
 * connection gone dead does. asked: the paths requested. fetch: Node's own, counting in answered the answers it has had and in seen
 * the body bytes it has passed on.
 * @param {(path: string, res: import('node:http').ServerResponse) => void} answer
 */
export async function siteOn(answer) {
  /** @type {string[]} */
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    answer(req.url ?? '', res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const s = {
    base: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    asked,
    seen: 0,
    answered: 0,
    /** @param {string} url @param {RequestInit} [init] */
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      s.answered++;
      const body = res.body?.pipeThrough(new TransformStream({ transform: (part, out) => { out.enqueue(part); s.seen += part.length; } }));
      return new Response(body, res);
    },
    // The 100 ms wait: Node's fetch can clear a finished test's timer after the next test's fake clock starts, and Node's mock clock
    // (v26.13.1) then drops whatever timer holds that place in the new clock's queue; 100 ms let 24 runs side by side end their
    // connections first (the re-read of dl-limit-next's round 2, 2026-11-17). Reported upstream as
    // https://github.com/nodejs/node/issues/67593: take this wait out once a Node with the fix is the one the tests run on.
    close: async () => {
      server.closeAllConnections();
      server.close();
      await turns(() => false, 100);
    },
  };
  return s;
}
