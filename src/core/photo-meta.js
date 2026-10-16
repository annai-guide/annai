/**
 * Reads what annai needs from a photo's own bytes without decoding it (spec §4.8): its format,
 * stored pixel size, EXIF orientation, and when and where it was taken. Handles JPEG, PNG, WebP
 * and HEIF (HEIC, AVIF). Damaged or hostile files never throw: what can't be read is left out.
 * Also strips that metadata from JPEG and WebP without re-encoding them.
 */

/**
 * @typedef {{ type: string | null, width?: number, height?: number, orientation?: number,
 *   taken?: string, place?: { lat: number, lng: number } }} PhotoInfo
 *   width and height are as stored; with orientation 5–8 the photo shows turned a quarter.
 */

/** @param {Uint8Array} b */
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
/** @param {Uint8Array} b @param {number} at @param {number} n */
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

/** The image format from the file's first bytes, or null. @param {Uint8Array} b @returns {string | null} */
export function sniffImageType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 16 && ascii(b, 4, 4) === 'ftyp') {
    const end = Math.min(b.length, view(b).getUint32(0));
    const brands = [ascii(b, 8, 4)];
    for (let p = 16; p + 4 <= end; p += 4) brands.push(ascii(b, p, 4));
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
    if (brands.some((x) => ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'].includes(x))) return 'image/heic';
    if (brands.includes('mif1') || brands.includes('msf1')) return 'image/heif';
  }
  return null;
}

/** @param {Uint8Array} bytes @returns {PhotoInfo} */
export function readPhotoMeta(bytes) {
  const type = sniffImageType(bytes);
  /** @type {PhotoInfo} */
  const info = { type };
  try {
    if (type === 'image/jpeg') readJpeg(bytes, info);
    else if (type === 'image/png') readPng(bytes, info);
    else if (type === 'image/webp') readWebp(bytes, info);
    else if (type === 'image/heic' || type === 'image/heif' || type === 'image/avif') readHeif(bytes, info);
  } catch {
    // Damaged: keep whatever was read before the damage.
  }
  // Browsers turn a photo by its EXIF orientation only in JPEG; HEIF uses irot (set above).
  if (type === 'image/png' || type === 'image/webp') delete info.orientation;
  return info;
}

/** The size the photo shows at, after its EXIF orientation. @param {PhotoInfo} info */
export function displaySize(info) {
  if (info.width === undefined || info.height === undefined) return {};
  const quarter = (info.orientation ?? 1) >= 5;
  return quarter ? { width: info.height, height: info.width } : { width: info.width, height: info.height };
}

const isSof = (/** @type {number} */ m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

/** @param {Uint8Array} b @param {PhotoInfo} info */
function readJpeg(b, info) {
  const v = view(b);
  let exif = false;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return;
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
    if (m === 0xd9 || m === 0xda) return;
    const len = v.getUint16(p + 2);
    if (len < 2) return;
    const start = p + 4;
    const end = Math.min(p + 2 + len, b.length);
    if (m === 0xe1 && !exif && end - start > 6 && ascii(b, start, 6) === 'Exif\0\0') {
      exif = true;
      readTiff(b.subarray(start + 6, end), info);
    } else if (isSof(m) && end - start >= 5) {
      info.height = v.getUint16(start + 1);
      info.width = v.getUint16(start + 3);
    }
    p += 2 + len;
  }
}

/** @param {Uint8Array} b @param {PhotoInfo} info */
function readPng(b, info) {
  const v = view(b);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = v.getUint32(p);
    const kind = ascii(b, p + 4, 4);
    const data = p + 8;
    if (data + len > b.length) return;
    if (kind === 'IHDR' && len >= 8) {
      info.width = v.getUint32(data);
      info.height = v.getUint32(data + 4);
    } else if (kind === 'eXIf') readTiff(b.subarray(data, data + len), info);
    else if (kind === 'IEND') return;
    p = data + len + 4;
  }
}

/** @param {Uint8Array} b @param {number} at */
const u24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

