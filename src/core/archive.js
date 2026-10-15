import { ZipWriter, readZip } from './zip.js';
import { encrypt, decrypt, isEncrypted } from './archive-crypto.js';
import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { isCompressedType, normPath } from './paths.js';
import { validate } from './schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, FORMAT, newId } from './scopes.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').ScopeRecord} ScopeRecord
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {{ history: boolean, memory: boolean, photos: boolean }} Include
 * @typedef {{ dir: string, record: ScopeRecord, events?: string }} ManifestScope
 * @typedef {{ name: string, scope: string, path: string, hash: string, size: number, type: string,
 *   author: string, source?: string, created: number, modified: number }} ManifestFile
 * @typedef {{ format: number, app: string, kind: 'trip'|'everything', created: number, include: Include,
 *   encrypted: boolean, scopes: ManifestScope[], files: ManifestFile[],
 *   blobs: { name: string, hash: string, type: string, size: number }[],
 *   extras: { name: string, hash: string }[], secrets?: string }} Manifest
 * @typedef {{ manifest: Manifest, entries: Map<string, Uint8Array>, events: Map<string, EventRecord[]> }} OpenedArchive
 *   events: each scope's history log, parsed and checked, by entry name
 */

export const ARCHIVE_FORMAT = 1;
export const MANIFEST_NAME = 'annai-archive.json';

/** Export presets (spec §12.2). */
export const PRESETS = Object.freeze({
  backup: Object.freeze({ history: true, memory: true, photos: true }),
  share: Object.freeze({ history: false, memory: false, photos: true }),
});

export class ArchiveError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export class NeedsPassphraseError extends ArchiveError {
  constructor() {
    super('This file is encrypted. Enter its passphrase to open it.');
    this.name = 'NeedsPassphraseError';
  }
}

/** @type {Record<string, string>} */
const DIRS = { [ME]: 'me', [SYS]: 'system/log', [SYS_SETTINGS]: 'system/settings', [SYS_PLUGINS]: 'system/plugins' };
const dirFor = (/** @type {string} */ id) => DIRS[id] ?? `trips/${id}`;

const HASH = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const SIZE = { type: 'integer', minimum: 0 };
const TIME = { type: 'number' };
const TEXT = { type: 'string' };

/** Everything an archive says about itself is checked, not just the bytes it carries. */
const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['format', 'app', 'kind', 'created', 'include', 'scopes', 'files', 'blobs', 'extras'],
  properties: {
    format: { type: 'integer', minimum: 1 },
    app: TEXT,
    kind: { enum: ['trip', 'everything'] },
    created: TIME,
    include: { type: 'object', properties: { history: { type: 'boolean' }, memory: { type: 'boolean' }, photos: { type: 'boolean' } } },
    encrypted: { type: 'boolean' },
    secrets: TEXT,
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['dir', 'record'],
        properties: {
          dir: TEXT,
          events: TEXT,
          record: {
            type: 'object',
            required: ['id', 'kind', 'title', 'status', 'created', 'updated', 'format'],
            properties: {
              id: { type: 'string', minLength: 1 }, kind: { enum: ['me', 'trip', 'sys'] }, title: TEXT,
              status: { enum: ['active', 'archived'] }, created: TIME, updated: TIME, format: { type: 'integer', minimum: 1 }, tripId: TEXT,
            },
          },
        },
      },
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'scope', 'path', 'hash', 'size', 'type', 'author', 'created', 'modified'],
        properties: { name: TEXT, scope: TEXT, path: TEXT, hash: HASH, size: SIZE, type: TEXT, author: TEXT, created: TIME, modified: TIME, source: TEXT },
      },
    },
    blobs: { type: 'array', items: { type: 'object', required: ['name', 'hash', 'type', 'size'], properties: { name: TEXT, hash: HASH, type: TEXT, size: SIZE } } },
    extras: { type: 'array', items: { type: 'object', required: ['name', 'hash'], properties: { name: TEXT, hash: HASH } } },
  },
};

