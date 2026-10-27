import { crc32 } from './crc32.js';
import { utf8, text, concat } from './bytes.js';
import { inflateSmall } from './inflate.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_FLAG = 0x0800;

/** What is wrong with a zip, in a developer's English: the detail in annai's own message, and what Shiori reads of a Wallet pass. */
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

/**
 * Inflates raw DEFLATE data, stopping as soon as the output passes limit.
 * @param {Uint8Array | Blob} data @param {number} [limit]
 */
export async function inflateRaw(data, limit = Infinity) {
  const source = data instanceof Blob ? data : new Blob([/** @type {BlobPart} */ (data)]);
  const reader = source.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  // With a known size, inflate into one buffer of that size: half the memory of collecting chunks and joining them.
  const out = Number.isFinite(limit) ? new Uint8Array(limit) : null;
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      await reader.cancel().catch(() => {});
      throw new ZipError('is larger than it says (it may be a zip bomb), so annai stopped reading it');
    }
    if (out) out.set(value, total);
    else chunks.push(value);
    total += value.byteLength;
  }
  return out ? out.subarray(0, total) : concat(chunks);
}

/**
 * Builds a zip archive one entry at a time (spec §12.1: written as a stream). Each
 * entry is compressed when it is added and moved into a Blob straight away, where
 * the browser may keep it on disk, so only the entry being added is in memory. The
 * archive is a Blob of those Blobs. No zip64: at most 65,535 entries and 4 GiB.
 */
