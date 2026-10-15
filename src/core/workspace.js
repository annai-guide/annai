import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { normPath, normPrefix, typeForPath } from './paths.js';
import { mergePatch } from './patch.js';
import { validate } from './schema.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Tx} Tx
 * @typedef {import('./types.js').FileEntry} FileEntry
 * @typedef {{ author: string, type?: string, source?: string }} WriteOptions
 * @typedef {{ op: 'write'|'delete', scope: string, path: string, entry?: FileEntry }} Change
 */

export class ValidationError extends Error {
  /** @param {string} path @param {string[]} errors */
  constructor(path, errors) {
    super(`${path} isn't valid: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.path = path;
    this.errors = errors;
  }
}

export class NotFoundError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`${what} doesn't exist`);
    this.name = 'NotFoundError';
  }
}

export class StorageFullError extends Error {
  constructor() {
    super("annai's storage on this device is full. Export a backup, then delete photos or old trips to make room.");
    this.name = 'StorageFullError';
  }
}

/**
 * Files inside scopes, with full history. Every change is one transaction that
 * stores the content blob, points the path at it, and appends a file.write or
 * file.delete event (spec §4.2). Changes to one path run one at a time.
 */
export class Workspace {
  /** @type {Map<string, Promise<unknown>>} */
  #locks = new Map();
  /** @type {Set<(c: Change) => unknown>} */
  #listeners = new Set();

  /**
   * @param {Store} store
   * @param {{ schemaFor?: (scope: string, path: string) => any, now?: () => number }} [opts]
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.schemaFor = opts.schemaFor ?? (() => null);
    this.now = opts.now ?? (() => Date.now());
  }

  /** Calls fn after every committed write or delete. Listener errors are reported, never thrown. */
  onChange(/** @type {(c: Change) => unknown} */ fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {string} scope @param {string} path */
  async read(scope, path) {
    const p = normPath(path);
    return this.store.tx(['files', 'blobs'], 'readonly', async (t) => {
      const entry = await t.getFile(scope, p);
      if (!entry) return undefined;
      const blob = await t.getBlob(entry.hash);
      if (!blob) throw new Error(`the content of ${p} is missing from storage`);
      return { entry, bytes: new Uint8Array(blob.data) };
    });
  }

  /** @param {string} scope @param {string} path */
  async readText(scope, path) {
    const r = await this.read(scope, path);
    return r && text(r.bytes);
  }

  /** @param {string} scope @param {string} path */
  async readJSON(scope, path) {
    const s = await this.readText(scope, path);
    return s === undefined ? undefined : JSON.parse(s);
  }

  /** @param {string} scope @param {string} [prefix] */
  async list(scope, prefix = '/') {
    const p = normPrefix(prefix);
    return this.store.tx(['files'], 'readonly', (t) => t.listFiles(scope, p));
  }

  /**
   * Strings and bytes are stored as they are; any other value is stored as pretty JSON.
   * @param {string} scope @param {string} path
   * @param {string | Uint8Array | ArrayBuffer | object} content
   * @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async write(scope, path, content, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, () => this.#write(scope, p, content, opts));
  }

  /**
   * Applies a JSON Merge Patch to a JSON file.
   * @param {string} scope @param {string} path @param {any} changes @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async patch(scope, path, changes, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const current = await this.readJSON(scope, p);
      if (current === undefined) throw new NotFoundError(p);
      return this.#write(scope, p, mergePatch(current, changes), opts);
    });
  }

  /** @param {string} scope @param {string} path @param {WriteOptions} opts */
  async delete(scope, path, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const now = this.now();
      await guardStorage(this.store.tx(['files', 'events', 'scopes'], 'readwrite', async (t) => {
        await touchScope(t, scope, now);
        const old = await t.getFile(scope, p);
        if (!old) throw new NotFoundError(p);
        await t.deleteFile(scope, p);
        await t.appendEvent(scope, { ts: now, type: 'file.delete', actor: opts.author, data: { path: p, old: old.hash } });
      }));
      await this.#emit({ op: 'delete', scope, path: p });
    });
  }

