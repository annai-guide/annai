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

test('a fixed-seed fuzz against node\'s zlib: valid streams agree; a damaged one is refused, or gives what zlib gives, never more (review)', async () => {
  const { default: zlib } = await import('node:zlib');
  let seed = 20261021;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const ri = (/** @type {number} */ n) => Math.floor(rnd() * n);
  const strategies = [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE, zlib.constants.Z_FIXED];
  const words = ['the ', 'quick ', 'brown ', 'fox ', '京都 ', '\n', '{"a":1}', 'zz'];
  /** @param {number} n */
  const sampleOf = (n) => {
    const out = new Uint8Array(n);
    const kind = ri(4);
    if (kind === 0) for (let i = 0; i < n; i++) out[i] = ri(256);
    else if (kind === 1) { let t = ''; while (t.length < n) t += words[ri(words.length)]; out.set(new TextEncoder().encode(t).subarray(0, n)); }
    else if (kind === 2) { out.fill(ri(256)); for (let i = 0; i < n / 50; i++) out[ri(n)] = ri(256); }
    else for (let i = 0; i < n; i++) out[i] = i > 300 && rnd() < 0.6 ? out[i - 1 - ri(Math.min(i, 32768) - 1 || 1)] : ri(8);
    return out;
  };
  const same = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  let damagedRefused = 0;
  for (let iter = 0; iter < 120; iter++) {
    const n = [0, 1, 2, 10, 100, 1000, 5000, 20000][ri(8)];
    const data = sampleOf(n);
    const packed = zlib.deflateRawSync(data, { level: ri(10), strategy: strategies[ri(5)], memLevel: 1 + ri(9), windowBits: 9 + ri(7) });
    assert.ok(same(inflateSmall(packed, n), data), `valid stream ${iter}`);
    for (let k = 0; k < 5; k++) {
      const c = new Uint8Array(packed);
      const mode = ri(3);
      if (mode === 0 && c.length) c[ri(c.length)] ^= 1 << ri(8);
      else if (mode === 1 && c.length) for (let j = 0; j < 1 + ri(8); j++) c[ri(c.length)] = ri(256);
      const input = mode === 2 ? c.subarray(0, ri(c.length + 1)) : c;
      let ours = null;
      try { ours = inflateSmall(input, n + 64); } catch { damagedRefused++; }
      let ref = null;
      try { ref = zlib.inflateRawSync(input, { maxOutputLength: Math.max(n + 64, 1) }); } catch { /* refused */ }
      if (ours) assert.ok(ref && same(ours, ref), `a damaged stream ${iter}.${k} that zlib refuses, or reads differently, was read`);
    }
  }
  assert.ok(damagedRefused > 100, String(damagedRefused));
});
