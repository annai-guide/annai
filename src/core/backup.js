import { exportArchive, PRESETS } from './archive.js';
import { recordBackup, SYS } from './scopes.js';
import { logEvent } from './events.js';
import { withoutSecrets, withoutSecretsIn } from './agent/net.js';
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

/** The newest time of each device's backups in a listing, by that device's own clock (minors 23). @param {RemoteBackup[]} listed @returns {Record<string, number>} */
function knownOf(listed) {
  /** @type {Record<string, number>} */
  const out = Object.create(null);
  for (const b of listed) out[b.device ?? ''] = Math.max(out[b.device ?? ''] ?? 0, b.at);
  return out;
}

/**
 * The newest backup another device made after the one this device builds on, or null (single writer).
 * Each listed is checked against the newest of its device's seen here (last.known), by that device's
 * clock: one behind is still seen, one never seen is newer (minors 23). An older record knows its base's time.
 * @param {RemoteBackup[]} listed newest first @param {import('./backup-targets.js').LastBackup | null | undefined} last
 * @param {string} me @param {{ remote: RemoteBackup, known?: Record<string, number> } | null} [over] the hold the user backs
 *   up over, which covers every device listed with it (fix pass R1)
 */
function newerOf(listed, last, me, over = null) {
  const on = over?.remote ?? last;
  /** @type {Record<string, number>} */
  const known = Object.assign(Object.create(null), last?.known);
  if (over) for (const [d, at] of [...Object.entries(over.known ?? {}), [over.remote.device ?? '', over.remote.at]]) known[d] = Math.max(known[d] ?? 0, Number(at) || 0);
  const unknown = last && !last.known ? on?.at ?? -1 : -1;
  return listed.find((b) => b.device !== me && b.id !== on?.id && b.at > (known[b.device ?? ''] ?? unknown)) ?? null;
}

/** How long annai waits after the count-th failure in a row before trying a place again: 15 minutes, doubling up to 6 hours. @param {number} count */
export function retryDelay(count) {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, count - 1), 6 * 3_600_000);
}

/**
 * @param {{ store: Store, ws: Workspace, registry: Registry, app: string, label: string, noun?: string,
 *   ensure?: (type: string, o?: { keepOff?: boolean }) => Promise<void>, now?: () => number }} deps
 *   label: what this device is called in its backups ("iPhone"); noun: what the user calls it ("phone");
 *   ensure: makes a kind of place available, installing its plugin (spec §5.3); keepOff: one the user turned off stays off
 */
