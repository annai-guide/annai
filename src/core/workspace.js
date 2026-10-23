import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { normPath, normPrefix, typeForPath } from './paths.js';
import { mergePatch } from './patch.js';
import { validate } from './schema.js';
import { reachable, refused } from './reach.js';

export { StorageFullError } from './errors.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').Tx} Tx
 * @typedef {import('./types.js').FileEntry} FileEntry
 * @typedef {{ author: string, type?: string, source?: string, meta?: import('./types.js').PhotoMeta, guard?: (before: any, next: any) => any }} WriteOptions
 *   guard: for a JSON file, called inside the path's lock with what is stored (undefined if nothing, or not JSON) and the
 *   value about to be stored, read as the format check reads it; what it returns is stored, and what it throws stops the write
 * @typedef {{ op: 'write'|'delete', scope: string, path: string, entry?: FileEntry }} Change
 * @typedef {{ hash: string, type: string, size: number, bytes?: Uint8Array }} Version
 * @typedef {{ seq: number, ts: number, actor: string, type: string, old: string | null, new: string | null, was?: { old?: string, new?: string } }} HistoryEntry
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
   * Applies a JSON Merge Patch to a JSON file. With create, a missing file starts as {}.
   * With append, a key ending in "+" appends to a list (spec §18), as Shiori's patch tool asks.
   * @param {string} scope @param {string} path @param {any} changes @param {WriteOptions & { create?: boolean, append?: boolean }} opts
   * @returns {Promise<FileEntry>}
   */
  async patch(scope, path, changes, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      let current = await this.readJSON(scope, p);
      if (current === undefined) {
        if (!opts.create) throw new NotFoundError(p);
        current = {};
      }
      return this.#write(scope, p, mergePatch(current, changes, { append: Boolean(opts.append) }), opts);
    });
  }

  /**
   * Changes a JSON file in the path's lock: fn gets what is stored and gives the new content, so nothing written between the read
   * and the write is lost (a Test's result recorded while a field is saved, say). A file that is not there is not found.
   * @param {string} scope @param {string} path @param {(current: any) => any | Promise<any>} fn @param {WriteOptions} opts
   * @returns {Promise<any>} the new content
   */
  async update(scope, path, fn, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const current = await this.readJSON(scope, p);
      if (current === undefined) throw new NotFoundError(p);
      const next = await fn(current);
      await this.#write(scope, p, next, opts);
      return next;
    });
  }

  /** @param {string} scope @param {string} path @param {WriteOptions} opts */
  async delete(scope, path, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const now = this.now();
      await this.store.tx(['files', 'events', 'scopes'], 'readwrite', (t) => removeFile(t, scope, p, opts.author, now));
      await this.#emit({ op: 'delete', scope, path: p });
    });
  }

  /**
   * Writes and deletes several files in one transaction: all of them or none.
   * Content null deletes the file. Like write(), unchanged content is left alone.
   * @param {string} scope
   * @param {{ path: string, content: string | Uint8Array | ArrayBuffer | object | null, type?: string }[]} changes
   * @param {WriteOptions} opts
   */
  async writeMany(scope, changes, opts) {
    /** @type {{ path: string, version: Version | null }[]} */
    const prepared = [];
    for (const c of changes) {
      const path = normPath(c.path);
      if (c.content === null) {
        prepared.push({ path, version: null });
        continue;
      }
      const type = c.type ?? typeForPath(path);
      const bytes = contentBytes(c.content);
      if (type === 'application/json') this.#validateJSON(scope, path, bytes);
      prepared.push({ path, version: { hash: await sha256Hex(bytes), type, size: bytes.byteLength, bytes } });
    }
    const now = this.now();
    const commit = async () => {
      const done = await this.store.tx(['blobs', 'files', 'events', 'scopes'], 'readwrite', async (t) => {
        /** @type {Change[]} */
        const out = [];
        for (const { path, version } of prepared) {
          if (!version) {
            await removeFile(t, scope, path, opts.author, now);
            out.push({ op: 'delete', scope, path });
            continue;
          }
          const entry = await putVersion(t, scope, path, version, opts, now);
          if (entry) out.push({ op: 'write', scope, path, entry });
        }
        return out;
      });
      for (const change of done) await this.#emit(change);
    };
    // In the lock of each path it changes, taken in sorted order (two calls never wait for each other), so it comes before or after a
    // write, patch or update of that path, never between a read and a write of it.
    const paths = [...new Set(prepared.map((c) => c.path))].sort();
    const within = (/** @type {number} */ i) => (i === paths.length ? commit() : this.#locked(scope, paths[i], () => within(i + 1)));
    await within(0);
  }

  /**
   * Points the path back at an earlier version (its blob is kept forever in M1).
   * The version keeps the type it was saved with: blobs are shared between files
   * with the same bytes, so the blob's own type may belong to another file.
   * Only content the scope's own files and history name can be restored (reach.js): never another trip's, named by its
   * hash, nor the user's own (/me/) into a trip.
   * @param {string} scope @param {string} path @param {string} hash @param {WriteOptions} opts
   * @returns {Promise<FileEntry>}
   */
  async restore(scope, path, hash, opts) {
    const p = normPath(path);
    return this.#locked(scope, p, async () => {
      const { blob, held, events, current } = await this.store.tx(['blobs', 'events', 'files'], 'readonly', async (t) => {
        const own = await reachable(t, scope, hash, { me: false });
        return {
          blob: own ? await t.getBlob(hash) : undefined,
          held: !own && (await t.hasBlob(hash)),
          events: await t.listEvents(scope, { types: ['file.write'], reverse: true }),
          current: await t.getFile(scope, p),
        };
      });
      if (held) await refused(this.store, scope, hash, 'restore');
      if (!blob) throw new NotFoundError(`that version of ${p}`);
      const saved = events.find((e) => e.data?.path === p && e.data?.new === hash);
      const type = typeof saved?.data?.type === 'string' ? saved.data.type : typeForPath(p);
      // A photo's metadata describes the photo, not one version of its bytes: keep it.
      return this.#commit(scope, p, { hash, type, size: blob.size }, { ...opts, meta: opts.meta ?? current?.meta });
    });
  }

  /** @param {string} scope @param {string} path */
  async history(scope, path) {
    return (await this.histories(scope)).get(normPath(path)) ?? [];
  }

  /**
   * Every file's history in a scope, by path, oldest first: one read of the log, by type. was: versions an import
   * didn't carry (spec §12.3), which old and new no longer name.
   * @param {string} scope
   * @returns {Promise<Map<string, HistoryEntry[]>>}
   */
  async histories(scope) {
    const events = await this.store.tx(['events'], 'readonly', (t) => t.listEvents(scope, { types: ['file.write', 'file.delete'] }));
    /** @type {Map<string, HistoryEntry[]>} */
    const by = new Map();
    for (const e of events) {
      const p = e.data?.path;
      if (typeof p !== 'string') continue;
      if (!by.has(p)) by.set(p, []);
      by.get(p)?.push({ seq: e.seq, ts: e.ts, actor: e.actor, type: e.type, old: e.data.old ?? null, new: e.data.new ?? null, ...(e.data.was ? { was: e.data.was } : {}) });
    }
    return by;
  }

  /** @param {string} scope @param {string} path @param {any} content @param {WriteOptions} opts */
  async #write(scope, path, content, opts) {
    const type = opts.type ?? typeForPath(path);
    let bytes = contentBytes(content);
    if (opts.guard && type === 'application/json') {
      // Inside the path's lock (write and patch hold it), so nothing changes the file between this read and the write.
      const next = parseJSON(path, bytes);
      const value = opts.guard(await this.readJSON(scope, path).catch(() => undefined), next);
      if (value !== next) bytes = contentBytes(value);
    }
    if (type === 'application/json') this.#validateJSON(scope, path, bytes);
    const hash = await sha256Hex(bytes); // before the transaction: IndexedDB commits early if we await other work inside it
    return this.#commit(scope, path, { hash, type, size: bytes.byteLength, bytes }, opts);
  }

  /** @param {string} scope @param {string} path @param {Version} version @param {WriteOptions} opts @returns {Promise<FileEntry>} */
  async #commit(scope, path, version, opts) {
    const now = this.now();
    const { entry, changed } = await this.store.tx(['blobs', 'files', 'events', 'scopes'], 'readwrite', async (t) => {
      const next = await putVersion(t, scope, path, version, opts, now);
      return next ? { entry: next, changed: true } : { entry: /** @type {FileEntry} */ (await t.getFile(scope, path)), changed: false };
    });
    if (changed) await this.#emit({ op: 'write', scope, path, entry });
    return entry;
  }

  /** @param {string} scope @param {string} path @param {Uint8Array} bytes */
  #validateJSON(scope, path, bytes) {
    const value = parseJSON(path, bytes);
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
/** A JSON file's value, as every reader reads it (a byte-order mark is read past). @param {string} path @param {Uint8Array} bytes */
function parseJSON(path, bytes) {
  try {
    return JSON.parse(text(bytes));
  } catch (e) {
    throw new ValidationError(path, [`not valid JSON (${/** @type {Error} */ (e).message})`]);
  }
}

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

