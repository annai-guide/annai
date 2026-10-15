import { utf8, concat, ownBuffer } from './bytes.js';

/** File layout: MAGIC | iterations (u32, big-endian) | salt (16) | iv (12) | AES-GCM ciphertext + tag. */
const MAGIC = utf8('ANNAI-ENC1\n');
export const ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export class PassphraseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PassphraseError';
  }
}

/** @param {Uint8Array} bytes */
export function isEncrypted(bytes) {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/** @param {string} passphrase @param {Uint8Array} salt @param {number} iterations */
async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', ownBuffer(utf8(passphrase.normalize('NFC'))), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ownBuffer(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a whole archive with a passphrase (PBKDF2-SHA-256 → AES-256-GCM).
 * @param {Uint8Array} bytes @param {string} passphrase @param {number} [iterations]
 */
export async function encrypt(bytes, passphrase, iterations = ITERATIONS) {
  if (!passphrase) throw new PassphraseError('Enter a passphrase to encrypt the file.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ownBuffer(MAGIC) }, key, ownBuffer(bytes)));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, iterations);
  return concat([MAGIC, head, salt, iv, ct]);
}

/** @param {Uint8Array} bytes @param {string} passphrase */
export async function decrypt(bytes, passphrase) {
  if (!isEncrypted(bytes)) throw new PassphraseError('This file is not encrypted.');
  let o = MAGIC.length;
  const iterations = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getUint32(0);
  o += 4;
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new PassphraseError('This file is damaged.');
  const salt = bytes.slice(o, o + 16);
  const iv = bytes.slice(o + 16, o + 28);
  const key = await deriveKey(passphrase, salt, iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ownBuffer(iv), additionalData: ownBuffer(MAGIC) }, key, ownBuffer(bytes.slice(o + 28))));
  } catch {
    throw new PassphraseError('Wrong passphrase, or the file is damaged.');
  }
}