  /**
   * Points the path back at an earlier version (its blob is kept forever in M1).
   * @param {string} scope @param {string} path @param {string} hash @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async restore(scope, path, hash, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const blob = await this.store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
      if (!blob) throw new NotFoundError(`that version of ${p}`);
      return this.#commit(scope, p, { hash, type: blob.type, size: blob.size }, opts);
    });
  }

  /** @param {string} scope @param {string} path */
  async history(scope, path) {
    const p = normPath(path);
    const events = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['file.write', 'file.delete'] }));
    return events
      .filter((e) => e.data?.path === p)
      .map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, old: e.data.old ?? null, new: e.data.new ?? null }));
  }

  /** @param {string} scope @param {string} path @param {any} content @param {WriteOptions} opts */
  async #write(scope, path, content, opts) {
    const type = opts.type ?? typeForPath(path);
    const bytes = contentBytes(content);
    if (type === 'application/json') this.#validateJSON(scope, path, bytes);
    const hash = await sha256Hex(bytes); // before the transaction: IndexedDB commits early if we await other work inside it
    return this.#commit(scope, path, { hash, type, size: bytes.byteLength, bytes }, opts);
  }

  /**
   * @param {string} scope @param {string} path
   * @param {{ hash: string, type: string, size: number, bytes?: Uint8Array }} blob
   * @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async #commit(scope, path, blob, opts) {
    const now = this.now();
    const { entry, changed } = await guardStorage(this.store.tx(['blobs', 'files', 'events', 'scopes'], 'readwrite', async (t) => {
      await touchScope(t, scope, now);
      const old = await t.getFile(scope, path);
      if (old && old.hash === blob.hash && old.type === blob.type) return { entry: old, changed: false };
      if (blob.bytes && !(await t.hasBlob(blob.hash))) {
        await t.putBlob({ hash: blob.hash, type: blob.type, size: blob.size, data: ownBuffer(blob.bytes) });
      }
      /** @type {FileEntry} */
      const next = {
        scope, path, hash: blob.hash, size: blob.size, type: blob.type, author: opts.author,
        created: old?.created ?? now, modified: now, ...(opts.source ? { source: opts.source } : {}),
      };
      await t.putFile(next);
      await t.appendEvent(scope, { ts: now, type: 'file.write', actor: opts.author, data: { path, old: old?.hash ?? null, new: blob.hash, size: blob.size } });
      return { entry: next, changed: true };
    }));
    if (changed) await this.#emit({ op: 'write', scope, path, entry });
    return entry;
  }

  /** @param {string} scope @param {string} path @param {Uint8Array} bytes */
  #validateJSON(scope, path, bytes) {
    let value;
    try {
      value = JSON.parse(text(bytes));
    } catch (e) {
      throw new ValidationError(path, [`not valid JSON (${/** @type {Error} */ (e).message})`]);
    }
    const schema = this.schemaFor(scope, path);
    if (schema) {
      const errors = validate(schema, value);
      if (errors.length) throw new ValidationError(path, errors);
    }
  }

  /** @param {Change} change */
  async #emit(change) {
    for (const fn of this.#listeners) {
      try {
        await fn(change);
      } catch (e) {
        console.warn('a workspace change listener failed', e);
      }
    }
  }

  /**
   * @template T
   * @param {string} scope @param {string} path @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  #locked(scope, path, fn) {
    const key = `${scope}\u0000${path}`;
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }
}

/** @param {any} content @returns {Uint8Array} */
function contentBytes(content) {
  if (typeof content === 'string') return utf8(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return utf8(JSON.stringify(content, null, 2) + '\n');
}

/** @param {Tx} t @param {string} scope @param {number} now */
async function touchScope(t, scope, now) {
  const rec = await t.getScope(scope);
  if (!rec) throw new NotFoundError(`the trip or area "${scope}"`);
  await t.putScope({ ...rec, updated: now });
}

/** @template T @param {Promise<T>} p @returns {Promise<T>} */
async function guardStorage(p) {
  try {
    return await p;
  } catch (e) {
    if (/** @type {any} */ (e)?.name === 'QuotaExceededError') throw new StorageFullError();
    throw e;
  }
}
