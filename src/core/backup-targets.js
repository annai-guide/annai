import { SYS_DEVICE, ensureDeviceScope, newId } from './scopes.js';
import { NotFoundError } from './workspace.js';

/**
 * Where this device backs up to (spec §12.4), and what it last did there: one file in this
 * device's own scope, which no archive carries, so a restored backup can't make two devices one.
 * What a place needs to sign in (a token, a key, a password) is a secret, backup:<id>.
 * @typedef {import('./workspace.js').Workspace} Workspace
 * @typedef {import('./types.js').Store} Store
 * @typedef {'off'|'changes'|'daily'} Auto
 * @typedef {{ id: string, at: number, device?: string, label?: string, encrypted?: boolean }} RemoteBackup
 *   a backup at a place: its id there, when it was made, and the device that made it, when known
 * @typedef {{ kind: 'newer', remote: RemoteBackup, seen?: boolean } | { kind: 'large', bytes: number, at: number }
 *   | { kind: 'error', message: string, at: number, count: number, retryAt: number, needsYou: boolean }} Hold
 *   why automatic backups to a place wait: a backup there this device hasn't taken in; an upload too
 *   large to make without asking; or a failure, tried again at retryAt (needsYou: only the user can fix it).
 *   seen: the user found the newer backup themselves, testing the place on its screen
 * @typedef {{ id: string, at: number, seqs: Record<string, number>, bytes: number }} LastBackup
 *   the backup at the place this device builds on, one it made or took in; seqs: each scope's last log entry in it
 * @typedef {{ id: string, type: string, name: string, config: Record<string, string>, auto: Auto, mobileData: boolean,
 *   created: number, checked: number | null, last: LastBackup | null, hold: Hold | null, encrypt?: boolean, keys?: boolean, keep?: number }} Target
 *   checked: when it last passed a test; automatic backups wait for one. For whole-file places: encrypt, the backups are
 *   encrypted with the passphrase in its secret; keys, and hold the API keys; keep, how many of this device's backups stay there
 * @typedef {{ device: string | null, targets: Record<string, Target> }} State
 */

const FILE = '/backups.json';

/** @param {Workspace} ws @returns {Promise<State>} */
async function read(ws) {
  /** @type {any} */
  const v = (await ws.readJSON(SYS_DEVICE, FILE).catch(() => null)) ?? {};
  const targets = v.targets && typeof v.targets === 'object' && !Array.isArray(v.targets) ? v.targets : {};
  return { device: typeof v.device === 'string' ? v.device : null, targets };
}

/** @type {Promise<unknown>} */
let turn = Promise.resolve();

/**
 * Changes the file one change at a time, so a screen saving a place and a backup noting its result
 * never undo each other. @template T
 * @param {Workspace} ws @param {(v: State) => T} fn changes v in place @returns {Promise<T>}
 */
function change(ws, fn) {
  const run = turn.then(async () => {
    await ensureDeviceScope(ws.store, ws.now());
    const v = await read(ws);
    const out = fn(v);
    await ws.write(SYS_DEVICE, FILE, v, { author: 'system' });
    return out;
  });
  turn = run.catch(() => {});
  return run;
}

/** Every place this device backs up to, oldest first. @param {Workspace} ws @returns {Promise<Target[]>} */
export async function listTargets(ws) {
  return Object.values((await read(ws)).targets).sort((a, b) => a.created - b.created);
}

/** @param {Workspace} ws @param {string} id @returns {Promise<Target | undefined>} */
export async function getTarget(ws, id) {
  return (await read(ws)).targets[id];
}

/** This device's id in the backups it makes: random, made once, kept only here. @param {Workspace} ws @returns {Promise<string>} */
export async function deviceId(ws) {
  const had = (await read(ws)).device;
  if (had) return had;
  return change(ws, (v) => (v.device ??= newId('d').slice(2)));
}

/**
 * @param {Workspace} ws @param {{ type: string, name: string, config?: Record<string, string>, auto?: Auto, mobileData?: boolean }} t
 * @returns {Promise<string>} the new place's id
 */
export async function addTarget(ws, { type, name, config = {}, auto = 'changes', mobileData = false }) {
  const id = newId('bt');
  await change(ws, (v) => {
    v.targets[id] = { id, type, name, config, auto, mobileData, created: ws.now(), checked: null, last: null, hold: null, encrypt: false, keys: false, keep: 3 };
  });
  return id;
}

/**
 * Sets some of a place's fields, keeping the others. @param {Workspace} ws @param {string} id
 * @param {Partial<Omit<Target, 'id' | 'type' | 'created'>>} fields @returns {Promise<Target>}
 */
export function setTarget(ws, id, fields) {
  return change(ws, (v) => {
    const t = v.targets[id];
    if (!t) throw new NotFoundError(`backup place ${id}`);
    v.targets[id] = { ...t, ...fields };
    return v.targets[id];
  });
}

/** Forgets a place and its secret. What is stored at the place stays there. @param {Workspace} ws @param {string} id */
export async function removeTarget(ws, id) {
  await change(ws, (v) => { delete v.targets[id]; });
  await setTargetSecret(ws.store, id, null);
}

/** The ids of backup places' secrets begin so. They never leave this device: not even an encrypted backup with API keys holds them. */
export const BACKUP_SECRET_PREFIX = 'backup:';

/** @param {string} id */
export const secretId = (id) => `${BACKUP_SECRET_PREFIX}${id}`;

/** What a place needs to sign in, such as { token }. @param {Store} store @param {string} id @returns {Promise<Record<string, string>>} */
export async function targetSecret(store, id) {
  const v = await store.tx(['secrets'], 'readonly', (t) => t.getSecret(secretId(id)));
  return v && typeof v === 'object' ? { ...v } : {};
}

/**
 * Keeps the values given (an empty one removes that value); null removes the whole secret.
 * @param {Store} store @param {string} id @param {Record<string, string> | null} values
 */
export async function setTargetSecret(store, id, values) {
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (values === null) return t.deleteSecret(secretId(id));
    /** @type {Record<string, string>} */
    const next = { ...((await t.getSecret(secretId(id))) ?? {}) };
    for (const [k, v] of Object.entries(values)) {
      if (v) next[k] = v;
      else delete next[k];
    }
    return Object.keys(next).length ? t.putSecret(secretId(id), next) : t.deleteSecret(secretId(id));
  });
}