/** One line of a history log. */
const EVENT_SCHEMA = {
  type: 'object',
  required: ['seq', 'ts', 'type', 'actor'],
  properties: { seq: { type: 'integer', minimum: 1 }, ts: TIME, type: { type: 'string', minLength: 1 }, actor: TEXT, refs: { type: 'array', items: TEXT } },
};

/**
 * Builds an archive of one trip or of everything (spec §12.1–12.2).
 * @param {Store} store
 * @param {{ kind: 'trip'|'everything', scopes?: string[], include: Include, secrets?: boolean,
 *   passphrase?: string, iterations?: number, app: string, now?: number }} opts
 * @returns {Promise<{ blob: Blob, filename: string, manifest: Manifest }>}
 */
export async function exportArchive(store, opts) {
  const now = opts.now ?? Date.now();
  if (opts.secrets && (opts.kind !== 'everything' || !opts.passphrase)) {
    throw new ArchiveError('API keys can only be included in an encrypted backup of everything.');
  }
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const scopes = opts.kind === 'trip'
    ? all.filter((s) => s.kind === 'trip' && (opts.scopes ?? []).includes(s.id))
    : all.filter((s) => s.id !== SYS || opts.include.history);
  if (!scopes.length) throw new ArchiveError('There is nothing to export.');

  /** @type {Manifest} */
  const manifest = {
    format: ARCHIVE_FORMAT, app: opts.app, kind: opts.kind, created: now, include: { ...opts.include },
    encrypted: Boolean(opts.passphrase), scopes: [], files: [], blobs: [], extras: [],
  };
  const zip = new ZipWriter();
  /** @type {Set<string>} */ const current = new Set();
  /** @type {Set<string>} */ const historic = new Set();

  for (const scope of scopes) {
    const dir = dirFor(scope.id);
    const { files, events } = await store.tx(['files', 'events'], 'readonly', async (t) => ({
      files: await t.listFiles(scope.id, '/'),
      events: opts.include.history ? await t.listEvents(scope.id) : [],
    }));
    /** @type {ManifestScope} */
    const ms = { dir, record: scope };
    for (const f of files) {
      if (!opts.include.memory && f.path === '/memory.md' && scope.kind !== 'sys') continue;
      if (!opts.include.photos && f.path.startsWith('/files/') && f.type.startsWith('image/')) continue;
      const name = dir + f.path;
      await zip.add(name, await readBlob(store, f.hash, f.path), { compress: !isCompressedType(f.type), mtime: f.modified });
      manifest.files.push({
        name, scope: scope.id, path: f.path, hash: f.hash, size: f.size, type: f.type, author: f.author,
        created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}),
      });
      current.add(f.hash);
    }
    if (events.length) {
      const name = `${dir}/.annai/events.jsonl`;
      const body = utf8(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await zip.add(name, body, { mtime: now });
      manifest.extras.push({ name, hash: await sha256Hex(body) });
      ms.events = name;
      for (const e of events) {
        for (const h of [e.data?.old, e.data?.new]) if (typeof h === 'string') historic.add(h);
        for (const r of e.refs ?? []) historic.add(r);
      }
    }
    manifest.scopes.push(ms);
  }

  for (const hash of historic) {
    if (current.has(hash)) continue;
    const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
    if (!rec) continue;
    const name = `blobs/${hash}`;
    await zip.add(name, new Uint8Array(rec.data), { compress: !isCompressedType(rec.type), mtime: now });
    manifest.blobs.push({ name, hash, type: rec.type, size: rec.size });
  }

  if (opts.secrets) {
    const secrets = await store.tx(['secrets'], 'readonly', async (t) => {
      const out = [];
      for (const id of await t.listSecretIds()) out.push({ id, value: await t.getSecret(id) });
      return out;
    });
    const name = 'system/secrets.json';
    const body = utf8(JSON.stringify(secrets));
    await zip.add(name, body, { mtime: now });
    manifest.extras.push({ name, hash: await sha256Hex(body) });
    manifest.secrets = name;
  }

  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest, null, 2)), { mtime: now });
  let blob = zip.finish();
  if (opts.passphrase) {
    const sealed = await encrypt(new Uint8Array(await blob.arrayBuffer()), opts.passphrase, opts.iterations);
    blob = new Blob([/** @type {BlobPart} */ (sealed)], { type: 'application/octet-stream' });
  }
  const title = opts.kind === 'trip' ? scopes[0].title : '';
  return { blob, manifest, filename: archiveName({ kind: opts.kind, title, encrypted: Boolean(opts.passphrase), now }) };
}

