/**
 * annai's own audio files (spec §10.6), with no library: AudioEncoder's
 * packets in Ogg Opus (RFC 7845), WebM Opus, AAC's ADTS frames, and FLAC. A segment is at most 30 s.
 */

/** @param {string} s */
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** @param {Uint8Array[]} parts */
export function cat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Samples at 48 kHz an Opus packet decodes to, from its TOC byte (RFC 6716 §3.1). @param {Uint8Array} p */
export function opusSamples(p) {
  const config = p[0] >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const c = p[0] & 3;
  return frame * (c === 0 ? 1 : c === 3 ? p[1] & 0x3f : 2);
}

/** @typedef {{ rate: number, preSkip: number, channels?: number, samples?: number }} OpusInfo  rate and samples: the input's (samples trim the end) */

/** @param {OpusInfo} o */
export function opusHead({ rate, preSkip, channels = 1 }) {
  const b = new Uint8Array(19);
  b.set(ascii('OpusHead'));
  const dv = new DataView(b.buffer);
  b[8] = 1;
  b[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, rate, true);
  return b;
}

// Ogg's own CRC: polynomial 0x04C11DB7, not reflected, from 0 (not the zip CRC).
const CRC = Uint32Array.from({ length: 256 }, (_, i) => {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
  return r >>> 0;
});
/** @param {Uint8Array} b */
export function oggCrc(b) {
  let c = 0;
  for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0;
  return c;
}

/** @param {Uint8Array[]} packets @param {number} flags 2 first, 4 last @param {number} granule @param {number} seq */
function page(packets, flags, granule, seq) {
  /** @type {number[]} */
  const lacing = [];
  for (const p of packets) {
    for (let n = p.length; ; n -= 255) {
      lacing.push(Math.min(n, 255));
      if (n < 255) break;
    }
  }
  const head = new Uint8Array(27 + lacing.length);
  head.set(ascii('OggS'));
  head[5] = flags;
  const dv = new DataView(head.buffer);
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, 0x616e6e61, true); // one serial number always: the same packets give the same file
  dv.setUint32(18, seq, true);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const out = cat([head, ...packets]);
  new DataView(out.buffer).setUint32(22, oggCrc(out), true);
  return out;
}

/** Where the sound ends, at 48 kHz with the pre-skip: what the last packet decodes past the input is cut. @param {Uint8Array[]} packets @param {OpusInfo} o */
function ending(packets, o) {
  const total = packets.reduce((n, p) => n + opusSamples(p), 0);
  return o.samples === undefined ? total : Math.min(total, o.preSkip + Math.ceil((o.samples * 48_000) / o.rate));
}

/** An Ogg Opus file: OpusHead and OpusTags pages, then pages of at most 50 packets (about a second). @param {Uint8Array[]} packets @param {OpusInfo} o */
export function oggOpus(packets, o) {
  const tags = cat([ascii('OpusTags'), Uint8Array.of(5, 0, 0, 0), ascii('annai'), new Uint8Array(4)]);
  const pages = [page([opusHead(o)], 2, 0, 0), page([tags], 0, 0, 1)];
  /** @type {Uint8Array[]} */
  let held = [];
  let laces = 0;
  let decoded = 0;
  for (const p of packets) {
    const n = Math.floor(p.length / 255) + 1;
    if (laces + n > 255 || held.length === 50) {
      pages.push(page(held, 0, decoded, pages.length));
      held = [];
      laces = 0;
    }
    held.push(p);
    laces += n;
    decoded += opusSamples(p);
  }
  pages.push(page(held, 4, ending(packets, o), pages.length));
  return cat(pages);
}

