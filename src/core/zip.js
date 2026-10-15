import { crc32 } from './crc32.js';
import { utf8, text } from './bytes.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_FLAG = 0x0800;

export class ZipError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** Raw DEFLATE using the platform's CompressionStream. @param {Uint8Array} bytes */
export async function deflateRaw(bytes) {
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {Uint8Array} bytes */
export async function inflateRaw(bytes) {
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Builds a zip archive one entry at a time. Each entry is compressed when it is
 * added, and the archive is returned as a Blob of the collected chunks, so a
 * large archive never needs one contiguous buffer. No zip64: at most 65,535
 * entries and 4 GiB.
 */
export class ZipWriter {
  /** @type {Uint8Array[]} */ #chunks = [];
  /** @type {{ name: Uint8Array, method: number, time: number, date: number, crc: number, csize: number, usize: number, offset: number }[]} */ #central = [];
  /** @type {Set<string>} */ #names = new Set();
  #offset = 0;

  /**
   * @param {string} name path inside the archive, with "/" separators
   * @param {Uint8Array} bytes
   * @param {{ compress?: boolean, mtime?: number }} [opts]
   */
  async add(name, bytes, opts = {}) {
    if (this.#names.has(name)) throw new ZipError(`the archive already has an entry called ${name}`);
    if (this.#central.length >= 0xffff) throw new ZipError('too many files for one archive');
    this.#names.add(name);
    const nameBytes = utf8(name);
    const crc = crc32(bytes);
    let method = 0;
    let data = bytes;
    if (opts.compress !== false && bytes.length > 0) {
      const packed = await deflateRaw(bytes);
      if (packed.length < bytes.length) {
        method = 8;
        data = packed;
      }
    }
    if (this.#offset + 30 + nameBytes.length + data.length > 0xffffffff) throw new ZipError('the archive would be larger than 4 GiB');
    const { time, date } = dosTime(opts.mtime ?? Date.now());
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, LOCAL, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, UTF8_FLAG, true);
    h.setUint16(8, method, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.#chunks.push(new Uint8Array(h.buffer), nameBytes, data);
    this.#central.push({ name: nameBytes, method, time, date, crc, csize: data.length, usize: bytes.length, offset: this.#offset });
    this.#offset += 30 + nameBytes.length + data.length;
  }

  /** @returns {Blob} the finished archive */
  finish() {
    const start = this.#offset;
    /** @type {Uint8Array[]} */
    const cd = [];
    for (const e of this.#central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, CENTRAL, true);
      h.setUint16(4, 0x0314, true); // made by: Unix, zip 2.0
      h.setUint16(6, 20, true);
      h.setUint16(8, UTF8_FLAG, true);
      h.setUint16(10, e.method, true);
      h.setUint16(12, e.time, true);
      h.setUint16(14, e.date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.csize, true);
      h.setUint32(24, e.usize, true);
      h.setUint16(28, e.name.length, true);
      h.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
      h.setUint32(42, e.offset, true);
      cd.push(new Uint8Array(h.buffer), e.name);
    }
    const size = cd.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, END, true);
    end.setUint16(8, this.#central.length, true);
    end.setUint16(10, this.#central.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    return new Blob(/** @type {BlobPart[]} */ ([...this.#chunks, ...cd, new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }
}

/** @param {number} ms */
function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/**
 * Reads a whole archive into memory. Supports stored and deflated entries,
 * checks every CRC-32, and skips folder entries.
 * @param {Uint8Array} zip
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(zip) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('this is not a zip archive');
  const count = v.getUint16(end + 10, true);
  const cdOffset = v.getUint32(end + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || v.getUint32(p, true) !== CENTRAL) throw new ZipError('the archive index is damaged');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = text(zip.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name} is encrypted with zip encryption, which annai does not read`);
    if (local + 30 > zip.length || v.getUint32(local, true) !== LOCAL) throw new ZipError(`the entry ${name} is damaged`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + csize);
    /** @type {Uint8Array} */
    let bytes;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) {
      try {
        bytes = await inflateRaw(raw);
      } catch {
        throw new ZipError(`${name} is corrupted (it cannot be decompressed)`);
      }
    } else throw new ZipError(`${name} uses compression method ${method}, which annai does not read`);
    if (bytes.length !== usize || crc32(bytes) !== crc) throw new ZipError(`${name} is corrupted (checksum mismatch)`);
    out.set(name, bytes);
  }
  return out;
}
