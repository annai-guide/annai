import { toBytes, hex, ownBuffer } from './bytes.js';

/**
 * SHA-256 of the bytes (strings are UTF-8 encoded), as lowercase hex.
 * @param {Uint8Array | ArrayBuffer | string} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
  const digest = await crypto.subtle.digest('SHA-256', ownBuffer(toBytes(data)));
  return hex(new Uint8Array(digest));
}
