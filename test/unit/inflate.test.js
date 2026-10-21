import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { inflateSmall } from '../../src/core/inflate.js';
import { deflateRaw, ZipWriter, ZipReader, ZipError } from '../../src/core/zip.js';
import { utf8 } from '../../src/core/bytes.js';

/** Deterministic noise with some repeats, so a block has both literals and matches. @param {number} n */
function sample(n) {
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = i > 40 && (x >>> 16) % 3 === 0 ? out[i - 1 - ((x >>> 8) % 40)] : x >>> 24;
  }
  return out;
}

test('plain-code inflate agrees with the platform for text, noise, repeats, nothing and stored blocks', async () => {
  const cases = [
    new Uint8Array(0),
    utf8('a'),
    utf8('the quick brown fox '.repeat(500)),
    utf8('京都の春 '.repeat(300)),
    new Uint8Array(5000).fill(7),
    sample(3000),
    crypto.getRandomValues(new Uint8Array(4096)),
    sample(60000),
  ];
  for (const c of cases) {
    assert.deepEqual(inflateSmall(await deflateRaw(c), c.length), c, `platform deflate of ${c.length} bytes`);
    for (const level of [0, 1, 9]) assert.deepEqual(inflateSmall(new Uint8Array(deflateSync(c, { level })).subarray(2, -4), c.length), c, `zlib level ${level}`);
  }
});

test('plain-code inflate refuses output larger than declared, and damaged data', async () => {
  const data = utf8('x'.repeat(1000));
  const packed = await deflateRaw(data);
  assert.throws(() => inflateSmall(packed, 999), RangeError);
  assert.throws(() => inflateSmall(packed.subarray(0, packed.length - 3), 1000));
  assert.throws(() => inflateSmall(new Uint8Array([0xff, 0xff, 0xff]), 10));
});

test('reading a run of small entries takes a few reads of the file, not two for each', async () => {
  const w = new ZipWriter();
  for (let i = 0; i < 200; i++) await w.add(`n/${i}.md`, utf8(`note ${i} `.repeat(100)));
  await w.add('photo.bin', crypto.getRandomValues(new Uint8Array(3000)), { compress: false });
  const blob = w.finish();
  let slices = 0;
  const counted = new Proxy(blob, { get(t, k) {
    if (k === 'slice') return (/** @type {any[]} */ ...a) => { slices++; return t.slice(...a); };
    const v = Reflect.get(t, k, t);
    return typeof v === 'function' ? v.bind(t) : v;
  } });
  const zip = await ZipReader.open(/** @type {Blob} */ (counted));
  slices = 0;
  for (const n of zip.names()) await zip.read(n);
  assert.ok(slices <= 8, `${slices} reads of the file for 201 entries`);
  assert.equal(new TextDecoder().decode(await zip.read('n/7.md')), 'note 7 '.repeat(100));
});

test('an entry that says it is smaller than it is still stops the plain inflate', async () => {
  const w = new ZipWriter();
  await w.add('a.txt', utf8('y'.repeat(5000)));
  const bytes = new Uint8Array(await w.finish().arrayBuffer());
  // The usize in the central directory is lowered by one: a bomb says less than it holds.
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 4999, true);
  const zip = await ZipReader.open(new Blob([bytes]));
  await assert.rejects(zip.read('a.txt'), (e) => e instanceof ZipError && /larger than it says/.test(e.message));
});
