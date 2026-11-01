import { shortName, readNames } from './names.js';
import { isPhotoType } from './photos.js';
import { sortWords } from './intl.js';
import { bookingRef, BOOKING_FILE, PLAN_FILE } from './plan.js';
import { filesToRead } from './handover.js';
import { validZone, deviceZone, dayIn, instantAt } from './time.js';
import { inTrip, isGivenFile } from './paths.js';

/**
 * A trip's Files (the file-details design): each file the user gave, what Shiori read from it, and the plan items that stand for those,
 * worked out from what is stored, as data the screens make words of. Photos are left out of the list unless a booking came from one or
 * it waits to be read.
 * @typedef {{ at: number | null, day: string | null }} When  at: the instant; day: "YYYY-MM-DD"
 * @typedef {{ kind: 'booking', bookingKind: string, path: string, title: string, at: number | null, day: string | null }
 *   | { kind: 'plan', path: string, title: string, at: number | null, day: string | null } | { kind: 'photo' } | { kind: 'waiting' } | { kind: 'nothing' }} Became
 * @typedef {{ path: string, name: string, real: string, type: string, became: Became[] }} FileRow  name: Shiori's short name, else the title of the one booking, else real
 * @typedef {{ files: import('./types.js').FileEntry[], bookings: { path: string, booking: any }[],
 *   items: { path: string, item: any, source?: string }[], names: Record<string, string>, toRead: string[], fallbackTz: string }} TripFiles
 * @typedef {{ path: string, item: Record<string, any>, at: number | null, day: string | null }} Planned
 * @typedef {{ path: string, booking: Record<string, any>, at: number | null, day: string | null, items: Planned[] }} Block
 * @typedef {{ file: FileRow | null, blocks: Block[], made: Planned[], focus: string | null }} Details
 */

/** An object, or null. @param {unknown} v @returns {Record<string, any> | null} */
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : null);

/**
 * The zone for a time whose own zone annai doesn't know: the trip's first, else this phone's.
 * @param {import('./workspace.js').Workspace} ws @param {string} id
 */
export async function tripZoneOf(ws, id) {
  const trip = (await ws.readJSON(id, '/trip.json').catch(() => null)) ?? {};
  return [trip.timezones?.[0], deviceZone()].find(validZone) ?? 'UTC';
}

/**
 * Everything the Files list and the details screen are worked out from.
 * @param {import('./workspace.js').Workspace} ws @param {import('./types.js').Store} store @param {string} id @returns {Promise<TripFiles>}
 */
export async function readTripFiles(ws, store, id) {
  const files = await ws.list(id, '/');
  /** @param {string} prefix @param {RegExp} shape */
  const records = async (prefix, shape) => Promise.all(files.filter((f) => f.path.startsWith(prefix) && shape.test(f.path))
    .map(async (f) => ({ path: f.path, value: await ws.readJSON(id, f.path).catch(() => null), source: f.source })));
  return {
    files,
    bookings: (await records('/bookings/', BOOKING_FILE)).map((x) => ({ path: x.path, booking: x.value })),
    items: (await records('/plan/', PLAN_FILE)).map((x) => ({ path: x.path, item: x.value, source: x.source })),
    names: await readNames(ws, id),
    toRead: await filesToRead(store, id),
    fallbackTz: await tripZoneOf(ws, id),
  };
}

/**
 * The moment of a stored `start`: its own zone, else the fallback's; a date alone is that day, sorted from its midnight in that zone
 * (west of UTC, UTC's midnight would put it before the evening of the day before). @param {unknown} start @param {string} fallbackTz @returns {When}
 */
function whenOf(start, fallbackTz) {
  const s = record(start);
  const at = s?.at;
  const tz = validZone(s?.tz) ? s?.tz : fallbackTz;
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const ms = instantAt(`${at}T00:00`, tz);
    return { at: Number.isFinite(ms) ? ms : null, day: at };
  }
  const ms = instantAt(at, tz);
  return Number.isFinite(ms) ? { at: ms, day: dayIn(ms, tz) } : { at: null, day: null };
}

/** Time order: no time last, then by path. @param {{ at: number | null, path: string }} a @param {{ at: number | null, path: string }} b */
const byTime = (a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at - b.at) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** @param {TripFiles} t @param {string} path @returns {Block[]} the bookings whose source is the file, in time order, with their plan items */
function blocksOf(t, path) {
  /** @type {Block[]} */
  const blocks = [];
  for (const { path: p, booking } of t.bookings) {
    const b = record(booking);
    if (b && inTrip(b.source) === path) blocks.push({ path: p, booking: b, ...whenOf(b.start, t.fallbackTz), items: [] });
  }
  return blocks.sort(byTime);
}

