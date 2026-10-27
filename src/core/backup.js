import { exportArchive, checkManifest, PRESETS, archiveWords, ARCHIVE_CODES } from './archive.js';
import { answerWords, ANSWER_CODES } from './answer.js';
import { recordBackup, SYS } from './scopes.js';
import { logEvent } from './events.js';
import { withoutSecrets, withoutSecretsIn, shownWithoutSecrets } from './agent/net.js';
import { isPluginBug } from './plugins.js';
import { storageTypes, TargetError, NEEDS_YOU, backupFileName } from './storage-types.js';
import { listTargets, getTarget, addTarget, setTarget, removeTarget, deviceId, targetSecret, setTargetSecret } from './backup-targets.js';
import { t, lang } from './l10n.js';
import { OFFICIAL_NAMES, STORAGE_NAMES } from './official-names.js';
import { officialName, pluginName } from './llm/official.js';
import { sentences, size } from './intl.js';

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
 * @typedef {{ code: 'plugin-off' | 'passphrase' | 'offline' | 'large' | 'newer', type?: string, noun?: string, bytes?: number }
 *   | import('./answer.js').AnswerSaid | import('./archive.js').ArchiveSaid} Said
 *   one of annai's own errors, as data (a hold keeps it): backup's own (the place's kind, by its type; this device's noun; the upload's
 *   size), a server's
 *   (answer.js: unreachable, or its answer) or an export's (archive.js)
 */

/**
 * One of annai's own backup errors in the screens' words, made from its data: when it is thrown, and again when a hold that keeps it
 * is shown (localization L5f). Its English is the log's. null for a code this annai doesn't know (a later one's): shown as an old hold.
 * @param {Said} s @param {string} [place] the place's name as the screens show it (its kind's, kindNames); else its type
 * @returns {string | null}
 */
export function backupWords(s, place) {
  const name = place ?? ('type' in s ? s.type : '');
  if (ANSWER_CODES.has(s.code)) return sentences(answerWords(/** @type {import('./answer.js').AnswerSaid} */ (s)), t`annai tries again later.`);
  if (ARCHIVE_CODES.has(s.code)) return archiveWords(/** @type {import('./archive.js').ArchiveSaid} */ (s));
  if (s.code === 'plugin-off') return t`The plugin for ${name} isn't running. Open this backup place in Settings → Backups to turn it on.`;
  if (s.code === 'passphrase') return t`Type the passphrase for the encrypted backups at ${name}, then save.`;
  if (s.code === 'large') return t`This backup would upload ${size(s.bytes ?? 0)}.`;
  if (s.code === 'newer') return t`There is a newer backup at ${name}.`;
  if (s.code !== 'offline') return null;
  if (s.noun === 'phone') return t`This phone is offline, so annai couldn't reach this place.`;
  if (s.noun === 'iPad') return t`This iPad is offline, so annai couldn't reach this place.`;
  if (s.noun === 'computer') return t`This computer is offline, so annai couldn't reach this place.`;
  return t`This device is offline, so annai couldn't reach this place.`;
}

/**
 * A kind of backup place by name, which every place is named by (no place has a name of its own): shown, as the screens show it, and
 * english, for the log. The running plugin's (in the screens' words); else the installed plugin that provides it (annai's own by its
 * own translation on the device); else annai's own kind's, from its catalog's words once read; else its type.
 * @param {Registry} registry @param {import('./plugins.js').PluginHost | null} plugins @param {string} type
 * @returns {Promise<{ shown: string, english: string }>}
 */
export async function kindNames(registry, plugins, type) {
  const state = (await plugins?.installed()) ?? {};
  const gives = (/** @type {any} */ p) => [p?.provides?.['storage-type']].flat().includes(type);
  // provides is kept with a record since 43c515f3; one from before is read from its manifest.
  let id = Object.keys(state).find((x) => gives(state[x]));
  for (const x of Object.keys(state)) if (!id && !state[x].provides && gives(await plugins?.manifestOf(x).catch(() => null))) id = x;
  const s = id ? state[id] : null;
  const english = /** @type {Record<string, string>} */ (STORAGE_NAMES)[type] ?? s?.name ?? type;
  const running = storageTypes(registry).get(type)?.name;
  if (running) return { shown: running, english };
  if (id && s) return { shown: await pluginName(/** @type {any} */ (plugins), s, id, s.name), english };
  const own = /** @type {Record<string, string>} */ (OFFICIAL_NAMES['storage-type'])[type];
  return { shown: own ? officialName(own, english) : type, english };
}

