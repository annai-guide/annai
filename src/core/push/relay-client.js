import { toBase64Url, fromBase64Url } from '../bytes.js';

/**
 * The push relay's API (spec §11.6): the public key, a reminder scheduled, a reminder cancelled.
 * Through annai's traced fetch, so every request shows in the trace (§15); the cancel token goes
 * only in the Authorization header, which the trace doesn't keep. Whatever the relay answers, a
 * failure is a RelayError in plain words, never a TypeError or SyntaxError.
 */

export const DEFAULT_RELAY = 'https://push.annai.guide';
export const ADDRESS = 'The relay address must start with https:// (http:// only for localhost, to test).';

export class RelayError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'offline' | 'rate' | 'full' | 'unconfirmed' | 'key' | 'gone' | 'refused' | 'relay', status?: number, retryAfter?: number }} o
   *   retryAfter: seconds the relay asked annai to wait
   */
  constructor(message, { code, status = 0, retryAfter = 0 }) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** Worth trying again later by itself: no connection, the relay busy or down, the subscription not confirmed yet. */
  get passing() {
    return this.code === 'offline' || this.code === 'rate' || this.code === 'relay' || this.code === 'unconfirmed';
  }
}

/** The relay's address as annai keeps it, or null when it isn't one: https, or http on this computer. @param {string} url */
export function relayAddress(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** @param {{ base: string, fetch: (url: string, init?: RequestInit) => Promise<Response> }} c */
export function relayClient({ base, fetch }) {
  const host = new URL(base).host;

  /** @param {string} path @param {RequestInit} init @returns {Promise<{ res: Response, body: any }>} */
  async function call(path, init) {
    /** @type {Response} */
    let res;
    try {
      res = await fetch(`${base}${path}`, init);
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      throw new RelayError(`annai couldn't reach the relay at ${host}. Is the phone offline? annai tries again by itself.`, { code: 'offline' });
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    /** @type {any} */
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { res, body: body && typeof body === 'object' && !Array.isArray(body) ? body : null };
  }

  /** @param {Response} res @param {any} body */
  function failure(res, body) {
    const said = typeof body?.message === 'string' ? body.message.slice(0, 300) : '';
    const code = typeof body?.error === 'string' ? body.error : '';
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    if (res.status === 429 && code === 'unconfirmed') return new RelayError(said || 'The relay is waiting for this phone\'s first notification.', { code: 'unconfirmed', status: 429, retryAfter: retryAfter || 10 });
    if (res.status === 429) {
      return new RelayError(said || `The relay at ${host} is busy. annai tries again in a minute.`, { code: code === 'full' ? 'full' : 'rate', status: 429, retryAfter: code === 'full' ? 0 : retryAfter || 60 });
    }
    if (res.status === 409 && code === 'key') return new RelayError(said || "The relay's key changed.", { code: 'key', status: 409 });
    if (res.status === 410) return new RelayError(said || "The phone's push service says this subscription no longer exists.", { code: 'gone', status: 410 });
    if (res.status >= 500) return new RelayError(`The relay at ${host} answered ${res.status}${said ? `: ${said}` : ''}. annai tries again later.`, { code: 'relay', status: res.status });
    return new RelayError(`The relay at ${host} refused it (${res.status}${said ? `: ${said}` : ''}).`, { code: 'refused', status: res.status });
  }

  return {
    /** The relay's VAPID public key, which the phone subscribes with. @returns {Promise<string>} */
    async vapid() {
      const { res, body } = await call('/v1/vapid', { method: 'GET' });
      if (!res.ok) throw failure(res, body);
      const raw = typeof body?.key === 'string' ? fromBase64Url(body.key) : null;
      if (!raw || raw.length !== 65 || raw[0] !== 4) throw new RelayError(`The relay at ${host} sent a key annai can't use. Is this the address of an annai push relay?`, { code: 'refused', status: res.status });
      return body.key;
    },
    /**
     * Keeps one encrypted reminder at the relay until sendAt.
     * @param {{ endpoint: string, key: string, id: string, token: string, sendAt: number, ttl: number, payload: Uint8Array }} r
     * @returns {Promise<{ id: string, sendAt: number, sent: boolean }>}
     */
    async schedule({ endpoint, key, id, token, sendAt, ttl, payload }) {
      const { res, body } = await call('/v1/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint, key, id, sendAt, ttl, urgency: 'high', payload: toBase64Url(payload) }),
      });
      if (res.status !== 201) throw failure(res, body);
      return { id: typeof body?.id === 'string' ? body.id : '', sendAt: Number(body?.sendAt), sent: body?.sent === true };
    },
    /** Calls a reminder off. "gone": it was sent already, or isn't there. @param {string} id @param {string} token @returns {Promise<'cancelled' | 'gone'>} */
    async cancel(id, token) {
      const { res, body } = await call(`/v1/schedule/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 204) return 'cancelled';
      if (res.status === 404 || res.status === 403) return 'gone';
      throw failure(res, body);
    },
  };
}
