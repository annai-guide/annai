import { toB64u, fromB64u } from './b64.js';
import { readVapidKey, vapidJwt, vapidAuthorization } from './vapid.js';

/**
 * The push relay (spec §11.6): it keeps reminders the page encrypted, and sends each to its push
 * service at its time. A Cloudflare Worker with one Durable Object per push subscription, whose
 * alarm fires at the next sendAt. It never decrypts, logs or keeps anything after sending. No
 * dependencies: the Workers runtime has fetch and WebCrypto, and so has Node, where relay/serve.mjs
 * runs the same code.
 * @typedef {{ get: (key: string) => Promise<any>, put: (key: string | Record<string, any>, value?: any) => Promise<void>,
 *   delete: (key: string | string[]) => Promise<any>, deleteAll: () => Promise<void>, list: (o?: { prefix?: string }) => Promise<Map<string, any>>,
 *   getAlarm: () => Promise<number | null>, setAlarm: (t: number) => Promise<void>, deleteAlarm: () => Promise<void> }} Storage
 * @typedef {{ storage: Storage }} State  a Durable Object's state, as the relay uses it
 * @typedef {{ idFromName: (name: string) => any, get: (id: any) => { fetch: (req: Request) => Promise<Response> } }} Namespace
 * @typedef {{ RELAY: Namespace, VAPID_KEY?: string, VAPID_SUBJECT?: string, ORIGINS?: string, EXTRA_PUSH_ORIGINS?: string,
 *   LIMIT?: { limit: (o: { key: string }) => Promise<{ success: boolean }> } }} Env
 * @typedef {{ id: string, endpoint: string, sendAt: number, next: number, ttl: number, urgency: string, token: string, tries: number }} Waiting
 *   a reminder waiting: next is when it is tried (sendAt, or later after a failure); tries, the failures so far
 */

const MIN = 60_000;
const DAY = 86_400_000;
/** The abuse limits (spec §11.6, choice 5). */
export const LIMITS = Object.freeze({ payload: 4096, pending: 200, ahead: 30 * DAY, behind: 5 * MIN, body: 8192, endpoint: 2048, ttl: 28 * 86_400 });
/** A reminder its push service won't take is tried again until this long after its time, then dropped (choice 6). */
export const RETRY_FOR = 60 * MIN;
/**
 * Until a subscription has had a push through the relay, it keeps only this many reminders, due within this long
 * (choice 13): a made-up endpoint costs little, and only until its push service refuses it.
 */
export const UNCONFIRMED = Object.freeze({ pending: 3, within: 10 * MIN });
/** A subscription's first push is remembered this long after its last one. */
export const KEEP_CONFIRMED = 60 * DAY;
/** One alarm sends at most this many; the next alarm goes straight on with the rest. */
export const BATCH = 25;
/** A VAPID token lives 12 hours and is used until an hour is left (choice 7). */
const JWT_LIFE_S = 12 * 3600;
const JWT_RENEW_MS = 60 * MIN;
/** The smallest aes128gcm body: the 86-byte header, a delimiter and the 16-byte tag. */
const SMALLEST = 103;
const URGENCY = ['very-low', 'low', 'normal', 'high'];
const RAND = /^[A-Za-z0-9_-]{22}$/;
const ID = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{22,128})$/;
/**
 * The push services browsers use (choice 3), each with the shape of its own endpoints, so no other
 * address at those hosts can stand in for one: Google's (Chrome, Android, Samsung, Edge on Android),
 * Apple's, Mozilla's and Microsoft's (Edge on Windows).
 * @type {[RegExp, (u: URL) => boolean][]}
 */
