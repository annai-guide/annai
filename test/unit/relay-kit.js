import { makeRelay, subscriptionName } from '../../relay/src/relay.js';
import { memoryNamespace, memoryLimiter } from '../../relay/memory.js';
import { newVapidJwk, readVapidKey } from '../../relay/src/vapid.js';
import { toB64u } from '../../relay/src/b64.js';

export const APP = 'https://annai.guide';
export const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMei7Ldr5a6zf_deadbeef';
export const T0 = Date.parse('2026-11-27T08:00:00Z');
export const MIN = 60_000;
/** A cancel token, as the page makes one. */
export const token = () => toB64u(crypto.getRandomValues(new Uint8Array(32)));
/** n random bytes, base64url. @param {number} n */
export const bytes = (n) => toB64u(crypto.getRandomValues(new Uint8Array(n)));

/**
 * A relay in memory on a clock the test moves. It sends to a recorder that answers 201, or the
 * statuses given in turn (0: no connection), unless send is given (the real fetch, to a stand-in).
 * @param {{ limit?: number, statuses?: number[], send?: (url: string, init: any) => Promise<Response>, extraPushOrigins?: string[], subject?: string }} [o]
 */
export async function relayKit({ limit = 300, statuses = [], send, extraPushOrigins = [], subject } = {}) {
  let t = T0;
  /** @type {{ url: string, init: any }[]} */
  const sent = [];
  const answers = [...statuses];
  const record = async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push({ url, init });
    const s = answers.shift() ?? 201;
    if (s === 0) throw new TypeError('fetch failed');
    return new Response(null, { status: s });
  };
  const { worker, PushRelay } = makeRelay({ now: () => t, send: send ?? record });
  const jwk = await newVapidJwk();
  /** @type {any} */
  const env = { VAPID_KEY: jwk, ORIGINS: `${APP}, http://127.0.0.1:8790`, EXTRA_PUSH_ORIGINS: extraPushOrigins.join(','), LIMIT: memoryLimiter({ limit, now: () => t }), ...(subject ? { VAPID_SUBJECT: subject } : {}) };
  env.RELAY = memoryNamespace(PushRelay, env, { now: () => t, timers: false });
  const key = (await readVapidKey(jwk)).publicKey;
  /**
   * @param {string} method @param {string} path
   * @param {{ body?: any, token?: string, origin?: string, ip?: string, headers?: Record<string, string> }} [o]
   */
  const call = async (method, path, o = {}) => {
    const headers = new Headers(o.headers ?? {});
    if (o.token) headers.set('Authorization', `Bearer ${o.token}`);
    if (o.origin) headers.set('Origin', o.origin);
    headers.set('CF-Connecting-IP', o.ip ?? '203.0.113.7');
    if (o.body !== undefined) headers.set('Content-Type', 'application/json');
    const body = o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    const res = await worker.fetch(new Request(`https://push.annai.guide${path}`, { method, headers, body }), env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const object = async (/** @type {string} */ endpoint) => env.RELAY.objects.get(await subscriptionName(endpoint));
  return {
    env, key, sent, call,
    /** A valid schedule request's body, changed by o. @param {Record<string, any>} [o] */
    reminder: (o = {}) => ({ endpoint: ENDPOINT, key, sendAt: t + 10 * MIN, ttl: 3600, payload: bytes(3174), ...o }),
    now: () => t,
    /** Moves the clock, and fires the alarms that came due. @param {number} ms */
    async after(ms) {
      t += ms;
      await env.RELAY.runDue();
    },
    /** @returns {Promise<any[]>} every reminder waiting, in every object */
    waiting: () => env.RELAY.waiting(),
    /** Every key stored in a subscription's object. */
    async stored(endpoint = ENDPOINT) {
      return (await object(endpoint))?.storage.keys() ?? [];
    },
    /** The object's alarm. */
    async alarm(endpoint = ENDPOINT) {
      return (await object(endpoint))?.storage.alarm ?? null;
    },
  };
}