/**
 * Why backups to a place stopped, as a screen says it: from what the hold keeps where annai wrote it; a plugin's own words in the
 * screens' language when they were kept in it (a backup can bring the hold to a device in another); else a place's or a plugin's
 * words, and a hold kept before it said what it was, as they were written.
 * @param {{ message: string, said?: Said | null, offline?: boolean, shown?: string, lang?: string }} h
 * @param {string} [place] the place's name as the screens show it (Backups' list and get)
 */
export function holdWords(h, place) {
  const why = (h.said ? backupWords(h.said, place) : null) ?? (h.shown && h.lang === lang() ? h.shown : h.message);
  return h.offline ? sentences(why, t`annai tries again once it's back online.`) : why;
}

/**
 * A hold kept before holds said what they were: one kept now always has said (null for a place's or a plugin's own words), so an
 * older one has neither said nor offline. Its words are the English annai wrote then, which a screen shows as a line of their own,
 * marked English, never inside a sentence of the screens' language. @param {any} h
 */
export const oldHold = (h) => h?.kind === 'error' && ((!('said' in h) && !('offline' in h)) || (h.said && backupWords(h.said) === null));

/**
 * One of annai's own errors, by the shown rule: its English for the log and the hold (message), the screens' words (shown), and what
 * it was (said). @param {ConstructorParameters<typeof TargetError>[0]} kind @param {string} en @param {Said} said
 * @param {ConstructorParameters<typeof TargetError>[2]} [extra]
 */
const own = (kind, en, said, extra) => Object.assign(new TargetError(kind, en, extra), { shown: backupWords(said) ?? en, said });

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
 * @param {{ store: Store, ws: Workspace, registry: Registry, plugins?: import('./plugins.js').PluginHost | null, app: string, label: string, noun?: string,
 *   ensure?: (type: string, o?: { keepOff?: boolean }) => Promise<void>, now?: () => number, online?: () => boolean }} deps
 *   plugins: the plugin host, which names a place whose plugin is installed but not running (kindNames);
 *   label: what this device is called in its backups ("iPhone"); noun: what the user calls it ("phone");
 *   ensure: makes a kind of place available, installing its plugin (spec §5.3); keepOff: one the user turned off stays off;
 *   online: whether the browser says this device has a connection
 */
