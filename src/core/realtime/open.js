import { ProviderError, KINDS, explain, sameOrigin } from '../llm/contract.js';
import { NO_USAGE, costOf, addCost } from '../llm/cost.js';
import { addressProblem } from '../llm/provider-desc.js';
import { isPluginBug } from '../registry.js';
import { utf8 } from '../bytes.js';

/**
 * Live sessions (the Koe and Kokoro design, "Realtime sessions"; spec §15). annai opens the WebSocket itself, only at
 * its ability's origin, and a protocol plugin drives it; a socket can't follow a redirect, so the key reaches no one
 * else. Its life is traced as live.session entries, each turn's usage as a priced net.request of kind realtime;
 * neither holds its address, subprotocols or key.
 * @typedef {import('../llm/contract.js').EndpointType} EndpointType @typedef {import('../llm/contract.js').LiveDriver} LiveDriver
 * @typedef {import('../llm/contract.js').LiveEvent} LiveEvent @typedef {import('../llm/contract.js').ErrorKind} ErrorKind
 * @typedef {import('../llm/contract.js').LiveSetup} LiveSetup
 * @typedef {Omit<LiveDriver, 'close'> & { closed: Promise<{ code: number, reason: string, kind: ErrorKind | null }>, on(fn: (e: LiveEvent) => void): () => void,
 *   close(why?: string): void, bytes: { in: number, out: number }, handle?: string, tunables: Record<string, any>,
 *   audioIn: LiveSetup['audioIn'], audioOut: LiveSetup['audioOut'] }} LiveSession
 *   closed: kind null when annai closed it; handle: the latest resume handle, in memory only (decision 28); tunables: what it opened with; audioIn, audioOut: 16-bit PCM at their rates (K6)
 */

/** How long a session may take to be ready. */
export const READY_MS = 15_000;

/** A session's format, unless its setup says: the one its tunable names, else its protocol's first (K6). @param {any[] | undefined} list @param {unknown} name */
const pick = (list, name) => list?.find((f) => f.format === name) ?? list?.[0];

/**
 * Refuses a session address not at the ability's origin, before anything opens: the one rule HTTP requests follow
 * (sameOrigin), wss: as https and ws: as http, which the security policy allows only for localhost and 127.0.0.1.
 * @param {import('../llm/config.js').Endpoint} endpoint @param {string} url
 */
export function liveOrigin(endpoint, url) {
  const web = /^wss?:\/\//i.test(url) ? url.replace(/^ws/i, 'http') : '';
  sameOrigin(endpoint, web);
  const wrong = addressProblem(new URL(web).origin);
  if (wrong) throw new ProviderError('bad-request', wrong);
}

/**
 * What a close means (spec §9.9): the protocol's reading, else annai's, the words first (Gemini's 1007 is a bad field
 * and a bad key both): a refused key auth; quota rate; 1008 or "not found" not-found; 1011 server; else network.
 * @param {EndpointType} type @param {number} code @param {string} reason @returns {ErrorKind}
 */
export function closeKind(type, code, reason) {
  /** @type {any} */
  let k = null;
  try {
    k = type.classifyClose?.(code, reason);
  } catch {
    // a broken reading is none
  }
  if (KINDS.has(k)) return k;
  if (/api key|unauthenticated|permission denied/i.test(reason)) return 'auth';
  if (/quota|resource_exhausted|rate limit/i.test(reason)) return 'rate';
  if (code === 1008 || /not found/i.test(reason)) return 'not-found';
  return code === 1011 ? 'server' : 'network';
}

/**
 * Opens a live session; an address not at the ability's origin throws at once. A protocol may open once more, before
 * the session is ready, with the tunables its reopen() gives (decision 11).
 * @param {{ type: EndpointType, endpoint: import('../llm/config.js').Endpoint, model: import('../llm/config.js').Model, key: string | null,
 *   tunables: Record<string, any>, setup: Omit<LiveSetup, 'audioIn' | 'audioOut'> & Partial<LiveSetup>, trace: ReturnType<typeof import('../llm/trace.js').modelTrace> | null,
 *   socket?: (url: string, protocols: string[]) => any, registry?: { fail(id: string, what: string, e: unknown): void }, wake?: string, now?: () => number, readyMs?: number }} c
 * @returns {LiveSession}
 */