/** @param {Uint8Array} b @param {PhotoInfo} info */
function readWebp(b, info) {
  const v = view(b);
  const end = Math.min(b.length, 8 + v.getUint32(4, true));
  let p = 12;
  while (p + 8 <= end) {
    const kind = ascii(b, p, 4);
    const len = v.getUint32(p + 4, true);
    const data = p + 8;
    if (data + len > end) return;
    if (kind === 'VP8X' && len >= 10) {
      info.width = 1 + u24(b, data + 4);
      info.height = 1 + u24(b, data + 7);
    } else if (kind === 'VP8 ' && len >= 10 && info.width === undefined) {
      info.width = v.getUint16(data + 6, true) & 0x3fff;
      info.height = v.getUint16(data + 8, true) & 0x3fff;
    } else if (kind === 'VP8L' && len >= 5 && info.width === undefined) {
      const bits = v.getUint32(data + 1, true);
      info.width = (bits & 0x3fff) + 1;
      info.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (kind === 'EXIF') {
      const payload = b.subarray(data, data + len);
      readTiff(len > 6 && ascii(payload, 0, 6) === 'Exif\0\0' ? payload.subarray(6) : payload, info);
    }
    p = data + len + (len & 1);
  }
}

/** Bytes per value of each TIFF field type. @type {Record<number, number>} */
const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

/**
 * Orientation, capture time and GPS position from a TIFF-structured EXIF block.
 * @param {Uint8Array} t @param {PhotoInfo} info
 */
function readTiff(t, info) {
  if (t.length < 8) return;
  const v = view(t);
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return;
  const u16 = (/** @type {number} */ o) => v.getUint16(o, le);
  const u32 = (/** @type {number} */ o) => v.getUint32(o, le);
  if (u16(2) !== 42) return;
  /** @type {Set<number>} */
  const seen = new Set();
  /** @typedef {{ type: number, count: number, at: number }} Entry */
  /** The entries of the IFD at off, by tag. Each IFD is read once, so loops end. @param {number} off */
  const ifd = (off) => {
    /** @type {Map<number, Entry>} */
    const out = new Map();
    if (seen.has(off) || off < 8 || off + 2 > t.length) return out;
    seen.add(off);
    const n = Math.min(u16(off), 500);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (SIZES[type] ?? 0) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (size > 0 && at + size <= t.length) out.set(u16(e), { type, count, at });
    }
    return out;
  };
  /** @param {Entry | undefined} e */
  const str = (e) => (e && e.type === 2 ? ascii(t, e.at, Math.min(e.count, 64)).replace(/\0[\s\S]*$/, '').trim() : undefined);
  /** @param {Entry | undefined} e */
  const short = (e) => (e && e.type === 3 ? u16(e.at) : undefined);
  /** @param {Entry | undefined} e */
  const long = (e) => (e && e.type === 4 ? u32(e.at) : undefined);
  /** @param {Entry | undefined} e */
  const rationals = (e) => (e && e.type === 5 && e.count >= 3 ? [0, 1, 2].map((i) => u32(e.at + i * 8) / u32(e.at + i * 8 + 4)) : undefined);

  const ifd0 = ifd(u32(4));
  const orientation = short(ifd0.get(0x0112));
  if (orientation !== undefined && orientation >= 1 && orientation <= 8) info.orientation = orientation;
  const exifAt = long(ifd0.get(0x8769));
  const exif = exifAt === undefined ? new Map() : ifd(exifAt);
  const taken = exifTime(str(exif.get(0x9003)) ?? str(ifd0.get(0x0132)), str(exif.get(0x9011)));
  if (taken) info.taken = taken;
  const gpsAt = long(ifd0.get(0x8825));
  if (gpsAt !== undefined) {
    const gps = ifd(gpsAt);
    const lat = degrees(rationals(gps.get(2)), str(gps.get(1)), 90);
    const lng = degrees(rationals(gps.get(4)), str(gps.get(3)), 180);
    if (lat !== undefined && lng !== undefined) info.place = { lat, lng };
  }
}

/**
 * "2026:11:26 19:04:12" (+ "-08:00") → "2026-11-26T19:04:12-08:00"; without an offset, local time.
 * @param {string | undefined} s @param {string | undefined} offset
 */
function exifTime(s, offset) {
  const m = s ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s) : null;
  if (!m) return undefined;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return undefined;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? local + offset : local;
}

/** @param {number[] | undefined} r degrees, minutes, seconds @param {string | undefined} ref N, S, E or W @param {number} max */
function degrees(r, ref, max) {
  if (!r || !r.every(Number.isFinite)) return undefined;
  const deg = (r[0] + r[1] / 60 + r[2] / 3600) * (ref === 'S' || ref === 'W' ? -1 : 1);
  return Math.abs(deg) <= max ? Math.round(deg * 1e6) / 1e6 : undefined;
}

/**
 * ISO-BMFF boxes between start and end.
 * @param {Uint8Array} b @param {number} start @param {number} end
 * @returns {{ type: string, start: number, end: number }[]} each box's content range
 */
function boxes(b, start, end) {
  const v = view(b);
  const out = [];
  let p = start;
  while (p + 8 <= end && out.length < 1000) {
    let size = v.getUint32(p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type: ascii(b, p + 4, 4), start: p + header, end: p + size });
    p += size;
  }
  return out;
}

