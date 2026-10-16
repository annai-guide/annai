import { ingestPhoto, isPhotoType, photoSettings } from '../core/photos.js';
import { sniffImageType } from '../core/photo-meta.js';
import { readAppSettings } from '../core/settings.js';
import { normPath, typeForPath, freeName } from '../core/paths.js';
import { codec } from './photo-codec.js';

/**
 * Adds files to a trip one at a time, so a hundred photos never sit in memory together: photos
 * through ingest (spec §4.8), anything else as it is, under /files/.
 * @param {any} ctx @param {string} scope @param {(Blob & { name?: string })[]} files
 * @param {(done: number, total: number) => void} [progress]
 * @returns {Promise<{ paths: string[], notes: string[] }>} notes: what the user should know, one per photo that needs it
 */
export async function addFiles(ctx, scope, files, progress = () => {}) {
  const settings = photoSettings(await readAppSettings(ctx.ws));
  /** @type {string[]} */ const paths = [];
  /** @type {string[]} */ const notes = [];
  for (const [i, file] of files.entries()) {
    progress(i, files.length);
    const name = file.name || 'file';
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const type = sniffImageType(head) ?? (file.type || typeForPath(name));
    if (isPhotoType(type)) {
      const { entry, note } = await ingestPhoto(ctx.ws, scope, file, { settings, codec });
      paths.push(entry.path);
      if (note) notes.push(note);
    } else {
      // An added file never replaces another, or a booking's source would point at the wrong one (spec §7.3).
      const taken = new Set((await ctx.ws.list(scope, '/files/')).map((/** @type {any} */ f) => f.path));
      const path = freeName(normPath(`/files/${name}`), taken);
      await ctx.ws.write(scope, path, new Uint8Array(await file.arrayBuffer()), { author: 'user', type });
      paths.push(path);
    }
  }
  progress(files.length, files.length);
  return { paths, notes };
}