export function openLive(c) {
  const { type, endpoint, model, key, trace, registry, wake, now = Date.now, readyMs = READY_MS } = c;
  const setup = { ...c.setup, audioIn: c.setup.audioIn ?? pick(type.audio?.in, c.tunables.input), audioOut: c.setup.audioOut ?? pick(type.audio?.out, c.tunables.output) };
  const socket = c.socket ?? ((url, protocols) => new WebSocket(url, protocols));
  // The key as given, and as an address escapes it (a protocol may put it in the query): an echo of either is blanked.
  const forms = key ? [...new Set([key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)])].sort((a, b) => b.length - a.length) : [];
  for (const f of forms) trace?.secret(f);
  const blank = (/** @type {string} */ t) => forms.reduce((x, f) => x.split(f).join('«key»'), t);
  /** A bug in the protocol's code counts against its plugin (spec §5.5). @param {string} what @param {unknown} e */
  const bug = (what, e) => { if (isPluginBug(e)) registry?.fail(type.pluginId, `live ${what}`, e); };
  /** @param {Record<string, any>} tunables @returns {{ url: string, protocols?: string[] }} */
  const build = (tunables) => {
    /** @type {any} */
    let r;
    try {
      r = /** @type {NonNullable<EndpointType['open']>} */ (type.open)({ endpoint, model, key, tunables });
    } catch (e) {
      bug('open', e);
      throw e instanceof ProviderError ? e : new ProviderError('plugin', `${type.name} couldn't start a live session.`);
    }
    liveOrigin(endpoint, String(r?.url));
    return r;
  };
  const first = build(c.tunables);
  const host = new URL(first.url).host;
  const started = now();
  let last = started;
  const bytes = { in: 0, out: 0 };
  const size = (/** @type {string | Uint8Array} */ d) => (typeof d === 'string' ? utf8(d).length : d.byteLength);
  let turns = 0;
  /** @type {number | undefined} */
  let cost;
  let asked = ''; // why annai closed it
  let done = false;
  /** @type {LiveDriver | null} */
  let driver = null;
  /** @type {any} */
  let ws = null;
  /** @type {Set<(e: LiveEvent) => void>} */
  const listeners = new Set();
  /** @param {string} state @param {Record<string, any>} [more] */
  const log = (state, more) => trace?.live({ state, endpoint: endpoint.name, model: model.name, providerModel: model.providerId, ...more, wake });
  /** @type {(v: { code: number, reason: string, kind: ErrorKind | null }) => void} */
  let settle = () => {};
  const closed = new Promise((r) => { settle = r; });
  /** @param {number} code @param {string} reason @param {ErrorKind | null} kind */
  const finish = (code, reason, kind) => {
    if (done) return;
    done = true;
    log('closed', { ms: now() - started, code, kind, why: asked || reason, bytesIn: bytes.in, bytesOut: bytes.out, turns, cost });
    settle({ code, reason: blank(reason), kind });
  };
  /** Usage priced and traced, the handle kept, then every listener told. @param {LiveEvent} e */
  const emit = (e) => {
    if (done) return; // a late timer's
    if (e?.type === 'usage') {
      const usage = { ...NO_USAGE, ...e.usage };
      const turnCost = costOf(usage, model.prices);
      cost = addCost(cost, turnCost);
      trace?.request({ kind: 'realtime', endpoint: endpoint.name, model: model.name, providerModel: model.providerId, url: first.url, status: 101, ms: now() - last, firstMs: null, outcome: 'ok', usage, cost: turnCost, wake });
      last = now();
    } else if (e?.type === 'resume') session.handle = e.handle;
    else if (e?.type === 'goaway') log('goaway', { ms: e.ms });
    else if (e?.type === 'turn') turns++;
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        console.warn('a live session listener failed', err);
      }
    }
  };
  log('open');
  const ready = new Promise((resolve, reject) => {
    /** One connection. @param {{ url: string, protocols?: string[] }} r @param {Record<string, any>} tunables @param {boolean} again */
    const attempt = (r, tunables, again) => {
      const st = { opened: false, up: false, late: false, broken: false };
      /** Set as the protocol attaches. @type {((d: string | Uint8Array) => void) | null} */
      let handler = null;
      /** @param {ProviderError} err @param {number} code @param {string} reason */
      const down = (err, code, reason) => {
        reject(err);
        finish(code, reason, err.kind);
      };
      try {
        ws = socket(r.url, r.protocols ?? []);
      } catch (e) {
        // The browser refused at once (its security policy); its words may hold the address, so only their name is kept.
        return down(new ProviderError('unreachable', `annai couldn't open a live session with ${host} (${/** @type {any} */ (e)?.name ?? 'error'}).`), 1006, '');
      }
      const s = ws;
      s.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { st.late = true; s.close(1000); }, readyMs);
      const broke = (/** @type {string} */ what, /** @type {unknown} */ e) => {
        bug(what, e);
        st.broken = true;
        // A refusal the protocol read (K6): the session ends with its kind and words.
        if (e instanceof ProviderError) down(new ProviderError(e.kind, blank(e.message)), 1000, e.message);
        s.close(1000);
      };
      s.addEventListener('open', () => {
        st.opened = true;
        if (asked) return s.close(1000);
        const io = {
          send: (/** @type {string | Uint8Array} */ d) => {
            bytes.out += size(d);
            s.send(d);
          },
          on: (/** @type {(d: string | Uint8Array) => void} */ fn) => { handler = fn; },
        };
        try {
          driver = /** @type {NonNullable<EndpointType['attach']>} */ (type.attach)(io, { endpoint, model, tunables, setup, emit });
        } catch (e) {
          return broke('attach', e);
        }
        Promise.resolve(driver?.ready).then(() => {
          if (done || st.up) return;
          st.up = true;
          clearTimeout(timer);
          log(setup.resume ? 'resumed' : 'ready', { ms: now() - started });
          resolve(undefined);
        }, (e) => broke('ready', e));
        return undefined;
      });
      s.addEventListener('message', (/** @type {MessageEvent} */ e) => {
        const d = typeof e.data === 'string' ? e.data : new Uint8Array(e.data);
        bytes.in += size(d);
        try {
          handler?.(d);
        } catch (err) {
          bug('message', err);
        }
      });
      s.addEventListener('close', (/** @type {CloseEvent} */ e) => {
        clearTimeout(timer);
        const reason = String(e.reason ?? '');
        if (st.up) {
          if (!asked) call('close', []); // its own close: the protocol lets go too (annai's called it already)
          return finish(e.code, reason, asked ? null : closeKind(type, e.code, reason));
        }
        try {
          const next = asked || !st.opened || again || st.late || st.broken ? null : type.reopen?.(e.code, reason, tunables);
          if (next) return attempt(build((session.tunables = next)), next, true);
        } catch (err) {
          bug('reopen', err);
          if (err instanceof ProviderError) return down(err, e.code, reason);
        }
        /** @type {ErrorKind} */
        const kind = asked ? 'cancelled' : st.late ? 'timeout' : !st.opened ? 'unreachable' : st.broken ? 'plugin' : closeKind(type, e.code, reason);
        const words = { timeout: "The live session didn't start in time.", unreachable: `annai couldn't reach ${host}.`, plugin: `${type.name} couldn't start a live session.` }[/** @type {string} */ (kind)];
        return down(new ProviderError(kind, words ?? (blank(reason) || `The live session closed (${e.code}).`)), e.code, reason);
      });
      return undefined;
    };
    attempt(first, c.tunables, false);
  });
  ready.catch(() => {}); // read by whoever awaits it, never left unhandled
  /** A driver call; a bug in it counts against the plugin. @param {string} what @param {any[]} a */
  const call = (what, a) => {
    try {
      if (driver && !done) /** @type {any} */ (driver)[what]?.(...a);
    } catch (e) {
      bug(what, e);
      if (!isPluginBug(e)) throw e;
    }
  };
  const session = /** @type {LiveSession} */ ({
    ready,
    closed,
    bytes,
    tunables: c.tunables,
    audioIn: setup.audioIn,
    audioOut: setup.audioOut,
    on(/** @type {(e: LiveEvent) => void} */ fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    ...Object.fromEntries(['audio', 'activity', 'text', 'image', 'answer', 'cancel', 'cut'].map((m) => [m, (/** @type {any[]} */ ...a) => call(m, a)])),
    close(why = 'closed') {
      if (done || asked) return;
      asked = why;
      call('close', []);
      ws?.close(1000);
    },
  });
  return session;
}

