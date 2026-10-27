import { readPhotoMeta, displaySize, stripMetadata } from './photo-meta.js';
import { normPath, typeForPath } from './paths.js';
import { t } from './l10n.js';

/**
 * Photos coming in (spec §4.8, ingest): each one is stored once, as its original (Keep originals)
 * or as the ingest encoding, with when and where it was taken kept beside it.
 */

/** @typedef {import('./workspace.js').Workspace} Workspace */
/** @typedef {{ formats: string[], quality: number, maxEdge: number | null, maxBytes: number | null }} EncodeSettings */
/** @typedef {{ keepOriginals: boolean, ingest: EncodeSettings, request: EncodeSettings }} PhotoSettings */
/**
 * What turns a photo into another format: in browsers, src/ui/photo-codec.js.
 * @typedef {{ encode(source: Blob, opts: EncodeSettings & { maxPixels: number }): Promise<{ bytes: Uint8Array, type: string, width: number, height: number }>, canMake?: (type: string) => Promise<boolean> }} Codec
 *   canMake: whether this browser can write a format (a refusal that wants another one ends with a card)
 */

/** Formats annai treats as photos. Others, such as GIF and SVG, are stored as ordinary files. */
export const PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']);
/** The most pixels annai draws at once: Safari has been reported to cap a canvas here (§4.8). */
export const MAX_CANVAS_PIXELS = 4096 * 4096;
/** The settings annai starts with: re-encode, WebP where this browser can write it, else JPEG. */
export const DEFAULT_PHOTO_SETTINGS = Object.freeze({
  keepOriginals: false,
  ingest: Object.freeze({ formats: Object.freeze(['image/webp', 'image/jpeg']), quality: 0.9, maxEdge: null, maxBytes: null }),
  // What Shiori is sent (spec §4.8): within these and what the model accepts.
  request: Object.freeze({ formats: Object.freeze(['image/webp', 'image/jpeg']), quality: 0.9, maxEdge: 2000, maxBytes: 1024 * 1024 }),
});
/** @type {Record<string, string>} */
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif' };

/** @param {string} type */
export const isPhotoType = (type) => PHOTO_TYPES.includes(type);
/** @param {unknown} n */
const isSize = (n) => Number.isInteger(n) && /** @type {number} */ (n) >= 1;

/**
 * The photo settings inside the app settings, with defaults for anything missing or out of range.
 * @param {Record<string, any>} app @returns {PhotoSettings}
 */
export function photoSettings(app) {
  const p = app?.photos ?? {};
  /** @param {unknown} x @param {number} lo @param {number} hi */
  const num = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
  /** One set of encode settings, with its defaults for anything missing or out of range. @param {any} i @param {{ formats: readonly string[], quality: number, maxEdge: number | null, maxBytes: number | null }} d @returns {EncodeSettings} */
  const read = (i = {}, d) => ({
    formats: Array.isArray(i.formats) && i.formats.length > 0 && i.formats.every((/** @type {unknown} */ f) => typeof f === 'string' && f.startsWith('image/')) ? [...i.formats] : [...d.formats],
    quality: num(i.quality, 0.1, 1) ?? d.quality,
    // No limit is null, or 0: a merge patch can't write null, which deletes and brings the default back.
    maxEdge: i.maxEdge === null || i.maxEdge === 0 ? null : num(i.maxEdge, 16, 65535) ?? d.maxEdge,
    maxBytes: i.maxBytes === null || i.maxBytes === 0 ? null : num(i.maxBytes, 1024, 2 ** 40) ?? d.maxBytes,
  });
  return {
    keepOriginals: p.keepOriginals === true,
    ingest: read(p.ingest, DEFAULT_PHOTO_SETTINGS.ingest),
    request: read(p.request, DEFAULT_PHOTO_SETTINGS.request),
  };
}

/**
 * The size to draw a width × height image at: never larger, at most maxEdge on its longest side
 * and maxPixels in all, keeping its shape. null means no limit.
 * @param {number} width @param {number} height @param {number | null} maxEdge @param {number | null} maxPixels
 */
