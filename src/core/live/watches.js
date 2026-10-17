import { newId } from '../scopes.js';

/**
 * Watches (spec §4.4: "stored as a record so it survives reloads"): /watches/<id>.json in the
 * scope of the conversation they belong to (a trip, or "me"), so removing a trip removes its
 * watches (§4.9). The plan's own watches aren't stored: they come from the plan.
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {{ id: string, owner: string, when: { type: string, [k: string]: any }, repeat?: boolean, fallback: string, expires?: string, created?: string, path?: string }} Watch
 *   owner: shiori, system or plugin:<id>; path: where it is stored (not part of the record)
 */

export const WATCH_DIR = '/watches/';
export const WATCH_FILE = /^\/watches\/[^/]+\.json$/;
export const WATCH_SCHEMA = {
  type: 'object', required: ['id', 'owner', 'when', 'fallback'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 80 },
    owner: { type: 'string', minLength: 1 },
    when: { type: 'object', required: ['type'], properties: { type: { type: 'string', minLength: 1 } } },
    repeat: { type: 'boolean' },
    fallback: { type: 'string', minLength: 1, maxLength: 500 },
    expires: { type: 'string', format: 'date-time' },
    created: { type: 'string', format: 'date-time' },
  },
};

export const newWatchId = () => newId('w');
/** @param {string} id */
export const watchPath = (id) => `${WATCH_DIR}${id}.json`;

/**
 * The watches stored in a scope, and how many files there couldn't be read as one.
 * @param {Workspace} ws @param {string} scope @returns {Promise<{ watches: Watch[], broken: number }>}
 */
export async function readWatches(ws, scope) {
  /** @type {Watch[]} */
  const watches = [];
  let broken = 0;
  for (const f of await ws.list(scope, WATCH_DIR)) {
    if (!WATCH_FILE.test(f.path)) continue;
    try {
      const w = await ws.readJSON(scope, f.path);
      if (w && typeof w === 'object' && typeof w.id === 'string' && typeof w.when?.type === 'string' && typeof w.fallback === 'string' && w.fallback.trim()) {
        watches.push({ ...w, path: f.path });
      } else broken++;
    } catch {
      broken++;
    }
  }
  return { watches, broken };
}

/** @param {Workspace} ws @param {string} scope @param {Watch} w @param {string} author */
export function saveWatch(ws, scope, w, author) {
  const { path, ...record } = w;
  return ws.write(scope, path ?? watchPath(w.id), record, { author });
}

/** Removes a watch; one already gone is fine. @param {Workspace} ws @param {string} scope @param {Watch} w */
export async function removeWatch(ws, scope, w, author = 'system') {
  const path = w.path ?? watchPath(w.id);
  if (await ws.read(scope, path)) await ws.delete(scope, path, { author });
}

/** Whether a watch is past its expiry. @param {Watch} w @param {number} now */
export function expired(w, now) {
  if (!w.expires) return false;
  const t = Date.parse(w.expires);
  return Number.isFinite(t) && now >= t;
}
