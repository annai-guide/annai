/**
 * annai's own audio files (Koe and Kokoro design, "Audio formats"; no library): the packets
 * WebCodecs' AudioEncoder makes, put into Ogg Opus (RFC 7845), WebM Opus, AAC in ADTS frames, and
 * FLAC. Pure: bytes in, bytes out. A segment is at most 30 s (the detector's limit).
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

/** How many samples, at 48 kHz, an Opus packet decodes to: from its TOC byte (RFC 6716 §3.1). @param {Uint8Array} p */
export function opusSamples(p) {
  const config = p[0] >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const c = p[0] & 3;
  return frame * (c === 0 ? 1 : c === 3 ? p[1] & 0x3f : 2);
}

/** @typedef {{ rate: number, preSkip: number, channels?: number, samples?: number }} OpusInfo  rate: the input's; samples: how many it had, to trim the end */

/** The OpusHead packet (RFC 7845 §5.1): mapping family 0, no gain. @param {OpusInfo} o */
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

// Ogg's own CRC: polynomial 0x04C11DB7, not reflected, starting at 0 (not the zip CRC).
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

/** One Ogg page. flags: 2 first, 4 last. @param {Uint8Array[]} packets @param {number} flags @param {number} granule @param {number} seq */
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
  dv.setUint32(14, 0x616e6e61, true); // the stream's serial number: one stream, always the same, so the same packets give the same file
  dv.setUint32(18, seq, true);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const out = cat([head, ...packets]);
  new DataView(out.buffer).setUint32(22, oggCrc(out), true);
  return out;
}

/** The end of the sound, at 48 kHz, counting the pre-skip: trims what the last packet adds past the input. @param {Uint8Array[]} packets @param {OpusInfo} o */
function ending(packets, o) {
  const total = packets.reduce((n, p) => n + opusSamples(p), 0);
  return o.samples === undefined ? total : Math.min(total, o.preSkip + Math.ceil((o.samples * 48_000) / o.rate));
}

/**
 * An Ogg Opus file (RFC 7845): OpusHead and OpusTags on pages of their own, then the packets, with
 * granule positions at 48 kHz; the last page ends the stream. @param {Uint8Array[]} packets @param {OpusInfo} o
 */
export function oggOpus(packets, o) {
  const tags = cat([ascii('OpusTags'), Uint8Array.of(5, 0, 0, 0), ascii('annai'), new Uint8Array(4)]);
  const pages = [page([opusHead(o)], 2, 0, 0), page([tags], 0, 0, 1)];
  /** @type {Uint8Array[]} */
  let held = [];
  let laces = 0;
  let decoded = 0;
  for (const p of packets) {
    const n = Math.floor(p.length / 255) + 1;
    if (laces + n > 255) {
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
/** An EBML element: its id (as written, 1 to 4 bytes), size and body. @param {number} id @param {Uint8Array | Uint8Array[]} body */
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
 * A WebM Opus file: the EBML header (DocType webm), one audio track A_OPUS with its OpusHead, and
 * the packets as SimpleBlocks in one cluster, at their times in milliseconds (16 bits: up to 32 s).
 * @param {Uint8Array[]} packets @param {OpusInfo} o
 */
export function webmOpus(packets, o) {
  const ms = (/** @type {number} */ samples) => Math.round(samples / 48);
  const header = el(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), el(0x4282, ascii('webm')), uint(0x4287, 4), uint(0x4285, 2)]);
  const info = el(0x1549a966, [uint(0x2ad7b1, 1_000_000), el(0x4d80, ascii('annai')), el(0x5741, ascii('annai')), float(0x4489, ms(ending(packets, o) - o.preSkip))]);
  const track = el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 2), el(0x86, ascii('A_OPUS')), el(0x63a2, opusHead(o)),
    uint(0x56aa, Math.round((o.preSkip / 48_000) * 1e9)), uint(0x56bb, 80_000_000), el(0xe1, [float(0xb5, 48_000), uint(0x9f, o.channels ?? 1)])]);
  let at = 0;
  const blocks = packets.map((p) => {
    const t = ms(at);
    at += opusSamples(p);
    return el(0xa3, cat([Uint8Array.of(0x81, t >> 8, t & 0xff, 0x80), p]));
  });
  return cat([header, el(0x18538067, [info, el(0x1654ae6b, [track]), el(0x1f43b675, [uint(0xe7, 0), ...blocks])])]);
}

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * AAC in ADTS frames (ISO 14496-3): a 7-byte header, without a checksum, before each raw AAC-LC
 * frame. Frames that are ADTS already are kept as they are. @param {Uint8Array[]} frames @param {{ rate: number, channels: number }} o
 */
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
 * A FLAC file: the encoder's description ("fLaC" and its STREAMINFO; a bare STREAMINFO is given
 * both), then the frames, which carry their own headers. @param {Uint8Array | null} description @param {Uint8Array[]} frames
 */
export function flacFile(description, frames) {
  if (!description?.length) throw new Error('The FLAC encoder gave no STREAMINFO.');
  const marked = String.fromCharCode(...description.subarray(0, 4)) === 'fLaC';
  return cat([...(marked ? [description] : [ascii('fLaC'), Uint8Array.of(0x80, 0, 0, description.length), description]), ...frames]);
}
