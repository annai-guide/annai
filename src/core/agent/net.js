import { logEvent } from '../events.js';
import { t } from '../l10n.js';
import { answerWords } from '../answer.js';
import { isBase64, fromBase64 } from '../bytes.js';

/**
 * Web requests by tools and plugins, each recorded as a net.request (spec §4.5, §15): the trace
 * shows every request the agent sends. The address is kept as sent, except that no secret annai
 * keeps may reach the trace (§9.9): a username or password in it, the values of credential-named
 * query parameters, and any stored secret wherever it appears (path, query, an error message) are
 * blanked. When the keys annai keeps can't be read, nothing that could hold one is kept: of the address
 * only its scheme (not even its host), and no error's words.
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

/** A text as a form encodes it ("+" for a space). @param {string} s */
const formOf = (s) => new URLSearchParams({ s }).toString().slice(2);

/**
 * Every way a secret may be written: as it is, and as a URL or a form encodes it, once or twice (an address holding it inside another
 * address's parameter). @param {string} s
 */
function forms(s) {
  const once = [s, encodeURIComponent(s), formOf(s), encodeURI(s)];
  return [...new Set([...once, ...once.flatMap((f) => [encodeURIComponent(f), formOf(f)])])];
}

/** Blanks each secret in any of its forms, whatever the case of letters and of percent-escapes. @param {string} text @param {string[]} secrets */
function scrub(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) {
    for (const f of forms(s)) out = out.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), BLANK);
  }
  return out;
}

/** Strict, so that bytes that aren't UTF-8 text (what a word read as base64 mostly gives) are no user:password. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether a Basic value is RFC 7617's: base64 of UTF-8 text holding the ":" between a user id and a password. Words that merely read as base64
 * ("Basic Economy/Main") are not, almost always: their bytes are no text. @param {string} v
 */
function userPass(v) {
  try {
    return isBase64(v) && UTF8.decode(fromBase64(v)).includes(':');
  } catch {
    return false;
  }
}

/**
 * Credentials by their shape, whoever's they are, so that even one annai doesn't keep never shows: a SigV4 Authorization header, a Bearer
 * value (one holding a digit, or a JWT, which starts "eyJ": most real tokens have one, and "Bearer instruments" stays; a token of letters
 * only, if annai doesn't keep it, is left, and one annai keeps is blanked whatever its shape), a Basic value (RFC 7617's
 * user:password; "Basic authentication" and "Basic Economy/Main" stay), and a presigned URL's signature, credential and token. They run over
 * ordinary answers too (a search provider's rows, a tool's text), so each is as narrow as its credential allows.
 * @type {[RegExp, (whole: string, ...parts: string[]) => string][]}
 */