/** An EBML size, in as few bytes as it needs. @param {number} n */
function vint(n) {
  for (let len = 1; len <= 4; len++) {
    if (n < 2 ** (7 * len) - 1) return Uint8Array.from({ length: len }, (_, i) => ((n / 2 ** (8 * (len - 1 - i))) & 0xff) | (i === 0 ? 0x80 >> (len - 1) : 0));
  }
  return Uint8Array.of(0x01, 0, 0, 0, (n / 2 ** 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}
/** @param {number} id as written @param {Uint8Array | Uint8Array[]} body */
function el(id, body) {
  const b = Array.isArray(body) ? cat(body) : body;
  const ids = [];
  for (let x = id; x > 0; x = Math.floor(x / 256)) ids.unshift(x & 0xff);
  return cat([Uint8Array.from(ids), vint(b.length), b]);
}
/** @param {number} id @param {number} n */
const uint = (id, n) => {
  const bytes = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  return el(id, Uint8Array.from(bytes));
};
/** @param {number} id @param {number} x */
const float = (id, x) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return el(id, b);
};

/**
 * A WebM Opus file: one A_OPUS track, the packets as SimpleBlocks in one cluster (times in ms,
 * 16 bits), the last in a BlockGroup whose DiscardPadding trims the end. @param {Uint8Array[]} packets @param {OpusInfo} o
 */
export function webmOpus(packets, o) {
  const ns = (/** @type {number} */ samples) => Math.round((samples / 48_000) * 1e9);
  const end = ending(packets, o);
  const header = el(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), el(0x4282, ascii('webm')), uint(0x4287, 4), uint(0x4285, 2)]);
  const info = el(0x1549a966, [uint(0x2ad7b1, 1_000_000), float(0x4489, Math.round((end - o.preSkip) / 48))]);
  const track = el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 2), el(0x86, ascii('A_OPUS')), el(0x63a2, opusHead(o)),
    uint(0x56aa, ns(o.preSkip)), uint(0x56bb, 80_000_000), el(0xe1, [float(0xb5, 48_000), uint(0x9f, o.channels ?? 1)])]);
  let at = 0;
  const blocks = packets.map((p, i) => {
    const t = Math.round(at / 48);
    at += opusSamples(p);
    const block = cat([Uint8Array.of(0x81, t >> 8, t & 0xff, 0x80), p]);
    return i < packets.length - 1 || at <= end ? el(0xa3, block) : el(0xa0, [el(0xa1, block), uint(0x75a2, ns(at - end))]);
  });
  return cat([header, el(0x18538067, [info, el(0x1654ae6b, [track]), el(0x1f43b675, [uint(0xe7, 0), ...blocks])])]);
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AAC-LC frames in ADTS (a 7-byte header each, no checksum); frames that are ADTS already stay. @param {Uint8Array[]} frames @param {{ rate: number, channels: number }} o */
export function adts(frames, { rate, channels }) {
  const fi = RATES.indexOf(rate);
  if (fi < 0) throw new Error(`ADTS has no sample rate ${rate}.`);
  return cat(frames.flatMap((f) => {
    if (f[0] === 0xff && (f[1] & 0xf6) === 0xf0) return [f];
    const len = f.length + 7;
    return [Uint8Array.of(0xff, 0xf1, (1 << 6) | (fi << 2) | (channels >> 2), ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc), f];
  }));
}

/**
 * A FLAC file: "fLaC", the metadata with its last block marked, then the frames. Encoders give the
 * metadata in the stream, after a mapping header in the description (Ogg FLAC's), or as a bare STREAMINFO.
 * @param {Uint8Array | null} description @param {Uint8Array[]} frames
 */
export function flacFile(description, frames) {
  const marker = (/** @type {Uint8Array} */ b, /** @type {number} */ i) => String.fromCharCode(...b.subarray(i, i + 4)) === 'fLaC';
  const d = description ?? new Uint8Array();
  const at = d.findIndex((_, i) => marker(d, i));
  const head = frames[0] && marker(frames[0], 0) ? [] : at >= 0 ? [d.subarray(at)] : d.length === 34 ? [ascii('fLaC'), Uint8Array.of(0, 0, 0, 34), d] : null;
  if (!head) throw new Error('The FLAC encoder gave no STREAMINFO.');
  const file = cat([...head, ...frames]);
  for (let i = 4; i + 4 <= file.length && !(file[i] & 0x80);) {
    const next = i + 4 + ((file[i + 1] << 16) | (file[i + 2] << 8) | file[i + 3]);
    if (next >= file.length || file[next] === 0xff) file[i] |= 0x80; // a frame starts 0xFF
    i = next;
  }
  return file;
}
