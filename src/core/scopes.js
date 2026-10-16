import { ValidationError } from './workspace.js';
import { blobsOf } from './events.js';

/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').ScopeRecord} ScopeRecord @typedef {import('./types.js').Tx} Tx */
/** @typedef {import('./workspace.js').Workspace} Workspace */

export const FORMAT = 1;
export const ME = 'me';
export const SYS = 'sys';
export const SYS_SETTINGS = 'sys:settings';
export const SYS_PLUGINS = 'sys:plugins';

/** @param {string} scope @returns {'me'|'trip'|'sys'|'other'} */
export function kindOf(scope) {
  if (scope === ME) return 'me';
  if (scope === SYS || scope.startsWith('sys:')) return 'sys';
  if (scope.startsWith('trip-')) return 'trip';
  return 'other';
}

/** A sortable, collision-resistant id: "<prefix>-<time base36><8 random base36>". @param {string} prefix */
export function newId(prefix) {
  let r = '';
  for (const b of crypto.getRandomValues(new Uint8Array(8))) r += (b % 36).toString(36);
  return `${prefix}-${Date.now().toString(36)}${r}`;
}

const PROFILE = '# Profile\n\n- What to call me:\n- Language: English\n- Units:\n- Preferences:\n';

/** Creates "me" and the system scopes if they are missing. @param {Workspace} ws */
export async function ensureBaseScopes(ws) {
  const now = ws.now();
  /** @type {[string, ScopeRecord['kind'], string][]} */
  const base = [[ME, 'me', 'Me'], [SYS, 'sys', 'System log'], [SYS_SETTINGS, 'sys', 'Settings'], [SYS_PLUGINS, 'sys', 'Plugins']];
  const made = await ws.store.tx(['scopes'], 'readwrite', async (t) => {
    /** @type {string[]} */
    const created = [];
    for (const [id, kind, title] of base) {
      if (!(await t.getScope(id))) {
        await t.putScope({ id, kind, title, status: 'active', created: now, updated: now, format: FORMAT });
        created.push(id);
      }
    }
    return created;
  });
  if (made.includes(ME)) {
    await ws.write(ME, '/profile.md', PROFILE, { author: 'user' });
    await ws.write(ME, '/memory.md', '# Memory\n', { author: 'user' });
  }
}

/**
 * @param {Workspace} ws
 * @param {{ title: string, start?: string, end?: string }} trip
 * @returns {Promise<string>} the new scope id
 */
export async function createTrip(ws, { title, start, end }) {
  const clean = (title ?? '').trim();
  if (!clean) throw new ValidationError('/trip.json', ['$.title: is required']);
  const now = ws.now();
  const id = newId('trip');
  const tripId = newId('t');
  await ws.store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    await t.putScope({ id, kind: 'trip', title: clean, status: 'active', created: now, updated: now, format: FORMAT, tripId });
    await t.appendEvent(id, { ts: now, type: 'scope.create', actor: 'user', data: { title: clean } });
  });
  try {
    await ws.write(id, '/trip.json', { id: tripId, title: clean, ...(start ? { start } : {}), ...(end ? { end } : {}), places: [], party: [] }, { author: 'user' });
    await ws.write(id, '/memory.md', '# Trip memory\n', { author: 'user' });
  } catch (e) {
    await ws.store.tx(['scopes', 'files', 'events'], 'readwrite', (t) => t.deleteScope(id));
    throw e;
  }
  return id;
}

/** @param {Store} store */
export async function listTrips(store) {
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const trips = all.filter((s) => s.kind === 'trip').sort((a, b) => b.updated - a.updated);
  return { active: trips.filter((s) => s.status === 'active'), archived: trips.filter((s) => s.status === 'archived') };
}