/**
 * Points path at a version inside transaction t: stores the blob if it is new, then the
 * entry, then a file.write event. Returns null, touching nothing, when the content is unchanged.
 * @param {Tx} t @param {string} scope @param {string} path @param {Version} version @param {WriteOptions} opts @param {number} now
 * @returns {Promise<FileEntry | null>}
 */
async function putVersion(t, scope, path, version, opts, now) {
  const old = await t.getFile(scope, path);
  if (old && old.hash === version.hash && old.type === version.type) return null;
  await touchScope(t, scope, now);
  if (version.bytes) await keepBlob(t, version.hash, version.type, version.bytes);
  /** @type {FileEntry} */
  const next = {
    scope, path, hash: version.hash, size: version.size, type: version.type, author: opts.author,
    created: old?.created ?? now, modified: now, ...(opts.source ? { source: opts.source } : {}), ...(opts.meta ? { meta: opts.meta } : {}),
  };
  await t.putFile(next);
  await t.appendEvent(scope, {
    ts: now, type: 'file.write', actor: opts.author,
    data: { path, old: old?.hash ?? null, new: version.hash, size: version.size, type: version.type },
  });
  return next;
}

/**
 * Stores bytes under their hash in transaction t, unless that content is stored whole already. A record without its bytes
 * (an older annai kept a string or an ArrayBuffer given to a log entry so) is written again with them. The held record
 * is read whole to know: IndexedDB returns whole records, and its size can be right while its bytes are missing, so no
 * index can tell. Content already stored is written again rarely (the same photo added to a second trip), and texts are small.
 * @param {Tx} t @param {string} hash @param {string} type @param {Uint8Array} bytes
 */
export async function keepBlob(t, hash, type, bytes) {
  const had = await t.getBlob(hash);
  if (had?.data instanceof ArrayBuffer && had.data.byteLength === bytes.byteLength) return;
  await t.putBlob({ hash, type, size: bytes.byteLength, data: ownBuffer(bytes) });
}

/** @param {Tx} t @param {string} scope @param {string} path @param {string} author @param {number} now */
async function removeFile(t, scope, path, author, now) {
  await touchScope(t, scope, now);
  const old = await t.getFile(scope, path);
  if (!old) throw new NotFoundError(path);
  await t.deleteFile(scope, path);
  await t.appendEvent(scope, { ts: now, type: 'file.delete', actor: author, data: { path, old: old.hash } });
}
