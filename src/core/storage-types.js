/**
 * Kinds of backup places are storage types that plugins add (spec §5.4 storage, §12.4):
 * archive-level check, list, put and get, and delete where a place keeps whole archive files.
 * annai builds each backup and decides when; a type only moves it. Its functions are called
 * without `this`.
 *
 * stores: "tree" keeps the archive's files (git: one backup is one commit, and only changed files
 * are uploaded); "file" keeps the archive file itself.
 * fields and secret: what the user fills in for a place; secret values live in secrets, never in files.
 * where(config): the place in a few words ("you/annai-backup").
 * check(c) may fill in fields the user left empty: its config, which annai keeps as the place's own; or refuse
 * with TargetError "setup" and choices, each a label and the fields it fills in, for the user to pick one.
 * put(c, archive, o) refuses with TargetError "newer" when the place's newest backup is neither
 * o.base nor one this device made (c.device.id), and with "large" before uploading anything when it
 * would send more than o.maxUpload bytes.
 * peek(c, id, o) is optional, for a place that stores a "tree" and can tell what a backup holds without sending it: it
 * returns the backup's annai-archive.json (parsed) alone, in a few requests however many files the backup has (Forgejo: two,
 * GitHub: one). annai previews a backup with it, and calls get only when the user imports; a place without it
 * gets the whole backup first. get still brings every file, and its archive must carry the manifest peek returned (annai refuses
 * the backup if it does not); annai checks each file against that manifest's hash as it imports. Anything but a function is no peek.
 *
 * @typedef {import('./backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {{ key: string, label: string, placeholder?: string, advanced?: boolean }} Field
 * @typedef {{ label: string, config: Record<string, string> }} Choice  one of several a place found for fields left empty
 * @typedef {{ config: Record<string, string>, secret: Record<string, string>, device: { id: string, label: string }, app: string }} TargetContext
 * @typedef {{ phase: 'building'|'checking'|'uploading'|'downloading', done: number, total: number }} Progress
 * @typedef {{ blob: Blob, name: string, manifest: any }} Archive
 * @typedef {{ base: string | null, maxUpload: number, signal?: AbortSignal, onProgress: (p: Progress) => void }} PutOptions
 * @typedef {{ type: string, name: string, stores: 'tree' | 'file', fields: Field[], secret: Field[], help?: string, helpUrl?: string, helpLabel?: string,
 *   where: (config: Record<string, string>) => string,
 *   check: (c: TargetContext) => Promise<{ note: string, config?: Record<string, string> }>,
 *   list: (c: TargetContext) => Promise<RemoteBackup[]>,
 *   put: (c: TargetContext, archive: Archive, o: PutOptions) => Promise<{ id: string, at: number, uploaded?: number, files?: number }>,
 *   get: (c: TargetContext, id: string, o: { signal?: AbortSignal, onProgress: (p: Progress) => void }) => Promise<Blob>,
 *   peek?: (c: TargetContext, id: string, o: { signal?: AbortSignal }) => Promise<unknown>,
 *   delete?: (c: TargetContext, id: string) => Promise<void>, browserAccess?: (origin: string) => { text: string, code: string },
 *   pluginId: string }} StorageType
 *   browserAccess: what the place must allow for annai at this origin, shown on its screen
 */

/** Why a backup place said no, in plain words, with what annai needs to act on it. */
export class TargetError extends Error {
  /**
   * @param {'newer'|'large'|'rate'|'auth'|'refused'|'missing'|'setup'|'other'} kind
   * @param {string} message what happened and what to do next
   * @param {{ remote?: RemoteBackup, bytes?: number, retryAt?: number, choices?: Choice[], shown?: string }} [extra]
   *   remote: the newer backup ("newer"); bytes: what the upload would be ("large"); retryAt: when to try again ("rate");
   *   choices: what the user may pick from, for a field left empty ("setup"); shown: the screens' words, message staying English
   *   for the log and a hold (the shown rule; a plugin's annai.l10n.both gives both)
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'TargetError';
    this.kind = kind;
    this.shown = extra.shown;
    this.remote = extra.remote;
    this.bytes = extra.bytes;
    this.retryAt = extra.retryAt;
    this.choices = extra.choices;
  }
}

/** Failures only the user can fix, so a card says so (spec §17 rule 3). */
export const NEEDS_YOU = new Set(['auth', 'refused', 'missing', 'setup']);

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;

/** What is wrong with a storage type a plugin registers, or null. @param {any} t @returns {string | null} */
export function checkStorageType(t) {
  if (typeof t?.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.type)) {
    /* en */ return 'a kind of backup place needs a "type" id of lowercase letters, digits and dashes';
  }
  /* en */ const named = `the kind of backup place "${t.type}"`;
  if (typeof t.name !== 'string' || !t.name.trim()) /* en */ return `${named} needs a name`;
  if (t.stores !== 'tree' && t.stores !== 'file') /* en */ return `${named} must say whether it stores a "tree" of files or the archive "file"`;
  for (const f of ['where', 'check', 'list', 'put', 'get']) if (typeof t[f] !== 'function') return `${named} needs ${f}()`;
  if (t.delete !== undefined && typeof t.delete !== 'function') /* en */ return `${named} has a delete that isn't a function`;
  for (const list of [t.fields ?? [], t.secret ?? []]) {
    if (!Array.isArray(list) || list.some((f) => !FIELD_KEY.test(f?.key ?? '') || typeof f.label !== 'string')) /* en */ return `${named} has a field without a key or a label`;
  }
  return null;
}