/** @param {Store} store @param {string} hash @param {string} path */
async function readBlob(store, hash, path) {
  const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  if (!rec) throw new ArchiveError(`The content of ${path} is missing from storage, so it can't be exported.`);
  return new Uint8Array(rec.data);
}

/**
 * Decrypts (if needed), unzips and verifies an archive. Throws ArchiveError
 * (or NeedsPassphraseError / PassphraseError) without touching storage.
 * @param {Uint8Array} bytes
 * @param {string} [passphrase]
 * @returns {Promise<OpenedArchive>}
 */
export async function openArchive(bytes, passphrase) {
  if (isEncrypted(bytes)) {
    if (!passphrase) throw new NeedsPassphraseError();
    bytes = await decrypt(bytes, passphrase);
  }
  /** @type {Map<string, Uint8Array>} */
  let entries;
  try {
    entries = await readZip(bytes);
  } catch (e) {
    throw new ArchiveError(`This file isn't an annai file, or it is damaged (${/** @type {Error} */ (e).message}).`);
  }
  const raw = entries.get(MANIFEST_NAME);
  if (!raw) throw new ArchiveError("This zip isn't an annai file: it has no annai-archive.json.");
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text(raw));
  } catch {
    throw new ArchiveError('This file is damaged: its manifest is not readable.');
  }
  const newer = (/** @type {unknown} */ f) => typeof f === 'number' && f > FORMAT;
  if ((typeof manifest?.format === 'number' && manifest.format > ARCHIVE_FORMAT)
    || (Array.isArray(manifest?.scopes) && manifest.scopes.some((/** @type {any} */ s) => newer(s?.record?.format)))) {
    throw new ArchiveError('This file was made by a newer version of annai. Update annai, then open it again.');
  }
  const errors = validate(MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new ArchiveError(`This file is damaged: ${errors.join('; ')}`);
  for (const f of manifest.files) {
    if (!isSafePath(f.path)) throw new ArchiveError(`This file contains an unsafe file path (${JSON.stringify(f.path)}), so annai won't open it.`);
  }
  /** @type {string[]} */
  const problems = [];
  const check = async (/** @type {string} */ name, /** @type {string} */ hash) => {
    const b = entries.get(name);
    if (!b) problems.push(`${name} is missing`);
    else if ((await sha256Hex(b)) !== hash) problems.push(`${name} was changed`);
  };
  for (const f of manifest.files) await check(f.name, f.hash);
  for (const b of manifest.blobs) await check(b.name, b.hash);
  for (const x of manifest.extras) await check(x.name, x.hash);
  if (problems.length) throw new ArchiveError(`This file is damaged: ${problems.join('; ')}.`);
  /** @type {Map<string, EventRecord[]>} */
  const events = new Map();
  for (const s of manifest.scopes) {
    if (s.events) events.set(s.events, readLog(s.events, entries.get(s.events)));
  }
  return { manifest, entries, events };
}

/**
 * Parses and checks a history log: every line an event, numbered upwards from 1 without repeats.
 * @param {string} name @param {Uint8Array | undefined} bytes
 * @returns {EventRecord[]}
 */
function readLog(name, bytes) {
  if (!bytes) throw new ArchiveError(`This file is damaged: ${name} is missing.`);
  /** @type {EventRecord[]} */
  const out = [];
  let last = 0;
  for (const [i, line] of text(bytes).split('\n').entries()) {
    if (!line) continue;
    /** @type {any} */
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      throw new ArchiveError(`This file is damaged: line ${i + 1} of ${name} is not readable.`);
    }
    const errors = validate(EVENT_SCHEMA, e);
    if (!errors.length && e.seq <= last) errors.push(`$.seq: ${e.seq} comes after ${last}`);
    if (errors.length) throw new ArchiveError(`This file is damaged: line ${i + 1} of ${name}: ${errors.join('; ')}`);
    last = e.seq;
    out.push(e);
  }
  return out;
}

