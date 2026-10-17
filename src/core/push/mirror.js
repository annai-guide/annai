import { SYS_DEVICE, ensureDeviceScope, ME } from '../scopes.js';
import { logEvent } from '../events.js';
import { utf8, toBase64Url, hex, ownBuffer } from '../bytes.js';
import { encryptPush } from './webpush.js';
import { relayClient, relayAddress, RelayError, DEFAULT_RELAY, ADDRESS } from './relay-client.js';
import { tracedFetch, withoutSecrets } from '../agent/net.js';
import { realClock } from '../live/clock.js';

/**
 * Reminders for a closed annai (spec §11.6): while notifications are on, the time reminders live
 * mode would give wait at the push relay, each encrypted on the phone and padded to one size, sent
 * 30 seconds after its time. annai on screen says one itself and calls the relay's copy off.
 * State: /push.json in this device's own scope; the cancel tokens, the secret push:tokens.
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../live/live.js').Mirrored} Mirrored
 * @typedef {{ endpoint: string, p256dh: Uint8Array, auth: Uint8Array }} Sub  the phone's push subscription
 * @typedef {{ supported: () => 'yes' | 'install' | 'no', permission: () => string, ask: () => Promise<string>,
 *   get: () => Promise<Sub | null>, subscribe: (key: string) => Promise<Sub>, unsubscribe: () => Promise<void> }} Source
 *   the phone's push subscription and notification permission (src/ui/push.js; a fake in tests)
 * @typedef {{ reminders: () => Promise<Mirrored[] | null>, onReminders: (fn: (level: 'calm' | 'prompt' | 'urgent') => void) => () => void }} LiveLike
 * @typedef {{ id: string, due: number, sendAt: number, hash: string, scope: string, sending?: boolean }} Item
 *   a reminder at the relay; sending: written down before it was sent, not yet known to have arrived
 * @typedef {{ m: Mirrored, sendAt: number, title: string, body: string, hash: string, reuse?: boolean }} Want
 * @typedef {{ on: boolean, relay: string, key: string | null, endpoint: string | null, hello: { endpoint: string, relay: string, at: number } | null,
 *   items: Record<string, Item>, cancels: Cancel[], problem: { message: string, at: number, needsYou: boolean } | null }} State
 * @typedef {{ id: string, relay: string, sendAt: number }} Cancel  a reminder to call off at a relay; sendAt: when that relay would send it
 *   key, endpoint: what the phone subscribed with; hello: the "notifications are on" sent for that endpoint, through that relay
 */

/** Whether this subscription had its "notifications are on" through this relay: each relay confirms it once (6a choice 13). @param {State} st @param {Sub} sub */
const greeted = (st, sub) => st.hello?.endpoint === sub.endpoint && st.hello.relay === st.relay;

export const FILE = '/push.json';
export const TOKENS = 'push:tokens';
/** The relay sends this long after a reminder's time, so annai on screen says it first and calls it off (6b choice 3). */
export const GRACE_MS = 30_000;
/** At most this many wait at the relay (it keeps 200): the nearest (choice 7). */
export const MAX_WAITING = 150;
/** The furthest ahead annai sends: the relay takes 30 days. */
export const AHEAD_MS = 29 * 86_400_000;
/** Every reminder is padded to this size before it is encrypted (6a choice 4). */
export const PAD = 3072;
/** A push service keeps a reminder it can't deliver yet this long; catch-up covers the rest. */
export const TTL_S = 3600;
/** A reminder moves at the relay when its time comes this much earlier… (choice 2) */
export const MOVE_MS = 5 * 60_000;
/** …or, within this long of the relay's time, when it would come later than the relay's. */
export const NEAR_MS = 10 * 60_000;
/** The test notification comes this long after the tap. */
export const TEST_IN_MS = 15_000;
const MIN = 60_000;
/** A reminder this long past its send is not called off: it was sent. */
const LONG_SENT_MS = 10 * MIN;
/** The mirror waits this long after live mode's news, so a burst of changes is one sync… */
const SOON_MS = 500;
/** …and this long when only times may have moved (a new fix, each second while driving): one sync at most so often. */
export const CALM_MS = 30_000;
const HELLO = 'Notifications are on. Reminders come like this while annai is closed.';
const AGAIN = 'Notifications are on again: reminders come like this while annai is closed.';
const NO_CONNECTION = "This phone has no connection: annai sends its reminders to the relay once it's back.";
const OFF_BY_PHONE = "The phone turned annai's notifications off, or they were turned off in its settings, so reminders don't reach a closed annai. In Settings → Notifications, tap Turn on notifications.";

