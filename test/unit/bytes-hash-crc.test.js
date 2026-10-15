import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../../src/core/hash.js';
import { crc32 } from '../../src/core/crc32.js';
import { utf8, text, concat, hex, toBytes, ownBuffer } from '../../src/core/bytes.js';

test('sha256 of "abc"', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 of empty bytes', async () => {
  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 of a subarray hashes only the view', async () => {
  const big = utf8('xxabcxx');
  assert.equal(await sha256Hex(big.subarray(2, 5)), await sha256Hex('abc'));
});

test('crc32 check value', () => {
  assert.equal(crc32(utf8('123456789')), 0xcbf43926);
});

test('crc32 running value equals one-shot', () => {
  assert.equal(crc32(utf8('56789'), crc32(utf8('1234'))), 0xcbf43926);
});

test('utf8, text and concat round-trip non-ASCII', () => {
  assert.equal(text(concat([utf8('案内'), utf8('.guide')])), '案内.guide');
});

test('hex, toBytes and ownBuffer', () => {
  assert.equal(hex(new Uint8Array([0, 15, 255])), '000fff');
  assert.deepEqual([...toBytes(new Uint8Array([1, 2]).buffer)], [1, 2]);
  const view = new Uint8Array([9, 8, 7, 6]).subarray(1, 3);
  assert.deepEqual([...new Uint8Array(ownBuffer(view))], [8, 7]);
});
