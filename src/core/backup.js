import { exportArchive, PRESETS } from './archive.js';
import { recordBackup, SYS } from './scopes.js';
import { logEvent } from './events.js';
import { withoutSecrets } from './agent/net.js';
import { isPluginBug } from './plugins.js';
import { storageTypes, TargetError, NEEDS_YOU, backupFileName } from './storage-types.js';
import { listTargets, getTarget, addTarget, setTarget, removeTarget, deviceId, targetSecret, setTargetSecret } from './backup-targets.js';

/**
 * Backups to the places this device backs up to (spec §12.4). annai builds a Backup of everything
 * (§12.2); a storage type moves it; the trips it holds count as backed up once it lands (§4.9).
 * Single writer: a place whose newest backup is neither the one this device builds on nor one it
 * made waits until the user chooses: import that backup as a copy, or back up over it.
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./workspace.js').Workspace} Workspace
 * @typedef {import('./registry.js').Registry} Registry
 * @typedef {import('./backup-targets.js').Target} Target
 * @typedef {import('./backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {import('./backup-targets.js').Hold} Hold
 * @typedef {import('./backup-targets.js').Auto} Auto
 * @typedef {import('./storage-types.js').StorageType} StorageType
 * @typedef {import('./storage-types.js').TargetContext} TargetContext
 * @typedef {import('./storage-types.js').Progress} Progress
 * @typedef {ReturnType<typeof createBackups>} Backups
 */

/** How long annai waits after the count-th failure in a row before trying a place again: 15 minutes, doubling up to 6 hours. @param {number} count */
export function retryDelay(count) {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, count - 1), 6 * 3_600_000);
}

/**
 * @param {{ store: Store, ws: Workspace, registry: Registry, app: string, label: string, noun?: string,
 *   ensure?: (type: string) => Promise<void>, now?: () => number }} deps
 *   label: what this device is called in its backups ("iPhone"); noun: what the user calls it ("phone");
 *   ensure: makes a kind of place available, installing its plugin (spec §5.3)
 */