/**
 * Whether a reminder's time moved enough to move it at the relay (choice 2): 5 minutes earlier (a
 * closed annai would be late), or later when the relay's copy comes within 10 minutes (it would come
 * before annai's own). @param {number} was the relay's @param {number} due annai's own @param {number} now
 */
export function moves(was, due, now) {
  if (due === was) return false;
  if (was - due >= MOVE_MS) return true;
  return due > was && was - now <= NEAR_MS;
}

/**
 * What to change at the relay: reminders no longer wanted, whose words changed, or whose time moved,
 * are called off; new and moved ones are sent; one written down but not known to have arrived is
 * sent again as it was. @param {Record<string, Item>} items @param {Map<string, Want>} wanted @param {number} now
 * @returns {{ off: string[], send: Want[] }}
 */
export function plan(items, wanted, now) {
  /** @type {string[]} */
  const off = [];
  for (const [key, item] of Object.entries(items)) {
    const w = wanted.get(key);
    if (!w || w.hash !== item.hash || moves(item.due, w.m.due, now)) off.push(key);
  }
  /** @type {Want[]} */
  const send = [];
  for (const [key, w] of wanted) {
    const item = items[key];
    if (!item || off.includes(key)) send.push(w);
    else if (item.sending) send.push({ ...w, reuse: true });
  }
  return { off, send };
}

/** The relay's name for a subscription's object: the SHA-256 of its endpoint (6a choice 1). @param {string} endpoint */
export async function subscriptionName(endpoint) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(utf8(endpoint)))));
}

/**
 * What a failed turn-on says: what happened, that nothing was turned on, and what to do (fix pass N5).
 * @param {unknown} e
 */
function turnOnError(e) {
  if (!(e instanceof RelayError)) return e;
  const next = e.passing ? 'check the connection, then tap Turn on notifications again.' : 'tap Turn on notifications again once that is fixed.';
  return new RelayError(`${e.message.replace(/\s+$/, '')} Nothing was turned on: ${next}`, { code: e.code, status: e.status, retryAfter: e.retryAfter });
}

/** @param {number} n */
const random = (n) => toBase64Url(crypto.getRandomValues(new Uint8Array(n)));

/** @param {string} text */
async function digest(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', ownBuffer(utf8(text))))).slice(0, 16);
}

/** @param {any} v @returns {State} */
function stateOf(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const items = o.items && typeof o.items === 'object' && !Array.isArray(o.items) ? o.items : {};
  const relay = relayAddress(o.relay ?? '') ?? DEFAULT_RELAY;
  return {
    on: o.on === true,
    relay,
    key: typeof o.key === 'string' ? o.key : null,
    endpoint: typeof o.endpoint === 'string' ? o.endpoint : null,
    // A hello kept before it named its relay was through the relay in use then.
    hello: o.hello && typeof o.hello.endpoint === 'string' && Number.isFinite(o.hello.at) ? { endpoint: o.hello.endpoint, relay: typeof o.hello.relay === 'string' ? o.hello.relay : relay, at: o.hello.at } : null,
    items: Object.fromEntries(Object.entries(items).filter(([, i]) => i && typeof i.id === 'string' && Number.isFinite(i.sendAt) && Number.isFinite(i.due))),
    cancels: Array.isArray(o.cancels)
      ? o.cancels.filter((/** @type {any} */ c) => c && typeof c.id === 'string' && typeof c.relay === 'string').map((/** @type {any} */ c) => ({ id: c.id, relay: c.relay, sendAt: Number(c.sendAt) || 0 }))
      : [],
    problem: o.problem && typeof o.problem.message === 'string' ? { message: o.problem.message, at: Number(o.problem.at) || 0, needsYou: o.problem.needsYou === true } : null,
  };
}

export class PushMirror {
  /** @type {Promise<unknown>} */
  #turn = Promise.resolve();
  /** A reminder went while a sync was sending: the rest wait for the next, which calls off first. */
  #dirty = false;
  /** @type {any} */
  #soonTimer = null;
  #soonAt = 0;
  /** @type {Map<string, string>} the hash of each title and text, worked out once */
  #hashes = new Map();
  /** @type {any} */
  #retryTimer = null;
  #retries = 0;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {(() => void)[]} */
  #offs = [];
  /** The "notifications are off" card, once a run. */
  #warned = false;
  #lastState = '';
  /** @type {Promise<void> | null} a sync waiting to run */
  #queued = null;
  #lastTokens = '';