export function fitSize(width, height, maxEdge, maxPixels) {
  let scale = 1;
  if (maxEdge !== null && Math.max(width, height) > maxEdge) scale = maxEdge / Math.max(width, height);
  if (maxPixels !== null && width * height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * A file name for a photo: when it was taken ("2026-11-26-1904") if known, otherwise its own
 * name, with the extension of the format it is stored in.
 * @param {string | undefined} taken @param {string} original @param {string} type
 */
export function photoName(taken, original, type) {
  const m = taken ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(taken) : null;
  let base = m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}${m[5]}` : original.normalize('NFC').replace(/\.[^.]*$/, '').replace(/[\\/\u0000-\u001f\u007f]+/g, '-').trim().slice(0, 80);
  if (base === '' || base === '.' || base === '..') base = 'photo';
  return `${base}.${EXTENSIONS[type] ?? 'bin'}`;
}

/**
 * A free path for name in the trip's /files/ folder: "name", then "name-2", "name-3"…
 * @param {Workspace} ws @param {string} scope @param {string} name
 */
export async function freePath(ws, scope, name) {
  const taken = new Set((await ws.list(scope, '/files/')).map((f) => f.path));
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const path = normPath(`/files/${n === 1 ? stem : `${stem}-${n}`}${ext}`);
    if (!taken.has(path)) return path;
  }
}

/**
 * Adds a photo from the camera, the file picker or the share sheet.
 * @param {Workspace} ws @param {string} scope
 * @param {Blob & { name?: string }} file
 * @param {{ settings: PhotoSettings, codec: Codec, author?: string }} opts
 * @returns {Promise<{ entry: import('./types.js').FileEntry, note: string | null }>}
 *   note: something the user should know, for example that this browser couldn't convert the photo
 */
export async function ingestPhoto(ws, scope, file, { settings, codec, author = 'user' }) {
  const name = file.name ?? 'photo';
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readPhotoMeta(bytes);
  const type = info.type ?? (file.type || typeForPath(name));
  const shown = displaySize(info);
  const s = settings.ingest;
  /** @type {{ bytes: Uint8Array, type: string, width?: number, height?: number, original: boolean }} */
  let out;
  let note = null;
  if (settings.keepOriginals) {
    out = { bytes, type, ...shown, original: true };
  } else {
    /** @type {Awaited<ReturnType<Codec['encode']>> | null} */
    let encoded = null;
    try {
      encoded = await codec.encode(new Blob([/** @type {BlobPart} */ (bytes)], { type }), { ...s, maxPixels: MAX_CANVAS_PIXELS });
    } catch {
      encoded = null; // this browser can't read it, for example HEIC outside Safari
    }
    // The original bytes win when they're already acceptable and no larger: no second round of compression.
    const keepable = s.formats.includes(type) && (info.orientation ?? 1) === 1 && shown.width !== undefined && shown.height !== undefined
      && (s.maxEdge === null || Math.max(shown.width, shown.height) <= s.maxEdge) && (s.maxBytes === null || bytes.length <= s.maxBytes);
    const stripped = keepable ? stripMetadata(bytes, type) : null;
    if (stripped && (!encoded || stripped.length <= encoded.bytes.length)) out = { bytes: stripped, type, ...shown, original: false };
    else if (encoded) out = { ...encoded, original: false };
    else {
      out = { bytes, type, ...shown, original: true };
      note = t`This browser can't convert ${name}, so annai kept it as it is. It may show only in Safari.`;
    }
  }
  const path = await freePath(ws, scope, photoName(info.taken, name, out.type));
  const meta = {
    ...(isSize(out.width) && isSize(out.height) ? { width: out.width, height: out.height } : {}), // a header may say 0
    ...(info.taken ? { taken: info.taken } : {}),
    ...(info.place ? { place: info.place } : {}),
    ...(out.original ? { original: true } : {}),
  };
  const entry = await ws.write(scope, path, out.bytes, { author, type: out.type, source: name, meta });
  return { entry, note };
}
