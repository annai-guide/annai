import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, isEncrypted, PassphraseError } from '../../src/core/archive-crypto.js';
import { utf8, text } from '../../src/core/bytes.js';

const FAST = 100_000; // the minimum accepted; production uses ITERATIONS

test('round-trips with the right passphrase', async () => {
  const enc = await encrypt(utf8('our trip'), 'correct horse', FAST);
  assert.equal(isEncrypted(enc), true);
  assert.equal(isEncrypted(utf8('PK\u0003\u0004')), false);
  assert.equal(text(await decrypt(enc, 'correct horse')), 'our trip');
});

test('a wrong passphrase or a changed byte is refused', async () => {
  const enc = await encrypt(utf8('our trip'), 'correct horse', FAST);
  await assert.rejects(decrypt(enc, 'wrong'), PassphraseError);
  const bad = enc.slice();
  bad[bad.length - 1] ^= 1;
  await assert.rejects(decrypt(bad, 'correct horse'), PassphraseError);
});

test('composed and decomposed passphrases are the same passphrase', async () => {
  const enc = await encrypt(utf8('x'), 'café', FAST);
  assert.equal(text(await decrypt(enc, 'café')), 'x');
});

test('empty passphrases, plain files and damaged headers are refused', async () => {
  await assert.rejects(encrypt(utf8('x'), ''), PassphraseError);
  await assert.rejects(decrypt(utf8('PK plain zip'), 'p'), (e) => e instanceof PassphraseError && /not encrypted/.test(e.message));
  const enc = await encrypt(utf8('x'), 'p', FAST);
  const bad = enc.slice();
  new DataView(bad.buffer).setUint32(11, 1); // iterations field right after the 11-byte magic
  await assert.rejects(decrypt(bad, 'p'), (e) => e instanceof PassphraseError && /damaged/.test(e.message));
});

test('an encrypted file cut short is called damaged, not a crash', async () => {
  const enc = await encrypt(utf8('our trip'), 'p', FAST);
  for (const n of [11, 13, 20, 43, 50]) {
    await assert.rejects(decrypt(enc.slice(0, n), 'p'), (e) => e instanceof PassphraseError && /damaged/.test(e.message), `${n} bytes`);
  }
});
