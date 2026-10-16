import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { sniffImageType, readPhotoMeta, displaySize } from '../../src/core/photo-meta.js';

/** @param {string} name */
const fixture = async (name) => new Uint8Array(await readFile(new URL(`../fixtures/photos/${name}`, import.meta.url)));
const bigSur = { lat: 36.2219, lng: -121.7598 };

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
