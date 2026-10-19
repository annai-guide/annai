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

/** Query names whose values the trace always blanks; the MCP client's shown addresses use the same (one list, so they can't drift). */
export const CREDENTIAL = /key|token|secret|sig|auth|pass|session|credential|appid|app_id|code/i;
/** Shorter stored values are not blanked: "ab" would wreck the trace, and no real key is that short. */
const SECRET_MIN = 8;
const BLANK = '«key»';

/**
 * Every secret value annai keeps (keys for models and plugins), longest first. strict: when they can't be
 * read, reject rather than give none (annai.secrets.blank, for what leaves the device).
 * @param {Store} store @param {{ strict?: boolean }} [o] @returns {Promise<string[]>}
 */
export async function knownSecrets(store, { strict = false } = {}) {
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
  } catch (e) {
    if (strict) throw new Error("annai couldn't read the keys it keeps, so it couldn't blank them. Try again.", { cause: e });
    // no secrets to read: nothing to blank
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Every way a secret may be written: as it is, and as a URL or a form encodes it. @param {string} s */
function forms(s) {
  return [...new Set([s, encodeURIComponent(s), new URLSearchParams({ s }).toString().slice(2), encodeURI(s)])];
}

/** Blanks each secret in any of its forms, whatever the case of letters and of percent-escapes. @param {string} text @param {string[]} secrets */
function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    for (const f of forms(s)) out = out.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), BLANK);
  }
  return out;
}

/**
 * Credentials by their shape, whoever's they are, so that even one annai doesn't keep never shows:
 * a SigV4 Authorization header, a Bearer value, a Basic value (when it looks like base64, so "Basic
 * authentication" stays), and a presigned URL's signature, credential and token.
 * @type {[RegExp, string][]}
 */