export function createBackups({ store, ws, registry, app, label, noun = 'device', ensure = async () => {}, now = () => Date.now() }) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, Progress & { stop: AbortController }>} */
  const running = new Map();
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (e) {
        console.warn('a backup listener failed', e);
      }
    }
  };
  /** One backup or download at a time. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  /** @param {string} type @param {Record<string, any>} data */
  const log = (type, data) => logEvent(store, SYS, { type, actor: 'system', data }).catch(() => {});
  /** @param {string} type */
  const typeOf = (type) => storageTypes(registry).get(type);

  /** @param {string} id */
  async function target(id) {
    const rec = await getTarget(ws, id);
    if (!rec) throw new TargetError('missing', 'That backup place was removed.');
    return rec;
  }

  /** The error as annai shows and keeps it: a TargetError without any secret annai keeps (spec §9.9). @param {unknown} e @returns {Promise<TargetError>} */
  async function clean(e) {
    const t = e instanceof TargetError ? e : null;
    const message = await withoutSecrets(store, String(/** @type {any} */ (e)?.message ?? e));
    return new TargetError(t?.kind ?? 'other', message, { remote: t?.remote, bytes: t?.bytes, retryAt: t?.retryAt });
  }

  /** @param {unknown} e */
  const stopped = (e) => /** @type {any} */ (e)?.name === 'AbortError';

  /**
   * Calls a place's type. A bug in its code counts against its plugin (spec §5.5); every other
   * error comes back clean.
   * @template T @param {Target} rec @param {string} what @param {(t: StorageType, c: TargetContext) => Promise<T>} fn @returns {Promise<T>}
   */
  async function call(rec, what, fn) {
    const type = typeOf(rec.type);
    if (!type) throw new TargetError('setup', `The plugin for ${rec.name} isn't running. Open this backup place in Settings → Backups to turn it on.`);
    try {
      return await fn(type, { config: { ...rec.config }, secret: await targetSecret(store, rec.id), device: { id: await deviceId(ws), label }, app });
    } catch (e) {
      if (stopped(e)) throw e;
      if (isPluginBug(e)) registry.fail(type.pluginId, `backup ${what}`, e);
      throw await clean(e);
    }
  }

  /** Notes why automatic backups to a place now wait, and returns the error. @param {Target} rec @param {TargetError} e */
  async function hold(rec, e) {
    const at = now();
    /** @type {Hold} */
    let h;
    if (e.kind === 'newer') h = { kind: 'newer', remote: e.remote ?? { id: '', at } };
    else if (e.kind === 'large') h = { kind: 'large', bytes: e.bytes ?? 0, at };
    else {
      const count = rec.hold?.kind === 'error' ? rec.hold.count + 1 : 1;
      h = { kind: 'error', message: e.message, at, count, retryAt: e.retryAt ?? at + retryDelay(count), needsYou: NEEDS_YOU.has(e.kind) };
    }
    await setTarget(ws, rec.id, { hold: h }).catch(() => {});
    if (h.kind === 'newer') await log('backup.newer', { target: rec.id, type: rec.type, remote: h.remote });
    else await log('backup.error', { target: rec.id, type: rec.type, kind: e.kind, message: e.message, ...(h.kind === 'large' ? { bytes: h.bytes } : {}) });
    return e;
  }

  /**
   * Before a whole file is sent: its size against what may go without asking, and the place's
   * newest backup (single writer). A git place checks both in its own put.
   * @param {Target} rec @param {number} bytes @param {string | null} base @param {number} maxUpload @param {string} me
   */
  async function beforeFile(rec, bytes, base, maxUpload, me) {
    if (bytes > maxUpload) throw new TargetError('large', `This backup would upload ${Math.ceil(bytes / 1_000_000)} MB.`, { bytes });
    const [newest] = await call(rec, 'list', (t, c) => t.list(c));
    if (newest && newest.id !== base && newest.device !== me) throw new TargetError('newer', `There is a newer backup at ${rec.name}.`, { remote: newest });
  }

  /**
   * Keeps the last few backups this device made at a whole-file place, deleting older ones;
   * another device's are never touched. A failure here is logged, and the backup still counts.
   * @param {Target} rec @param {string} me
   */
  async function keepLast(rec, me) {
    if (typeof typeOf(rec.type)?.delete !== 'function') return;
    try {
      const own = (await call(rec, 'list', (t, c) => t.list(c))).filter((b) => b.device === me).sort((a, b) => b.at - a.at);
      for (const b of own.slice(Math.max(1, rec.keep ?? 3))) {
        await call(rec, 'delete', (t, c) => /** @type {NonNullable<StorageType['delete']>} */ (t.delete)(c, b.id));
        await log('backup.prune', { target: rec.id, type: rec.type, backup: b.id });
      }
    } catch (e) {
      await log('backup.error', { target: rec.id, type: rec.type, kind: 'prune', message: String(/** @type {any} */ (e)?.message ?? e) });
    }
  }

  /** @param {string} id @param {{ over?: boolean, maxUpload?: number, reason?: 'auto' | 'user' }} o */
  async function backUpNow(id, { over = false, maxUpload = Infinity, reason = 'user' }) {
    const rec = await target(id);
    const stop = new AbortController();
    running.set(id, { phase: 'building', done: 0, total: 0, stop });
    emit();
    const started = now();
    try {
      const base = over && rec.hold?.kind === 'newer' ? rec.hold.remote.id : rec.last?.id ?? null;
      const file = typeOf(rec.type)?.stores === 'file';
      const me = await deviceId(ws);
      // A whole-file place may keep its backups encrypted, with the API keys when the user chose (spec §12.2).
      const passphrase = file && rec.encrypt ? (await targetSecret(store, id)).passphrase : undefined;
      if (file && rec.encrypt && !passphrase) throw new TargetError('setup', `Type the passphrase for the encrypted backups at ${rec.name}, then save.`);
      const built = await exportArchive(store, {
        kind: 'everything', include: { ...PRESETS.backup }, app, now: Date.now(), ...(passphrase ? { passphrase, secrets: Boolean(rec.keys) } : {}),
      });
      const name = file ? backupFileName({ at: built.manifest.created, label, device: me, encrypted: Boolean(passphrase) }) : built.filename;
      if (file) await beforeFile(rec, built.blob.size, base, maxUpload, me);
      const result = await call(rec, 'put', (t, c) => t.put(c, { blob: built.blob, name, manifest: built.manifest }, {
        base, maxUpload, signal: stop.signal,
        onProgress: (p) => {
          running.set(id, { ...p, stop });
          emit();
        },
      }));
      const at = Number.isFinite(result.at) ? result.at : now();
      await recordBackup(store, built.seqs, at);
      await setTarget(ws, id, { last: { id: result.id, at, seqs: Object.fromEntries(built.seqs), bytes: built.blob.size }, hold: null });
      await log('backup', { target: id, type: rec.type, reason, backup: result.id, files: result.files ?? null, uploaded: result.uploaded ?? built.blob.size, ms: now() - started });
      if (file) await keepLast(rec, me);
      return result;
    } catch (e) {
      if (stopped(e)) throw e;
      throw await hold(rec, e instanceof TargetError ? e : await clean(e));
    } finally {
      running.delete(id);
      emit();
    }
  }

  return {
    label,
    noun,
    /** Every place this device backs up to, oldest first. */
    list: () => listTargets(ws),
    /** @param {string} id */
    get: (id) => getTarget(ws, id),
    typeOf,
    types: () => [...storageTypes(registry).values()],

    /** Adds a place of a kind, installing its plugin when needed (spec §5.3). @param {string} type @returns {Promise<string>} */
    async add(type) {
      try {
        await ensure(type);
      } catch (e) {
        throw await clean(e);
      }
      const t = typeOf(type);
      if (!t) throw new TargetError('setup', "annai couldn't start the plugin for this kind of backup place. Try again.");
      const id = await addTarget(ws, { type, name: t.name });
      emit();
      return id;
    },

    /**
     * Changes a place. Changing where it is or how it signs in means it must pass a test again
     * before automatic backups use it; a passphrase for its encrypted backups doesn't.
     * @param {string} id
     * @param {{ config?: Record<string, string>, secret?: Record<string, string>, auto?: Auto, mobileData?: boolean,
     *   encrypt?: boolean, keys?: boolean, keep?: number, passphrase?: string }} c
     */
    async update(id, { config, secret, auto, mobileData, encrypt, keys, keep, passphrase }) {
      const rec = await target(id);
      const signIn = Boolean(secret && Object.keys(secret).length);
      if (signIn) await setTargetSecret(store, id, /** @type {Record<string, string>} */ (secret));
      if (passphrase !== undefined) await setTargetSecret(store, id, { passphrase });
      const encrypting = encrypt ?? rec.encrypt ?? false;
      const withKeys = encrypt === false ? false : keys ?? rec.keys ?? false;
      if (encrypt !== undefined || keys !== undefined || passphrase !== undefined) {
        if (encrypting && !(await targetSecret(store, id)).passphrase) throw new TargetError('setup', 'Type a passphrase for the encrypted backups, then save.');
        if (withKeys && !encrypting) throw new TargetError('setup', 'API keys go only in encrypted backups: tick "Encrypt backups with a passphrase" first.');
      }
      await setTarget(ws, id, {
        ...(config ? { config: { ...rec.config, ...config } } : {}),
        ...(auto ? { auto } : {}),
        ...(mobileData === undefined ? {} : { mobileData }),
        ...(encrypt === undefined && keys === undefined ? {} : { encrypt: encrypting, keys: withKeys }),
        ...(keep === undefined ? {} : { keep: Math.min(30, Math.max(1, Math.round(Number(keep) || 3))) }),
        ...(config || signIn ? { checked: null } : {}),
      });
      emit();
    },

    /** Forgets a place and its secret; the backups there stay. @param {string} id */
    async remove(id) {
      running.get(id)?.stop.abort();
      await removeTarget(ws, id);
      emit();
    },

    /** Which of a place's secret values are saved: their names, never the values. @param {string} id */
    savedSecrets: async (id) => Object.keys(await targetSecret(store, id)),

    /** Starts the plugin of a place's kind again, on the user's tap. @param {string} id */
    async turnOn(id) {
      try {
        await ensure((await target(id)).type);
      } catch (e) {
        throw await clean(e);
      }
      emit();
    },

    /**
     * Tests a place and looks at what is there. A backup this device hasn't taken in, made by
     * another device, waits for the user's choice (single writer).
     * @param {string} id @returns {Promise<{ note: string, newer: RemoteBackup | null }>}
     */
    async check(id) {
      const rec = await target(id);
      const { note } = await call(rec, 'check', (t, c) => t.check(c));
      const [remote] = await call(rec, 'list', (t, c) => t.list(c));
      const me = await deviceId(ws);
      const unseen = Boolean(remote) && remote.id !== rec.last?.id;
      const newer = unseen && remote.device !== me ? remote : null;
      await setTarget(ws, id, {
        checked: now(),
        // A backup this device made but didn't get to note is the one to build on.
        ...(unseen && !newer ? { last: { id: remote.id, at: remote.at, seqs: {}, bytes: 0 } } : {}),
        // The user is looking at the place's screen, which shows the newer backup: no card for it.
        hold: newer ? { kind: 'newer', remote: newer, seen: true } : rec.hold?.kind === 'large' ? rec.hold : null,
      });
      emit();
      return { note, newer };
    },

    /**
     * Backs up everything to a place now. over: the user chose to back up over the newer backup
     * there. maxUpload: bytes it may send without asking.
     * @param {string} id @param {{ over?: boolean, maxUpload?: number, reason?: 'auto' | 'user' }} [o]
     */
    backUp: (id, o = {}) => serial(() => backUpNow(id, o)),

    /** The backups at a place, newest first. @param {string} id */
    async remote(id) {
      const rec = await target(id);
      return call(rec, 'list', (t, c) => t.list(c));
    },

    /** Downloads one backup from a place, as an archive file for the import screen (spec §12.3). @param {string} id @param {string} backupId */
    download: (id, backupId) => serial(async () => {
      const rec = await target(id);
      const stop = new AbortController();
      running.set(id, { phase: 'downloading', done: 0, total: 0, stop });
      emit();
      try {
        const blob = await call(rec, 'get', (t, c) => t.get(c, backupId, {
          signal: stop.signal,
          onProgress: (p) => {
            running.set(id, { ...p, stop });
            emit();
          },
        }));
        await log('backup.download', { target: id, type: rec.type, backup: backupId, bytes: blob.size });
        return blob;
      } finally {
        running.delete(id);
        emit();
      }
    }),

    /** This device took in a backup from a place: its next backup there builds on that one. @param {string} id @param {RemoteBackup} remote */
    async accept(id, remote) {
      await setTarget(ws, id, { last: { id: remote.id, at: remote.at, seqs: {}, bytes: 0 }, hold: null });
      emit();
    },

    /** Stops the backup or download running for a place. @param {string} id */
    stop(id) {
      running.get(id)?.stop.abort();
    },

    /** @param {string} id @returns {Progress | null} */
    progress(id) {
      const p = running.get(id);
      return p ? { phase: p.phase, done: p.done, total: p.total } : null;
    },

    /** Calls fn whenever a place or its progress changes. @param {() => void} fn */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