export function createBackups({ store, ws, registry, plugins = null, app, label, noun = 'device', ensure = async () => {}, now = () => Date.now(), online = () => true }) {
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
        console.warn(/* en */ 'a backup listener failed', e);
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

  /** A place as Backups shows it: named by its kind (kindNames). A name an annai from before stored is never read. @param {Target} rec */
  const named = async (rec) => ({ ...rec, name: (await kindNames(registry, plugins, rec.type)).shown });
  /**
   * One of annai's own errors about a place: its English names the place's kind in English; said keeps only its type, never the
   * screens' words; shown names it as the screens do.
   * @param {Target} rec @param {ConstructorParameters<typeof TargetError>[0]} kind @param {(name: string) => string} en @param {Said} said
   * @param {ConstructorParameters<typeof TargetError>[2]} [extra]
   */
  const about = async (rec, kind, en, said, extra) => {
    const kept = /** @type {Said} */ ({ ...said, type: rec.type });
    const { shown, english } = await kindNames(registry, plugins, rec.type);
    return Object.assign(own(kind, en(english), kept, extra), { shown: backupWords(kept, shown) ?? en(english) });
  };

  /** The place as stored. @param {string} id */
  async function target(id) {
    const rec = await getTarget(ws, id);
    if (!rec) throw Object.assign(new TargetError('missing', /* en */ "That backup place was removed."), { shown: t`That backup place was removed.` });
    return rec;
  }

  /**
   * The error as annai shows and keeps it: a TargetError without any secret annai keeps (spec §9.9), and
   * the choices a place offers (fields left empty) only as settings of its own fields.
   * @param {unknown} e @param {Target} [rec] @returns {Promise<TargetError>}
   */
  async function clean(e, rec) {
    const te = e instanceof TargetError ? e : null;
    const message = await withoutSecrets(store, String(/** @type {any} */ (e)?.message ?? e));
    const choices = rec && Array.isArray(te?.choices)
      ? await withoutSecretsIn(store, te.choices.slice(0, 20).map((c) => ({ label: String(c?.label ?? '').slice(0, 200), config: settingsOf(rec, c?.config) })))
      : undefined;
    const cleaned = new TargetError(te?.kind ?? 'other', message, { remote: te?.remote, bytes: te?.bytes, retryAt: te?.retryAt, ...(choices ? { choices } : {}) });
    // The screens' words and what it was go with it (annai's own errors, an archive's): message stays the English the log keeps.
    const { said } = /** @type {any} */ (e) ?? {};
    const shown = /** @type {any} */ (e)?.shown ?? (said ? backupWords(said) ?? undefined : undefined);
    return Object.assign(cleaned, { ...(typeof shown === 'string' ? { shown: await shownWithoutSecrets(store, shown) } : {}), ...(said ? { said } : {}) });
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
    if (!type) throw await about(rec, 'setup', (name) => /* en */ `The plugin for ${name} isn't running.`, { code: 'plugin-off' });
    // Offline, no place answers, whatever it would guess why (browser access, its address): said so, and tried again once back.
    const offline = () => own('other', /* en */ `This ${noun} is offline.`, { code: 'offline', noun }, { retryAt: now() });
    if (!online()) throw offline();
    try {
      return await fn(type, { config: { ...rec.config }, secret: await targetSecret(store, rec.id), device: { id: await deviceId(ws), label }, app });
    } catch (e) {
      // A stop is a stop, in annai's own words: whatever the plugin's error said may hold a secret.
      if (stopped(e)) throw /* en */ new DOMException('The backup was stopped.', 'AbortError');
      if (!online()) throw offline();
      const cleaned = await clean(e, rec);
      // A bug counts against the plugin (spec §5.5), told without any secret its message echoed.
      const by = registry.owner('storage-type', type.type)?.pluginId; // the plugin that registered it, never a field it carries
      if (isPluginBug(e) && by) registry.fail(by, /* en */ `backup ${what}`, cleaned);
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
      // Offline is no failure of the place's: its count, which the wait after a failure grows with, stays.
      const was = rec.hold?.kind === 'error' ? rec.hold.count : 0;
      const count = online() ? was + 1 : was;
      const { said, shown } = /** @type {any} */ (e);
      h = { kind: 'error', message: e.message, said: said ?? null, ...(online() ? {} : { offline: true }), at, count, retryAt: e.retryAt ?? at + retryDelay(count), needsYou: NEEDS_YOU.has(e.kind),
        // A place's plugin's own words (annai's own say what they were), kept with their language: a screen in another shows its English.
        ...(!said && typeof shown === 'string' && shown !== e.message ? { shown, lang: lang() } : {}) };
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
    if (bytes > maxUpload) throw own('large', /* en */ `This backup would upload ${bytes} bytes.`, { code: 'large', bytes }, { bytes });
    const there = await listed(rec);
    const newer = newerOf(there, rec.last, me, over);
    if (newer) throw Object.assign(await about(rec, 'newer', (name) => /* en */ `There is a newer backup at ${name}.`, { code: 'newer' }, { remote: newer }), { known: knownOf(there) });
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
      if (file && rec.encrypt && !passphrase) throw await about(rec, 'setup', (name) => /* en */ `The passphrase for the encrypted backups at ${name} isn't saved.`, { code: 'passphrase' });
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
    list: async () => Promise.all((await listTargets(ws)).map(named)),
    /** @param {string} id */
    get: async (id) => {
      const rec = await getTarget(ws, id);
      return rec && named(rec);
    },
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
      const kind = typeOf(type);
      if (!kind) throw Object.assign(new TargetError('setup', /* en */ "annai couldn't start the plugin for this kind of backup place. Try again."), { shown: t`annai couldn't start the plugin for this kind of backup place. Try again.` });
      const id = await addTarget(ws, { type });
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
        throw Object.assign(new TargetError('setup', /* en */ "Type a number of megabytes, or leave it empty for no limit."), { shown: t`Type a number of megabytes, or leave it empty for no limit.` });
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
        if (u && (u.username || u.password)) throw Object.assign(new TargetError('setup', /* en */ "Put the user name and the password in their own fields, not in the address."), { shown: t`Put the user name and the password in their own fields, not in the address.` });
      }
      const signIn = Boolean(secret && Object.keys(secret).length);
      const encrypting = encrypt ?? rec.encrypt ?? false;
      const withKeys = encrypt === false ? false : keys ?? rec.keys ?? false;
      // Checked before anything is kept: a change that fails keeps no new sign-in or passphrase (minors 25).
      if (encrypt !== undefined || keys !== undefined || passphrase !== undefined) {
        const hasPassphrase = passphrase !== undefined ? Boolean(passphrase) : Boolean((await targetSecret(store, id)).passphrase);
        if (encrypting && !hasPassphrase) throw Object.assign(new TargetError('setup', /* en */ "Type a passphrase for the encrypted backups, then save."), { shown: t`Type a passphrase for the encrypted backups, then save.` });
        if (withKeys && !encrypting) throw Object.assign(new TargetError('setup', /* en */ 'API keys go only in encrypted backups: tick "Encrypt backups with a passphrase" first.'), { shown: t`API keys go only in encrypted backups: tick "Encrypt backups with a passphrase" first.` });
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
      const note = await shownWithoutSecrets(store, String(said?.note ?? t`Works.`));
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

    /**
     * What one backup holds, from its manifest alone, for a place whose type can peek (storage-types.js): the import screen previews
     * with it, and calls download when the user imports. Null for a place that can't. It reads nothing else, so an automatic
     * backup running isn't in its way. @param {string} id @param {string} backupId @param {{ signal?: AbortSignal }} [o]
     */
    async peek(id, backupId, o = {}) {
      const rec = await target(id);
      const type = typeOf(rec.type);
      // Only a place that keeps the unpacked tree: a whole archive file may be encrypted, and its preview needs the passphrase form.
      if (type?.stores !== 'tree' || typeof type.peek !== 'function') return null;
      const manifest = await call(rec, 'peek', (t, c) => /** @type {NonNullable<StorageType['peek']>} */ (t.peek)(c, backupId, { signal: o.signal }));
      try {
        checkManifest(manifest);
      } catch (e) {
        // What is wrong with it goes to the Trace; the screen says it in a few plain words.
        const why = String(/** @type {any} */ (e)?.message ?? e);
        await log('backup.peek', { target: id, type: rec.type, backup: backupId, problem: (await withoutSecrets(store, why)).slice(0, 500) });
        if (/** @type {any} */ (e)?.newer) throw Object.assign(new TargetError('other', /* en */ "This backup was made by a newer annai: update annai first."), { shown: t`This backup was made by a newer annai: update annai first.` });
        throw Object.assign(new TargetError('other', /* en */ "This backup is damaged."), { shown: t`This backup is damaged.` });
      }
      return manifest;
    },

    /**
     * Downloads one backup from a place, as an archive file for the import screen (spec §12.3). signal: the user left or cancelled; a
     * download still waiting its turn then never reaches the place, and one under way stops it.
     * @param {string} id @param {string} backupId @param {{ signal?: AbortSignal }} [o]
     */
    download: (id, backupId, { signal } = {}) => {
      // The user is waiting for this: an automatic backup in its way stops, and carries on later as usual.
      for (const p of running.values()) if (p.reason === 'auto') p.stop.abort();
      const stopped = () => /* en */ new DOMException('The backup was stopped.', 'AbortError');
      return serial(async () => {
        if (signal?.aborted) throw stopped();
        const rec = await target(id);
        // A cancel that came while the place's record was read has no listener to reach: look again, then listen, with nothing between.
        if (signal?.aborted) throw stopped();
        const stop = new AbortController();
        const forward = () => stop.abort();
        signal?.addEventListener('abort', forward, { once: true });
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
          // A cancel as the download ends throws the backup away, and the trace says so.
          const cut = Boolean(signal?.aborted);
          await log('backup.download', { target: id, type: rec.type, backup: backupId, bytes: blob.size, ...(cut ? { stopped: true } : {}) });
          if (cut) throw stopped();
          return blob;
        } finally {
          signal?.removeEventListener('abort', forward);
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
