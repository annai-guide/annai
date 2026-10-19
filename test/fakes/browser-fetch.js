/** Headers a browser sends without asking first (CORS-safelisted), with the values annai could send. */
const SAFE = new Set(['accept', 'accept-language', 'content-language']);

/**
 * fetch as a browser on a page at origin makes it, for Node tests: a request that isn't simple is
 * asked about first (a preflight), and an answer without the server's leave to read it is a failure
 * without an answer, as "Failed to fetch" is in Chromium. Content-Type is counted as unsafe, as it is
 * for application/json.
 * @param {string} origin @returns {(url: string, init?: RequestInit) => Promise<Response>}
 */
export function browserFetch(origin) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const unsafe = [...headers.keys()].filter((h) => !SAFE.has(h)).sort();
    const blocked = () => new TypeError('Failed to fetch');
    if (!['GET', 'HEAD', 'POST'].includes(method) || unsafe.length) {
      const pre = await fetch(url, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method, ...(unsafe.length ? { 'access-control-request-headers': unsafe.join(',') } : {}) } }).catch(() => { throw blocked(); });
      const allowed = (pre.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map((s) => s.trim());
      const methods = (pre.headers.get('access-control-allow-methods') ?? '').toUpperCase().split(',').map((s) => s.trim());
      const from = pre.headers.get('access-control-allow-origin');
      if (!pre.ok || (from !== origin && from !== '*') || unsafe.some((h) => !allowed.includes(h)) || (!['GET', 'HEAD', 'POST'].includes(method) && !methods.includes(method))) throw blocked();
    }
    const res = await fetch(url, { ...init, headers: { ...Object.fromEntries(headers), origin } }).catch((e) => {
      if (e?.name === 'AbortError') throw e;
      throw blocked();
    });
    const from = res.headers.get('access-control-allow-origin');
    if (from !== origin && from !== '*') throw blocked();
    return res;
  };
}