/** @param {Store} store @param {string} id @param {'active'|'archived'} status */
export async function setTripStatus(store, id, status, now = Date.now()) {
  await store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    const rec = await t.getScope(id);
    if (!rec || rec.kind !== 'trip') throw new Error(`trip ${id} doesn't exist`);
    await t.putScope({ ...rec, status, updated: now });
    await t.appendEvent(id, { ts: now, type: status === 'archived' ? 'scope.archive' : 'scope.unarchive', actor: 'user' });
  });
}

/**
 * Removes a trip from this device for good: its record, files and history, and every stored
 * content nothing else uses, so its space comes back at once (spec §4.9). One transaction:
 * all of it goes, or none of it.
 * @param {Store} store @param {string} id @param {number} [now]
 * @returns {Promise<{ title: string, bytes: number }>} bytes: the size of the content removed
 */
export async function removeTrip(store, id, now = Date.now()) {
  return store.tx(['scopes', 'files', 'events', 'blobs'], 'readwrite', async (t) => {
    const rec = await t.getScope(id);
    if (!rec || rec.kind !== 'trip') throw new Error(`trip ${id} doesn't exist`);
    await t.deleteScope(id);
    const used = await blobsInUse(t);
    let bytes = 0;
    for (const b of await t.listBlobs()) {
      if (used.has(b.hash)) continue;
      await t.deleteBlob(b.hash);
      bytes += b.size;
    }
    await t.appendEvent(SYS, { ts: now, type: 'trip.remove', actor: 'user', data: { title: rec.title, bytes } });
    return { title: rec.title, bytes };
  });
}

/**
 * Every blob that a file or a log entry of any scope still points at (spec §4.9).
 * @param {Tx} t a transaction over scopes, files and events
 */
export async function blobsInUse(t) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const s of await t.listScopes()) {
    for (const f of await t.listFiles(s.id, '/')) used.add(f.hash);
    for (const e of await t.listEvents(s.id)) for (const h of blobsOf(e)) used.add(h);
  }
  return used;
}

/** Changes to a trip's status, not to what it holds: a Backup made before them still has everything (spec §4.9). */
const STATUS_ONLY = new Set(['scope.archive', 'scope.unarchive']);

/**
 * Notes a saved Backup on each trip it held (spec §4.9). A scope that isn't a trip, a trip
 * that is gone, and a Backup older than the one already noted are left alone.
 * @param {Store} store @param {Map<string, number>} seqs scope id → the last history entry the Backup holds
 * @param {number} at when it was saved
 */
export async function recordBackup(store, seqs, at) {
  await store.tx(['scopes'], 'readwrite', async (t) => {
    for (const [id, seq] of seqs) {
      const rec = await t.getScope(id);
      if (rec?.kind !== 'trip' || (rec.backup && rec.backup.seq > seq)) continue;
      await t.putScope({ ...rec, backup: { at, seq } });
    }
  });
}

/**
 * When the trip was last backed up, and whether it changed after that (spec §4.9).
 * @param {Store} store @param {string} id
 * @returns {Promise<{ at: number | null, changed: boolean }>} at is null when it never was
 */
export async function backupState(store, id) {
  return store.tx(['scopes', 'events'], 'readonly', async (t) => {
    const backup = (await t.getScope(id))?.backup;
    if (!backup) return { at: null, changed: true };
    const later = await t.listEvents(id, { after: backup.seq });
    return { at: backup.at, changed: later.some((e) => !STATUS_ONLY.has(e.type)) };
  });
}

/** Keeps each trip scope's title equal to the title in its trip.json. @param {Workspace} ws */
export function syncTripTitles(ws) {
  return ws.onChange(async ({ op, scope, path }) => {
    if (op !== 'write' || kindOf(scope) !== 'trip' || path !== '/trip.json') return;
    const trip = await ws.readJSON(scope, '/trip.json');
    const title = String(trip?.title ?? '').trim();
    if (!title) return;
    await ws.store.tx(['scopes'], 'readwrite', async (t) => {
      const rec = await t.getScope(scope);
      if (rec && rec.title !== title) await t.putScope({ ...rec, title });
    });
  });
}