const PUSH_SERVICES = [
  [/^fcm\.googleapis\.com$/, (u) => /^\/(?:fcm\/send|wp)\/[^/]+$/.test(u.pathname)],
  [/^android\.googleapis\.com$/, (u) => /^\/gcm\/send\/[^/]+$/.test(u.pathname)],
  // Apple asks servers to allow any *.push.apple.com host; a web push endpoint there is one token, with no deeper path (APNs's /3/device/…) and no query.
  [/(?:^|\.)push\.apple\.com$/, (u) => /^\/[^/]+$/.test(u.pathname) && !u.search],
  [/(?:^|\.)push\.services\.mozilla\.com$/, (u) => /^\/wpush\/v\d+\/[^/]+$/.test(u.pathname)],
  // WNS answers on one regional label, such as wns2-par02p.notify.windows.com.
  [/^[a-z0-9-]+\.notify\.windows\.com$/, (u) => u.pathname === '/w/' && Boolean(u.searchParams.get('token'))],
];
const MISSING = 'There is no such reminder at the relay: it was sent, or cancelled.';

/**
 * Whether the relay sends to this endpoint: https on the standard port at a push service browsers
 * use, or an origin the operator added (EXTRA_PUSH_ORIGINS: the tests' stand-in).
 * @param {string} endpoint @param {string[]} [extra]
 */
export function pushEndpointAllowed(endpoint, extra = []) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (extra.includes(u.origin)) return true;
  return u.protocol === 'https:' && u.port === '' && PUSH_SERVICES.some(([host, shape]) => host.test(u.hostname) && shape(u));
}

/** Requests a minute from one address (choice 5): 60 × 1,440 = 86,400 a day, under the Free plan's 100,000. */
export const PER_MINUTE = 60;

/**
 * The address the rate limit counts: an IPv4 address as it is; an IPv6 one by its /64, the block one
 * home or phone gets, so per address means something there too.
 * @param {string | null | undefined} ip
 */
export function addressKey(ip) {
  const s = String(ip ?? '').trim().toLowerCase();
  if (!s) return 'unknown';
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  if (!s.includes(':')) return s;
  const double = s.includes('::');
  const [head, tail = ''] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = double && tail ? tail.split(':') : [];
  const groups = double ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** The name of a subscription's object: the SHA-256 of its endpoint, base64url (choice 1). @param {string} endpoint */
export async function subscriptionName(endpoint) {
  return toB64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))));
}