/**
 * What the import preview shows, including which trips already exist here.
 * @param {Store} store
 * @param {OpenedArchive} opened
 */
export async function describeArchive(store, { manifest }) {
  const local = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const trips = manifest.scopes
    .filter((s) => s.record.kind === 'trip')
    .map((s) => {
      const files = manifest.files.filter((f) => f.scope === s.record.id);
      const existing = local.find((l) => l.kind === 'trip' && l.status === 'active' && l.tripId && l.tripId === s.record.tripId);
      return {
        scope: s.record.id, title: s.record.title, files: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0), history: Boolean(s.events),
        existing: existing?.id ?? null, existingTitle: existing?.title ?? null,
      };
    });
  const has = (/** @type {string} */ id) => manifest.scopes.some((s) => s.record.id === id);
  return {
    kind: manifest.kind, created: manifest.created, app: manifest.app, include: manifest.include,
    encrypted: manifest.encrypted, trips, hasMe: has(ME), hasSettings: has(SYS_SETTINGS), hasPlugins: has(SYS_PLUGINS),
    hasSecrets: Boolean(manifest.secrets),
  };
}

/**
 * Imports an opened archive in one transaction: everything or nothing.
 * Trips default to "new". "me", settings and plugins default to "keep".
 * @param {Store} store
 * @param {OpenedArchive} opened
 * @param {{ trips?: Record<string, 'new'|'replace'|'skip'>, me?: 'keep'|'replace', settings?: 'keep'|'replace',
 *   plugins?: 'keep'|'replace', secrets?: boolean, now?: number }} [choices]
 */
