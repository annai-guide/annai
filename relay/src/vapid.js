import { toB64u, fromB64u } from './b64.js';

/**
 * The relay's VAPID key (RFC 8292): who it is to push services. One P-256 key pair, kept as the
 * Worker secret VAPID_KEY in JWK form (choice 8), and ES256 tokens signed with it on WebCrypto.
 * @typedef {{ sign: CryptoKey, publicKey: string }} VapidKey  publicKey: the uncompressed point, base64url, as browsers subscribe with it
 */

const te = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

/** A new key pair, as one line of JWK JSON: { kty, crv, x, y, d }. @returns {Promise<string>} */
export async function newVapidJwk() {
  const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']));
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return JSON.stringify({ kty, crv, x, y, d });
}

/** Reads the VAPID_KEY secret; throws a plain Error naming what is wrong with it. @param {string | undefined} text @returns {Promise<VapidKey>} */
export async function readVapidKey(text) {
  /** @type {any} */
  let jwk = null;
  try {
    jwk = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('VAPID_KEY is missing, or is not the JSON that relay/keys.mjs prints.');
  }
  const x = fromB64u(jwk?.x);
  const y = fromB64u(jwk?.y);
  const d = fromB64u(jwk?.d);
  if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || x?.length !== 32 || y?.length !== 32 || d?.length !== 32) {
    throw new Error('VAPID_KEY must be a P-256 private key in JWK form (kty EC, crv P-256, x, y and d), as relay/keys.mjs prints it.');
  }
  /** @type {CryptoKey} */
  let sign;
  try {
    sign = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, ECDSA, false, ['sign']);
  } catch {
    throw new Error("VAPID_KEY isn't a key WebCrypto can sign with. Make a new one with relay/keys.mjs.");
  }
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 33);
  return { sign, publicKey: toB64u(raw) };
}

/** An ES256 JWT for one push service (RFC 8292 §2). @param {VapidKey} key @param {{ aud: string, exp: number, sub: string }} claims exp in seconds */
export async function vapidJwt(key, { aud, exp, sub }) {
  const part = (/** @type {any} */ o) => toB64u(te.encode(JSON.stringify(o)));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud, exp, sub })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.sign, te.encode(input)));
  return `${input}.${toB64u(sig)}`;
}

/** The Authorization header's value (RFC 8292 §3). @param {string} jwt @param {string} publicKey */
export const vapidAuthorization = (jwt, publicKey) => `vapid t=${jwt}, k=${publicKey}`;
