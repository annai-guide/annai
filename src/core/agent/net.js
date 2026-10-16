import { logEvent } from '../events.js';

/**
 * Web requests by tools and plugins, each recorded as a net.request (spec §4.5, §15): the trace
 * shows every request the agent sends. The address is kept as sent, except a username or password
 * and the values of credential-named query parameters, which are blanked.
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */

const CREDENTIAL = /key|token|secret|sig|auth|pass|session|credential/i;

/** @param {string} url */
export function traceUrl(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (CREDENTIAL.test(k)) u.searchParams.set(k, '«key»');
    return u.href;
  } catch {
    return String(url).split('#')[0];
  }
}

/**
 * @param {import('../types.js').Store} store @param {string} scope @param {{ tool: string, wake?: string }} who
 * @param {Fetch} [get] @returns {Fetch}
 */
export function tracedFetch(store, scope, who, get = (url, init) => fetch(url, init)) {
  return async (url, init = {}) => {
    const started = Date.now();
    const base = { kind: 'web', tool: who.tool, ...(who.wake ? { wake: who.wake } : {}), url: traceUrl(url), method: init.method ?? 'GET' };
    try {
      const res = await get(url, init);
      const bytes = Number(res.headers.get('content-length')) || undefined;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: res.status, ms: Date.now() - started, ...(bytes ? { bytes } : {}) } }).catch(() => {});
      return res;
    } catch (e) {
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: 0, ms: Date.now() - started, error: String(/** @type {any} */ (e)?.message ?? e) } }).catch(() => {});
      throw e;
    }
  };
}
