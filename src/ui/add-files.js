import { ingestPhoto, isPhotoType, photoSettings } from '../core/photos.js';
import { sniffImageType } from '../core/photo-meta.js';
import { readAppSettings } from '../core/settings.js';
import { normPath, typeForPath, freeName, outsideName } from '../core/paths.js';
import { codec } from './photo-codec.js';

/**
 * Adds files to a trip one at a time, so a hundred photos never sit in memory together: photos
 * through ingest (spec §4.8), anything else as it is, under /files/ (each named by outsideName). A file that can't be kept (no room) stops the rest, and what
 * was kept before it comes back with why (`failed`), so whatever follows a keep (a calendar read, Shiori's wake, the share inbox
 * let go of) is done for what was kept, and an add again takes only the rest. Every caller looks at `failed`.
 * @param {any} ctx @param {string} scope @param {(Blob & { name?: string })[]} files
 * @param {(done: number, total: number) => void} [progress] done: kept so far
 * @returns {Promise<{ paths: string[], types: Record<string, string>, notes: string[], failed?: unknown }>} paths: one per file kept, in the
 *   files' order; types: what each kept path was stored as, so nothing reads the folder again after the keep (a bring-in's wake, the type box's hand-over); notes: what the user should know,
 *   one per photo that needs it; failed: why the file after the kept ones wasn't kept, when one wasn't
 */
export async function addFiles(ctx, scope, files, progress = () => {}) {
  const settings = photoSettings(await readAppSettings(ctx.ws));
  /** @type {string[]} */ const paths = [];
  /** @type {Record<string, string>} */ const types = {};
  /** @type {string[]} */ const notes = [];
  for (const [i, file] of files.entries()) {
    progress(i, files.length);
    try {
      const name = file.name || 'file';
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      const type = sniffImageType(head) ?? (file.type || typeForPath(name));
      if (isPhotoType(type)) {
        const { entry, note } = await ingestPhoto(ctx.ws, scope, file, { settings, codec });
        paths.push(entry.path);
        types[entry.path] = entry.type;
        if (note) notes.push(note);
      } else {
        // An added file never replaces another, or a booking's source would point at the wrong one (spec §7.3).
        const taken = new Set((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => f.path));
        const path = freeName(normPath(`/files/${outsideName(name, 'file')}`), taken);
        await ctx.ws.write(scope, path, new Uint8Array(await file.arrayBuffer()), { author: 'user', type });
        paths.push(path);
        types[path] = type;
      }
    } catch (e) {
      return { paths, types, notes, failed: e };
    }
  }
  progress(files.length, files.length);
  return { paths, types, notes };
}
