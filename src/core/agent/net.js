import { logEvent } from '../events.js';
import { t } from '../l10n.js';
import { answerWords } from '../answer.js';

/**
 * Web requests by tools and plugins, each recorded as a net.request (spec §4.5, §15): the trace
 * shows every request the agent sends. The address is kept as sent, except that no secret annai
 * keeps may reach the trace (§9.9): a username or password in it, the values of credential-named
 * query parameters, and any stored secret wherever it appears (path, query, an error message) are
 * blanked. When the keys annai keeps can't be read, nothing that could hold one is kept: the address
 * only to its host, and no error's words.
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 * @typedef {import('../types.js').Store} Store
 */

/** Query names whose values the trace always blanks; the MCP client's shown addresses use the same (one list, so they can't drift). */
export const CREDENTIAL = /key|token|secret|sig|auth|pass|session|credential|appid|app_id|code/i;
/** Shorter stored values are not blanked: "ab" would wreck the trace, and no real key is that short. */
const SECRET_MIN = 8;
/* en */ const BLANK = '«key»';

/**
 * Every secret value annai keeps (keys for models and plugins), longest first; null when they can't be read: unknown, never none, so
 * each reader keeps nothing it can't check (spec §9.9). strict: reject instead (annai.secrets.blank, for what leaves the device).
 * @param {Store} store @param {{ strict?: boolean }} [o] @returns {Promise<string[] | null>}
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
    if (strict) throw new Error(/* en */ "annai couldn't read the keys it keeps, so it couldn't blank them. Try again.", { cause: e }); // a plugin's
    return null; // unknown: any text could hold one
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

/* en */
const HIDDEN = 'The message held a key, so it is not shown.';
/* en */
const UNCHECKED = "annai couldn't check this message for keys, so it is not shown.";

/**
 * Text kept or read (an error in the log, a hold, what a model reads) with every secret annai keeps blanked, and anything shaped like a
 * credential; when one might still show, a plain note instead (hidden), and when the keys can't be read, another (unchecked), in annai's
 * English (spec §9.9). @param {Store} store @param {string} text @param {string} [hidden] that note
 * @param {{ strict?: boolean, unchecked?: string }} [o] strict: reject when the secrets can't be read
 */
export async function withoutSecrets(store, text, hidden = HIDDEN, { strict = false, unchecked = UNCHECKED } = {}) {
  const secrets = await knownSecrets(store, { strict });
  if (!secrets) return text ? unchecked : '';
  const out = blankAll(text, secrets);
  return leaks(out, secrets) ? hidden : out;
}

/**
 * The same for the user's eyes (a card, a status line): the notes in the screens' words. own: annai's own words, or Shiori's, which hold no key: shown as
 * they are when the keys can't be read. @param {Store} store @param {string} text @param {{ own?: boolean }} [o]
 */
export const shownWithoutSecrets = (store, text, { own = false } = {}) => withoutSecrets(store, text, t`The message held a key, so it is not shown.`,
  { unchecked: own ? text : t`annai couldn't check this message for keys, so it is not shown.` });

/**
 * A value with every text in it as withoutSecrets would keep it: when the keys can't be read, every text is that note. strict: reject
 * instead. @param {Store} store @param {any} value @param {{ strict?: boolean }} [o] @returns {Promise<any>}
 */
export async function withoutSecretsIn(store, value, { strict = false } = {}) {
  const secrets = await knownSecrets(store, { strict });
  /** @param {any} v @returns {any} */
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!secrets) return v && UNCHECKED;
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
    /* en */ return new URL(url).host || 'the address';
  } catch {
    /* en */ return 'the address';
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
 * @param {string} url @param {string[]} [secrets] @param {boolean} [unread] the keys annai keeps couldn't be read: only the host is kept
 */
export function traceUrl(url, secrets = [], unread = false) {
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
    // Fail closed: if any decoding could still show a secret, or the keys couldn't be read, the path and query are not kept at all.
    return unread || leaks(out, secrets) ? `${u.protocol}//${leaks(host, secrets) ? BLANK : host}/${BLANK}` : out;
  } catch {
    // Not an address: keep only what comes before any query or fragment, if that holds no secret.
    const out = scrub(String(url).split(/[?#]/)[0], secrets);
    return unread || leaks(out, secrets) ? BLANK : out;
  }
}

/**
 * @param {Store} store @param {string} scope
 * @param {{ tool: string, wake?: string, blank?: string[] }} who blank: keys that aren't secrets yet, such as those
 *   in an address being tried, blanked as secrets are
 * @param {Fetch} [get] @returns {Fetch}
 */
export function tracedFetch(store, scope, who, get = (url, init) => fetch(url, init)) {
  return async (url, init = {}) => {
    const started = Date.now();
    const known = await knownSecrets(store);
    const secrets = [...new Set([...known ?? [], ...(who.blank ?? []).filter((k) => typeof k === 'string' && k)])].sort((a, b) => b.length - a.length);
    const base = { kind: 'web', tool: who.tool, ...(who.wake ? { wake: who.wake } : {}), url: traceUrl(url, secrets, !known), method: init.method ?? 'GET' };
    try {
      const res = await get(url, init);
      const bytes = Number(res.headers.get('content-length')) || undefined;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: res.status, ms: Date.now() - started, ...(bytes ? { bytes } : {}) } }).catch(() => {});
      return res;
    } catch (e) {
      // A request called off with a reason (a timeout's, a race's) says it: WebKit's own words are "Fetch is aborted" for all. A stop
      // with none (the engine's plain AbortError) keeps the browser's words.
      const why = init.signal?.aborted ? /** @type {any} */ (init.signal.reason) : undefined;
      const own = typeof why?.message === 'string' && !(why instanceof DOMException && why.name === 'AbortError');
      const said = blankAll(String(/** @type {any} */ (own ? why : e)?.message ?? e), secrets);
      // Not kept when it held a secret, or when the keys couldn't be read to check it.
      const held = !known || leaks(said, secrets);
      /* en */
      const error = !known ? "The request failed. (annai couldn't check its error message for keys, so it is not kept.)"
        : held ? 'The request failed. (Its error message held a secret, so it is not kept.)' : said;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: 0, ms: Date.now() - started, error } }).catch(() => {});
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      // No answer at all (offline, blocked, no such host): the tool's answer, not a crash in its code (spec §17).
      // Marked a network failure (what a search provider rests on), with the browser's own error kept as its cause.
      const host = hostOf(base.url);
      /* en */
      const en = `annai couldn't reach ${host}${held ? '' : ` (${said})`}. Is the device offline?`;
      // What it was goes with it (answer.js's vocabulary): a hold or a pack's failure keeps it, and a screen says it in its words.
      /** @type {import('../answer.js').AnswerSaid} */
      const what = { code: 'unreachable', where: host, ...(held ? {} : { info: said }) };
      throw Object.assign(new Error(en, held ? undefined : { cause: e }), { kind: 'network', said: what, shown: answerWords(what) });
    }
  };
}
