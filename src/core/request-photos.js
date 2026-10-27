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
  /* en */ const from = s.width && s.height ? `${s.width}×${s.height}` : 'size unknown';
  /* en */ return c.made && c.width && c.height ? `${from}, sent as ${c.width}×${c.height}` : from;
}

export class PhotoCopies {
  /** @type {Map<string, Copy>} */
  #made = new Map();
  /**
   * @param {{ codec: import('./photos.js').Codec & { encode(source: Blob, opts: any): Promise<{ bytes: Uint8Array, type: string, width: number, height: number }> }, read: (hash: string, scope?: string) => Promise<Uint8Array | null> }} c
   *   read: stored bytes by hash, for the scope a copy is made for (reach.js): a copy made for one trip is reused in another only if that one reaches it too
   */
  constructor({ codec, read }) {
    this.codec = codec;
    this.read = read;
  }

  /** @param {Source} source @param {Limits} limits @param {Crop} [crop] @param {string} [scope] whose photo it is, read for that scope @returns {Promise<Copy>} */
  async copy(source, limits, crop, scope) {
    if (!crop && fits(source, limits)) return { hash: source.hash, mediaType: source.type, width: source.width ?? null, height: source.height ?? null, made: false };
    // Each conversation's copies are its own: one made for another is never looked up by its hash (review, 5a).
    const key = JSON.stringify([scope ?? '', source.hash, limits.formats, limits.quality, limits.maxEdge, limits.maxBytes, crop ?? null]);
    const had = this.#made.get(key);
    // A copy made before is reused only while its bytes are stored: a repair or a removed trip may have freed them.
    if (had && (await this.read(had.hash, scope))) return { ...had, data: undefined };
    this.#made.delete(key);
    const bytes = await this.read(source.hash, scope);
    if (!bytes) /* en */ throw new Error('That photo is no longer stored.');
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

/** The smallest crop, in pixels, that still shows something. */
export const MIN_CROP = 32;

/**
 * A crop region as Shiori gives it, healed (spec §7.2): [left, top, right, bottom] as fractions;
 * values above 1 are pixels; reversed edges are swapped; outside values are clamped; a region
 * too small to show anything is grown around its centre. The result says what was done.
 * @param {number[]} region @param {number} width @param {number} height
 */
export function healRegion(region, width, height) {
  /** @type {string[]} */
  const notes = [];
  let [l, t, r, b] = [0, 1, 2, 3].map((i) => Number(region?.[i]));
  if ([l, t, r, b].some((v) => !Number.isFinite(v))) /* en */ throw new Error('A region is four numbers: [left, top, right, bottom], as fractions of the photo from 0 to 1.');
  if ([l, t, r, b].some((v) => v > 1)) {
    /* en */ notes.push('values above 1 were read as pixels');
    [l, r] = [l, r].map((v) => (v > 1 ? v / width : v));
    [t, b] = [t, b].map((v) => (v > 1 ? v / height : v));
  }
  if (l > r || t > b) /* en */ notes.push('reversed edges were swapped');
  if (l > r) [l, r] = [r, l];
  if (t > b) [t, b] = [b, t];
  const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
  if ([l, t, r, b].some((v) => v < 0 || v > 1)) /* en */ notes.push('it was clamped to the photo');
  [l, t, r, b] = [l, t, r, b].map(clamp);
  let x = Math.round(l * width);
  let y = Math.round(t * height);
  let w = Math.round((r - l) * width);
  let h = Math.round((b - t) * height);
  const grow = (/** @type {number} */ start, /** @type {number} */ size, /** @type {number} */ max) => {
    const need = Math.min(MIN_CROP, max);
    if (size >= need) return [start, size];
    const centre = start + size / 2;
    const s = Math.min(max - need, Math.max(0, Math.round(centre - need / 2)));
    return [s, need];
  };
  if (w < Math.min(MIN_CROP, width) || h < Math.min(MIN_CROP, height)) /* en */ notes.push(`it was grown to at least ${MIN_CROP} pixels around its centre`);
  [x, w] = grow(x, w, width);
  [y, h] = grow(y, h, height);
  const round = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
  return { crop: { x, y, width: w, height: h }, used: [round(x / width), round(y / height), round((x + w) / width), round((y + h) / height)], notes };
}
