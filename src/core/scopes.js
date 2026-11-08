import { ValidationError, NotFoundError, notJSON } from './workspace.js';
import { t } from './l10n.js';
import { text } from './bytes.js';

/** @typedef {import('./types.js').Store} Store @typedef {import('./types.js').ScopeRecord} ScopeRecord @typedef {import('./types.js').Tx} Tx */
/** @typedef {import('./workspace.js').Workspace} Workspace */

export const FORMAT = 1;
export const ME = 'me';
export const SYS = 'sys';
export const SYS_SETTINGS = 'sys:settings';
export const SYS_PLUGINS = 'sys:plugins';
/** What the user handed Shiori while no trip was open waits here, outside every trip and outside /me/, until she files it (waiting.js). */
export const SYS_WAITING = 'sys:waiting';
/** This device's own scope: never exported, never imported (see ensureDeviceScope). */
export const SYS_DEVICE = 'sys:device';
/** Secrets that belong to this device alone: backup places' sign-ins and the push relay's cancel tokens. No archive holds them. @param {string} id */
export const isDeviceSecret = (id) => id.startsWith('backup:') || id.startsWith('push:');

/** @param {string} scope @returns {'me'|'trip'|'sys'|'other'} */
export function kindOf(scope) {
  if (scope === ME) return 'me';
  if (scope === SYS || scope.startsWith('sys:')) return 'sys';
  if (scope.startsWith('trip-')) return 'trip';
  return 'other';
}

/** A line the user said: typed, or heard and not dismissed; a hand-over's copy in another trip (data.from) counts too. What "last talked in" counts. @param {{ type: string, data?: any }} e */
export const talks = (e) => e.type === 'msg.user' || (e.type === 'heard' && !e.data?.dismissed);

/** What a trip's record mirrors of its trip.json, so no file is opened to tell which trips matter now: its dates, when they are dates. @param {unknown} trip @returns {{ start?: string, end?: string }} */
export function tripMirror(trip) {
  const t = /** @type {any} */ (trip);
  /** @type {{ start?: string, end?: string }} */
  const out = {};
  for (const k of /** @type {const} */ (['start', 'end'])) if (typeof t?.[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t[k])) out[k] = t[k];
  return out;
}

/** A sortable, collision-resistant id: "<prefix>-<time base36><8 random base36>". @param {string} prefix */
export function newId(prefix) {
  let r = '';
  for (const b of crypto.getRandomValues(new Uint8Array(8))) r += (b % 36).toString(36);
  return `${prefix}-${Date.now().toString(36)}${r}`;
}

/** A draft's stored name until its first line names it (chats.js); the screens show it in theirs. */
export const DRAFT_TITLE = /* en */ 'New conversation';

/* en */
const PROFILE = '# Profile\n\n- What to call me:\n- Language: English\n- Units:\n- Preferences:\n';

/**
 * A scope's title as the screens show it: "me" and the system scopes by their id, in the screens' language (the stored title is
 * annai's English, written once when the scope was made); a trip by the title its user gave it. @param {{ id: string, title: string }} rec
 */
export function scopeTitle(rec) {
  switch (rec.id) {
    case ME: return t`Me`;
    case SYS: return t`System log`;
    case SYS_SETTINGS: return t`Settings`;
    case SYS_PLUGINS: return t`Plugins`;
    case SYS_DEVICE: return t`This device`;
    case SYS_WAITING: return t`Waiting with Shiori`;
    default: return rec.title === DRAFT_TITLE ? t`New conversation` : rec.title;
  }
}

/** Creates "me" and the system scopes if they are missing. @param {Workspace} ws */
export async function ensureBaseScopes(ws) {
  const now = ws.now();
  /** @type {[string, ScopeRecord['kind'], string][]} */
  /* en */
  const base = [[ME, 'me', 'Me'], [SYS, 'sys', 'System log'], [SYS_SETTINGS, 'sys', 'Settings'], [SYS_PLUGINS, 'sys', 'Plugins'], [SYS_WAITING, 'sys', 'Waiting with Shiori']];
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
    await ws.write(ME, '/memory.md', /* en */ '# Memory\n', { author: 'user' });
  }
}

/**
 * This device's own scope, made on first use: what annai keeps about this device alone, such as
 * where it backs up to (spec §12.4). Exports leave it out and imports skip it, so a restored backup
 * can never make two devices one.
 * @param {Store} store @param {number} [now]
 */
export async function ensureDeviceScope(store, now = Date.now()) {
  await store.tx(['scopes'], 'readwrite', async (t) => {
    if (!(await t.getScope(SYS_DEVICE))) {
      await t.putScope({ id: SYS_DEVICE, kind: 'sys', title: /* en */ 'This device', status: 'active', created: now, updated: now, format: FORMAT });
    }
  });
}

