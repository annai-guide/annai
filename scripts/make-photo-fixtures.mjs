#!/usr/bin/env node
// Builds the small photos in test/fixtures/photos/ (dev only; needs ImageMagick 7 with HEIC and WebP).
// Every photo is 64×48 pixels as stored: the left half red, the right half blue, so a test can
// tell which way up it was drawn. EXIF is written by the tiny writer below, because ImageMagick
// can't set GPS. Run: node scripts/make-photo-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] ?? fileURLToPath(new URL('../test/fixtures/photos/', import.meta.url));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'annai-photos-'));
const magick = (/** @type {string[]} */ ...args) => execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'inherit'] });

/**
 * A big-endian TIFF block with IFD0 (Orientation), an Exif IFD (DateTimeOriginal, OffsetTimeOriginal)
 * and, when lat/lng are given, a GPS IFD.
 * @param {{ orientation: number, taken: string, offset?: string, lat?: number, lng?: number }} o
 */
export function tiff(o) {
  const ascii = (/** @type {string} */ s) => [...Buffer.from(s + '\0', 'latin1')];
  /** @param {number} deg */
  const dms = (deg) => {
    const d = Math.floor(deg), mf = (deg - d) * 60, m = Math.floor(mf);
    return [[d, 1], [m, 1], [Math.round((mf - m) * 60 * 10000), 10000]];
  };
  /** @type {[string, any[][]][]} */
  const layout = [
    ['IFD0', [[0x0112, 3, [o.orientation]], [0x8769, 4, 'EXIF'], ...(o.lat === undefined ? [] : [[0x8825, 4, 'GPS']])]],
    ['EXIF', [[0x9003, 2, ascii(o.taken)], ...(o.offset ? [[0x9011, 2, ascii(o.offset)]] : [])]],
  ];
  if (o.lat !== undefined && o.lng !== undefined) {
    layout.push(['GPS', [[0x0001, 2, ascii(o.lat >= 0 ? 'N' : 'S')], [0x0002, 5, dms(Math.abs(o.lat))],
      [0x0003, 2, ascii(o.lng >= 0 ? 'E' : 'W')], [0x0004, 5, dms(Math.abs(o.lng))]]]);
  }
  /** @param {any[]} e */
  const valueBytes = ([, type, v]) => (type === 3 ? 2 * v.length : type === 4 ? 4 : type === 5 ? 8 * v.length : v.length);
  /** @type {Record<string, number>} */
  const at = {};
  let off = 8;
  for (const [name, es] of layout) {
    at[name] = off;
    off += 2 + es.length * 12 + 4 + es.reduce((n, e) => n + (valueBytes(e) > 4 ? valueBytes(e) : 0), 0);
  }
  const buf = Buffer.alloc(off);
  buf.write('MM', 0, 'latin1');
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(8, 4);
  for (const [name, es] of layout) {
    let p = at[name];
    let data = p + 2 + es.length * 12 + 4;
    buf.writeUInt16BE(es.length, p);
    p += 2;
    for (const e of es) {
      const [tag, type, v] = e;
      /** @type {number[]} */
      const bytes = [];
      const u32 = (/** @type {number} */ x) => bytes.push(x >>> 24, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
      if (type === 3) for (const x of v) bytes.push(x >> 8, x & 255);
      else if (type === 4) u32(at[v]);
      else if (type === 5) for (const [a, b] of v) { u32(a); u32(b); }
      else bytes.push(...v);
      buf.writeUInt16BE(tag, p);
      buf.writeUInt16BE(type, p + 2);
      buf.writeUInt32BE(type === 4 ? 1 : type === 3 || type === 5 ? v.length : v.length, p + 4);
      if (bytes.length <= 4) Buffer.from(bytes).copy(buf, p + 8);
      else {
        buf.writeUInt32BE(data, p + 8);
        Buffer.from(bytes).copy(buf, data);
        data += bytes.length;
      }
      p += 12;
    }
    buf.writeUInt32BE(0, p);
  }
  return buf;
}

/** A JPEG with an EXIF APP1 segment right after its start marker. @param {Buffer} jpeg @param {Buffer} t */
function withExif(jpeg, t) {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const base = join(work, 'base.png');
magick('-size', '32x48', 'xc:#ff0000', '-size', '32x48', 'xc:#0000ff', '+append', base);
magick(base, '-strip', '-quality', '92', join(work, 'base.jpg'));
const jpeg = readFileSync(join(work, 'base.jpg'));
const bigSur = { lat: 36.2219, lng: -121.7598 };

// Taken at Nepenthe, Big Sur, held sideways: EXIF orientation 6 (turn 90° clockwise to show).
writeFileSync(join(out, 'portrait.jpg'), withExif(jpeg, tiff({ orientation: 6, taken: '2026:11:26 19:04:12', offset: '-08:00', ...bigSur })));
// Upside down (orientation 3), no offset, no location.
writeFileSync(join(out, 'upside-down.jpg'), withExif(jpeg, tiff({ orientation: 3, taken: '2026:11:27 08:15:00' })));
// Upright with a location: the kind of JPEG annai may keep as it is once its EXIF is stripped.
writeFileSync(join(out, 'upright.jpg'), withExif(jpeg, tiff({ orientation: 1, taken: '2026:11:26 12:30:00', offset: '-08:00', ...bigSur })));
// No metadata at all.
writeFileSync(join(out, 'plain.jpg'), jpeg);
// The same photo as WebP (EXIF chunk) and HEIC (Exif item), converted by ImageMagick, which keeps the EXIF.
magick(join(out, 'portrait.jpg'), '-quality', '90', join(out, 'portrait.webp'));
magick(join(out, 'portrait.jpg'), '-quality', '90', join(out, 'portrait.heic'));
// A screenshot: PNG, no metadata.
magick(base, join(out, 'screenshot.png'));
rmSync(work, { recursive: true, force: true });
console.log(`wrote photo fixtures to ${out}`);