export function createBackups({ store, ws, registry, app, label, noun = 'device', ensure = async () => {}, now = () => Date.now() }) {
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, Progress & { stop: AbortController, reason: 'auto' | 'user' | 'download' }>} */
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
  /** Whether a place keeps whole archive files. @param {Target} rec */
  const whole = (rec) => typeOf(rec.type)?.stores === 'file';

  /** @param {string} id */
  async function target(id) {
    const rec = await getTarget(ws, id);
    if (!rec) throw new TargetError('missing', 'That backup place was removed.');
    return rec;
  }

  /**
   * The error as annai shows and keeps it: a TargetError without any secret annai keeps (spec §9.9), and
   * the choices a place offers (fields left empty) only as settings of its own fields.
   * @param {unknown} e @param {Target} [rec] @returns {Promise<TargetError>}
   */
  async function clean(e, rec) {
    const t = e instanceof TargetError ? e : null;
    const message = await withoutSecrets(store, String(/** @type {any} */ (e)?.message ?? e));
    const choices = rec && Array.isArray(t?.choices)
      ? await withoutSecretsIn(store, t.choices.slice(0, 20).map((c) => ({ label: String(c?.label ?? '').slice(0, 200), config: settingsOf(rec, c?.config) })))
      : undefined;
    return new TargetError(t?.kind ?? 'other', message, { remote: t?.remote, bytes: t?.bytes, retryAt: t?.retryAt, ...(choices ? { choices } : {}) });
  }

  /** What a place filled in for fields left empty, or offers: text values of its own fields. @param {Target} rec @param {unknown} config @returns {Record<string, string>} */
  function settingsOf(rec, config) {
    const keys = new Set((typeOf(rec.type)?.fields ?? []).map((f) => f.key));
    /** @type {Record<string, string>} */
    const out = {};
    if (config && typeof config === 'object') for (const [k, v] of Object.entries(config)) if (keys.has(k) && typeof v === 'string' && v.length <= 200) out[k] = v;
    return out;
  }

  /** @param {unknown} e */
  const stopped = (e) => /** @type {any} */ (e)?.name === 'AbortError';

  /**
   * A backup a place listed, as annai keeps and shows it: only what it needs, and no secret, since
   * its words come from the place (a commit message, a file name).
   * @param {any} r @returns {Promise<RemoteBackup>}
   */
  async function keptRemote(r) {
    return withoutSecretsIn(store, {
      id: String(r?.id ?? ''), at: Number.isFinite(r?.at) ? r.at : 0,
      ...(typeof r?.device === 'string' ? { device: r.device.slice(0, 64) } : {}),
      ...(typeof r?.label === 'string' ? { label: r.label.slice(0, 40) } : {}),
      ...(typeof r?.encrypted === 'boolean' ? { encrypted: r.encrypted } : {}),
    });
  }

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
      // A stop is a stop, in annai's own words: whatever the plugin's error said may hold a secret.
      if (stopped(e)) throw new DOMException('The backup was stopped.', 'AbortError');
      const cleaned = await clean(e, rec);
      // A bug counts against the plugin (spec §5.5), told without any secret its message echoed.
      if (isPluginBug(e)) registry.fail(type.pluginId, `backup ${what}`, cleaned);
      throw cleaned;
    }
  }

  /** Notes why automatic backups to a place now wait, and returns the error. @param {Target} rec @param {TargetError} e */
  async function hold(rec, e) {
    const at = now();
    /** @type {Hold} */
    let h;
    if (e.kind === 'newer') {
      const known = /** @type {any} */ (e).known;
      h = { kind: 'newer', remote: await keptRemote(e.remote ?? { id: '', at }), ...(known ? { known } : {}) };
    }
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

  /** What a place lists, as annai keeps it. @param {Target} rec */
  async function listed(rec) {
    const got = await call(rec, 'list', (t, c) => t.list(c));
    return Promise.all((Array.isArray(got) ? got : []).map(keptRemote));
  }

  /**
   * Before a whole file is sent: its size against what may go without asking, and every backup the
   * place lists (single writer); what it lists, for the record. A newer one is held with what was listed
   * with it. A git place checks both in its own put.
   * @param {Target} rec @param {number} bytes @param {Extract<Hold, { kind: 'newer' }> | null} over @param {number} maxUpload @param {string} me
   */
  async function beforeFile(rec, bytes, over, maxUpload, me) {
    if (bytes > maxUpload) throw new TargetError('large', `This backup would upload ${Math.ceil(bytes / 1_000_000)} MB.`, { bytes });
    const there = await listed(rec);
    const newer = newerOf(there, rec.last, me, over);
    if (newer) throw Object.assign(new TargetError('newer', `There is a newer backup at ${rec.name}.`, { remote: newer }), { known: knownOf(there) });
    return there;
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
      await log('backup.error', { target: rec.id, type: rec.type, kind: 'prune', message: (await clean(e)).message });
    }
  }

  /** @param {string} id @param {{ over?: boolean, maxUpload?: number, reason?: 'auto' | 'user' }} o */
  async function backUpNow(id, { over = false, maxUpload = Infinity, reason = 'user' }) {
    const rec = await target(id);
    const stop = new AbortController();
    running.set(id, { phase: 'building', done: 0, total: 0, stop, reason });
    emit();
    const started = now();
    try {
      const overHold = over && rec.hold?.kind === 'newer' ? rec.hold : null;
      const base = overHold?.remote.id ?? rec.last?.id ?? null;
      const file = whole(rec);
      const me = await deviceId(ws);
      // A whole-file place may keep its backups encrypted, with the API keys when the user chose (spec §12.2).
      const passphrase = file && rec.encrypt ? (await targetSecret(store, id)).passphrase : undefined;
      if (file && rec.encrypt && !passphrase) throw new TargetError('setup', `Type the passphrase for the encrypted backups at ${rec.name}, then save.`);
      const built = await exportArchive(store, {
        kind: 'everything', include: { ...PRESETS.backup }, app, now: Date.now(), ...(passphrase ? { passphrase, secrets: Boolean(rec.keys) } : {}),
      });
      const name = file ? backupFileName({ at: built.manifest.created, label, device: me, encrypted: Boolean(passphrase) }) : built.filename;
      const there = file ? await beforeFile(rec, built.blob.size, overHold, maxUpload, me) : null;
      const result = await call(rec, 'put', (t, c) => t.put(c, { blob: built.blob, name, manifest: built.manifest }, {
        base, maxUpload, signal: stop.signal,
        onProgress: (p) => {
          running.set(id, { ...p, stop, reason });
          emit();
        },
      }));
      const at = Number.isFinite(result?.at) ? result.at : now();
      const made = await keptRemote({ id: result?.id, at });
      await recordBackup(store, built.seqs, at);
      await setTarget(ws, id, { last: { id: made.id, at, seqs: Object.fromEntries(built.seqs), bytes: built.blob.size, ...(there ? { known: knownOf(there) } : {}) }, hold: null });
      await log('backup', { target: id, type: rec.type, reason, backup: made.id, files: Number.isFinite(result?.files) ? result.files : null, uploaded: Number.isFinite(result?.uploaded) ? result.uploaded : built.blob.size, ms: now() - started });
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

    /**
     * Adds a place of a kind, installing its plugin when needed (spec §5.3). A plugin the user turned off
     * stays off, and the words say so (fix pass): the place's Turn it on is the tap for that.
     * @param {string} type @returns {Promise<string>}
     */
    async add(type) {
      try {
        await ensure(type, { keepOff: true });
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
     *   encrypt?: boolean, keys?: boolean, keep?: number, passphrase?: string, askAbove?: number | null }} c
     *   askAbove: bytes an automatic backup may upload without asking where the browser can't name the connection; null for no limit
     */
    async update(id, { config, secret, auto, mobileData, encrypt, keys, keep, passphrase, askAbove }) {
      const rec = await target(id);
      if (askAbove !== undefined && askAbove !== null && !(Number.isFinite(askAbove) && askAbove >= 0)) {
        throw new TargetError('setup', 'Type a number of megabytes, or leave it empty for no limit.');
      }
      // An address with a user name and password in it would keep them in the place's record.
      for (const v of Object.values(config ?? {})) {
        /** @type {URL | null} */
        let u = null;
        try {
          u = new URL(String(v));
        } catch {
          // not an address
        }
        if (u && (u.username || u.password)) throw new TargetError('setup', 'Put the user name and the password in their own fields, not in the address.');
      }
      const signIn = Boolean(secret && Object.keys(secret).length);
      const encrypting = encrypt ?? rec.encrypt ?? false;
      const withKeys = encrypt === false ? false : keys ?? rec.keys ?? false;
      // Checked before anything is kept: a change that fails keeps no new sign-in or passphrase (minors 25).
      if (encrypt !== undefined || keys !== undefined || passphrase !== undefined) {
        const hasPassphrase = passphrase !== undefined ? Boolean(passphrase) : Boolean((await targetSecret(store, id)).passphrase);
        if (encrypting && !hasPassphrase) throw new TargetError('setup', 'Type a passphrase for the encrypted backups, then save.');
        if (withKeys && !encrypting) throw new TargetError('setup', 'API keys go only in encrypted backups: tick "Encrypt backups with a passphrase" first.');
      }
      if (signIn) await setTargetSecret(store, id, /** @type {Record<string, string>} */ (secret));
      if (passphrase !== undefined) await setTargetSecret(store, id, { passphrase });
      await setTarget(ws, id, {
        ...(config ? { config: { ...rec.config, ...config } } : {}),
        ...(auto ? { auto } : {}),
        ...(mobileData === undefined ? {} : { mobileData }),
        ...(askAbove === undefined ? {} : { askAbove: askAbove === null ? null : Math.round(askAbove) }),
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
      let rec = await target(id);
      const said = await call(rec, 'check', (t, c) => t.check(c));
      const note = await withoutSecrets(store, String(said?.note ?? 'Works.'));
      // What the place filled in for fields left empty is the place's own from now on: later backups don't look again.
      const filled = settingsOf(rec, said?.config);
      if (Object.keys(filled).length) rec = await setTarget(ws, id, { config: { ...rec.config, ...filled } });
      const there = await listed(rec);
      const me = await deviceId(ws);
      const newer = newerOf(there, rec.last, me);
      const [remote] = there;
      // A backup this device made but didn't get to note is the one to build on.
      const mine = !newer && remote && remote.id !== rec.last?.id && remote.device === me ? remote : null;
      // What is there, seen: kept as the base's, or with the hold (fix pass R1); a git place keeps none.
      const known = whole(rec) ? { known: knownOf(there) } : {};
      await setTarget(ws, id, {
        checked: now(),
        ...(mine ? { last: { id: mine.id, at: mine.at, seqs: {}, bytes: 0, ...known } } : !newer && rec.last ? { last: { ...rec.last, ...known } } : {}),
        // The user is looking at the place's screen, which shows the newer backup: no card for it.
        hold: newer ? { kind: 'newer', remote: newer, seen: true, ...known } : rec.hold?.kind === 'large' ? rec.hold : null,
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
      return listed(await target(id));
    },

    /** Downloads one backup from a place, as an archive file for the import screen (spec §12.3). @param {string} id @param {string} backupId */
    download: (id, backupId) => {
      // The user is waiting for this: an automatic backup in its way stops, and carries on later as usual.
      for (const p of running.values()) if (p.reason === 'auto') p.stop.abort();
      return serial(async () => {
        const rec = await target(id);
        const stop = new AbortController();
        running.set(id, { phase: 'downloading', done: 0, total: 0, stop, reason: 'download' });
        emit();
        try {
          const blob = await call(rec, 'get', (t, c) => t.get(c, backupId, {
            signal: stop.signal,
            onProgress: (p) => {
              running.set(id, { ...p, stop, reason: 'download' });
              emit();
            },
          }));
          await log('backup.download', { target: id, type: rec.type, backup: backupId, bytes: blob.size });
          return blob;
        } finally {
          running.delete(id);
          emit();
        }
      });
    },

    /** This device took in a backup from a place: its next backup there builds on that one. @param {string} id @param {RemoteBackup} remote */
    async accept(id, remote) {
      const rec = await target(id);
      const had = rec.last?.known ?? {};
      const known = whole(rec) ? { known: { ...had, [remote.device ?? '']: Math.max(had[remote.device ?? ''] ?? 0, remote.at) } } : {};
      await setTarget(ws, id, { last: { id: remote.id, at: remote.at, seqs: {}, bytes: 0, ...known }, hold: null });
      emit();
    },

    /** Stops the backup or download running for a place. @param {string} id */
    stop(id) {
      running.get(id)?.stop.abort();
    },

    /** What runs now: a backup (automatic or the user's) or a download, by place. */
    running: () => [...running].map(([id, p]) => ({ id, reason: p.reason, phase: p.phase })),

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