/** The kinds of backup places running plugins provide, by type id: each type's owner, annai's own first, then by install time. @param {import('./registry.js').Registry} registry @returns {Map<string, StorageType>} */
export function storageTypes(registry) {
  return new Map(registry.list('storage-type').map((t) => [t.type, t]));
}

/** The kinds of device annai backs up from, by the word in a whole-file backup's name. @type {Record<string, string>} */
/* en */ const KINDS = { iphone: 'iPhone', ipad: 'iPad', 'android-phone': 'Android phone', computer: 'computer' };

/**
 * The name of a whole-file backup (stores: "file"): when it was made (UTC, to the millisecond), the
 * kind of device and the device's id, and whether it is encrypted (spec §12.2: ".annai" encrypted,
 * ".annai.zip" plain): "annai-backup-20261016T180405123Z-iphone-<device id>.annai.zip".
 * @param {{ at: number, label: string, device: string, encrypted: boolean }} b
 */
export function backupFileName({ at, label, device, encrypted }) {
  const stamp = new Date(at).toISOString().replace(/[-:.]/g, '');
  const kind = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
  /* en */ return `annai-backup-${stamp}-${kind}-${device}${encrypted ? '.annai' : '.annai.zip'}`;
}

/** A whole-file backup as annai lists it, from its name; null for any other file. @param {string} name @returns {(RemoteBackup & { encrypted: boolean }) | null} */
export function parseBackupFileName(name) {
  const m = /^annai-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([a-z0-9-]+?)-([0-9a-z]{8,})\.annai(\.zip)?$/.exec(name);
  if (!m) return null;
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  return { id: name, at, device: m[9], label: KINDS[m[8]] ?? m[8].replace(/-/g, ' '), encrypted: !m[10] };
}

/** The most annai reads of a server's answer as text or JSON. An archive's download has no such limit. */
export const TEXT_MAX = 8 * 1024 * 1024;

/**
 * Reads a server's answer for a storage plugin. Whatever is wrong with the answer (cut off, not
 * JSON, too large) is the server's doing, so it is a TargetError, never a crash in the plugin's code:
 * only real bugs count against a plugin (spec §5.5), and a broken or hostile server mustn't switch
 * backups off.
 * @param {Response} res @param {'json' | 'text' | 'bytes' | 'blob' | 'arrayBuffer'} how
 *   bytes: a Uint8Array, at most max of them; blob and arrayBuffer: a whole download, such as an archive
 * @param {string} where the server, in a few words ("GitHub", "the bucket")
 * @param {{ max?: number }} [o] max: the most bytes read as text, JSON or bytes
 * @returns {Promise<any>}
 */
export async function readAnswer(res, how, where, { max = TEXT_MAX } = {}) {
  // What it was goes with it (said, answer.js's vocabulary): a hold keeps it, and the screens make its words.
  const mb = Math.round(max / 1048576);
  const tooLarge = () => Object.assign(new TargetError('other', /* en */ `${where} sent an answer larger than annai reads (${mb} MB). annai tries again later.`), { said: { code: 'too-much', where, mb } });
  try {
    if (how === 'blob') return await res.blob();
    if (how === 'arrayBuffer') return await res.arrayBuffer();
    if (Number(res.headers.get('content-length')) > max) {
      res.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    /** @type {Uint8Array[]} */
    const chunks = [];
    let n = 0;
    const reader = res.body?.getReader();
    for (;;) {
      const step = reader ? await reader.read() : { done: true, value: undefined };
      if (step.done || !step.value) break;
      n += step.value.byteLength;
      if (n > max) {
        await reader?.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(step.value);
    }
    const bytes = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    if (how === 'bytes') return bytes;
    const text = new TextDecoder().decode(bytes);
    if (how === 'text') return text;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new TargetError('other', /* en */ `${where} answered something annai can't read. annai tries again later.`), { said: { code: 'unreadable', where } });
    }
  } catch (e) {
    if (e instanceof TargetError || /** @type {any} */ (e)?.name === 'AbortError') throw e;
    throw Object.assign(new TargetError('other', /* en */ `The connection to ${where} broke while annai read its answer. annai tries again later.`), { said: { code: 'cut', where } });
  }
}