const SHAPES = [
  [/\bAWS4-HMAC-SHA256\s+Credential=[^\s,]+(?:,\s*SignedHeaders=[^\s,]+)?(?:,\s*Signature=[0-9a-f]+)?/gi, `AWS4-HMAC-SHA256 ${BLANK}`],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${BLANK}`],
  [/\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{6,}={0,2}/g, `$1 ${BLANK}`],
  [/\b(Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"'<>]+/gi, `$1=${BLANK}`],
];

/** Every secret annai keeps, and every credential-shaped text, blanked. @param {string} text @param {string[]} secrets */
function blankAll(text, secrets) {
  return scrub(SHAPES.reduce((t, [re, to]) => t.replace(re, to), String(text ?? '')), secrets);
}

const HIDDEN = 'The message held a key, so it is not shown.';

/**
 * Text for the user's eyes (a card, an error in the log) with every secret annai keeps blanked, and
 * anything shaped like a credential; when one might still show, a plain note instead (spec §9.9).
 * @param {Store} store @param {string} text
 */
export async function withoutSecrets(store, text) {
  const secrets = await knownSecrets(store);
  const out = blankAll(text, secrets);
  return leaks(out, secrets) ? HIDDEN : out;
}

/**
 * A value with every text in it as withoutSecrets would show it. strict: reject when the secrets can't be read.
 * @param {Store} store @param {any} value @param {{ strict?: boolean }} [o] @returns {Promise<any>}
 */
export async function withoutSecretsIn(store, value, { strict = false } = {}) {
  const secrets = await knownSecrets(store, { strict });
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (typeof v === 'string') {
      const out = blankAll(v, secrets);
      return leaks(out, secrets) ? HIDDEN : out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/**
 * A log whose every text holds no secret: for entries made from what plugins said, such as the
 * registry's plugin.error (spec §5.5, §9.9), whichever plugin failed.
 * @param {Store} store @param {string} scope @returns {(ev: { type: string, actor?: string, data?: any }) => Promise<unknown>}
 */
export function secretFreeLog(store, scope) {
  return async (ev) => logEvent(store, scope, { ...ev, data: await withoutSecretsIn(store, ev.data ?? {}) });
}

/** Whether text, decoded, holds a secret. @param {string} text @param {string[]} secrets */
function holds(text, secrets) {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // not valid percent-encoding: the text as it is
  }
  const lower = [text, decoded, decodeSafe(text)].map((x) => x.toLowerCase());
  return secrets.some((s) => lower.some((x) => x.includes(s.toLowerCase())));
}

/**
 * Whether any decoding of text could still show a secret: as it is, percent-decoded, with "+" as a
 * space, ignoring case, white space, slashes and backslashes. Used to fail closed, whatever the
 * parsers in between do. @param {string} text @param {string[]} secrets
 */
export function leaks(text, secrets) {
  const squash = (/** @type {string} */ x) => x.toLowerCase().replace(/[\s/\\]+/g, '');
  const seen = [text, decodeSafe(text), decodeSafe(text.replace(/\+/g, ' '))].map(squash);
  return secrets.some((s) => seen.some((x) => x.includes(squash(s))));
}

/** The host of an address as the trace keeps it. @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host || 'the address';
  } catch {
    return 'the address';
  }
}

/** @param {string} text */
function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The address as the trace keeps it: part by part, any part that holds a secret once decoded is
 * blanked (the host, a path segment, a query name or value), credential-named query values are
 * blanked, and the username, password and fragment are left out.
 * @param {string} url @param {string[]} [secrets]
 */
export function traceUrl(url, secrets = []) {
  try {
    const u = new URL(url);
    const host = holds(u.hostname, secrets) ? BLANK : u.host;
    const path = u.pathname.split('/').map((seg) => (holds(seg, secrets) ? BLANK : seg)).join('/');
    const query = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      const name = holds(k, secrets) ? BLANK : k;
      query.append(name, CREDENTIAL.test(k) || holds(v, secrets) ? BLANK : v);
    }
    const search = query.toString();
    const out = scrub(`${u.protocol}//${host}${path}${search ? `?${search}` : ''}`, secrets);
    // Fail closed: if any decoding could still show a secret, the path and query are not kept at all.
    return leaks(out, secrets) ? `${u.protocol}//${leaks(host, secrets) ? BLANK : host}/${BLANK}` : out;
  } catch {
    // Not an address: keep only what comes before any query or fragment, if that holds no secret.
    const out = scrub(String(url).split(/[?#]/)[0], secrets);
    return leaks(out, secrets) ? BLANK : out;
  }
}

/**
 * @param {Store} store @param {string} scope
 * @param {{ tool: string, wake?: string, blank?: string[] }} who blank: keys that aren't secrets yet, such as those
 *   in an address being tried (fix pass 8a-1), blanked as secrets are
 * @param {Fetch} [get] @returns {Fetch}
 */
export function tracedFetch(store, scope, who, get = (url, init) => fetch(url, init)) {
  return async (url, init = {}) => {
    const started = Date.now();
    const secrets = [...new Set([...await knownSecrets(store), ...(who.blank ?? []).filter((k) => typeof k === 'string' && k)])].sort((a, b) => b.length - a.length);
    const base = { kind: 'web', tool: who.tool, ...(who.wake ? { wake: who.wake } : {}), url: traceUrl(url, secrets), method: init.method ?? 'GET' };
    try {
      const res = await get(url, init);
      const bytes = Number(res.headers.get('content-length')) || undefined;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: res.status, ms: Date.now() - started, ...(bytes ? { bytes } : {}) } }).catch(() => {});
      return res;
    } catch (e) {
      const said = blankAll(String(/** @type {any} */ (e)?.message ?? e), secrets);
      const held = leaks(said, secrets);
      const error = held ? 'The request failed. (Its error message held a secret, so it is not kept.)' : said;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: 0, ms: Date.now() - started, error } }).catch(() => {});
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      // No answer at all (offline, blocked, no such host): the tool's answer, not a crash in its code (spec §17).
      throw new Error(`annai couldn't reach ${hostOf(base.url)}${held ? '' : ` (${said})`}. Is the device offline?`);
    }
  };
}