/**
 * A new trip: a name is enough. Shiori starts one for a hand-over as hers (the bookings-and-trips design), its first entries carrying it.
 * @param {Workspace} ws
 * @param {{ title: string, start?: string, end?: string, places?: string[], timezones?: string[] }} trip
 * @param {{ author?: 'user' | 'shiori', handover?: string, draft?: boolean }} [o] author: who starts it (the user, unless Shiori did); handover: the hand-over she started it for;
 *   draft: the standing draft (chats.js), unless one is there already, whose id it then gives
 * @returns {Promise<string>} the new scope id
 */
export async function createTrip(ws, { title, start, end, places, timezones }, o = {}) {
  const clean = (title ?? '').trim();
  if (!clean) throw new ValidationError('/trip.json', [/* en */ '$.title: is required']);
  const now = ws.now();
  const id = newId('trip');
  const tripId = newId('t');
  const author = o.author ?? 'user';
  const handover = o.handover ? { handover: o.handover } : {};
  const had = await ws.store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    const draft = o.draft ? (await t.listScopes()).find((s) => s.draft) : null;
    if (draft) return draft.id;
    await t.putScope({ id, kind: 'trip', title: clean, status: 'active', created: now, updated: now, format: FORMAT, tripId, ...tripMirror({ start, end }), talked: null, ...(o.draft ? { draft: /** @type {const} */ (true) } : {}) });
    await t.appendEvent(id, { ts: now, type: 'scope.create', actor: author, data: { title: clean, ...handover } });
    return null;
  });
  if (had) return had;
  try {
    const record = { id: tripId, title: clean, ...(start ? { start } : {}), ...(end ? { end } : {}), places: places ?? [], ...(timezones?.length ? { timezones } : {}), party: [] };
    await ws.write(id, '/trip.json', record, { author, ...handover });
    await ws.write(id, '/memory.md', /* en */ '# Trip memory\n', { author, ...handover });
  } catch (e) {
    await ws.store.tx(['scopes', 'files', 'events'], 'readwrite', (t) => t.deleteScope(id));
    throw e;
  }
  return id;
}

/** The trips and chats, newest change first, and the standing draft apart: it is no conversation until it is used. @param {Store} store */
export async function listTrips(store) {
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const trips = all.filter((s) => s.kind === 'trip' && !s.draft).sort((a, b) => b.updated - a.updated);
  return { active: trips.filter((s) => s.status === 'active'), archived: trips.filter((s) => s.status === 'archived'), draft: all.find((s) => s.kind === 'trip' && s.draft)?.id ?? null };
}

/** @param {Store} store @param {string} id @param {'active'|'archived'} status */
export async function setTripStatus(store, id, status, now = Date.now()) {
  await store.tx(['scopes', 'events'], 'readwrite', async (t) => {
    const rec = await t.getScope(id);
    if (!rec || rec.kind !== 'trip') throw new Error(/* en */ `trip ${id} doesn't exist`);
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
    if (!rec || rec.kind !== 'trip') throw new NotFoundError(`trip ${id}`);
    await t.deleteScope(id);
    const bytes = await freeUnused(t);
    await t.appendEvent(SYS, { ts: now, type: 'trip.remove', actor: 'user', data: { title: rec.title, bytes } });
    return { title: rec.title, bytes };
  });
}

/**
 * Deletes every stored content no file and no log entry names, through the indexes of what they
 * name: no log is read in full (spec §4.9). @param {Tx} t @returns {Promise<number>} the bytes freed
 */
async function freeUnused(t) {
  let bytes = 0;
  for (const b of await t.listBlobs()) {
    if (await t.blobInUse(b.hash)) continue;
    await t.deleteBlob(b.hash);
    bytes += b.size;
  }
  return bytes;
}

/**
 * Removes files and log entries left under a scope that no longer exists, and the content only
 * they named. A request that ignored Stop can finish after its trip was removed and log itself
 * there; annai runs this as it starts, so removing still means removing (spec §4.9).
 * @param {Store} store @param {number} [now]
 * @returns {Promise<{ scopes: number, bytes: number }>} scopes: how many removed scopes had something left
 */
export async function removeLeftovers(store, now = Date.now()) {
  return store.tx(['scopes', 'files', 'events', 'blobs'], 'readwrite', async (t) => {
    const known = new Set((await t.listScopes()).map((s) => s.id));
    const left = (await t.scopesWithData()).filter((id) => !known.has(id));
    if (!left.length) return { scopes: 0, bytes: 0 };
    for (const id of left) await t.deleteScope(id);
    const result = { scopes: left.length, bytes: await freeUnused(t) };
    await t.appendEvent(SYS, { ts: now, type: 'leftovers.remove', actor: 'system', data: result });
    return result;
  });
}

