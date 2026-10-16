/**
 * Runs fn until it succeeds or the tries run out, waiting base ms, then 3× as long each time:
 * "retry with backoff" (spec §5.4).
 * @template T
 * @param {(attempt: number) => Promise<T>} fn
 * @param {{ tries?: number, base?: number, retryIf?: (e: unknown) => boolean, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<T>}
 */
export async function retry(fn, { tries = 3, base = 500, retryIf = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt + 1 >= tries || !retryIf(e)) throw e;
      await sleep(base * 3 ** attempt);
    }
  }
}
