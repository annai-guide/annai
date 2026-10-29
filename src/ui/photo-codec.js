import { fitSize } from '../core/photos.js';
import { t } from '../core/l10n.js';

/**
 * The browser's own image encoders (spec §4.8): decoding a photo upright, and writing it in the
 * first format of a list that this browser can write. Formats a browser lacks come from plugins.
 */

/** @type {Map<string, Promise<boolean>>} */
const support = new Map();

/** A canvas of the given size: an OffscreenCanvas where there is one. @param {number} width @param {number} height */
function canvas(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement('canvas'), { width, height });
}

/** @param {OffscreenCanvas | HTMLCanvasElement} c @param {string} type @param {number} quality @returns {Promise<Blob | null>} */
function toBlob(c, type, quality) {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality });
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

/**
 * Whether this browser can write type. A browser that can't silently writes PNG instead, so the
 * answer comes from a test encode, never from the browser's name.
 * @param {string} type
 */
export function canEncode(type) {
  let answer = support.get(type);
  if (!answer) {
    answer = (async () => {
      try {
        const c = canvas(1, 1);
        // Typed as at encodePhoto: tsc resolves getContext on the canvas union differently by the order it checks files in.
        /** @type {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null} */ (c.getContext('2d'))?.fillRect(0, 0, 1, 1);
        return (await toBlob(c, type, 0.9))?.type === type;
      } catch {
        return false;
      }
    })();
    support.set(type, answer);
  }
  return answer;
}

/**
 * Decodes a photo, turned upright by its EXIF orientation, and encodes it in the first of
 * opts.formats this browser can write (JPEG when none), at most maxEdge on its longest side
 * and maxPixels in all, never enlarged. Over maxBytes, it lowers the quality to 0.5, then the
 * size, until the photo fits. Rejects when the browser can't read the photo.
 * @param {Blob} source
 * With crop, only that part of the photo (in its pixels, upright) is drawn (spec §4.8: a closer look).
 * @param {{ formats: string[], quality: number, maxEdge: number | null, maxBytes: number | null, maxPixels: number | null, crop?: { x: number, y: number, width: number, height: number } | null }} opts
 * @returns {Promise<{ bytes: Uint8Array, type: string, width: number, height: number }>}
 */
export async function encodePhoto(source, opts) {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    let type = 'image/jpeg';
    for (const f of opts.formats) {
      if (await canEncode(f)) {
        type = f;
        break;
      }
    }
    const box = opts.crop ?? { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    let { width, height } = fitSize(box.width, box.height, opts.maxEdge, opts.maxPixels);
    let quality = opts.quality;
    for (;;) {
      const c = canvas(width, height);
      const g = /** @type {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null} */ (c.getContext('2d'));
      if (!g) throw Object.assign(new Error(/* en */ 'this browser could not draw the photo'), { shown: t`This browser could not draw the photo.` });
      if (type === 'image/jpeg') {
        g.fillStyle = '#fff'; // JPEG has no transparency
        g.fillRect(0, 0, width, height);
      }
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, width, height);
      const blob = await toBlob(c, type, quality);
      if (!blob || blob.type !== type) throw Object.assign(new Error(/* en */ `this browser could not write ${type}`), { shown: t`This browser could not write ${type}.` });
      if (opts.maxBytes === null || blob.size <= opts.maxBytes || Math.max(width, height) <= 64) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), type, width, height };
      }
      if (quality > 0.5) quality = Math.max(0.5, Math.round((quality - 0.1) * 100) / 100);
      else ({ width, height } = fitSize(width, height, Math.floor(Math.max(width, height) * 0.8), null));
    }
  } finally {
    bitmap.close();
  }
}

/** The codec ingest uses (src/core/photos.js). */
export const codec = { encode: encodePhoto, canMake: canEncode };