/** Size, rotation and EXIF of a HEIF file's primary image. @param {Uint8Array} b @param {PhotoInfo} info */
function readHeif(b, info) {
  const v = view(b);
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return;
  const parts = boxes(b, meta.start + 4, meta.end); // meta is a full box: 4 bytes of version and flags
  const part = (/** @type {string} */ type) => parts.find((x) => x.type === type);
  const pitm = part('pitm');
  const primary = pitm ? (b[pitm.start] === 0 ? v.getUint16(pitm.start + 4) : v.getUint32(pitm.start + 4)) : 1;

  // Item types, from iinf → infe (version 2 and 3).
  /** @type {Map<number, string>} */
  const kinds = new Map();
  const iinf = part('iinf');
  if (iinf) {
    const first = iinf.start + 4 + (b[iinf.start] === 0 ? 2 : 4);
    for (const infe of boxes(b, first, iinf.end)) {
      const ver = b[infe.start];
      if (infe.type !== 'infe' || ver < 2) continue;
      const id = ver === 2 ? v.getUint16(infe.start + 4) : v.getUint32(infe.start + 4);
      const at = infe.start + 4 + (ver === 2 ? 2 : 4) + 2;
      kinds.set(id, ascii(b, at, 4));
    }
  }

  // Width, height and rotation of the primary item, from iprp → ipco and ipma.
  const iprp = part('iprp');
  if (iprp) {
    const inner = boxes(b, iprp.start, iprp.end);
    const ipco = inner.find((x) => x.type === 'ipco');
    const ipma = inner.find((x) => x.type === 'ipma');
    const props = ipco ? boxes(b, ipco.start, ipco.end) : [];
    if (ipma) {
      const ver = b[ipma.start];
      const wide = (b[ipma.start + 3] & 1) === 1;
      let p = ipma.start + 4;
      const count = v.getUint32(p);
      p += 4;
      for (let i = 0; i < count && p < ipma.end; i++) {
        const id = ver < 1 ? v.getUint16(p) : v.getUint32(p);
        p += ver < 1 ? 2 : 4;
        const n = b[p++];
        for (let j = 0; j < n; j++) {
          const index = wide ? v.getUint16(p) & 0x7fff : b[p] & 0x7f;
          p += wide ? 2 : 1;
          const prop = props[index - 1];
          if (id !== primary || !prop) continue;
          if (prop.type === 'ispe') {
            info.width = v.getUint32(prop.start + 4);
            info.height = v.getUint32(prop.start + 8);
          } else if (prop.type === 'clap') {
            // The clean aperture: the encoded image cropped to what is shown.
            const w = v.getUint32(prop.start) / v.getUint32(prop.start + 4);
            const h = v.getUint32(prop.start + 8) / v.getUint32(prop.start + 12);
            if (Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1) {
              info.width = Math.round(w);
              info.height = Math.round(h);
            }
          } else if (prop.type === 'irot') info.orientation = (b[prop.start] & 3) % 2 === 1 ? 6 : 1;
        }
      }
    }
  }

  // EXIF: the item of type "Exif", located by iloc.
  const exifId = [...kinds].find(([, kind]) => kind === 'Exif')?.[0];
  const iloc = part('iloc');
  if (exifId === undefined || !iloc) return;
  const where = itemExtent(b, iloc, exifId, part('idat'));
  if (!where || where.length < 4) return;
  const skip = view(where).getUint32(0);
  const rotation = info.orientation;
  readTiff(where.subarray(4 + skip), info);
  info.orientation = rotation; // HEIF turns photos with irot; its EXIF orientation is only informative
  if (info.orientation === undefined) delete info.orientation;
}

/**
 * The bytes of one item, when it is stored in a single extent (EXIF always is).
 * @param {Uint8Array} b @param {{ start: number, end: number }} iloc @param {number} want
 * @param {{ start: number, end: number } | undefined} idat
 */
function itemExtent(b, iloc, want, idat) {
  const v = view(b);
  const ver = b[iloc.start];
  let p = iloc.start + 4;
  /** Reads an n-byte big-endian number (n is 0, 2, 4 or 8) and moves past it. @param {number} n */
  const read = (n) => {
    const x = n === 0 ? 0 : n === 2 ? v.getUint16(p) : n === 4 ? v.getUint32(p) : n === 8 ? Number(v.getBigUint64(p)) : NaN;
    p += n;
    return x;
  };
  const sizes = read(2);
  const offsetSize = sizes >> 12;
  const lengthSize = (sizes >> 8) & 15;
  const baseSize = (sizes >> 4) & 15;
  const indexSize = ver === 1 || ver === 2 ? sizes & 15 : 0;
  const count = read(ver < 2 ? 2 : 4);
  for (let i = 0; i < count && p < iloc.end; i++) {
    const id = read(ver < 2 ? 2 : 4);
    const method = ver === 1 || ver === 2 ? read(2) & 15 : 0;
    read(2); // data reference index
    const base = read(baseSize);
    const extents = read(2);
    /** @type {{ offset: number, length: number }[]} */
    const list = [];
    for (let j = 0; j < extents && p < iloc.end; j++) {
      read(indexSize);
      list.push({ offset: read(offsetSize), length: read(lengthSize) });
    }
    if (id !== want) continue;
    if (list.length !== 1) return null;
    const origin = method === 0 ? 0 : method === 1 && idat ? idat.start : NaN;
    const start = origin + base + list[0].offset;
    const length = Math.min(list[0].length, 1 << 20);
    return Number.isFinite(start) && start + length <= b.length ? b.subarray(start, start + length) : null;
  }
  return null;
}