export class ZipWriter {
  /** @type {Blob[]} */ #parts = [];
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
    this.#parts.push(new Blob(/** @type {BlobPart[]} */ ([new Uint8Array(h.buffer), nameBytes, data])));
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
    return new Blob(/** @type {BlobPart[]} */ ([...this.#parts, ...cd, new Uint8Array(end.buffer)]), { type: 'application/zip' });
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

/** Archives larger than this (uncompressed, in total) are refused by readZip before anything is inflated. */
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
/** Entries larger than this (uncompressed) are refused: each one is in memory while it is read. */
export const MAX_ENTRY = 1024 * 1024 * 1024;
/** What a ZipReader accepts in total, uncompressed. Without zip64 an archive is at most 4 GiB, and photos barely compress. */
export const MAX_ARCHIVE = 8 * 1024 * 1024 * 1024;
/**
 * An archive may say it unpacks to at most MAX_RATIO times its own size, plus RATIO_ALLOWANCE.
 * Photos are stored as they are and notes compress a few times over; a zip bomb claims thousands.
 */
export const MAX_RATIO = 100;
export const RATIO_ALLOWANCE = 64 * 1024 * 1024;

/** Entries that deflate to at most this much are inflated in plain code: a stream per note costs more than the work. */
const SMALL = 64 * 1024;
/** A read of the file takes this much at once, so a run of small entries costs one read, not two each. */
const WINDOW = 256 * 1024;

/** @param {Blob} b */
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());
/** @param {Uint8Array} b */
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * @typedef {{ flags: number, method: number, crc: number, csize: number, usize: number, local: number }} Entry
 */

/**
 * Reads a zip archive straight from a file (a Blob), one entry at a time: only the
 * index and the entry being read are ever in memory, so an archive larger than memory
 * can be read (spec §12.1). Supports stored and deflated entries, checks every CRC-32,
 * skips folder entries and refuses two entries with one name. Against zip bombs, before
 * anything is inflated: an entry may declare at most maxEntry bytes, all of them together
 * at most maxTotal, and no more than maxRatio times the file's own size (plus
 * RATIO_ALLOWANCE). Inflating stops as soon as an entry produces more than it declared.
 */
export class ZipReader {
  /** @type {Blob} */ #file;
  /** @type {Map<string, Entry>} */ #entries;
  /** @type {{ start: number, bytes: Uint8Array }} the piece of the file read last */
  #window = { start: 0, bytes: new Uint8Array(0) };

  /** @param {Blob} file @param {Map<string, Entry>} entries */
  constructor(file, entries) {
    this.#file = file;
    this.#entries = entries;
  }

  /** @param {Blob} file @param {{ maxEntry?: number, maxTotal?: number, maxRatio?: number }} [opts] */
  static async open(file, opts = {}) {
    const maxEntry = opts.maxEntry ?? MAX_ENTRY;
    const maxTotal = opts.maxTotal ?? MAX_ARCHIVE;
    const maxRatio = opts.maxRatio ?? MAX_RATIO;
    const tailStart = Math.max(0, file.size - 22 - 0xffff);
    const tail = await bytesOf(file.slice(tailStart));
    const tv = view(tail);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === END) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new ZipError('this is not a zip archive');
    const count = tv.getUint16(end + 10, true);
    const cdSize = tv.getUint32(end + 12, true);
    const cdOffset = tv.getUint32(end + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');
    if (cdOffset + cdSize > tailStart + end) throw new ZipError('the archive index is damaged');
    const cd = await bytesOf(file.slice(cdOffset, cdOffset + cdSize));
    const v = view(cd);
    /** @type {Map<string, Entry>} */
    const entries = new Map();
    let total = 0;
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || v.getUint32(p, true) !== CENTRAL) throw new ZipError('the archive index is damaged');
      const nlen = v.getUint16(p + 28, true);
      if (p + 46 + nlen > cd.length) throw new ZipError('the archive index is damaged');
      const name = text(cd.subarray(p + 46, p + 46 + nlen));
      /** @type {Entry} */
      const entry = {
        flags: v.getUint16(p + 8, true),
        method: v.getUint16(p + 10, true),
        crc: v.getUint32(p + 16, true),
        csize: v.getUint32(p + 20, true),
        usize: v.getUint32(p + 24, true),
        local: v.getUint32(p + 42, true),
      };
      p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
      if (name.endsWith('/')) continue;
      if (entries.has(name)) throw new ZipError(`the archive has two entries called ${name}`);
      if (entry.usize > maxEntry) throw new ZipError(`${name} is too large to open here (over ${Math.floor(maxEntry / 1048576)} MB)`);
      total += entry.usize;
      entries.set(name, entry);
    }
    if (total > maxTotal) throw new ZipError(`this archive is too large to open here (over ${Math.floor(maxTotal / 1048576)} MB uncompressed)`);
    if (total > maxRatio * file.size + RATIO_ALLOWANCE) {
      throw new ZipError('this archive says it unpacks to far more than its own size, the way a zip bomb does, so annai won\'t open it');
    }
    return new ZipReader(file, entries);
  }

  /** Entry names in archive order. */
  names() {
    return [...this.#entries.keys()];
  }

  /** @param {string} name */
  has(name) {
    return this.#entries.has(name);
  }

  /** The uncompressed size the entry declares. @param {string} name */
  size(name) {
    return this.#entries.get(name)?.usize ?? 0;
  }

  /** Bytes start to end of the file, from the piece read last when they lie in it. @param {number} start @param {number} end */
  async #range(start, end) {
    const w = this.#window;
    if (start >= w.start && end <= w.start + w.bytes.length) return w.bytes.subarray(start - w.start, end - w.start);
    if (end - start > WINDOW) return bytesOf(this.#file.slice(start, end));
    const bytes = await bytesOf(this.#file.slice(start, Math.min(this.#file.size, start + WINDOW)));
    this.#window = { start, bytes };
    return bytes.subarray(0, end - start);
  }

  /** Reads, inflates and checks one entry. @param {string} name @returns {Promise<Uint8Array>} */
  async read(name) {
    const e = this.#entries.get(name);
    if (!e) throw new ZipError(`the archive has no entry called ${name}`);
    if (e.flags & 1) throw new ZipError(`${name} is encrypted with zip encryption, which annai does not read`);
    // A large entry's header is read alone: a window of the file is for a run of small entries.
    const head = e.csize > WINDOW ? await bytesOf(this.#file.slice(e.local, e.local + 30)) : await this.#range(e.local, e.local + 30);
    const hv = view(head);
    if (head.length < 30 || hv.getUint32(0, true) !== LOCAL) throw new ZipError(`the entry ${name} is damaged`);
    const start = e.local + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    if (start + e.csize > this.#file.size) throw new ZipError(`the entry ${name} is damaged`);
    /** @type {Uint8Array} */
    let bytes;
    if (e.method === 0) {
      const raw = await this.#range(start, start + e.csize);
      bytes = e.csize > WINDOW ? raw : raw.slice(); // a piece of the window must not outlive it
    } else if (e.method === 8) {
      try {
        bytes = e.csize <= SMALL && e.usize <= SMALL * 16
          ? inflateSmall(await this.#range(start, start + e.csize), e.usize)
          : await inflateRaw(this.#file.slice(start, start + e.csize), e.usize);
      } catch (err) {
        if (err instanceof ZipError) throw new ZipError(`${name} ${err.message}`);
        if (err instanceof RangeError) throw new ZipError(`${name} is larger than it says (it may be a zip bomb), so annai stopped reading it`);
        throw new ZipError(`${name} is corrupted (it cannot be decompressed)`);
      }
    } else throw new ZipError(`${name} uses compression method ${e.method}, which annai does not read`);
    if (bytes.length !== e.usize || crc32(bytes) !== e.crc) throw new ZipError(`${name} is corrupted (checksum mismatch)`);
    return bytes;
  }
}

/**
 * Reads a whole (small) archive into memory, e.g. a plugin package. The declared sizes
 * must add up to at most maxTotal before anything is inflated.
 * @param {Uint8Array | Blob} zip
 * @param {{ maxTotal?: number }} [opts]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readZip(zip, opts = {}) {
  const maxTotal = opts.maxTotal ?? MAX_TOTAL;
  const reader = await ZipReader.open(zip instanceof Blob ? zip : new Blob([/** @type {BlobPart} */ (zip)]), { maxEntry: maxTotal, maxTotal });
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const name of reader.names()) out.set(name, await reader.read(name));
  return out;
}
