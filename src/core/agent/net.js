import { logEvent } from '../events.js';

/**
 * Web requests by tools and plugins, each recorded as a net.request (spec §4.5, §15): the trace
 * shows every request the agent sends. The address is kept as sent, except that no secret annai
 * keeps may reach the trace (§9.9): a username or password in it, the values of credential-named
 * query parameters, and any stored secret wherever it appears (path, query, an error message) are
 * blanked.
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('../types.js').Store} Store
 */

const CREDENTIAL = /key|token|secret|sig|auth|pass|session|credential|appid|app_id|code/i;
/** Shorter stored values are not blanked: "ab" would wreck the trace, and no real key is that short. */
const SECRET_MIN = 8;
const BLANK = '«key»';

/** Every secret value annai keeps (keys for models and plugins), longest first. @param {Store} store @returns {Promise<string[]>} */
export async function knownSecrets(store) {
  /** @type {Set<string>} */
  const out = new Set();
  const add = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') {
      if (v.length >= SECRET_MIN) out.add(v);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) add(x);
    }
  };
  try {
    await store.tx(['secrets'], 'readonly', async (t) => {
      for (const id of await t.listSecretIds()) add(await t.getSecret(id));
    });
  } catch {
    // no secrets to read: nothing to blank
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Blanks each secret, as written and as a URL would encode it. @param {string} text @param {string[]} secrets */
function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join(BLANK);
  }
  return out;
}

/** The address as the trace keeps it. @param {string} url @param {string[]} [secrets] */
export function traceUrl(url, secrets = []) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (CREDENTIAL.test(k)) u.searchParams.set(k, BLANK);
    return scrub(u.href, secrets);
  } catch {
    // Not an address: keep only what comes before any query or fragment.
    return scrub(String(url).split(/[?#]/)[0], secrets);
  }
}

/**
 * @param {Store} store @param {string} scope @param {{ tool: string, wake?: string }} who
 * @param {Fetch} [get] @returns {Fetch}
 */
export function tracedFetch(store, scope, who, get = (url, init) => fetch(url, init)) {
  return async (url, init = {}) => {
    const started = Date.now();
    const secrets = await knownSecrets(store);
    const base = { kind: 'web', tool: who.tool, ...(who.wake ? { wake: who.wake } : {}), url: traceUrl(url, secrets), method: init.method ?? 'GET' };
    try {
      const res = await get(url, init);
      const bytes = Number(res.headers.get('content-length')) || undefined;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: res.status, ms: Date.now() - started, ...(bytes ? { bytes } : {}) } }).catch(() => {});
      return res;
    } catch (e) {
      const error = scrub(String(/** @type {any} */ (e)?.message ?? e), secrets);
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: 0, ms: Date.now() - started, error } }).catch(() => {});
      throw e;
    }
  };
}
