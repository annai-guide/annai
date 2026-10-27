import { utf8, concat, ownBuffer } from '../bytes.js';

/**
 * Web Push encryption (RFC 8291: aes128gcm, RFC 8188) on WebCrypto's ECDH, HKDF and AES-GCM. The
 * page encrypts each reminder itself with the push subscription's keys, so the relay never sees it
 * (spec §11.6).
 */

/** The record size the header states (RFC 8291 §4: one record, larger than what it holds). */
const RS = 4096;
/** The most plaintext one push carries: 4096 bytes, less the 86-byte header, the delimiter and the 16-byte tag (RFC 8291 §4). */
export const PLAINTEXT_MAX = 3993;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
/* en */ const BAD_KEY = "The subscription's key isn't a P-256 public key.";

/** HKDF-SHA-256 (RFC 5869): len bytes. @param {Uint8Array} salt @param {Uint8Array} ikm @param {Uint8Array} info @param {number} len */
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ownBuffer(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ownBuffer(salt), info: ownBuffer(info) }, key, len * 8));
}

/**
 * The aes128gcm body of a push message for a subscription (RFC 8291 §3.4 and §4).
 * @param {{ p256dh: Uint8Array, auth: Uint8Array }} to the subscription's public key (65 bytes, uncompressed) and auth secret (16 bytes)
 * @param {Uint8Array} plaintext
 * @param {{ pad?: number, salt?: Uint8Array, keys?: CryptoKeyPair }} [o]
 *   pad: the size every record is padded to (plaintext, the delimiter and zeros), so a message's length says nothing
 *   about it; salt, keys: fixed ones, only for the RFC's example (otherwise new for every message)
 * @returns {Promise<Uint8Array>}
 */
export async function encryptPush(to, plaintext, { pad, salt = crypto.getRandomValues(new Uint8Array(16)), keys } = {}) {
  if (!(to?.p256dh instanceof Uint8Array) || to.p256dh.length !== 65 || to.p256dh[0] !== 4) throw new Error(BAD_KEY);
  if (!(to.auth instanceof Uint8Array) || to.auth.length !== 16) /* en */ throw new Error("The subscription's auth secret isn't 16 bytes.");
  const room = Math.min(pad ?? PLAINTEXT_MAX + 1, PLAINTEXT_MAX + 1);
  if (plaintext.length + 1 > room) /* en */ throw new Error(`A push message holds at most ${room - 1} bytes.`);
  /** @type {CryptoKey} */
  let ua;
  try {
    ua = await crypto.subtle.importKey('raw', ownBuffer(to.p256dh), P256, false, []); // refuses a point off the curve (RFC 8291 §7)
  } catch {
    throw new Error(BAD_KEY);
  }
  const pair = keys ?? /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(P256, true, ['deriveBits']));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, pair.privateKey, 256));
  /* en */ const ikm = await hkdf(to.auth, secret, concat([utf8('WebPush: info\0'), to.p256dh, asPublic]), 32);
  /* en */ const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  /* en */ const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const record = new Uint8Array(pad ?? plaintext.length + 1);
  record.set(plaintext);
  record[plaintext.length] = 2; // the last record's delimiter; the zeros after it are padding (RFC 8188 §2)
  const key = await crypto.subtle.importKey('raw', ownBuffer(cek), 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ownBuffer(nonce) }, key, ownBuffer(record)));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RS);
  header[20] = asPublic.length;
  return concat([header, asPublic, sealed]);
}