/** @param {number} status @param {any} body @param {Record<string, string>} [headers] */
function reply(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { 'Cache-Control': 'no-store', ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
}

/** An error the page can show: a code, and what happened and what to do, in plain words. @param {number} status @param {string} error @param {string} message @param {Record<string, string>} [headers] */
const fail = (status, error, message, headers = {}) => reply(status, { error, message }, headers);

const notSetUp = () => fail(503, 'setup', 'This relay has no VAPID key yet. Its operator puts one in with relay/keys.mjs (see relay/README.md).');

/** Constant-time equality of two tokens. @param {unknown} a @param {unknown} b */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** @param {string | undefined} list a comma-separated setting */
const listOf = (list) => String(list ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** @param {Request} req */
const bearer = (req) => BEARER.exec(req.headers.get('Authorization') ?? '')?.[1] ?? null;

/**
 * The body as text, or null when it is larger than max bytes. It is read piece by piece and the
 * rest is never read once it passes max, so a body sent without its length (chunked) can't fill
 * the relay's memory.
 * @param {Request} req @param {number} max
 */
async function readBody(req, max) {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The VAPID key, read once for each secret it is given. @type {Map<string, Promise<import('./vapid.js').VapidKey | null>>} */
const keys = new Map();
/** @param {Env} env */
function vapid(env) {
  const text = String(env.VAPID_KEY ?? '');
  let k = keys.get(text);
  if (!k) {
    k = readVapidKey(text).catch(() => null);
    keys.set(text, k);
  }
  return k;
}

/**
 * A limit per address of the relay's own, for an isolate without Cloudflare's rate-limit binding:
 * the relay never runs without one (spec §11.6: "rate limits per IP"). It counts per isolate, as
 * the binding counts per Cloudflare location. @param {() => number} now
 */
function ownLimiter(now, limit = PER_MINUTE, period = 60_000) {
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  return {
    /** @param {{ key: string }} o */
    async limit({ key }) {
      const t = now();
      if (seen.size > 10_000) for (const [k, v] of seen) if (!v.some((x) => x > t - period)) seen.delete(k);
      const recent = (seen.get(key) ?? []).filter((x) => x > t - period);
      const success = recent.length < limit;
      if (success) recent.push(t);
      seen.set(key, recent);
      return { success };
    },
  };
}

/**
 * The relay, on a clock and a fetch of its own (tests and Node give theirs). timeout: how long one
 * send to a push service may take before it is tried again later.
 * @param {{ now?: () => number, send?: (url: string, init: RequestInit) => Promise<Response>, timeout?: number }} [o]
 */
export function makeRelay({ now = () => Date.now(), send = (url, init) => fetch(url, init), timeout = 15_000 } = {}) {
  const fallback = ownLimiter(now);
  /** @param {Request} req @param {Env} env @returns {Promise<Response>} */
  async function route(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return reply(204, null, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' });
    }
    // On Cloudflare, CF-Connecting-IP is the client's address, set by Cloudflare itself; relay/serve.mjs sets it too.
    const { success } = await (env.LIMIT ?? fallback).limit({ key: `ip:${addressKey(req.headers.get('CF-Connecting-IP'))}` });
    if (!success) return fail(429, 'rate', 'Too many requests from this address. annai tries again in a minute.', { 'Retry-After': '60' });
    if (pathname === '/v1/vapid') {
      if (req.method !== 'GET') return fail(405, 'method', 'Ask for the key with GET.');
      const key = await vapid(env);
      return key ? reply(200, { key: key.publicKey }) : notSetUp();
    }
    if (pathname === '/v1/schedule') return req.method === 'POST' ? schedule(req, env) : fail(405, 'method', 'Schedule a reminder with POST.');
    const m = /^\/v1\/schedule\/([^/]*)$/.exec(pathname);
    if (m) return req.method === 'DELETE' ? cancel(req, env, m[1]) : fail(405, 'method', 'Cancel a reminder with DELETE.');
    return fail(404, 'route', 'There is nothing at this address of the relay. Check the relay address in annai.');
  }

  /** POST /v1/schedule. @param {Request} req @param {Env} env */
  async function schedule(req, env) {
    const token = bearer(req);
    if (!token) return fail(401, 'token', "A reminder needs its cancel token in the Authorization header: Bearer, then 22 to 128 base64url characters.");
    const text = await readBody(req, LIMITS.body);
    if (text === null) return fail(413, 'size', `The request is larger than the ${LIMITS.body} bytes the relay reads.`);
    /** @type {any} */
    let b = null;
    try {
      b = JSON.parse(text);
    } catch {
      b = null;
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(400, 'json', 'The request must be a JSON object: endpoint, key, sendAt and payload.');
    const key = await vapid(env);
    if (!key) return notSetUp();
    if (b.key !== key.publicKey) return fail(409, 'key', "This relay's key isn't the one the phone subscribed with. annai subscribes again by itself.");
    if (typeof b.endpoint !== 'string' || b.endpoint.length > LIMITS.endpoint || !pushEndpointAllowed(b.endpoint, listOf(env.EXTRA_PUSH_ORIGINS))) {
      return fail(400, 'endpoint', "The endpoint isn't the address of a push service this relay sends to (Apple's, Google's, Mozilla's or Microsoft's, over https).");
    }
    const t = now();
    if (!Number.isSafeInteger(b.sendAt) || b.sendAt < t - LIMITS.behind || b.sendAt > t + LIMITS.ahead) {
      return fail(400, 'sendAt', 'sendAt must be a time in milliseconds, from a few minutes ago to 30 days ahead.');
    }
    const ttl = b.ttl ?? 3600;
    if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > LIMITS.ttl) return fail(400, 'ttl', `ttl must be whole seconds, from 0 to ${LIMITS.ttl}.`);
    const urgency = b.urgency ?? 'high';
    if (!URGENCY.includes(urgency)) return fail(400, 'urgency', `urgency must be one of: ${URGENCY.join(', ')}.`);
    const payload = typeof b.payload === 'string' ? fromB64u(b.payload) : null;
    if (!payload || payload.length < SMALLEST) return fail(400, 'payload', 'payload must be an encrypted push message (aes128gcm), in base64url.');
    if (payload.length > LIMITS.payload) return fail(413, 'payload', `A reminder may be at most ${LIMITS.payload} bytes, encrypted.`);
    const rand = b.id ?? toB64u(crypto.getRandomValues(new Uint8Array(16)));
    if (typeof rand !== 'string' || !RAND.test(rand)) return fail(400, 'id', 'id, when given, must be 22 base64url characters.');
    const name = await subscriptionName(b.endpoint);
    return env.RELAY.get(env.RELAY.idFromName(name)).fetch(new Request('https://relay/schedule', {
      method: 'POST', body: JSON.stringify({ id: `${name}.${rand}`, endpoint: b.endpoint, sendAt: b.sendAt, ttl, urgency, payload: toB64u(payload), token }),
    }));
  }

  /** DELETE /v1/schedule/:id. @param {Request} req @param {Env} env @param {string} id */
  async function cancel(req, env, id) {
    const token = bearer(req);
    if (!token) return fail(401, 'token', "Cancelling a reminder needs its cancel token in the Authorization header.");
    const m = ID.exec(id);
    if (!m) return fail(404, 'missing', MISSING);
    return env.RELAY.get(env.RELAY.idFromName(m[1])).fetch(new Request(`https://relay/schedule/${id}`, { method: 'DELETE', headers: { 'X-Token': token } }));
  }

  /** One push subscription's reminders (spec §11.6): kept until sent, cancelled, or expired. */
  class PushRelay {
    /** @param {State} state @param {Env} env */
    constructor(state, env) {
      this.storage = state.storage;
      this.env = env;
    }

    /** @param {Request} req */
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === 'POST' && pathname === '/schedule') return this.schedule(await req.json());
      const m = /^\/schedule\/(.+)$/.exec(pathname);
      if (req.method === 'DELETE' && m) return this.cancel(m[1], req.headers.get('X-Token') ?? '');
      return fail(404, 'route', 'There is nothing at this address of the relay.');
    }

    /** @param {{ id: string, endpoint: string, sendAt: number, ttl: number, urgency: string, payload: string, token: string }} m */
    async schedule(m) {
      /** @type {Waiting | undefined} */
      const had = await this.storage.get(`m:${m.id}`);
      if (had) return same(had.token, m.token) ? reply(201, { id: m.id, sendAt: had.sendAt }) : fail(409, 'id', 'A reminder with that id is already waiting. annai picks another.');
      const t = now();
      const waiting = (await this.storage.list({ prefix: 'm:' })).size;
      if (!(await this.storage.get('confirmed'))) {
        if (waiting >= UNCONFIRMED.pending || m.sendAt > t + UNCONFIRMED.within) {
          return fail(429, 'unconfirmed', `This phone's subscription hasn't had a notification through the relay yet. Until one arrives, the relay keeps just ${UNCONFIRMED.pending} reminders, due within 10 minutes. annai sends one when notifications are turned on, then the rest.`, { 'Retry-After': '10' });
        }
      } else if (waiting >= LIMITS.pending) {
        return fail(429, 'full', `This phone already has ${LIMITS.pending} reminders waiting at the relay. More can wait once some are sent.`);
      }
      const dueNow = m.sendAt <= t;
      // One due now is sent in this request: until it is, the alarm leaves it alone (its lease), or it would
      // be sent twice while this request awaits the push service.
      /** @type {Waiting} */
      const w = { id: m.id, endpoint: m.endpoint, sendAt: m.sendAt, next: dueNow ? t + timeout + 1000 : m.sendAt, ttl: m.ttl, urgency: m.urgency, token: m.token, tries: 0 };
      await this.storage.put({ [`m:${m.id}`]: w, [`p:${m.id}`]: m.payload });
      if (dueNow) {
        // Due now: sent in this request, so annai hears at once whether the phone's push service took it.
        const r = await this.#settle(w, t);
        await this.rewake();
        if (r === 'gone') return fail(410, 'gone', "The phone's push service says this subscription no longer exists. annai subscribes again.");
        if (r === 'drop') return fail(400, 'refused', "The phone's push service refused this reminder.");
        return reply(201, { id: m.id, sendAt: m.sendAt, sent: r === 'sent' || r === 'taken' });
      }
      const alarm = await this.storage.getAlarm();
      if (alarm === null || m.sendAt < alarm) await this.storage.setAlarm(m.sendAt);
      return reply(201, { id: m.id, sendAt: m.sendAt });
    }

    /** @param {string} id @param {string} token */
    async cancel(id, token) {
      /** @type {Waiting | undefined} */
      const had = await this.storage.get(`m:${id}`);
      if (!had) return fail(404, 'missing', MISSING);
      if (!same(had.token, token)) return fail(403, 'token', "That isn't this reminder's cancel token.");
      await this.storage.delete([`m:${id}`, `p:${id}`]);
      await this.rewake();
      return reply(204, null);
    }

    /**
     * The alarm: sends what is due (spec §11.6: "sends at sendAt"), at most BATCH at a time, so one
     * alarm never runs long; the next goes straight on. A subscription's first push is forgotten
     * KEEP_CONFIRMED after its last one.
     */
    async alarm() {
      try {
        const t = now();
        /** @type {Waiting[]} */
        const due = [...(await this.storage.list({ prefix: 'm:' })).values()].filter((w) => w.next <= t).sort((a, b) => a.next - b.next).slice(0, BATCH);
        for (const w of due) {
          // Read again: while a send waits, Cloudflare lets other requests in, and one may have cancelled this.
          /** @type {Waiting | undefined} */
          const fresh = await this.storage.get(`m:${w.id}`);
          if (!fresh || fresh.next > t) continue; // cancelled, or being sent by its own request meanwhile
          if ((await this.#settle(fresh, t)) === 'gone') break;
        }
        const confirmed = await this.storage.get('confirmed');
        if (confirmed && confirmed.at + KEEP_CONFIRMED <= t && !(await this.storage.list({ prefix: 'm:' })).size) await this.storage.delete('confirmed');
        if (await this.storage.get('fails')) await this.storage.delete('fails');
        await this.rewake();
      } catch {
        // The relay itself failed: looked at again later, a minute, then two, four… at most an hour apart,
        // rather than every minute, or by Cloudflare at once.
        try {
          const fails = (Number(await this.storage.get('fails')) || 0) + 1;
          await this.storage.put('fails', fails);
          await this.storage.setAlarm(now() + Math.min(60 * MIN, MIN * 2 ** (fails - 1)));
        } catch {
          await this.storage.setAlarm(now() + MIN).catch(() => {});
        }
      }
    }

    /**
     * Sends one reminder and keeps what came of it (choice 6): a gone subscription forgets
     * everything; a delivered reminder confirms its subscription (choice 13).
     * @param {Waiting} w @param {number} t @returns {Promise<'sent' | 'taken' | 'gone' | 'retry' | 'drop'>}
     */
    async #settle(w, t) {
      const r = await this.#deliver(w, t);
      if (r === 'gone') {
        // Everything this subscription's object keeps, however much (a delete takes at most 128 keys).
        await this.storage.deleteAll();
      } else if (r === 'retry') {
        /** @type {Waiting | undefined} */
        const still = await this.storage.get(`m:${w.id}`);
        if (still) {
          const tries = still.tries + 1;
          const next = t + Math.min(10 * MIN, 30_000 * 2 ** (tries - 1));
          if (next > still.sendAt + RETRY_FOR) await this.storage.delete([`m:${w.id}`, `p:${w.id}`]);
          else await this.storage.put(`m:${w.id}`, { ...still, tries, next });
        }
      } else {
        await this.storage.delete([`m:${w.id}`, `p:${w.id}`]); // sent, or never will be
        if (r === 'sent') await this.storage.put('confirmed', { at: t }); // only a push service's 201 confirms
      }
      return r;
    }

    /**
     * Sends one reminder to its push service (RFC 8030, VAPID per RFC 8292), choice 6. sent: the push
     * service answered 201, as RFC 8030 §5 says it must; taken: another 2xx, which confirms nothing.
     * @param {Waiting} w @param {number} t @returns {Promise<'sent' | 'taken' | 'gone' | 'retry' | 'drop'>}
     */
    async #deliver(w, t) {
      if (t > w.sendAt + RETRY_FOR) return 'drop'; // expired
      const key = await vapid(this.env);
      if (!key) return 'retry';
      const body = fromB64u((await this.storage.get(`p:${w.id}`)) ?? '');
      if (!body?.length) return 'drop';
      /** @type {Response} */
      let res;
      try {
        const jwt = await this.#jwt(key, new URL(w.endpoint).origin, t);
        // A redirect is never followed: the reminder goes to the push service's own address, or nowhere.
        res = await send(w.endpoint, {
          method: 'POST', body, signal: AbortSignal.timeout(timeout), redirect: 'manual',
          headers: { TTL: String(w.ttl), Urgency: w.urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(jwt, key.publicKey) },
        });
      } catch {
        return 'retry';
      }
      await res.arrayBuffer().catch(() => null);
      if (res.status === 201) return 'sent';
      if (res.ok) return 'taken';
      if (res.status === 404 || res.status === 410) return 'gone';
      if (res.status === 403 && w.tries === 0) {
        await this.storage.delete('jwt');
        return 'retry';
      }
      if (res.status === 429 || res.status >= 500) return 'retry';
      return 'drop';
    }

    /** A VAPID token for one push service, kept until an hour is left (choice 7). @param {import('./vapid.js').VapidKey} key @param {string} aud @param {number} t */
    async #jwt(key, aud, t) {
      const had = await this.storage.get('jwt');
      if (had && had.aud === aud && had.key === key.publicKey && had.exp * 1000 - t > JWT_RENEW_MS) return String(had.token);
      const exp = Math.floor(t / 1000) + JWT_LIFE_S;
      const token = await vapidJwt(key, { aud, exp, sub: this.env.VAPID_SUBJECT || 'https://annai.guide' });
      await this.storage.put('jwt', { aud, key: key.publicKey, exp, token });
      return token;
    }

    /**
     * The alarm at the next reminder's time. With none left, a confirmed subscription keeps only
     * that, and its VAPID token, until the confirmation runs out; otherwise nothing is stored.
     */
    async rewake() {
      /** @type {Waiting[]} */
      const waiting = [...(await this.storage.list({ prefix: 'm:' })).values()];
      if (waiting.length) {
        await this.storage.setAlarm(Math.min(...waiting.map((w) => w.next)));
        return;
      }
      const confirmed = await this.storage.get('confirmed');
      if (confirmed) {
        await this.storage.setAlarm(confirmed.at + KEEP_CONFIRMED);
        return;
      }
      await this.storage.deleteAlarm();
      await this.storage.delete(['jwt', 'fails']);
    }
  }

  const worker = {
    /** @param {Request} req @param {Env} env @returns {Promise<Response>} */
    async fetch(req, env) {
      const origin = req.headers.get('Origin');
      /** @type {Response} */
      let res;
      try {
        res = await route(req, env);
      } catch {
        res = fail(500, 'relay', "The relay couldn't do that just now. annai tries again later.");
      }
      const out = new Response(res.body, res); // a Durable Object's answer has headers that can't be changed
      out.headers.set('Vary', 'Origin');
      if (origin !== null && listOf(env.ORIGINS).includes(origin)) out.headers.set('Access-Control-Allow-Origin', origin);
      return out;
    },
  };
  return { worker, PushRelay };
}
