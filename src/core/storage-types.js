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
 * put(c, archive, o) refuses with TargetError "newer" when the place's newest backup is neither
 * o.base nor one this device made (c.device.id), and with "large" before uploading anything when it
 * would send more than o.maxUpload bytes.
 *
 * @typedef {import('./backup-targets.js').RemoteBackup} RemoteBackup
 * @typedef {{ key: string, label: string, placeholder?: string, advanced?: boolean }} Field
 * @typedef {{ config: Record<string, string>, secret: Record<string, string>, device: { id: string, label: string }, app: string }} TargetContext
 * @typedef {{ phase: 'building'|'checking'|'uploading'|'downloading', done: number, total: number }} Progress
 * @typedef {{ blob: Blob, name: string, manifest: any }} Archive
 * @typedef {{ base: string | null, maxUpload: number, signal?: AbortSignal, onProgress: (p: Progress) => void }} PutOptions
 * @typedef {{ type: string, name: string, stores: 'tree' | 'file', fields: Field[], secret: Field[], help?: string, helpUrl?: string, helpLabel?: string,
 *   where: (config: Record<string, string>) => string,
 *   check: (c: TargetContext) => Promise<{ note: string }>,
 *   list: (c: TargetContext) => Promise<RemoteBackup[]>,
 *   put: (c: TargetContext, archive: Archive, o: PutOptions) => Promise<{ id: string, at: number, uploaded?: number, files?: number }>,
 *   get: (c: TargetContext, id: string, o: { signal?: AbortSignal, onProgress: (p: Progress) => void }) => Promise<Blob>,
 *   delete?: (c: TargetContext, id: string) => Promise<void>, pluginId: string }} StorageType
 */

/** Why a backup place said no, in plain words, with what annai needs to act on it. */
export class TargetError extends Error {
  /**
   * @param {'newer'|'large'|'rate'|'auth'|'refused'|'missing'|'setup'|'other'} kind
   * @param {string} message what happened and what to do next
   * @param {{ remote?: RemoteBackup, bytes?: number, retryAt?: number }} [extra]
   *   remote: the newer backup ("newer"); bytes: what the upload would be ("large"); retryAt: when to try again ("rate")
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'TargetError';
    this.kind = kind;
    this.remote = extra.remote;
    this.bytes = extra.bytes;
    this.retryAt = extra.retryAt;
  }
}

/** Failures only the user can fix, so a card says so (spec §17 rule 3). */
export const NEEDS_YOU = new Set(['auth', 'refused', 'missing', 'setup']);

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/;

/** What is wrong with a storage type a plugin registers, or null. @param {any} t @returns {string | null} */
export function checkStorageType(t) {
  if (typeof t?.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.type)) {
    return 'a kind of backup place needs a "type" id of lowercase letters, digits and dashes';
  }
  const named = `the kind of backup place "${t.type}"`;
  if (typeof t.name !== 'string' || !t.name.trim()) return `${named} needs a name`;
  if (t.stores !== 'tree' && t.stores !== 'file') return `${named} must say whether it stores a "tree" of files or the archive "file"`;
  for (const f of ['where', 'check', 'list', 'put', 'get']) if (typeof t[f] !== 'function') return `${named} needs ${f}()`;
  if (t.delete !== undefined && typeof t.delete !== 'function') return `${named} has a delete that isn't a function`;
  for (const list of [t.fields ?? [], t.secret ?? []]) {
    if (!Array.isArray(list) || list.some((f) => !FIELD_KEY.test(f?.key ?? '') || typeof f.label !== 'string')) return `${named} has a field without a key or a label`;
  }
  return null;
}

/** The kinds of backup places running plugins provide, by type id (the first one wins). @param {import('./registry.js').Registry} registry @returns {Map<string, StorageType>} */
export function storageTypes(registry) {
  /** @type {Map<string, StorageType>} */
  const out = new Map();
  for (const t of registry.list('storage-type')) if (!out.has(t.type)) out.set(t.type, t);
  return out;
}
