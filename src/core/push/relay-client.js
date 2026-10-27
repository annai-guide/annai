import { toBase64Url, fromBase64Url } from '../bytes.js';
import { t, plural } from '../l10n.js';

/**
 * The push relay's API (spec §11.6): the public key, a reminder scheduled, a reminder cancelled.
 * Through annai's traced fetch, so every request shows in the trace (§15); the cancel token goes
 * only in the Authorization header, which the trace doesn't keep. Whatever the relay answers, a
 * failure is a RelayError, never a TypeError or SyntaxError: its words are the screens', made from
 * its code and data (relayWords), and its English, with what the relay said, is the log's.
 * @typedef {'offline' | 'rate' | 'full' | 'unconfirmed' | 'key' | 'gone' | 'refused' | 'relay'} Code
 * @typedef {{ code: Code, host?: string, status?: number, why?: 'none' | 'bad-key' | 'service' | 'connection' | 'off' | 'old', count?: number }} Said
 *   what a failure was, as data: why tells apart the failures of one code (no relay at the address, a key annai can't use,
 *   the phone's subscription not readable yet, no connection, notifications turned off, count reminders an old relay hasn't
 *   called off yet)
 */

export const DEFAULT_RELAY = 'https://push.annai.guide';
export const ADDRESS = t`The relay address must start with https:// (http:// only for localhost, to test).`;

/**
 * A failure in the screens' words, from its data: when it happens, and again when the Notifications screen shows one kept.
 * @param {Said} s @returns {string}
 */
export function relayWords({ code, host = '', status = 0, why, count = 1 }) {
  if (code === 'offline') {
    if (why === 'connection') return t`This phone has no connection: annai sends its reminders to the relay once it's back.`;
    if (why === 'service') return t`annai's offline service isn't running yet. Try again in a moment.`;
    return t`annai couldn't reach the relay at ${host}. Is the phone offline?`;
  }
  if (code === 'unconfirmed') return t`The relay is waiting for this phone's first notification.`;
  if (code === 'rate') return t`The relay at ${host} is busy.`;
  if (code === 'full') return t`The relay at ${host} keeps no more of this phone's reminders for now. More can wait once some are sent.`;
  if (code === 'key') return t`The relay's key changed.`;
  if (code === 'gone') return t`The phone's push service says this subscription no longer exists.`;
  if (why === 'old') {
    return plural(count, "A reminder at the old relay, {0}, couldn't be called off yet. annai keeps trying until its time has passed; the new relay works meanwhile.",
      "# reminders at the old relay, {0}, couldn't be called off yet. annai keeps trying until their times have passed; the new relay works meanwhile.", host);
  }
  if (code === 'relay') return t`The relay at ${host} answered ${status}.`;
  if (why === 'off') return t`The phone turned annai's notifications off, or they were turned off in its settings, so reminders don't reach a closed annai. In Settings → Notifications, tap Turn on notifications.`;
  if (why === 'none') return t`There's no annai push relay at ${host} (it answered 404). Check the relay address.`;
  if (why === 'bad-key') return t`The relay at ${host} sent a key annai can't use. Is this the address of an annai push relay?`;
  return t`The relay at ${host} refused it (${status}).`;
}

export class RelayError extends Error {
  /**
   * @param {Said & { message: string, retryAfter?: number }} o
   *   message: the failure in annai's English, with what the relay said, for the log (the screens show shown, made from what it was);
   *   retryAfter: seconds the relay asked annai to wait
   */
  constructor({ message, retryAfter = 0, ...said }) {
    super(message);
    /** The screens' words (the shown rule). */
    this.shown = relayWords(said);
    this.name = /* en */ 'RelayError';
    this.code = said.code;
    this.status = said.status ?? 0;
    this.retryAfter = retryAfter;
    /** @type {Said} */
    this.said = said;
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
      throw new RelayError({ code: 'offline', host, message: /* en */ `annai couldn't reach the relay at ${host}.` });
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
    // The log keeps what the relay said, in its English; the screens make their words from the code.
    const en = /* en */ `The relay at ${host} answered ${res.status}${code ? ` ${code}` : ''}${said ? `: ${said.replace(/[.\s]+$/, '')}` : ''}.`;
    const status = res.status;
    if (status === 429 && code === 'unconfirmed') return new RelayError({ code: 'unconfirmed', host, status, message: en, retryAfter: retryAfter || 10 });
    if (status === 429) return new RelayError({ code: code === 'full' ? 'full' : 'rate', host, status, message: en, retryAfter: code === 'full' ? 0 : retryAfter || 60 });
    if (status === 409 && code === 'key') return new RelayError({ code: 'key', host, status, message: en });
    if (status === 410) return new RelayError({ code: 'gone', host, status, message: en });
    return new RelayError({ code: status >= 500 ? 'relay' : 'refused', host, status, message: en });
  }

  return {
    /** The relay's VAPID public key, which the phone subscribes with. @returns {Promise<string>} */
    async vapid() {
      const { res, body } = await call('/v1/vapid', { method: 'GET' });
      if (res.status === 404) throw new RelayError({ code: 'refused', why: 'none', host, status: 404, message: /* en */ `There's no annai push relay at ${host} (it answered 404).` });
      if (!res.ok) throw failure(res, body);
      const raw = typeof body?.key === 'string' ? fromBase64Url(body.key) : null;
      if (!raw || raw.length !== 65 || raw[0] !== 4) throw new RelayError({ code: 'refused', why: 'bad-key', host, status: res.status, message: /* en */ `The relay at ${host} sent a key annai can't use.` });
      return body.key;
    },
    /**
     * Keeps one encrypted reminder at the relay until sendAt.
     * @param {{ endpoint: string, key: string, id: string, token: string, sendAt: number, ttl: number, payload: Uint8Array }} r
     * @returns {Promise<{ id: string, sendAt: number, sent: boolean }>}
     */
    async schedule({ endpoint, key, id, token, sendAt, ttl, payload }) {
      const { res, body } = await call('/v1/schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: /* en */ `Bearer ${token}` },
        body: JSON.stringify({ endpoint, key, id, sendAt, ttl, urgency: 'high', payload: toBase64Url(payload) }),
      });
      if (res.status !== 201) throw failure(res, body);
      return { id: typeof body?.id === 'string' ? body.id : '', sendAt: Number(body?.sendAt), sent: body?.sent === true };
    },
    /** Calls a reminder off. "gone": it was sent already, or isn't there. @param {string} id @param {string} token @returns {Promise<'cancelled' | 'gone'>} */
    async cancel(id, token) {
      const { res, body } = await call(`/v1/schedule/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: /* en */ `Bearer ${token}` } });
      if (res.status === 204) return 'cancelled';
      if (res.status === 404 || res.status === 403) return 'gone';
      throw failure(res, body);
    },
  };
}
