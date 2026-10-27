// Byte helpers shared by the core. No dependencies.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} s @returns {Uint8Array} */
export function utf8(s) {
  return encoder.encode(s);
}

/** @param {Uint8Array | ArrayBuffer} b @returns {string} */
export function text(b) {
  return decoder.decode(b instanceof Uint8Array ? b : new Uint8Array(b));
}

/**
 * Normalizes byte-like input to a Uint8Array view (no copy when possible).
 * @param {Uint8Array | ArrayBuffer | string} x
 * @returns {Uint8Array}
 */
export function toBytes(x) {
  if (typeof x === 'string') return utf8(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  /* en */ throw new TypeError('expected bytes or a string');
}

/** @param {Uint8Array} b @returns {string} lowercase hex */
export function hex(b) {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

/**
 * Returns an ArrayBuffer holding exactly these bytes, safe to store or hand to WebCrypto.
 * @param {Uint8Array} b
 * @returns {ArrayBuffer}
 */
export function ownBuffer(b) {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && b.buffer instanceof ArrayBuffer) return b.buffer;
  return /** @type {ArrayBuffer} */ (b.slice().buffer);
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Base64 of bytes, in pieces so a large photo doesn't overflow the call stack. @param {Uint8Array} b */
export function toBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Whether s is base64 itself (RFC 4648 §4, padded or not): not a data: address, base64url, or text with
 * spaces in it, which fromBase64 would refuse or read wrong (fix pass 8c-1).
 * @param {unknown} s
 */
export function isBase64(s) {
  if (typeof s !== 'string' || !s || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  return s.includes('=') ? s.length % 4 === 0 : s.length % 4 !== 1;
}

/** @param {string} s */
export function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Base64url without padding (RFC 4648 §5), the way Web Push writes keys and messages. @param {Uint8Array} b */
export function toBase64Url(b) {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of base64url (padding optional), or null when s isn't base64url. @param {string} s @returns {Uint8Array | null} */
export function fromBase64Url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const t = s.replace(/=+$/, '');
  if (t.length % 4 === 1 || (t.length < s.length && s.length % 4 !== 0)) return null; // padding only to a multiple of 4
  return fromBase64(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4));
}
