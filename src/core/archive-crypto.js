import { utf8, concat, ownBuffer } from './bytes.js';
import { t } from './l10n.js';

/**
 * File layout: MAGIC | iterations (u32, big-endian) | salt (16) | chunks.
 *
 * The archive is encrypted in chunks of CHUNK bytes (the last one shorter, possibly
 * empty), each sealed with AES-GCM under one key derived from the passphrase. Chunk i
 * uses the IV 0000000 | i (u32, big-endian) | last (1 on the final chunk, else 0), with
 * the header as additional data, so a chunk that is changed, dropped, moved or cut off
 * is refused. Neither side ever holds more than one chunk in memory (spec §12.1).
 */
const MAGIC = utf8('ANNAI-ENC2\n');
const HEADER = MAGIC.length + 4 + 16;
const TAG = 16;
export const CHUNK = 1024 * 1024;
export const ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export class PassphraseError extends Error {
  /** @param {string} message annai's English, as a backup's log and hold keep it @param {string} shown the screens' words (the shown rule) */
  constructor(message, shown) {
    super(message);
    this.name = 'PassphraseError';
    this.shown = shown;
  }
}

/** Whether bytes (the start of a file is enough) begin like an encrypted annai file. @param {Uint8Array} bytes */
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

/** @param {number} i @param {boolean} last */
function chunkIv(i, last) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(7, i);
  iv[11] = last ? 1 : 0;
  return iv;
}

/** @param {Blob} b */
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

/**
 * Encrypts a whole archive with a passphrase (PBKDF2-SHA-256 → AES-256-GCM), a chunk at a time.
 * @param {Blob} file @param {string} passphrase @param {number} [iterations]
 * @returns {Promise<Blob>}
 */
export async function encrypt(file, passphrase, iterations = ITERATIONS) {
  if (!passphrase) throw new PassphraseError('Enter a passphrase to encrypt the file.', t`Enter a passphrase to encrypt the file.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, iterations);
  const header = concat([MAGIC, count, salt]);
  const key = await deriveKey(passphrase, salt, iterations);
  /** @type {Blob[]} */
  const parts = [new Blob([/** @type {BlobPart} */ (header)])];
  const n = Math.max(1, Math.ceil(file.size / CHUNK));
  for (let i = 0; i < n; i++) {
    const plain = await bytesOf(file.slice(i * CHUNK, (i + 1) * CHUNK));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(i, i === n - 1), additionalData: ownBuffer(header) }, key, ownBuffer(plain));
    parts.push(new Blob([sealed]));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/**
 * Decrypts an encrypted archive a chunk at a time.
 * @param {Blob} file @param {string} passphrase
 * @returns {Promise<Blob>}
 */
export async function decrypt(file, passphrase) {
  const header = await bytesOf(file.slice(0, HEADER));
  if (!isEncrypted(header)) throw new PassphraseError('This file is not encrypted.', t`This file is not encrypted.`);
  if (file.size < HEADER + TAG) throw new PassphraseError('This file is damaged.', t`This file is damaged.`);
  const iterations = new DataView(header.buffer, header.byteOffset + MAGIC.length, 4).getUint32(0);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new PassphraseError('This file is damaged.', t`This file is damaged.`);
  const key = await deriveKey(passphrase, header.slice(MAGIC.length + 4, HEADER), iterations);
  const size = CHUNK + TAG;
  const n = Math.max(1, Math.ceil((file.size - HEADER) / size));
  /** @type {Blob[]} */
  const parts = [];
  for (let i = 0; i < n; i++) {
    const sealed = await bytesOf(file.slice(HEADER + i * size, HEADER + (i + 1) * size));
    try {
      parts.push(new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(i, i === n - 1), additionalData: ownBuffer(header) }, key, ownBuffer(sealed))]));
    } catch {
      throw i === 0 ? new PassphraseError('Wrong passphrase, or the file is damaged.', t`Wrong passphrase, or the file is damaged.`) : new PassphraseError('This file is damaged.', t`This file is damaged.`);
    }
  }
  return new Blob(parts);
}