/** What a Test says once a session is ready. @type {import('../llm/check.js').TestStep[]} */
const OPENED = [{ step: 'access', ok: true, detail: 'annai can open a live session at this address from the browser.' }, { step: 'key', ok: true, detail: 'The key works.' }];

/**
 * A realtime model's Test (K4): asked "Say OK.", the session must answer aloud, in words, within ms; then it closes.
 * onAudio: its voice, to play as it comes. @param {LiveSession} session @param {{ onAudio?: (data: Uint8Array) => void, ms?: number }} [o]
 * @returns {Promise<{ ok: boolean, steps: import('../llm/check.js').TestStep[] }>}
 */
export async function testLive(session, { onAudio, ms = 10_000 } = {}) {
  let said = '';
  let heard = 0;
  /** @type {(how: string) => void} */
  let ended = () => {};
  const end = new Promise((r) => { ended = r; });
  const off = session.on((e) => {
    if (e.type === 'said') said += e.text;
    if (e.type === 'audio') {
      heard += e.data.length;
      onAudio?.(e.data);
    }
    if (e.type === 'turn') ended(e.end);
  });
  try {
    await session.ready;
    const timer = setTimeout(() => ended('late'), ms);
    session.closed.then(({ kind }) => ended(kind ?? 'closed'));
    session.text('Say OK.');
    const how = await end;
    clearTimeout(timer);
    const words = said.replace(/[.!\s]+$/, '').trim();
    const ok = Boolean(heard && words);
    const detail = ok ? `It answered aloud: ${words}.` : how === 'late' ? `It didn't answer aloud within ${ms / 1000} seconds.`
      : KINDS.has(how) ? `The session closed before it answered. ${explain(new ProviderError(/** @type {any} */ (how), ''))}` : 'It answered, but not aloud in words.';
    return { ok, steps: [...OPENED, { step: 'live', ok, detail }] };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('plugin', String(/** @type {any} */ (e)?.message ?? e));
    return { ok: false, steps: [{ step: err.kind === 'auth' || err.kind === 'credit' ? 'key' : 'access', ok: false, detail: explain(err) }] };
  } finally {
    off();
    session.close('test');
  }
}
