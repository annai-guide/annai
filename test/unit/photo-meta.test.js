import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sniffImageType, sniffMediaType, readPhotoMeta, displaySize, stripMetadata } from '../../src/core/photo-meta.js';

/** @param {string} name */
const fixture = async (name) => new Uint8Array(await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)));
const bigSur = { lat: 36.2219, lng: -121.7598 };
const hasMagick = (() => { try { execFileSync('magick', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** A deterministic stream of numbers in [0, 1), so a failure can be replayed. */
function randomFrom(seed = 7) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

test('sniffImageType knows a photo by its first bytes, whatever it is called', async () => {
  assert.equal(sniffImageType(await fixture('portrait.jpg')), 'image/jpeg');
  assert.equal(sniffImageType(await fixture('portrait.webp')), 'image/webp');
  assert.equal(sniffImageType(await fixture('portrait.heic')), 'image/heic');
  assert.equal(sniffImageType(await fixture('screenshot.png')), 'image/png');
  assert.equal(sniffImageType(new TextEncoder().encode('GIF89a and the rest')), 'image/gif');
  assert.equal(sniffImageType(new TextEncoder().encode('# just notes')), null);
  assert.equal(sniffImageType(new Uint8Array(0)), null);
});

test('a sideways JPEG: its size, orientation, and when and where it was taken', async () => {
  const info = readPhotoMeta(await fixture('portrait.jpg'));
  assert.deepEqual(info, { type: 'image/jpeg', width: 64, height: 48, orientation: 6, taken: '2026-11-26T19:04:12-08:00', place: bigSur });
  assert.deepEqual(displaySize(info), { width: 48, height: 64 });
});

test('a capture time without an offset stays local time, and no GPS means no place', async () => {
  const info = readPhotoMeta(await fixture('upside-down.jpg'));
  assert.equal(info.taken, '2026-11-27T08:15:00');
  assert.equal(info.orientation, 3);
  assert.equal(info.place, undefined);
  assert.deepEqual(displaySize(info), { width: 64, height: 48 });
});

test('WebP and HEIC carry the same EXIF; only JPEG is turned by its EXIF orientation', async () => {
  // Chromium and WebKit ignore EXIF orientation in WebP, so annai must too.
  assert.deepEqual(readPhotoMeta(await fixture('portrait.webp')), { type: 'image/webp', width: 64, height: 48, taken: '2026-11-26T19:04:12-08:00', place: bigSur });
  const heic = readPhotoMeta(await fixture('portrait.heic'));
  assert.equal(heic.taken, '2026-11-26T19:04:12-08:00');
  assert.deepEqual(heic.place, bigSur);
  assert.deepEqual(displaySize(heic), { width: 48, height: 64 }); // cropped by clap, then turned by irot
});

test('photos without metadata give their size only', async () => {
  assert.deepEqual(readPhotoMeta(await fixture('plain.jpg')), { type: 'image/jpeg', width: 64, height: 48 });
  assert.deepEqual(readPhotoMeta(await fixture('screenshot.png')), { type: 'image/png', width: 64, height: 48 });
  assert.deepEqual(readPhotoMeta(new TextEncoder().encode('not a photo')), { type: null });
});

test('an impossible capture time is left out', async () => {
  const b = (await fixture('portrait.jpg')).slice();
  const at = Buffer.from(b).indexOf('2026:11:26 19:04:12', 0, 'latin1');
  b.set(new TextEncoder().encode('2026:13:40 25:04:12'), at);
  const info = readPhotoMeta(b);
  assert.equal(info.taken, undefined);
  assert.deepEqual(info.place, bigSur);
});

test('an EXIF block that points back at itself is read once, not forever', async () => {
  const b = (await fixture('portrait.jpg')).slice();
  const v = new DataView(b.buffer);
  const tiff = 12; // after FFD8, the APP1 marker (2), its length (2) and "Exif\0\0" (6)
  const ifd0 = tiff + v.getUint32(tiff + 4);
  for (let i = 0; i < v.getUint16(ifd0); i++) {
    const e = ifd0 + 2 + i * 12;
    if (v.getUint16(e) === 0x8769 || v.getUint16(e) === 0x8825) v.setUint32(e + 8, 8); // point the Exif and GPS IFDs at IFD0
  }
  const info = readPhotoMeta(b);
  assert.equal(info.orientation, 6);
  assert.equal(info.taken, undefined);
  assert.equal(info.place, undefined);
});

test('damaged or hostile photos never throw and never hang', async () => {
  const random = randomFrom();
  for (const name of await readdir(new URL('../fixtures/photos/', import.meta.url))) {
    const b = await fixture(name);
    for (let n = 0; n <= b.length; n++) readPhotoMeta(b.subarray(0, n));
    for (let k = 0; k < 500; k++) {
      const c = b.slice();
      for (let j = 0; j < 4; j++) c[Math.floor(random() * c.length)] = Math.floor(random() * 256);
      readPhotoMeta(c);
    }
  }
});

test('stripping a JPEG removes its EXIF and leaves every other byte alone', async () => {
  const s = stripMetadata(await fixture('upright.jpg'), 'image/jpeg');
  assert.ok(s);
  assert.deepEqual(s, await fixture('plain.jpg')); // the fixture is plain.jpg with an EXIF segment added
});

test('stripping keeps colour profiles and drops a second image after the first one ends', async () => {
  const jpg = await fixture('upright.jpg');
  const icc = new Uint8Array([0xff, 0xe2, 0x00, 0x10, ...new TextEncoder().encode('ICC_PROFILE\0'), 1, 1]);
  const gainMap = await fixture('portrait.jpg'); // a second JPEG with its own EXIF and GPS, as an HDR gain map can be
  const s = stripMetadata(new Uint8Array([...jpg.subarray(0, 2), ...icc, ...jpg.subarray(2), ...gainMap]), 'image/jpeg');
  assert.ok(s);
  const text = Buffer.from(s).toString('latin1');
  assert.ok(text.includes('ICC_PROFILE'));
  assert.ok(!text.includes('Exif'));
  assert.equal(s.length, (await fixture('plain.jpg')).length + icc.length);
});

test('stripping a WebP removes its EXIF chunk and clears its flag', async () => {
  const s = stripMetadata(await fixture('portrait.webp'), 'image/webp');
  assert.ok(s);
  assert.deepEqual(readPhotoMeta(s), { type: 'image/webp', width: 64, height: 48 });
  assert.equal(new DataView(s.buffer, s.byteOffset).getUint32(4, true), s.length - 8); // the RIFF size
  assert.equal(s[20] & 0x0c, 0); // VP8X flags: no EXIF, no XMP
});

test('stripped photos still decode', { skip: hasMagick ? false : 'ImageMagick is not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-strip-'));
  try {
    for (const [name, type] of [['upright.jpg', 'image/jpeg'], ['portrait.webp', 'image/webp']]) {
      const file = join(dir, name);
      await writeFile(file, /** @type {Uint8Array} */ (stripMetadata(await fixture(name), type)));
      assert.equal(execFileSync('magick', ['identify', '-format', '%wx%h', file]).toString(), '64x48');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stripping declines what it cannot follow, and never throws', async () => {
  assert.equal(stripMetadata(await fixture('screenshot.png'), 'image/png'), null);
  assert.equal(stripMetadata(await fixture('portrait.heic'), 'image/heic'), null);
  const random = randomFrom(11);
  for (const [name, type] of [['upright.jpg', 'image/jpeg'], ['portrait.webp', 'image/webp']]) {
    const b = await fixture(name);
    for (let n = 0; n < b.length; n++) stripMetadata(b.subarray(0, n), type);
    for (let k = 0; k < 500; k++) {
      const c = b.slice();
      for (let j = 0; j < 4; j++) c[Math.floor(random() * c.length)] = Math.floor(random() * 256);
      stripMetadata(c, type);
    }
  }
});

/** ISO-BMFF boxes for crafted HEIF files. */
const be = (/** @type {number} */ n, /** @type {number} */ size) => { const b = new Uint8Array(size); for (let i = size - 1; i >= 0; i--, n = Math.floor(n / 256)) b[i] = n % 256; return b; };
const ascii4 = (/** @type {string} */ s) => new TextEncoder().encode(s);
/** @param {Uint8Array[]} parts */
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const box = (/** @type {string} */ type, /** @type {Uint8Array[]} */ ...parts) => { const body = cat(...parts); return cat(be(8 + body.length, 4), ascii4(type), body); };
const fullBox = (/** @type {string} */ type, /** @type {number} */ version, /** @type {Uint8Array[]} */ ...parts) => box(type, be(version, 1), be(0, 3), ...parts);

test('a HEIF item table built to make the reader loop is read in no time', () => {
  // 3,000 items, each claiming 65,535 extents whose fields are zero bytes long, and the Exif item last.
  const items = [];
  for (let i = 0; i < 3000; i++) items.push(be(i === 2999 ? 1 : i + 2, 2), be(0, 2), be(0, 2), be(0xffff, 2));
  const iloc = fullBox('iloc', 1, be(0, 1), be(0, 1), be(3000, 2), ...items);
  const iinf = fullBox('iinf', 0, be(1, 2), fullBox('infe', 2, be(1, 2), be(0, 2), ascii4('Exif'), be(0, 1)));
  const file = cat(box('ftyp', ascii4('heic'), be(0, 4), ascii4('mif1')), fullBox('meta', 0, iinf, iloc));
  const started = performance.now();
  assert.equal(readPhotoMeta(file).type, 'image/heic');
  assert.ok(performance.now() - started < 250, `took ${Math.round(performance.now() - started)} ms`);
});

test('the brands of a HEIF file are read from its first bytes only', () => {
  // An ftyp box that claims to be as long as the file, with "heic" far from the start.
  const file = cat(be(4096, 4), ascii4('ftyp'), ascii4('xxxx'), be(0, 4), new Uint8Array(1000), ascii4('heic'), new Uint8Array(4096 - 1028));
  assert.equal(sniffImageType(file), null);
});

test('stripping keeps only what decoding needs, wherever else metadata hides', async () => {
  const upright = await fixture('upright.jpg');
  const plain = await fixture('plain.jpg');
  const exif = upright.subarray(2, 4 + ((upright[4] << 8) | upright[5])); // the fixture's APP1 EXIF segment, GPS included
  const as = (/** @type {number} */ marker) => { const s = exif.slice(); s[1] = marker; return s; };
  const icc = new Uint8Array([0xff, 0xe2, 0x00, 0x10, ...new TextEncoder().encode('ICC_PROFILE\0'), 1, 1]);
  const crafted = cat(
    plain.subarray(0, 2),
    as(0xe3), as(0xef), as(0xe2), // EXIF in APP3, APP15, and an APP2 that is no colour profile
    icc,
    plain.subarray(2, plain.length - 2),
    exif, // EXIF after the image data, before the end marker
    plain.subarray(plain.length - 2),
  );
  const s = stripMetadata(crafted, 'image/jpeg');
  assert.ok(s);
  assert.ok(!Buffer.from(s).toString('latin1').includes('Exif'));
  assert.deepEqual(s, cat(plain.subarray(0, 2), icc, plain.subarray(2)));
});

test('stripping a WebP keeps only image and colour chunks', async () => {
  const webp = await fixture('portrait.webp');
  const exif = Buffer.from(webp).indexOf('EXIF');
  const payload = webp.subarray(exif + 8, exif + 8 + new DataView(webp.buffer, webp.byteOffset).getUint32(exif + 4, true));
  const chunk = (/** @type {string} */ type) => cat(ascii4(type), new Uint8Array(new Uint32Array([payload.length]).buffer), payload, payload.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
  const body = cat(webp.subarray(12), chunk('META'), chunk('exif'));
  const crafted = cat(ascii4('RIFF'), new Uint8Array(new Uint32Array([body.length + 4]).buffer), ascii4('WEBP'), body);
  const s = stripMetadata(crafted, 'image/webp');
  assert.ok(s);
  assert.ok(!Buffer.from(s).toString('latin1').includes('Exif'));
  const kinds = [];
  for (let p = 12; p + 8 <= s.length;) {
    const len = new DataView(s.buffer, s.byteOffset).getUint32(p + 4, true);
    kinds.push(Buffer.from(s.subarray(p, p + 4)).toString('latin1'));
    p += 8 + len + (len & 1);
  }
  assert.deepEqual(kinds, ['VP8X', 'VP8 ']);
});

test('stripping drops a JFXX thumbnail and an Adobe segment with more than its 12 bytes, both of which can carry EXIF', async () => {
  const upright = await fixture('upright.jpg');
  const plain = await fixture('plain.jpg');
  const exif = upright.subarray(6, 4 + ((upright[4] << 8) | upright[5])); // the APP1 payload: "Exif\0\0" and the TIFF block
  const segment = (/** @type {number} */ marker, /** @type {Uint8Array} */ body) => cat(new Uint8Array([0xff, marker]), be(body.length + 2, 2), body);
  const jfxx = segment(0xe0, cat(ascii4('JFXX'), new Uint8Array([0, 0x10]), plain.subarray(0, 2), segment(0xe1, exif), plain.subarray(2)));
  const adobe = segment(0xee, cat(ascii4('Adobe'), new Uint8Array(7), exif));
  const s = stripMetadata(cat(plain.subarray(0, 2), jfxx, adobe, plain.subarray(2)), 'image/jpeg');
  assert.ok(s);
  assert.ok(!Buffer.from(s).toString('latin1').includes('Exif'));
  assert.deepEqual(s, plain);
});

test('an animated WebP is not stripped: its frames can hold chunks of their own', async () => {
  const webp = await fixture('portrait.webp');
  const anim = cat(ascii4('ANIM'), new Uint8Array([6, 0, 0, 0]), new Uint8Array(6));
  const body = cat(webp.subarray(12), anim);
  const animated = cat(ascii4('RIFF'), new Uint8Array(new Uint32Array([body.length + 4]).buffer), ascii4('WEBP'), body);
  assert.equal(stripMetadata(animated, 'image/webp'), null);
});

/** A 1×1 GIF, split after its global colour table, plus extension blocks: the loop count, XMP with GPS, a comment. */
function taggedGif() {
  const gif = new Uint8Array(Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  const head = gif.subarray(0, 19); // header, screen descriptor, 2-colour table
  const rest = gif.subarray(19); // graphic control, image, trailer
  const ext = (/** @type {number} */ label, /** @type {Uint8Array[]} */ ...blocks) => cat(new Uint8Array([0x21, label]), ...blocks.map((b) => cat(new Uint8Array([b.length]), b)), new Uint8Array([0]));
  const loop = ext(0xff, ascii4('NETSCAPE2.0'), new Uint8Array([1, 0, 0]));
  const xmp = ext(0xff, ascii4('XMP DataXMP'), ascii4('<x:xmpmeta><exif:GPSLatitude>36,13.31N</exif:GPSLatitude></x:xmpmeta>'));
  const comment = ext(0xfe, ascii4('taken at home'));
  return { head, rest, loop, tagged: cat(head, loop, xmp, comment, rest, ascii4('after the end')) };
}

test('stripping a GIF drops its comments and application data, and keeps its loop count', () => {
  const { head, rest, loop, tagged } = taggedGif();
  assert.deepEqual(stripMetadata(tagged, 'image/gif'), cat(head, loop, rest));
  assert.equal(stripMetadata(tagged.subarray(0, 40), 'image/gif'), null); // cut off before its end
});

test('raw photos (TIFF, DNG) and videos are recognised by their first bytes', () => {
  assert.equal(sniffImageType(cat(ascii4('II'), new Uint8Array([42, 0, 8, 0, 0, 0]))), 'image/tiff'); // DNG is TIFF too
  assert.equal(sniffImageType(cat(ascii4('MM'), new Uint8Array([0, 42, 0, 0, 0, 8]))), 'image/tiff');
  const ftyp = (/** @type {string} */ brand) => cat(be(20, 4), ascii4('ftyp'), ascii4(brand), be(0, 4), ascii4(brand));
  assert.equal(sniffImageType(ftyp('qt  ')), null);
  assert.equal(sniffMediaType(ftyp('qt  ')), 'video/quicktime');
  assert.equal(sniffMediaType(ftyp('isom')), 'video/mp4');
  assert.equal(sniffMediaType(cat(be(8, 4), ascii4('wide'), be(16, 4), ascii4('mdat'))), 'video/quicktime'); // an old QuickTime file
  assert.equal(sniffMediaType(ftyp('heic')), 'image/heic');
  assert.equal(sniffMediaType(ascii4('# notes')), null);
});