export async function importArchive(store, { manifest, entries, events: logs }, choices = {}) {
  const now = choices.now ?? Date.now();
  /** @type {{ rec: ScopeRecord, target: string, mode: 'new'|'replace'|'system', files: ManifestFile[], events: EventRecord[] }[]} */
  const plan = [];
  /** @type {Map<string, { bytes: Uint8Array, hash: string }>} */
  const overrides = new Map();
  for (const s of manifest.scopes) {
    const rec = s.record;
    /** @type {string} */ let target;
    /** @type {'new'|'replace'|'system'} */ let mode;
    if (rec.kind === 'trip') {
      const choice = choices.trips?.[rec.id] ?? 'new';
      if (choice === 'skip') continue;
      target = newId('trip');
      mode = choice;
    } else if (rec.id === ME && choices.me === 'replace') {
      target = ME; mode = 'system';
    } else if (rec.id === SYS_SETTINGS && choices.settings === 'replace') {
      target = SYS_SETTINGS; mode = 'system';
    } else if (rec.id === SYS_PLUGINS && choices.plugins === 'replace') {
      target = SYS_PLUGINS; mode = 'system';
    } else {
      continue; // kept, or the system log, which belongs to the device it came from
    }
    const files = manifest.files.filter((f) => f.scope === rec.id);
    const events = (s.events && logs.get(s.events)) || [];
    plan.push({ rec, target, mode, files, events });
    // Imported plugins arrive switched off: running their code must be an explicit choice
    // on the plugins screen, with its "full access" warning (spec §5.1).
    if (target === SYS_PLUGINS) {
      for (const f of files) {
        if (f.path !== '/installed.json') continue;
        /** @type {Record<string, any>} */
        let state = {};
        try { state = JSON.parse(text(/** @type {Uint8Array} */ (entries.get(f.name)))); } catch { /* treat as empty */ }
        const off = Object.fromEntries(Object.entries(state ?? {}).map(([id, s]) => [id, { ...s, enabled: false }]));
        const bytes = utf8(JSON.stringify(off, null, 2) + '\n');
        overrides.set(f.name, { bytes, hash: await sha256Hex(bytes) });
      }
    }
  }
  /** @type {{ id: string, value: any }[]} */
  const secrets = choices.secrets && manifest.secrets ? JSON.parse(text(/** @type {Uint8Array} */ (entries.get(manifest.secrets)))) : [];

  const result = {
    trips: /** @type {string[]} */ ([]), archived: /** @type {string[]} */ ([]), me: false, settings: false, plugins: false, secrets: 0,
    /** ids of API keys in the file that were not imported because this device already has a key with that id */
    keptSecrets: /** @type {string[]} */ ([]),
  };
  await store.tx(['blobs', 'files', 'events', 'scopes', 'secrets'], 'readwrite', async (t) => {
    for (const p of plan) {
      if (p.mode === 'replace') {
        const copies = (await t.listScopes()).filter((l) => l.kind === 'trip' && l.status === 'active' && l.tripId && l.tripId === p.rec.tripId);
        for (const old of copies) {
          await t.putScope({ ...old, status: 'archived', updated: now });
          await t.appendEvent(old.id, { ts: now, type: 'scope.archive', actor: 'user', data: { reason: 'replaced by an import' } });
          result.archived.push(old.id);
        }
      }
      if (p.mode === 'system') await t.deleteScope(p.target);
      // The target decides the kind: a record that calls "me" a trip must not make it one.
      const kind = p.target === ME ? 'me' : p.mode === 'system' ? 'sys' : 'trip';
      await t.putScope({ ...p.rec, id: p.target, kind, status: 'active', updated: now });
      for (const f of p.files) {
        const o = overrides.get(f.name);
        const hash = o?.hash ?? f.hash;
        const size = o?.bytes.byteLength ?? f.size;
        if (!(await t.hasBlob(hash))) {
          await t.putBlob({ hash, type: f.type, size, data: ownBuffer(o?.bytes ?? /** @type {Uint8Array} */ (entries.get(f.name))) });
        }
        await t.putFile({
          scope: p.target, path: f.path, hash, size, type: f.type, author: f.author,
          created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}),
        });
      }
      for (const e of p.events) await t.putEvent({ ...e, scope: p.target });
      await t.appendEvent(p.target, { ts: now, type: 'import', actor: 'user', data: { created: manifest.created, app: manifest.app, kind: manifest.kind } });
      if (p.rec.kind === 'trip') result.trips.push(p.target);
      else if (p.target === ME) result.me = true;
      else if (p.target === SYS_SETTINGS) result.settings = true;
      else if (p.target === SYS_PLUGINS) result.plugins = true;
    }
    for (const b of manifest.blobs) {
      if (!(await t.hasBlob(b.hash))) {
        await t.putBlob({ hash: b.hash, type: b.type, size: b.size, data: ownBuffer(/** @type {Uint8Array} */ (entries.get(b.name))) });
      }
    }
    // Keys already on this device always win: an archive must never swap in someone else's key.
    for (const s of secrets) {
      if ((await t.getSecret(s.id)) !== undefined) {
        result.keptSecrets.push(s.id);
        continue;
      }
      await t.putSecret(s.id, s.value);
      result.secrets++;
    }
  });
  return result;
}

/**
 * "annai-<slug>-<yyyy-mm-dd>.annai.zip", or ".annai" when encrypted.
 * @param {{ kind: 'trip'|'everything', title?: string, encrypted: boolean, now: number }} o
 */
export function archiveName({ kind, title, encrypted, now }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const base = kind === 'everything' ? 'backup' : slug(title ?? '');
  return `annai-${base}-${day}${encrypted ? '.annai' : '.annai.zip'}`;
}

/**
 * A file-name-safe form of a title in any script: Latin accents are dropped ("Café" → "cafe"),
 * other letters, marks and digits are kept, everything else becomes "-". At most 60 characters.
 * @param {string} s
 */
function slug(s) {
  const out = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...out].slice(0, 60).join('').replace(/-+$/, '') || 'trip';
}

/** A path an archive may write: already in normal form (no "..", no reserved folder, leading "/"). @param {unknown} p */
function isSafePath(p) {
  try {
    return typeof p === 'string' && normPath(p) === p;
  } catch {
    return false;
  }
}