const SHAPES = [
  [/\bAWS4-HMAC-SHA256\s+Credential=[^\s,]+(?:,\s*SignedHeaders=[^\s,]+)?(?:,\s*Signature=[0-9a-f]+)?/gi, () => `AWS4-HMAC-SHA256 ${BLANK}`],
  [/\b(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/g, (whole, word, value) => (/\d/.test(value) || value.startsWith('eyJ') ? `${word} ${BLANK}` : whole)],
  [/\b(Basic)\s+([A-Za-z0-9+/]{6,}={0,2})/g, (whole, word, value) => (userPass(value) ? `${word} ${BLANK}` : whole)],
  [/\b(Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"'<>]+/gi, (_, name) => `${name}=${BLANK}`],
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
    // What JSON keeps of it: a Date as its ISO text, not an empty object.
    if (v && typeof v === 'object' && typeof v.toJSON === 'function') v = v.toJSON();
    if (typeof v === 'string') {
      if (!secrets) return v && UNCHECKED;
      const out = blankAll(v, secrets);
      return leaks(out, secrets) ? HIDDEN : out;
    }
    if (Array.isArray(v)) return v.map(walk);
    // Its names are text too (a map keyed by address). While the keys can't be read they stay as they are: made notes, they would all be one
    // name, and annai's own records' names are fixed words; no official plugin keys what it logs by an address (one that does, while the
    // keys can't be read, keeps the key in the name).
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [secrets ? walk(k) : k, walk(x)]));
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

/**
 * Decodings a text is searched in for a key, to make it a note: four. Blanking (forms()) covers a key encoded twice, as an address inside
 * another address's parameter is; the two more cover a redirect or link guard around that. Each is one pass over the text, so one made to
 * decode on and on can't hold annai up. A key encoded five times passes: that takes five deliberate encodings, and this is for accidents.
 */
const DECODES = 4;

/** text, as it is and with "+" as a space, each percent-decoded until that changes nothing (at most DECODES times). @param {string} text */
function decodings(text) {
  const out = [];
  for (let x of [text, text.replace(/\+/g, ' ')]) {
    out.push(x);
    for (let i = 0; i < DECODES; i++) {
      const next = decodeSafe(x);
      if (next === x) break;
      out.push((x = next));
    }
  }
  return out;
}

/** Whether text, decoded, holds a secret. @param {string} text @param {string[]} secrets */
function holds(text, secrets) {
  const lower = decodings(text).map((x) => x.toLowerCase());
  return secrets.some((s) => lower.some((x) => x.includes(s.toLowerCase())));
}

/**
 * Whether any decoding of text could still show a secret: as it is, percent-decoded (again and again), with "+" as a
 * space, ignoring case, white space, slashes and backslashes. Used to fail closed, whatever the
 * parsers in between do. @param {string} text @param {string[]} secrets
 */
export function leaks(text, secrets) {
  const squash = (/** @type {string} */ x) => x.toLowerCase().replace(/[\s/\\]+/g, '');
  const seen = decodings(text).map(squash);
  return secrets.some((s) => seen.some((x) => x.includes(squash(s))));
}

/* en */ const THE_ADDRESS = 'the address';

/** The host of an address as the trace keeps it. @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host || THE_ADDRESS;
  } catch {
    return THE_ADDRESS;
  }
}

/** Each run of %XX escapes decoded on its own, one that isn't text left as it is: a stray "%" ("100%") spares the rest. @param {string} text */
export function decodeSafe(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * The address as the trace keeps it: part by part, any part that holds a secret once decoded is
 * blanked (the host, a path segment, a query name or value), credential-named query values are
 * blanked, and the username, password and fragment are left out.
 * @param {string} url @param {string[]} [secrets] @param {boolean} [unread] the keys annai keeps couldn't be read: not even the host is kept
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
    // Fail closed: if any decoding could still show a secret, the path and query are not kept at all; if the keys couldn't be read, the host
    // isn't either (a stored key may be in it).
    return unread || leaks(out, secrets) ? `${u.protocol}//${unread || leaks(host, secrets) ? BLANK : host}/${BLANK}` : out;
  } catch {
    // Not an address: one that may hold a name or password keeps only its scheme (which @ ends them can't be told); any other only what comes
    // before any query or fragment, if that holds no secret.
    if (CREDENTIALED.test(String(url))) return `${String(url).slice(0, String(url).indexOf('://'))}://${BLANK}`;
    const out = scrub(String(url).split(/[?#]/)[0], secrets);
    return unread || leaks(out, secrets) ? BLANK : out;
  }
}

// An address with something between its scheme and an at sign: it may hold a name or password, whether or not it parses.
const CREDENTIALED = /^[a-z][a-z0-9+.-]*:\/\/[^]*@/i;

/**
 * The requested address in an engine's words (Chromium's refusal of one with a name or password quotes it whole), as given or as parsed, made
 * its traced form in one pass, longest first, when it may hold a name or password; any other address's words are left as they are.
 * @param {string} words @param {unknown} url @param {string} traced
 */
function quotedAs(words, url, traced) {
  const given = String(url);
  /** @type {string[]} */
  const forms = [given];
  try {
    const u = new URL(given);
    if (!u.username && !u.password) return words;
    forms.push(u.href);
  } catch {
    if (!CREDENTIALED.test(given)) return words;
  }
  const any = new RegExp([...new Set(forms)].sort((a, b) => b.length - a.length).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return words.replace(any, () => traced);
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
      const said = blankAll(quotedAs(String(/** @type {any} */ (own ? why : e)?.message ?? e), url, base.url), secrets);
      // Not kept when it held a secret, or when the keys couldn't be read to check it.
      const held = !known || leaks(said, secrets);
      /* en */
      const error = !known ? "The request failed. (annai couldn't check its error message for keys, so it is not kept.)"
        : held ? 'The request failed. (Its error message held a secret, so it is not kept.)' : said;
      await logEvent(store, scope, { type: 'net.request', data: { ...base, status: 0, ms: Date.now() - started, error } }).catch(() => {});
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      // No answer at all (offline, blocked, no such host): the tool's answer, not a crash in its code (spec §17).
      // Marked a network failure (what a search provider rests on), with the browser's own error kept as its cause.
      // No host when the keys couldn't be read, or when it held one (the trace's blanked host would read back as punycode).
      const host = known && !leaks(hostOf(String(url)), secrets) ? hostOf(base.url) : THE_ADDRESS;
      /* en */
      const en = `annai couldn't reach ${host}${held ? '' : ` (${said})`}. Is the device offline?`;
      // What it was goes with it (answer.js's vocabulary): a hold or a pack's failure keeps it, and a screen says it in its words.
      /** @type {import('../answer.js').AnswerSaid} */
      const what = { code: 'unreachable', where: host, ...(held ? {} : { info: said }) };
      throw Object.assign(new Error(en, held ? undefined : { cause: e }), { kind: 'network', said: what, shown: answerWords(what) });
    }
  };
}