/** Log entries that change nothing a Backup holds: a refused read's note (reach.js). */
export const NOTES_ONLY = Object.freeze(['content.refused']);
/** Changes to a trip's status, not to what it holds, and notes: a Backup made before them still has everything (spec §4.9). */
const STATUS_ONLY = new Set(['scope.archive', 'scope.unarchive', ...NOTES_ONLY]);

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
    if ((await t.lastSeq(id)) <= backup.seq) return { at: backup.at, changed: false }; // the usual case: one key read
    // The first entry after the backup that is a change is enough to know, not every one after it.
    const [change] = await t.listEvents(id, { after: backup.seq, notTypes: [...STATUS_ONLY], limit: 1 });
    return { at: backup.at, changed: Boolean(change) };
  });
}

/** Keeps each trip scope's title and dates equal to its trip.json's; a file with no title keeps the record's. @param {Workspace} ws */
export function syncTripTitles(ws) {
  return ws.onChange(async ({ op, scope, path }) => {
    if (op === 'write' && kindOf(scope) === 'trip' && path === '/trip.json') await mirrorTrip(ws, scope);
  });
}

/** @param {Workspace} ws @param {string} scope */
async function mirrorTrip(ws, scope) {
  const trip = await ws.readJSON(scope, '/trip.json').catch(notJSON); // a failed read says nothing of its dates: the record stays, and the next start looks again
  await ws.store.tx(['scopes'], 'readwrite', async (t) => {
    const rec = await t.getScope(scope);
    const next = rec && mirrored(rec, trip);
    if (next) await t.putScope(next);
  });
}

/** The record with trip.json's title and dates, or null when it has them already; a file with no title keeps the record's. @param {ScopeRecord} rec @param {unknown} trip */
function mirrored(rec, trip) {
  const title = String(/** @type {any} */ (trip)?.title ?? '').trim();
  const dates = tripMirror(trip);
  const { start: _s, end: _e, ...rest } = rec;
  const next = { ...rest, ...dates, title: title || rec.title };
  return next.title !== rec.title || next.start !== rec.start || next.end !== rec.end ? next : null;
}

/** When the user last talked in a trip, from its log; null when nobody has. @param {Store} store @param {string} scope @returns {Promise<number | null>} */
async function lastTalked(store, scope) {
  const lines = await store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['msg.user', 'heard'], reverse: true }));
  return lines.find(talks)?.ts ?? null;
}

/**
 * Fills the mirror on records without it (released copies, some archives), archived too. The talked key says it was done; only this writes it on a record
 * without one, so a run that failed halfway is finished by the next. A filled record is checked against its trip.json, every trip's read in one
 * transaction, and written only where it differs (the heal for a date edit whose mirror failed): with hundreds of chats, a start costs no transaction per chat.
 * @param {Workspace} ws
 */
export async function backfillTrips(ws) {
  const { store } = ws;
  const trips = (await store.tx(['scopes'], 'readonly', (t) => t.listScopes())).filter((s) => s.kind === 'trip');
  const filled = trips.filter((s) => 'talked' in s);
  // A read that fails says nothing of the dates: those records wait for the next start.
  const files = filled.length ? await store.tx(['files', 'blobs'], 'readonly', async (t) => {
    /** @type {Map<string, unknown>} */
    const out = new Map();
    for (const s of filled) {
      const f = await t.getFile(s.id, '/trip.json');
      const b = f && (await t.getBlob(f.hash));
      if (f && !b) continue; // its content is missing: nothing said of its dates
      try {
        out.set(s.id, b ? JSON.parse(text(new Uint8Array(b.data))) : undefined);
      } catch {
        out.set(s.id, null); // not JSON: an answer, as notJSON reads it
      }
    }
    return out;
  }).catch(() => null) : null;
  for (const s of files ? filled : []) {
    if (!files?.has(s.id) || !mirrored(s, files.get(s.id))) continue;
    await store.tx(['scopes'], 'readwrite', async (t) => {
      const rec = await t.getScope(s.id);
      const next = rec && mirrored(rec, files?.get(s.id));
      if (next) await t.putScope(next);
    }).catch(() => {});
  }
  for (const s of trips.filter((x) => !('talked' in x))) {
    const dates = tripMirror(await ws.readJSON(s.id, '/trip.json').catch(notJSON));
    const talked = await lastTalked(store, s.id);
    await store.tx(['scopes'], 'readwrite', async (t) => {
      const rec = await t.getScope(s.id);
      if (rec && !('talked' in rec)) await t.putScope({ ...rec, ...dates, talked });
    });
  }
}