  /**
   * @param {{ store: Store, ws: Workspace, live: LiveLike, source: Source, fetch?: (url: string, init?: RequestInit) => Promise<Response>,
   *   clock?: import('../live/clock.js').Clock, notice?: (n: { title: string, body: string }) => void, online?: () => boolean }} c
   *   online: whether the browser says it has a connection; without one, nothing is tried until it is back (fix pass N4)
   */
  constructor({ store, ws, live, source, fetch, clock = realClock(), notice = () => {}, online = () => true }) {
    this.store = store;
    this.ws = ws;
    this.live = live;
    this.source = source;
    this.clock = clock;
    this.notice = notice;
    this.online = online;
    this.fetch = fetch ?? tracedFetch(store, SYS_DEVICE, { tool: 'push relay' });
  }

  /** Follows live mode, and brings the relay into step. */
  start() {
    this.#offs.push(this.live.onReminders((level) => this.#soon(level)));
    return this.sync();
  }

  dispose() {
    for (const off of this.#offs.splice(0)) off();
    if (this.#soonTimer !== null) this.clock.clear(this.#soonTimer);
    if (this.#retryTimer !== null) this.clock.clear(this.#retryTimer);
    this.#soonTimer = null;
    this.#retryTimer = null;
  }

  /** Hears when the state changes (the Notifications screen). @param {() => void} fn */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /** Settles once nothing is left to do. */
  async settled() {
    /** @type {Promise<unknown>} */
    let t;
    do {
      t = this.#turn;
      await t;
    } while (t !== this.#turn);
  }

  /** How things stand, for the Notifications screen. */
  async status() {
    const st = await this.#read();
    return {
      on: st.on, relay: st.relay, problem: st.problem,
      waiting: Object.values(st.items).filter((i) => !i.sending).length,
      supported: this.source.supported(), permission: this.source.permission(),
    };
  }

  /**
   * Turns notifications on, once the user has allowed them (the screen asks first, choice 11):
   * subscribes with the relay's key, says so with a notification at once (choice 6), then sends
   * every reminder. @param {string} [relay] its address; the one kept if not given
   */
  turnOn(relay) {
    return this.#run(() => this.#turnOn(relay).catch((e) => { throw turnOnError(e); })).then(() => this.sync());
  }

  /** @param {string} [relay] */
  async #turnOn(relay) {
    const st = await this.#read();
    const tokens = await this.#readTokens();
    const base = relayAddress(relay ?? st.relay);
    if (!base) throw new Error(ADDRESS);
    const key = await this.#client(base).vapid();
    if (base !== st.relay) this.#moveAll(st); // the old relay's copies are called off there (choice 13)
    const had = await this.source.get().catch(() => null);
    /** @type {Sub} */
    let sub;
    if (had && had.endpoint === st.endpoint && st.key === key && st.on) {
      sub = had;
    } else {
      if (had) await this.source.unsubscribe().catch(() => {});
      this.#moveAll(st);
      sub = await this.source.subscribe(key);
      st.hello = null;
    }
    st.on = true;
    st.relay = base;
    st.key = key;
    st.endpoint = sub.endpoint;
    st.problem = null;
    if (!greeted(st, sub)) await this.#hello(st, sub, HELLO);
    await this.#save(st, tokens);
    this.#tell();
  }

  /** Turns notifications off: everything at the relay is called off, then the subscription goes (choice 9). */
  turnOff() {
    return this.#run(async () => {
      const st = await this.#read();
      const tokens = await this.#readTokens();
      this.#moveAll(st);
      st.on = false;
      st.problem = null;
      st.hello = null;
      await this.#save(st, tokens);
      await this.#callOff(st, tokens); // what fails waits, and goes at the next sync
      await this.source.unsubscribe().catch(() => {});
      st.endpoint = null;
      st.key = null;
      await this.#save(st, tokens);
      this.#tell();
    });
  }

  /** Changes the relay's address; while on, everything moves there (choice 13). @param {string} url */
  async setRelay(url) {
    const base = relayAddress(url);
    if (!base) throw new Error(ADDRESS);
    const st = await this.#run(() => this.#read());
    if (base === st.relay) return;
    if (st.on) {
      await this.turnOn(base);
      return;
    }
    await this.#run(async () => {
      const now = await this.#read();
      now.relay = base;
      await this.#save(now, await this.#readTokens());
      this.#tell();
    });
  }

  /** A test notification, TEST_IN_MS from now (choice 6). */
  test() {
    return this.#run(async () => {
      const st = await this.#read();
      if (!st.on || !st.key) throw new Error('Turn notifications on first.');
      const sub = await this.source.get();
      if (!sub) throw new Error(OFF_BY_PHONE);
      const rand = random(16);
      const payload = await encryptPush(sub, utf8(JSON.stringify({ v: 1, key: `test|${rand}`, title: 'annai', body: 'A test: reminders reach this phone through the relay.', test: true })), { pad: PAD });
      await this.#client(st.relay).schedule({ endpoint: sub.endpoint, key: st.key, id: rand, token: random(32), sendAt: this.clock.now() + TEST_IN_MS, ttl: 600, payload });
    });
  }

  /**
   * What the service worker saw (choice 10): a notification shown means its copy left the relay; a
   * renewed subscription is sent everything again. @param {import('../live/live.js').PushNews[]} news
   */
  delivered(news) {
    const list = Array.isArray(news) ? news : [];
    const shown = list.filter((n) => n?.kind === 'shown' && !n.test && typeof n.key === 'string').map((n) => /** @type {string} */ (n.key));
    if (shown.length) {
      this.#run(async () => {
        const st = await this.#read();
        const tokens = await this.#readTokens();
        for (const key of shown) {
          const item = st.items[key];
          if (!item) continue;
          delete st.items[key];
          delete tokens[item.id];
        }
        await this.#save(st, tokens);
        this.#tell();
      }).catch((e) => console.warn('push: could not note a notification', e));
    }
    if (list.some((n) => n?.kind === 'changed')) this.#soon();
  }

  /**
   * Brings the relay into step with live mode. One waiting to run is enough: more asked meanwhile (timers
   * firing while a slow request fails) join it, rather than pile up (fix pass N4).
   * @returns {Promise<void>}
   */
  sync() {
    if (this.#queued) return this.#queued;
    const job = this.#run(() => {
      this.#queued = null;
      return this.#sync();
    });
    this.#queued = job;
    return job;
  }

  async #sync() {
    this.#dirty = false;
    if (!this.online()) {
      // Nothing can reach the relay: the browser's online event brings the next sync (fix pass N4).
      const st = await this.#read();
      if (st.on && st.problem?.message !== NO_CONNECTION) {
        st.problem = { message: NO_CONNECTION, at: this.clock.now(), needsYou: false };
        await this.#save(st, await this.#readTokens());
        this.#tell();
      }
      return;
    }
    if (this.#retryTimer !== null) this.clock.clear(this.#retryTimer);
    this.#retryTimer = null;
    const st = await this.#read();
    const tokens = await this.#readTokens();
    const before = st.problem; // a passing one from an earlier sync clears once this one goes well
    let sent = 0;
    let calledOff = 0;
    /** @type {RelayError | null} */
    let error = null;
    try {
      /** @type {Want[]} */
      let send = [];
      /** @type {Sub | null} */
      let sub = null;
      if (st.on) {
        sub = await this.#subscription(st);
        const wanted = sub ? await this.#wanted() : null;
        if (sub && wanted) {
          const p = plan(st.items, wanted, this.clock.now());
          for (const key of p.off) this.#offLater(st, tokens, key);
          send = p.send;
        }
      }
      const off = await this.#callOff(st, tokens);
      calledOff = off.n;
      if (sub && send.length) sent = await this.#send(st, tokens, sub, send);
      if (off.failed) throw this.#offFailure(st, off.failed); // noted, and tried again later, after the sends
      if (st.problem && st.problem === before && !before.needsYou) st.problem = null;
      this.#retries = 0;
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      error = e;
      await this.#trouble(st, e);
    } finally {
      await this.#save(st, tokens);
    }
    if (sent || calledOff || error) {
      const data = { relay: new URL(st.relay).host, sent, calledOff, waiting: Object.keys(st.items).length, ...(error ? { error: st.problem?.message ?? '' } : {}) };
      await logEvent(this.store, SYS_DEVICE, { type: 'push.sync', actor: 'system', data }, this.clock.now()).catch(() => {});
    }
    this.#tell();
    if (this.#dirty) this.#soon('prompt');
  }

  /** The phone's subscription, renewed by itself when it is gone and permission stays (choice 12). @param {State} st */
  async #subscription(st) {
    /** @type {Sub | null} */
    let sub;
    try {
      sub = await this.source.get();
    } catch (e) {
      // It can't be asked yet (annai's offline service starting): later, not "off".
      throw new RelayError(String(/** @type {any} */ (e)?.message ?? e), { code: 'offline' });
    }
    if (sub) {
      if (sub.endpoint !== st.endpoint) this.#renewed(st, sub);
      return sub;
    }
    if (this.source.permission() === 'granted' && st.key) {
      try {
        const again = await this.source.subscribe(st.key);
        this.#renewed(st, again);
        return again;
      } catch {
        // falls through: the user is asked
      }
    }
    this.#moveAll(st);
    st.problem = { message: OFF_BY_PHONE, at: this.clock.now(), needsYou: true };
    if (!this.#warned) {
      this.#warned = true;
      this.notice({ title: 'Notifications are off', body: OFF_BY_PHONE });
    }
    return null;
  }

  /** A new subscription: what waited for the old one is called off, and all is sent again. @param {State} st @param {Sub} sub */
  #renewed(st, sub) {
    this.#moveAll(st);
    st.endpoint = sub.endpoint;
    st.hello = null;
  }

  /** What should wait at the relay now: the nearest reminders within reach (choice 7). null: live mode hasn't loaded. */
  async #wanted() {
    const list = await this.live.reminders();
    if (!list) return null;
    const now = this.clock.now();
    /** @type {Map<string, Want>} */
    const out = new Map();
    /** @type {Map<string, string>} */
    const titles = new Map();
    for (const m of list) {
      const sendAt = m.due + GRACE_MS;
      if (sendAt <= now + 5000 || sendAt > now + AHEAD_MS) continue; // about to be said on screen, or too far
      if (out.size >= MAX_WAITING) break;
      const title = await this.#title(m.scope, titles);
      const body = String(m.text).slice(0, 500);
      out.set(m.key, { m, sendAt, title, body, hash: await this.#hash(`${title}\n${body}`) });
    }
    return out;
  }

  /** @param {string} text */
  async #hash(text) {
    const had = this.#hashes.get(text);
    if (had) return had;
    if (this.#hashes.size > 1000) this.#hashes.clear();
    const h = await digest(text);
    this.#hashes.set(text, h);
    return h;
  }

  /** A notification's title: the trip's name, or "Reminder" (choice 4). @param {string} scope @param {Map<string, string>} cache */
  async #title(scope, cache) {
    if (scope === ME) return 'Reminder';
    const had = cache.get(scope);
    if (had !== undefined) return had;
    const rec = await this.store.tx(['scopes'], 'readonly', (t) => t.getScope(scope)).catch(() => null);
    const title = String(rec?.title ?? 'Reminder').slice(0, 120);
    cache.set(scope, title);
    return title;
  }

  /** Moves a reminder from the relay's list to the calls-off; one long sent is just forgotten. @param {State} st @param {Record<string, string>} tokens @param {string} key */
  #offLater(st, tokens, key) {
    const item = st.items[key];
    if (!item) return;
    delete st.items[key];
    if (!item.sending && item.sendAt + LONG_SENT_MS < this.clock.now()) {
      delete tokens[item.id];
      return;
    }
    st.cancels.push({ id: item.id, relay: st.relay, sendAt: item.sendAt });
  }

  /** Every reminder at the relay is to be called off. @param {State} st */
  #moveAll(st) {
    for (const item of Object.values(st.items)) st.cancels.push({ id: item.id, relay: st.relay, sendAt: item.sendAt });
    st.items = {};
  }

  /**
   * Calls off what waits to be, before anything is sent (choice 3). A failure never holds up the sends
   * (fix pass N1): it stays queued and is tried again, and a relay that failed isn't asked again this
   * time. Once its reminder's time is long past, a cancel goes without a request: it was sent, or never
   * will be. @param {State} st @param {Record<string, string>} tokens
   * @returns {Promise<{ n: number, failed: { relay: string, error: RelayError, count: number } | null }>}
   */
  async #callOff(st, tokens) {
    const now = this.clock.now();
    let n = 0;
    /** @type {Map<string, RelayError>} */
    const down = new Map();
    /** @type {Cancel[]} */
    const keep = [];
    for (const c of st.cancels) {
      const token = tokens[c.id];
      const base = relayAddress(c.relay);
      if (!token || !base || c.sendAt + LONG_SENT_MS < now) {
        delete tokens[c.id];
        continue;
      }
      if (down.has(c.relay)) {
        keep.push(c);
        continue;
      }
      try {
        await this.#client(base).cancel(c.id, token);
        n++;
        delete tokens[c.id];
      } catch (e) {
        if (!(e instanceof RelayError)) throw e;
        down.set(c.relay, e);
        keep.push(c);
      }
    }
    st.cancels = keep;
    if (!down.size) return { n, failed: null };
    const relay = down.has(st.relay) ? st.relay : [...down.keys()][0];
    return { n, failed: { relay, error: /** @type {RelayError} */ (down.get(relay)), count: keep.filter((c) => c.relay === relay).length } };
  }

  /**
   * What a cancel that failed means for the user: at this relay, its own words; at an old one, that
   * the new relay works meanwhile (fix pass N1). @param {State} st @param {{ relay: string, error: RelayError, count: number }} f
   */
  #offFailure(st, f) {
    if (f.relay === st.relay) return f.error;
    const host = new URL(f.relay).host;
    const what = f.count === 1 ? 'A reminder' : `${f.count} reminders`;
    return new RelayError(`${what} at the old relay, ${host}, couldn't be called off yet (${f.error.message.replace(/[.\s]+$/, '')}). annai keeps trying until ${f.count === 1 ? 'its time has' : 'their times have'} passed; the new relay works meanwhile.`, { code: 'relay' });
  }

  /**
   * Sends reminders, nearest first. Each id and token is written down before it is sent (choice 8).
   * A change in live mode meanwhile stops this, so the next sync calls off first (choice 3).
   * @param {State} st @param {Record<string, string>} tokens @param {Sub} sub @param {Want[]} list
   */
  async #send(st, tokens, sub, list) {
    if (!greeted(st, sub)) await this.#hello(st, sub, AGAIN);
    const name = await subscriptionName(sub.endpoint);
    for (const w of list) {
      if (w.reuse) continue;
      const id = `${name}.${random(16)}`;
      tokens[id] = random(32);
      st.items[w.m.key] = { id, due: w.m.due, sendAt: w.sendAt, hash: w.hash, scope: w.m.scope, sending: true };
    }
    await this.#save(st, tokens);
    const client = this.#client(st.relay);
    let n = 0;
    for (const w of list) {
      if (this.#dirty) break;
      const item = st.items[w.m.key];
      if (!item?.sending || !st.key) continue;
      try {
        await client.schedule({ endpoint: sub.endpoint, key: st.key, id: item.id.slice(item.id.indexOf('.') + 1), token: tokens[item.id], sendAt: item.sendAt, ttl: TTL_S, payload: await this.#seal(sub, w) });
        delete item.sending;
        n++;
      } catch (e) {
        if (!(e instanceof RelayError) || e.code !== 'refused') throw e;
        // This one, for good: noted, and the others go on.
        delete st.items[w.m.key];
        delete tokens[item.id];
        st.problem = { message: await withoutSecrets(this.store, e.message), at: this.clock.now(), needsYou: false };
      }
    }
    return n;
  }

  /** A reminder as the service worker reads it, padded to one size. @param {Sub} sub @param {Want} w */
  async #seal(sub, w) {
    let body = w.body;
    for (;;) {
      const bytes = utf8(JSON.stringify({ v: 1, key: w.m.key, title: w.title, body, at: w.m.due, scope: w.m.scope, watch: w.m.watch }));
      if (bytes.length < PAD || !body) return encryptPush(sub, bytes, { pad: PAD });
      body = body.slice(0, -20);
    }
  }

  /** The notification that confirms a subscription at the relay, sent at once (choice 6). @param {State} st @param {Sub} sub @param {string} words */
  async #hello(st, sub, words) {
    if (!st.key) return;
    const rand = random(16);
    const payload = await encryptPush(sub, utf8(JSON.stringify({ v: 1, key: `hello|${rand}`, title: 'annai', body: words, test: true })), { pad: PAD });
    await this.#client(st.relay).schedule({ endpoint: sub.endpoint, key: st.key, id: rand, token: random(32), sendAt: this.clock.now(), ttl: 600, payload });
    st.hello = { endpoint: sub.endpoint, relay: st.relay, at: this.clock.now() };
  }

  /**
   * What a failure means: a new relay key or a gone subscription, subscribe again; passing, try again
   * later with growing waits; otherwise, note it for the user. @param {State} st @param {RelayError} e
   */
  async #trouble(st, e) {
    const now = this.clock.now();
    if (e.code === 'key' || e.code === 'gone') {
      try {
        const key = e.code === 'key' ? await this.#client(st.relay).vapid() : st.key;
        if (!key) throw e;
        await this.source.unsubscribe().catch(() => {});
        const sub = await this.source.subscribe(key);
        st.key = key;
        this.#renewed(st, sub);
        this.#soon();
        return;
      } catch (again) {
        e = again instanceof RelayError ? again : new RelayError(OFF_BY_PHONE, { code: 'refused' });
      }
    }
    // The "notifications are on" never arrived (the relay forgot this phone): another, next time.
    if (e.code === 'unconfirmed' && st.hello && now - st.hello.at > MIN) st.hello = null;
    const message = await withoutSecrets(this.store, e.message);
    if (e.passing) {
      // In the background, there is nothing for the user to do (fix pass N5).
      st.problem = { message: /tries again|keeps trying/.test(message) ? message : `${message} annai tries again by itself.`, at: now, needsYou: false };
      const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(30 * MIN, MIN * 2 ** this.#retries);
      this.#retries++;
      // The retry is the next sync: a sooner one already waiting would only fail again (fix pass N4).
      if (this.#soonTimer !== null) this.clock.clear(this.#soonTimer);
      this.#soonTimer = null;
      this.#retryTimer = this.clock.set(() => {
        this.#retryTimer = null;
        this.sync().catch((x) => console.warn('push: a sync failed', x));
      }, wait);
      return;
    }
    st.problem = { message, at: now, needsYou: e.code !== 'full' };
  }

  /** @param {string} base */
  #client(base) {
    return relayClient({ base, fetch: this.fetch });
  }

  /**
   * A sync soon: half a second after a reminder came, changed or went (urgent ones also stop a sync
   * that is sending), 30 seconds after a time may have moved. @param {'calm' | 'prompt' | 'urgent'} [level]
   */
  #soon(level = 'prompt') {
    if (level === 'urgent') this.#dirty = true;
    // A retry waits its turn: calm news doesn't cut its growing wait short (fix pass N4).
    if (level === 'calm' && this.#retryTimer !== null) return;
    const wait = level === 'calm' ? CALM_MS : SOON_MS;
    const at = this.clock.now() + wait;
    if (this.#soonTimer !== null) {
      if (this.#soonAt <= at) return;
      this.clock.clear(this.#soonTimer);
    }
    this.#soonAt = at;
    this.#soonTimer = this.clock.set(() => {
      this.#soonTimer = null;
      this.sync().catch((e) => console.warn('push: a sync failed', e));
    }, wait);
  }

  #tell() {
    for (const fn of this.#listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a push listener failed', e);
      }
    }
  }

  /** One piece of work after another; its result or error is the caller's. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  #run(fn) {
    const job = this.#turn.then(fn);
    this.#turn = job.catch(() => {});
    return job;
  }

  /** @returns {Promise<State>} */
  async #read() {
    await ensureDeviceScope(this.store, this.clock.now());
    const st = stateOf(await this.ws.readJSON(SYS_DEVICE, FILE).catch(() => null));
    this.#lastState = JSON.stringify(st);
    return st;
  }

  /** @returns {Promise<Record<string, string>>} */
  async #readTokens() {
    const v = await this.store.tx(['secrets'], 'readonly', (t) => t.getSecret(TOKENS)).catch(() => null);
    /** @type {Record<string, string>} */
    const out = {};
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
    this.#lastTokens = JSON.stringify(out);
    return out;
  }

  /** Writes what changed: the state file, and the tokens' secret. @param {State} st @param {Record<string, string>} tokens */
  async #save(st, tokens) {
    const text = JSON.stringify(st);
    if (text !== this.#lastState) {
      await this.ws.write(SYS_DEVICE, FILE, st, { author: 'system' });
      this.#lastState = text;
    }
    const t = JSON.stringify(tokens);
    if (t !== this.#lastTokens) {
      await this.store.tx(['secrets'], 'readwrite', (x) => (Object.keys(tokens).length ? x.putSecret(TOKENS, { ...tokens }) : x.deleteSecret(TOKENS)));
      this.#lastTokens = t;
    }
  }
}
