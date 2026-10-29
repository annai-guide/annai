/**
 * Shiori's short names for files (the bookings-and-trips design, goal 10): a file name is often not words ("IMG_3021.PNG"), so she
 * names each file for what it is ("ANNAI AIR flight · Nov 20"). The names are data in /names.json beside the files, in each trip and in
 * the waiting space, keyed by the file's path in that scope; the file keeps its own name.
 * @typedef {import('./workspace.js').Workspace} Workspace
 */

export const NAMES_FILE = '/names.json';
/** The longest short name, in characters. */
export const NAME_MAX = 80;

/** names.json's format: paths directly under /files/, each to a name of 1 to NAME_MAX characters. */
export const NAMES_SCHEMA = {
  type: 'object',
  propertyNames: { pattern: '^/files/[^/]+$' },
  additionalProperties: { type: 'string', minLength: 1, maxLength: NAME_MAX },
};

/**
 * The names Shiori gave in a scope, by path; none when there is no names.json, or it can't be read as one.
 * @param {Workspace} ws @param {string} scope @returns {Promise<Record<string, string>>}
 */
export async function readNames(ws, scope) {
  const v = await ws.readJSON(scope, NAMES_FILE).catch(() => undefined);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === 'string' && n) out[k] = n;
  return out;
}

/** A file's short name: hers, else the file's own name. @param {Record<string, string>} names @param {string} path */
export function shortName(names, path) {
  return Object.hasOwn(names, path) ? names[path] : path.split('/').pop() ?? path;
}
