import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, PassphraseError, CHUNK } from '../../src/core/archive-crypto.js';
import { utf8, text } from '../../src/core/bytes.js';
import { PiecesOnly, bytesOf, blobOf } from './pieces.js';

const FAST = 100_000; // the minimum accepted; production uses ITERATIONS
const HEADER = 11 + 4 + 16; // magic, iterations, salt

/** @param {string} s @param {string} p */
const seal = async (s, p) => bytesOf(await encrypt(blobOf(utf8(s)), p, FAST));
/** @param {Uint8Array} bytes @param {string} p */
const open = async (bytes, p) => text(await bytesOf(await decrypt(blobOf(bytes), p)));

test('round-trips with the right passphrase', async () => {
  const enc = await seal('our trip', 'correct horse');
  assert.equal(isEncrypted(enc), true);
  assert.equal(isEncrypted(utf8('PK\u0003\u0004')), false);
  assert.equal(await open(enc, 'correct horse'), 'our trip');
  assert.equal(await open(await seal('', 'p'), 'p'), '');
});

test('a wrong passphrase or a changed byte is refused', async () => {
  const enc = await seal('our trip', 'correct horse');
  await assert.rejects(open(enc, 'wrong'), PassphraseError);
  const bad = enc.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(open(bad, 'correct horse'), PassphraseError);
});

test('composed and decomposed passphrases are the same passphrase', async () => {
  const enc = await seal('x', 'café');
  assert.equal(await open(enc, 'café'), 'x');
});

test('empty passphrases, plain files and damaged headers are refused', async () => {
  await assert.rejects(encrypt(blobOf(utf8('x')), ''), PassphraseError);
  await assert.rejects(open(utf8('PK plain zip'), 'p'), (e) => e instanceof PassphraseError && /not encrypted/.test(e.message));
  const bad = await seal('x', 'p');
  new DataView(bad.buffer).setUint32(11, 1); // iterations field right after the 11-byte magic
  await assert.rejects(open(bad, 'p'), (e) => e instanceof PassphraseError && /damaged/.test(e.message));
});

test('an encrypted file cut short is called damaged, not a crash', async () => {
  const enc = await seal('our trip', 'p');
  for (const n of [11, 13, 20, 43, 50]) {
    await assert.rejects(open(enc.slice(0, n), 'p'), (e) => e instanceof PassphraseError && /damaged/.test(e.message), `${n} bytes`);
  }
});

test('a file of several chunks round-trips; dropped, swapped or cut-off chunks are refused', async () => {
  const plain = new Uint8Array(CHUNK * 2 + 1000);
  for (let i = 0; i < plain.length; i += 65536) crypto.getRandomValues(plain.subarray(i, i + 65536));
  const enc = await bytesOf(await encrypt(new Blob([plain]), 'p', FAST));
  assert.deepEqual(await bytesOf(await decrypt(new Blob([enc]), 'p')), plain);
  const head = enc.subarray(0, HEADER);
  const at = (/** @type {number} */ i) => enc.subarray(HEADER + i * (CHUNK + 16), HEADER + (i + 1) * (CHUNK + 16));
  const cases = {
    'last chunk dropped': [head, at(0), at(1)],
    'first two swapped': [head, at(1), at(0), at(2)],
    'middle chunk dropped': [head, at(0), at(2)],
  };
  for (const [what, parts] of Object.entries(cases)) {
    await assert.rejects(decrypt(new Blob(parts), 'p'), PassphraseError, what);
  }
});

test('encrypting and decrypting read the file a chunk at a time, never whole', async () => {
  const plain = new PiecesOnly([new Uint8Array(CHUNK * 3 + 5)]);
  const enc = await encrypt(plain, 'p', FAST);
  assert.ok(plain.largest <= CHUNK, `read ${plain.largest} bytes at once`);
  const sealed = new PiecesOnly([enc]);
  const back = await decrypt(sealed, 'p');
  assert.ok(sealed.largest <= CHUNK + 16 + HEADER, `read ${sealed.largest} bytes at once`);
  assert.equal(back.size, CHUNK * 3 + 5);
});
