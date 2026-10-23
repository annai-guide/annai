import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, createTrip } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { CORE_SCHEMAS } from '../../src/plugins/core-schemas/schemas.js';
import { TargetError, parseBackupFileName } from '../../src/core/storage-types.js';
import { createBackups } from '../../src/core/backup.js';
import { peekArchive } from '../../src/core/archive.js';

// Shared by the backup tests: a place in memory, and devices that back up to it.

export const TOKEN = 'sekrit-token-0001';

/**
 * A place that keeps backups in memory for every device given it, as the storage type contract says.
 * @param {{ peek?: boolean }} [o] peek: it can tell a backup's manifest alone, as a git place can; its peeks counts them
 */
export function memoryPlace({ peek = false } = {}) {
  let peeks = 0;
  /** @type {{ id: string, at: number, device: string, label: string, blob: Blob }[]} */
  const kept = [];
  /** @type {unknown} */
  let fail = null;
  /** @type {((signal: AbortSignal) => Promise<unknown>) | null} */
  let hold = null;
  let waiting = 0;
  const type = {
    type: 'memory', name: 'Memory', stores: 'tree', pluginId: 'memory-place',
    fields: [{ key: 'where', label: 'Where' }], secret: [{ key: 'token', label: 'Token' }],
    where: (/** @type {any} */ config) => config.where,
    check: async (/** @type {any} */ c) => {
      if (c.secret.token !== TOKEN) throw new TargetError('auth', `The token ${c.secret.token} was refused.`);
      return { note: 'Works.' };
    },
    list: async () => kept.map(({ id, at, device, label }) => ({ id, at, device, label })).reverse(),
    put: async (/** @type {any} */ c, /** @type {any} */ a, /** @type {any} */ o) => {
      if (fail) {
        const e = fail;
        fail = null;
        throw e;
      }
      if (hold) {
        waiting++;
        await hold(o.signal);
      }
      const newest = kept.at(-1);
      if (newest && newest.id !== o.base && newest.device !== c.device.id) {
        throw new TargetError('newer', 'There is a newer backup.', { remote: { id: newest.id, at: newest.at, device: newest.device, label: newest.label } });
      }
      if (a.blob.size > o.maxUpload) throw new TargetError('large', 'Too large.', { bytes: a.blob.size });
      o.onProgress({ phase: 'uploading', done: 1, total: 1 });
      const b = { id: `b${kept.length + 1}`, at: 1_000_000 + kept.length, device: c.device.id, label: c.device.label, blob: a.blob };
      kept.push(b);
      return { id: b.id, at: b.at, uploaded: a.blob.size, files: 1 };
    },
    get: async (/** @type {any} */ _c, /** @type {string} */ id) => {
      const b = kept.find((x) => x.id === id);
      if (!b) throw new TargetError('missing', 'That backup is gone.');
      return b.blob;
    },
    ...(peek ? {
      peek: async (/** @type {any} */ _c, /** @type {string} */ id) => {
        peeks++;
        const b = kept.find((x) => x.id === id);
        if (!b) throw new TargetError('missing', 'That backup is gone.');
        return (await peekArchive(b.blob)).manifest;
      },
    } : {}),
  };
  return {
    kept, type,
    peeks: () => peeks,
    waiting: () => waiting,
    /** The next put throws e. @param {unknown} e */
    failNext(e) { fail = e; },
    /** Puts wait until released, or until their signal aborts. @returns {() => void} release */
    pause() {
      /** @type {(v: unknown) => void} */
      let open = () => {};
      const gate = new Promise((resolve) => { open = resolve; });
      hold = (signal) => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        gate.then(resolve);
      });
      return () => {
        hold = null;
        open(undefined);
      };
    },
  };
}

/** A device whose registry has the place's type. @param {{ type: any }} place @param {string} [label] @param {(type: string, o?: { keepOff?: boolean }) => Promise<void>} [ensure] @param {() => boolean} [online] */
export async function device(place, label = 'iPhone', ensure, online = () => true) {
  /** @type {any[]} */
  const logged = [];
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor({ list: (k) => (k === 'schema' ? CORE_SCHEMAS : []) }, kindOf) });
  await ensureBaseScopes(ws);
  registry.add('memory-place', 'storage-type', place.type);
  let clock = 2_000_000;
  const backups = createBackups({ store, ws, registry, app: 'test', label, noun: 'phone', now: () => clock, online, ...(ensure ? { ensure } : {}) });
  const trip = await createTrip(ws, { title: 'Big Sur' });
  return { store, ws, registry, backups, trip, logged, now: () => clock, later: (/** @type {number} */ ms) => { clock += ms; } };
}

/** @param {Awaited<ReturnType<typeof device>>} d */
export async function placeOn(d) {
  const id = await d.backups.add('memory');
  await d.backups.update(id, { config: { where: 'here' }, secret: { token: TOKEN } });
  return id;
}

/** Everything a store keeps, as text: every log entry and every stored content. @param {any} store */
export function everything(store) {
  return store.tx(['scopes', 'events', 'blobs'], 'readonly', async (/** @type {any} */ t) => {
    const out = [];
    for (const s of await t.listScopes()) out.push(JSON.stringify(await t.listEvents(s.id)));
    for (const b of await t.listBlobs()) out.push(new TextDecoder().decode((await t.getBlob(b.hash))?.data));
    return out.join('\n');
  });
}

/** @param {() => boolean} ok */
export async function until(ok) {
  while (!ok()) await new Promise((resolve) => setTimeout(resolve, 1));
}


/** A place that keeps whole files in memory (stores: "file"), as S3 and WebDAV do. */
export function memoryFilePlace() {
  /** @type {Map<string, Blob>} */
  const files = new Map();
  /** @type {unknown} */
  let failDelete = null;
  const type = {
    type: 'memory-file', name: 'Folder', stores: 'file', pluginId: 'memory-place', fields: [], secret: [],
    where: () => 'memory',
    check: async () => ({ note: 'Works.' }),
    list: async () => [...files.keys()].map((n) => parseBackupFileName(n)).filter((b) => b !== null).sort((a, b) => b.at - a.at),
    put: async (/** @type {any} */ _c, /** @type {any} */ a, /** @type {any} */ o) => {
      o.onProgress({ phase: 'uploading', done: 0, total: 1 });
      files.set(a.name, a.blob);
      return { id: a.name, at: parseBackupFileName(a.name)?.at ?? 0, uploaded: a.blob.size, files: 1 };
    },
    get: async (/** @type {any} */ _c, /** @type {string} */ id) => {
      const b = files.get(id);
      if (!b) throw new TargetError('missing', 'That backup is gone.');
      return b;
    },
    delete: async (/** @type {any} */ _c, /** @type {string} */ id) => {
      if (failDelete) {
        const e = failDelete;
        failDelete = null;
        throw e;
      }
      files.delete(id);
    },
  };
  return {
    files, type,
    /** The next deletion throws e. @param {unknown} e */
    failDeleteNext(e) { failDelete = e; },
  };
}
