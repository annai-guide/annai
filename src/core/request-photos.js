import { MAX_CANVAS_PIXELS } from './photos.js';
import { toBase64 } from './bytes.js';
import { sha256Hex } from './hash.js';

/**
 * Request copies (spec §4.8): what Shiori is sent. The limits are the stricter of the request
 * settings and what the model accepts (§9.2). A photo within them goes as it is; otherwise a copy
 * is made once and reused, so the bytes stay the same and the provider's cache stays warm. A crop
 * is always a copy, made from the stored photo.
 * @typedef {import('./photos.js').EncodeSettings} EncodeSettings
 * @typedef {EncodeSettings & { maxCount: number | null }} Limits
 * @typedef {{ hash: string, type: string, width?: number | null, height?: number | null, size: number }} Source
 * @typedef {{ x: number, y: number, width: number, height: number }} Crop
 * @typedef {{ hash: string, mediaType: string, width: number | null, height: number | null, data?: string, made: boolean }} Copy
 */

/** @param {number | null | undefined} a @param {number | null | undefined} b */
const least = (a, b) => (a == null ? b ?? null : b == null ? a : Math.min(a, b));

/** @param {EncodeSettings} request @param {{ formats?: string[], maxEdge?: number, maxBytes?: number, maxCount?: number }} [images] @returns {Limits} */
export function requestLimits(request, images = {}) {
  const accepted = images.formats?.length ? request.formats.filter((f) => images.formats?.includes(f)) : request.formats;
  return {
    formats: accepted.length ? accepted : [...(images.formats ?? request.formats)],
    quality: request.quality,
    maxEdge: least(request.maxEdge, images.maxEdge),
    maxBytes: least(request.maxBytes, images.maxBytes),
    maxCount: images.maxCount ?? null,
  };
}

/** Whether a photo can go as it is. @param {{ type: string, width?: number | null, height?: number | null, size: number }} s @param {Limits} l */
export function fits(s, l) {
  if (!l.formats.includes(s.type)) return false;
  if (l.maxBytes !== null && s.size > l.maxBytes) return false;
  if (l.maxEdge !== null && s.width && s.height && Math.max(s.width, s.height) > l.maxEdge) return false;
  return true;
}

/** "4032×3024, sent as 2000×1500". @param {Source} s @param {Copy} c */
export function sizeLine(s, c) {
  const from = s.width && s.height ? `${s.width}×${s.height}` : 'size unknown';
  return c.made && c.width && c.height ? `${from}, sent as ${c.width}×${c.height}` : from;
}

export class PhotoCopies {
  /** @type {Map<string, Copy>} */
  #made = new Map();
  /** @param {{ codec: import('./photos.js').Codec & { encode(source: Blob, opts: any): Promise<{ bytes: Uint8Array, type: string, width: number, height: number }> }, read: (hash: string) => Promise<Uint8Array | null> }} c */
  constructor({ codec, read }) {
    this.codec = codec;
    this.read = read;
  }

  /** @param {Source} source @param {Limits} limits @param {Crop} [crop] @returns {Promise<Copy>} */
  async copy(source, limits, crop) {
    if (!crop && fits(source, limits)) return { hash: source.hash, mediaType: source.type, width: source.width ?? null, height: source.height ?? null, made: false };
    const key = JSON.stringify([source.hash, limits.formats, limits.quality, limits.maxEdge, limits.maxBytes, crop ?? null]);
    const had = this.#made.get(key);
    if (had) return { ...had, data: undefined };
    const bytes = await this.read(source.hash);
    if (!bytes) throw new Error('That photo is no longer stored.');
    const out = await this.codec.encode(new Blob([/** @type {BlobPart} */ (bytes)], { type: source.type }), {
      formats: limits.formats, quality: limits.quality, maxEdge: limits.maxEdge, maxBytes: limits.maxBytes, maxPixels: MAX_CANVAS_PIXELS, ...(crop ? { crop } : {}),
    });
    const copy = { hash: await sha256Hex(out.bytes), mediaType: out.type, width: out.width, height: out.height, made: true };
    this.#made.set(key, copy);
    return { ...copy, data: toBase64(out.bytes) };
  }

  /** Forgets every copy, after the limits change (Task 5). */
  clear() {
    this.#made.clear();
  }
}
