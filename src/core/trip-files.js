import { shortName } from './names.js';
import { isPhotoType } from './photos.js';
import { sortWords } from './intl.js';

/**
 * A trip's Files section (the bookings-and-trips design, goal 8): each file kept with the trip and what it became, as data the screen
 * makes words of. Photos are left out unless a booking came from one or it waits to be read (My call 4).
 * @typedef {{ kind: 'booking', bookingKind: string, path: string, title: string } | { kind: 'plan', path: string, title: string } |
 *   { kind: 'photo' } | { kind: 'waiting' } | { kind: 'nothing' }} Became
 * @typedef {{ path: string, name: string, real: string, type: string, became: Became[] }} FileRow  name: Shiori's short name, else real
 */

/** "/trip/files/x" and "/files/x" both name the trip's /files/x. @param {unknown} p */
const inTrip = (p) => (typeof p === 'string' ? p.replace(/^\/trip(?=\/)/, '') : '');

/**
 * @param {{ files: import('./types.js').FileEntry[], bookings: { path: string, booking: any }[], items: { path: string, item: any, source?: string }[],
 *   names: Record<string, string>, toRead: string[] }} o
 * @returns {FileRow[]} by name
 */
export function fileRows({ files, bookings, items, names, toRead }) {
  /** @type {FileRow[]} */
  const out = [];
  for (const file of files) {
    if (!/^\/files\/[^/]+$/.test(file.path)) continue;
    /** @type {Became[]} */
    const became = [];
    for (const { path, booking: b } of bookings) {
      if (b && typeof b === 'object' && inTrip(b.source) === file.path) became.push({ kind: 'booking', bookingKind: String(b.kind ?? ''), path, title: typeof b.title === 'string' ? b.title : '' });
    }
    for (const { path, item, source } of items) {
      if (inTrip(source) === file.path) became.push({ kind: 'plan', path, title: typeof item?.title === 'string' ? item.title : '' });
    }
    const photo = isPhotoType(file.type);
    if (!became.length) became.push(toRead.includes(file.path) ? { kind: 'waiting' } : photo ? { kind: 'photo' } : { kind: 'nothing' });
    if (photo && became[0].kind === 'photo') continue; // a trip photo is among the trip's photos, not its Files
    const real = file.path.split('/').pop() ?? file.path;
    out.push({ path: file.path, name: shortName(names, file.path), real, type: file.type, became });
  }
  return out.sort((a, b) => sortWords(a.name, b.name) || sortWords(a.real, b.real));
}
