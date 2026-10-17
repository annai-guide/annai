import { CREDENTIAL } from './agent/net.js';

/**
 * An address the user gives annai (an MCP server's, a package's) and the keys in it: shown and kept
 * with each part that may be a key blanked, the keys in a secret (milestone 8c's third finding; fix
 * passes 8c-2 and 8a-1).
 */

/** The blank a key's place shows. */
export const KEY_BLANK = '«key»';
/** Lowercase words, joined by - _ or .: model-context-protocol, internationalization. */
const WORDS = /^[a-z]+(?:[-_.][a-z]+)*$/;
/**
 * A part of an address that may be a key (the coordinator's third finding; fix pass 8c-2): 12 or more
 * digits; or a part that isn't words and is 16 or more characters, or 8 or more mixing letters and
 * digits; or lowercase letters alone, 24 or more, as no ordinary word is that long without a - _ or .
 * Words joined by - _ or . stay at any length. The gap accepted: a key of lowercase letters alone,
 * shorter than 24, stays visible.
 * @param {string} v
 */
const keyLike = (v) => /^\d{12,}$/.test(v) || /^[a-z]{24,}$/.test(v) || (!WORDS.test(v) && (v.length >= 16 || (v.length >= 8 && /[a-z]/i.test(v) && /\d/.test(v))));

/**
 * An address as annai shows and keeps it, and the keys in it (the coordinator's third finding; fix pass
 * 8a-1: for MCP servers and packages alike): every
 * path segment or query value that may be a key, and every credential-named query value, becomes
 * «key»; the keys go to secrets. The fragment is left out. fullAddress puts them back.
 * @param {string} address @returns {{ shown: string, keys: string[] }}
 */
export function addressParts(address) {
  const u = new URL(address);
  /** @type {string[]} */
  const keys = [];
  const path = u.pathname.split('/').map((seg) => {
    let value = seg;
    try {
      value = decodeURIComponent(seg);
    } catch {
      // kept as it is
    }
    if (!seg || !keyLike(value)) return seg;
    keys.push(value);
    return KEY_BLANK;
  }).join('/');
  /** @type {string[]} */
  const query = [];
  for (const [k, v] of u.searchParams) {
    if (v && (keyLike(v) || CREDENTIAL.test(k))) {
      keys.push(v);
      query.push(`${encodeURIComponent(k)}=${KEY_BLANK}`);
    } else {
      query.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return { shown: `${u.origin}${path}${query.length ? `?${query.join('&')}` : ''}`, keys };
}

/** The address with its keys back in their places. @param {string} shown @param {string[]} keys */
export function fullAddress(shown, keys) {
  const pieces = shown.split(KEY_BLANK);
  return pieces.map((piece, i) => (i < pieces.length - 1 ? piece + encodeURIComponent(keys[i] ?? '') : piece)).join('');
}

/**
 * Refuses an address with a name or password before an @ (milestone 8c's third finding): annai would
 * have nowhere safe to keep it. instead: where the key goes instead, said after "Leave it out".
 * @param {URL} u @param {string} [instead]
 */
export function refuseUserinfo(u, instead = '') {
  if (u.username || u.password) throw new Error(`This address holds a name or password before an @. Leave it out${instead}.`);
}
