import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZipWriter, ZipReader, readZip, ZipError } from '../../src/core/zip.js';
import { PiecesOnly } from './pieces.js';
import { utf8, text } from '../../src/core/bytes.js';

const bytesOf = async (/** @type {Blob} */ blob) => new Uint8Array(await blob.arrayBuffer());
const hasUnzip = (() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('round-trips text, binary, empty files and UTF-8 names', async () => {
  const z = new ZipWriter();
  const note = '# 案内\n'.repeat(50);
  const bin = crypto.getRandomValues(new Uint8Array(60000));
  await z.add('trips/trip-1/notes/案内.md', utf8(note));
  await z.add('trips/trip-1/files/photo.jpg', bin, { compress: false });
  await z.add('empty.txt', new Uint8Array());
  const out = await readZip(await bytesOf(z.finish()));
  assert.deepEqual([...out.keys()], ['trips/trip-1/notes/案内.md', 'trips/trip-1/files/photo.jpg', 'empty.txt']);
  assert.equal(text(out.get('trips/trip-1/notes/案内.md')), note);
  assert.deepEqual(out.get('trips/trip-1/files/photo.jpg'), bin);
  assert.equal(out.get('empty.txt')?.length, 0);
});

test('compressible text is deflated', async () => {
  const z = new ZipWriter();
  const big = utf8('a'.repeat(10000));
  await z.add('a.txt', big);
  const blob = z.finish();
  assert.ok(blob.size < 1000, `archive is ${blob.size} bytes`);
  assert.deepEqual((await readZip(await bytesOf(blob))).get('a.txt'), big);
});

test('incompressible data is stored even when compression is requested', async () => {
  const z = new ZipWriter();
  const noise = crypto.getRandomValues(new Uint8Array(4000));
  await z.add('noise.bin', noise);
  const blob = z.finish();
  assert.ok(blob.size < 4000 + 200);
  assert.deepEqual((await readZip(await bytesOf(blob))).get('noise.bin'), noise);
});

test('duplicate names are refused', async () => {
  const z = new ZipWriter();
  await z.add('a', utf8('1'));
  await assert.rejects(z.add('a', utf8('2')), ZipError);
});

test('a flipped byte is caught by the checksum', async () => {
  const z = new ZipWriter();
  await z.add('a.txt', utf8('hello world'), { compress: false });
  const b = await bytesOf(z.finish());
  b[30 + 'a.txt'.length] ^= 1; // first data byte follows the 30-byte header and the name
  await assert.rejects(readZip(b), (e) => e instanceof ZipError && /corrupted/.test(e.message));
});

test('something that is not a zip is refused', async () => {
  await assert.rejects(readZip(utf8('just text, no zip here')), (e) => e instanceof ZipError && /not a zip/.test(e.message));
});

test('reads an archive made by Info-ZIP', async () => {
  const z = await readZip(new Uint8Array(await readFile(new URL('../fixtures/infozip.zip', import.meta.url))));
  assert.equal(text(z.get('hello.txt')), 'hello zip\n'.repeat(200));
  assert.equal(text(z.get('dir/annai.txt')), 'annai\n');
  assert.equal(z.has('dir/'), false);
});

test('Info-ZIP accepts our archives', { skip: !hasUnzip && 'unzip is not installed' }, async () => {
  const z = new ZipWriter();
  await z.add('hello.txt', utf8('hello\n'.repeat(100)));
  await z.add('notes/案内.md', utf8('案内'), { compress: false });
  const dir = await mkdtemp(join(tmpdir(), 'annai-zip-'));
  const file = join(dir, 'ours.zip');
  await writeFile(file, await bytesOf(z.finish()));
  execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
});

/** Rewrites the uncompressed size of the only entry in a one-entry archive (local and central headers). @param {Uint8Array} b @param {number} size */
function lieAboutSize(b, size) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  v.setUint32(22, size, true);
  for (let i = b.length - 22; i >= 0; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      v.setUint32(v.getUint32(i + 16, true) + 24, size, true);
      break;
    }
  }
  return b;
}

test('an entry that inflates beyond its declared size is stopped early (zip bomb)', async () => {
  const z = new ZipWriter();
  await z.add('zeros.bin', new Uint8Array(4 * 1024 * 1024));
  const b = lieAboutSize(await bytesOf(z.finish()), 1024);
  await assert.rejects(readZip(b), (e) => e instanceof ZipError && /larger than it says/.test(e.message));
});

test('archives whose contents add up past the limit are refused before inflating', async () => {
  const z = new ZipWriter();
  await z.add('a.txt', utf8('a'.repeat(5000)));
  await z.add('b.txt', utf8('b'.repeat(5000)));
  const b = await bytesOf(z.finish());
  await assert.rejects(readZip(b, { maxTotal: 8000 }), (e) => e instanceof ZipError && /too large/.test(e.message));
  assert.equal((await readZip(b, { maxTotal: 10000 })).size, 2);
});

/** @param {number} n */
function noise(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, i + 65536));
  return b;
}

test('ZipReader reads one entry at a time from a file, never the whole file', async () => {
  const z = new ZipWriter();
  const photos = [noise(512 * 1024), noise(512 * 1024), noise(512 * 1024)];
  for (const [i, b] of photos.entries()) await z.add(`p${i}.jpg`, b, { compress: false });
  await z.add('notes.md', utf8('# 案内\n'.repeat(1000)));
  const file = new PiecesOnly([z.finish()]);
  const zip = await ZipReader.open(file);
  assert.deepEqual(zip.names(), ['p0.jpg', 'p1.jpg', 'p2.jpg', 'notes.md']);
  assert.equal(zip.has('p1.jpg'), true);
  assert.equal(zip.size('p1.jpg'), 512 * 1024);
  assert.deepEqual(await zip.read('p1.jpg'), photos[1]);
  assert.equal(text(await zip.read('notes.md')), '# 案内\n'.repeat(1000));
  await assert.rejects(zip.read('missing'), ZipError);
  assert.ok(file.largest < 600 * 1024, `read ${file.largest} of ${file.size} bytes at once`);
});

test('an archive with two entries of the same name is refused', async () => {
  const z = new ZipWriter();
  await z.add('a.txt', utf8('one'));
  await z.add('b.txt', utf8('two'));
  const bytes = await bytesOf(z.finish());
  const [a, b] = [utf8('a.txt'), utf8('b.txt')];
  for (let i = 0; i + b.length <= bytes.length; i++) {
    if (b.every((x, j) => bytes[i + j] === x)) bytes.set(a, i); // rename b.txt to a.txt in every header
  }
  await assert.rejects(ZipReader.open(new Blob([bytes])), (e) => e instanceof ZipError && /two entries/.test(e.message));
});

test('an entry that declares more than the limit is refused before it is read', async () => {
  const z = new ZipWriter();
  await z.add('big.txt', utf8('x'.repeat(5000)));
  await assert.rejects(ZipReader.open(z.finish(), { maxEntry: 4000 }), (e) => e instanceof ZipError && /too large/.test(e.message));
});
