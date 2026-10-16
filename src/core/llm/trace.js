import { sha256Hex } from '../hash.js';
import { utf8, ownBuffer } from '../bytes.js';

/**
 * Model calls in the trace (spec §4.5, §9.6, §15): a net.request for every attempt, and a
 * model.turn for every role call. Request bodies aren't kept: a model request is logged as a
 * reference, not a copy. The reply's text and its reasoning are kept, as blobs the model.turn names
 * in refs, written in the same transaction (§4.9). Keys never reach the trace; any a provider echoes back in an
 * error are blanked out. Writing to the trace never breaks a call, not even on a full device.
 * @typedef {import('../types.js').Store} Store
 * @typedef {{ endpoint: string, model: string, providerModel: string, url: string, status: number, ms: number, firstMs: number | null,
 *   outcome: string, error?: string, usage: any, cost?: number }} RequestInfo
 * @typedef {{ model: string, name: string, outcome: string, ms: number, cost?: number, error?: string }} Attempt
 * @typedef {{ role: string, level: string, answeredBy: string | null, attempts: Attempt[], usage: any, cost: number | undefined, stop?: string }} TurnInfo
 */

/** A URL fit for the trace: no username or password, and no query values. @param {string} url */
function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return String(url).split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//');
  }
}

/** Query parameters whose values are credentials whatever their length. */
const CREDENTIAL = /key|token|secret|sig|auth|pass|session|credential|code/i;

/**
 * Every form a credential in a URL may take: its password and each query value, as written and
 * decoded both ways ("+" kept, and "+" as a space), so an echo in any of those forms is blanked.
 * Values of credential-named parameters count from 4 characters, other values from 8, so that
 * "page=2" doesn't blank every 2.
 * @param {string} url @returns {[string, number][]} [value, the length from which it counts]
 */
function urlSecrets(url) {
  /** @type {[string, number][]} */
  const out = [];
  const add = (/** @type {string} */ v, /** @type {number} */ min) => {
    if (!v) return;
    out.push([v, min]);
    for (const decode of [(/** @type {string} */ x) => decodeURIComponent(x), (/** @type {string} */ x) => decodeURIComponent(x.replace(/\+/g, ' '))]) {
      try {
        out.push([decode(v), min]);
      } catch {
        // not valid percent-encoding: the raw form is enough
      }
    }
  };
  const raw = String(url);
  const info = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@]*)@/i.exec(raw)?.[1];
  if (info) add(info.includes(':') ? info.slice(info.indexOf(':') + 1) : info, 4);
  for (const pair of raw.split('#')[0].split('?').slice(1).join('?').split('&')) {
    const i = pair.indexOf('=');
    if (i >= 0) add(pair.slice(i + 1), CREDENTIAL.test(pair.slice(0, i)) ? 4 : 8);
  }
  return out;
}

/** @param {Store} store @param {string} scope */
export function modelTrace(store, scope) {
  /** @type {Set<string>} */
  const secrets = new Set();
  const scrub = (/** @type {unknown} */ s) => {
    let out = String(s ?? '');
    // Longest first, so a secret that contains another is blanked whole.
    for (const k of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(k).join('«key»');
    return out;
  };
  /**
   * Appends an event, keeping each non-empty text as a blob it names in refs; data.stored says
   * which is which.
   * @param {{ ts: number, type: string, actor: string, data: any }} ev @param {[string, string][]} texts [name, text] pairs
   */
  const append = async (ev, texts) => {
    try {
      const kept = [];
      for (const [name, text] of texts) {
        if (!text) continue;
        const bytes = utf8(text);
        kept.push({ name, bytes, hash: await sha256Hex(bytes) });
      }
      if (!kept.length) {
        await store.tx(['events'], 'readwrite', (t) => t.appendEvent(scope, ev));
        return;
      }
      await store.tx(['blobs', 'events'], 'readwrite', async (t) => {
        for (const k of kept) {
          if (!(await t.hasBlob(k.hash))) await t.putBlob({ hash: k.hash, type: 'text/plain; charset=utf-8', size: k.bytes.byteLength, data: ownBuffer(k.bytes) });
        }
        await t.appendEvent(scope, { ...ev, data: { ...ev.data, stored: kept.map((k) => k.name) }, refs: kept.map((k) => k.hash) });
      });
    } catch {
      // the trace must never break a call
    }
  };
  /**
   * A key the calls use, so that an echo of it can be blanked out. Values shorter than min are
   * ignored: blanking every "ab" would wreck the trace, and no real credential is that short.
   * @param {string} key @param {number} [min]
   */
  const secret = (key, min = 4) => {
    if (typeof key === 'string' && key.length >= min) secrets.add(key);
  };
  return {
    secret,
    /** @param {RequestInfo} i */
    request(i) {
      // A credential can sit in the address too: its password and query values are treated as ones,
      // and the address is traced without them.
      for (const [v, min] of urlSecrets(i.url)) secret(v, min);
      const data = { kind: 'model', ...i, ...(i.error ? { error: scrub(i.error) } : {}), url: scrub(safeUrl(i.url)) };
      return append({ ts: Date.now(), type: 'net.request', actor: 'system', data }, []);
    },
    /**
     * @param {TurnInfo} i @param {string} text the reply's text
     * @param {string} [reasoning] the reply's reasoning: never shown in the conversation, visible here (spec §9.3)
     */
    turn(i, text, reasoning = '') {
      const data = { ...i, attempts: i.attempts.map((a) => (a.error ? { ...a, error: scrub(a.error) } : a)) };
      return append({ ts: Date.now(), type: 'model.turn', actor: 'system', data }, [['reply', scrub(text)], ['reasoning', scrub(reasoning)]]);
    },
  };
}