/** @param {TripFiles} t @param {string} bookingPath @returns {Planned[]} plan items standing for a booking, in time order */
function itemsOf(t, bookingPath) {
  /** @type {Planned[]} */
  const out = [];
  for (const { path, item } of t.items) {
    const i = record(item);
    if (i && bookingRef(i.booking) === bookingPath) out.push({ path, item: i, ...whenOf(i.start, t.fallbackTz) });
  }
  return out.sort(byTime);
}

/** @param {TripFiles} t @param {string} path @returns {Planned[]} plan items made from a file (a calendar), in time order */
function madeFrom(t, path) {
  /** @type {Planned[]} */
  const out = [];
  for (const { path: p, item, source } of t.items) {
    const i = record(item);
    if (i && inTrip(source) === path) out.push({ path: p, item: i, ...whenOf(i.start, t.fallbackTz) });
  }
  return out.sort(byTime);
}

/** One file's row, photo or not. @param {TripFiles} t @param {import('./types.js').FileEntry} file @returns {FileRow} */
function rowOf(t, file) {
  /** @type {Became[]} */
  const became = [];
  for (const b of blocksOf(t, file.path)) became.push({ kind: 'booking', bookingKind: String(b.booking.kind ?? ''), path: b.path, title: typeof b.booking.title === 'string' ? b.booking.title : '', at: b.at, day: b.day });
  for (const p of madeFrom(t, file.path)) became.push({ kind: 'plan', path: p.path, title: typeof p.item.title === 'string' ? p.item.title : '', at: p.at, day: p.day });
  if (!became.length) became.push(t.toRead.includes(file.path) ? { kind: 'waiting' } : isPhotoType(file.type) ? { kind: 'photo' } : { kind: 'nothing' });
  const real = file.path.split('/').pop() ?? file.path;
  const only = became.length === 1 && became[0].kind === 'booking' ? became[0].title.trim() : '';
  return { path: file.path, name: Object.hasOwn(t.names, file.path) ? shortName(t.names, file.path) : only || real, real, type: file.type, became };
}

/** The earliest day of what a file became, or null. @param {FileRow} r */
const firstDay = (r) => r.became.reduce((/** @type {string | null} */ d, b) => ('day' in b && b.day && (!d || b.day < d) ? b.day : d), null);

/**
 * The rows of Files: one per file under /files/, by the first day of what it became (a file with no day after those with one), then by name.
 * @param {TripFiles} t @returns {FileRow[]}
 */
export function fileRows(t) {
  const out = [];
  for (const file of t.files) {
    if (!isGivenFile(file.path)) continue;
    const row = rowOf(t, file);
    if (row.became[0].kind !== 'photo') out.push(row); // a trip photo is among the trip's photos, not its Files
  }
  return out
    .map((r) => ({ r, day: firstDay(r) }))
    .sort((a, b) => (a.day === b.day ? 0 : a.day === null ? 1 : b.day === null ? -1 : a.day < b.day ? -1 : 1) || sortWords(a.r.name, b.r.name) || sortWords(a.r.real, b.r.real))
    .map((x) => x.r);
}

/**
 * What a details screen shows for `path`: a file under /files/ (with its bookings and plan items), or a booking (its file's screen at its
 * block when the file is there, else its block alone). Null when it is neither.
 * @param {TripFiles} t @param {string} path @returns {Details | null}
 */
export function fileDetails(t, path) {
  const p = inTrip(path);
  if (isGivenFile(p)) {
    const file = t.files.find((f) => f.path === p);
    if (!file) return null;
    const blocks = blocksOf(t, p);
    for (const b of blocks) b.items = itemsOf(t, b.path);
    const shown = new Set(blocks.flatMap((b) => b.items.map((i) => i.path)));
    return { file: rowOf(t, file), blocks, made: madeFrom(t, p).filter((i) => !shown.has(i.path)), focus: null };
  }
  if (!BOOKING_FILE.test(p)) return null;
  const booking = record(t.bookings.find((b) => b.path === p)?.booking);
  if (!booking) return null;
  const source = inTrip(booking.source);
  const own = isGivenFile(source) && t.files.some((f) => f.path === source) ? fileDetails(t, source) : null;
  if (own) return { ...own, focus: p };
  return { file: null, blocks: [{ path: p, booking, ...whenOf(booking.start, t.fallbackTz), items: itemsOf(t, p) }], made: [], focus: null };
}

/**
 * What Delete removes for a details screen: the file, each booking, every plan item shown, once each.
 * @param {Details} d @returns {{ file: string | null, bookings: string[], items: string[] }}
 */
export function deletionOf(d) {
  return {
    file: d.file?.path ?? null,
    bookings: d.blocks.map((b) => b.path),
    items: [...new Set([...d.blocks.flatMap((b) => b.items.map((i) => i.path)), ...d.made.map((i) => i.path)])],
  };
}
