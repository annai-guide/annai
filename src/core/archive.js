import { ZipWriter, ZipReader } from './zip.js';
import { encrypt, decrypt, isEncrypted } from './archive-crypto.js';
import { sha256Hex } from './hash.js';
import { utf8, text, ownBuffer } from './bytes.js';
import { isCompressedType, normPath } from './paths.js';
import { validate } from './schema.js';
import { ME, SYS, SYS_SETTINGS, SYS_PLUGINS, SYS_DEVICE, FORMAT, newId, isDeviceSecret } from './scopes.js';
import { isPhotoType } from './photos.js';
import { readPhotoMeta, stripMetadata, sniffImageType, sniffMediaType } from './photo-meta.js';
import { blobsOf } from './events.js';
import { dayIn, deviceZone } from './time.js';

/**
 * @typedef {import('./types.js').Store} Store
 * @typedef {import('./types.js').ScopeRecord} ScopeRecord
 * @typedef {import('./types.js').EventRecord} EventRecord
 * @typedef {{ history: boolean, memory: boolean, photos: boolean }} Include
 * @typedef {{ dir: string, record: ScopeRecord, events?: string }} ManifestScope
 * @typedef {import('./types.js').PhotoMeta} PhotoMeta
 * @typedef {{ name: string, scope: string, path: string, hash: string, size: number, type: string,
 *   author: string, source?: string, meta?: PhotoMeta, created: number, modified: number }} ManifestFile
 * @typedef {(file: { path: string, type: string, meta?: PhotoMeta }, bytes: Uint8Array) =>
 *   Promise<{ bytes: Uint8Array, type: string, width?: number, height?: number } | null>} PhotoConvert
 *   Encodes a photo for a Share (in browsers, with the ingest settings); null when it can't.
 * @typedef {{ format: number, app: string, kind: 'trip'|'everything', created: number, include: Include,
 *   encrypted: boolean, scopes: ManifestScope[], files: ManifestFile[],
 *   blobs: { name: string, hash: string, type: string, size: number }[],
 *   extras: { name: string, hash: string }[], secrets?: string }} Manifest
 * @typedef {{ manifest: Manifest, zip: ZipReader, events: Map<string, EventRecord[]> }} OpenedArchive
 *   zip: the archive's entries, read on demand; events: each scope's history log, parsed and checked, by entry name
 */

export const ARCHIVE_FORMAT = 1;
export const MANIFEST_NAME = 'annai-archive.json';

/** Export presets (spec §12.2). */
export const PRESETS = Object.freeze({
  backup: Object.freeze({ history: true, memory: true, photos: true }),
  share: Object.freeze({ history: false, memory: false, photos: true }),
});

/**
 * Whether an export counts as backing its trips up: a Backup with everything ticked (spec §4.9).
 * A Share leaves out the conversation and the history.
 * @param {Include} include @param {boolean} share
 */
export function isFullBackup(include, share) {
  return !share && include.history && include.memory && include.photos;
}

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
const PHOTO_META = {
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, taken: { type: 'string', maxLength: 40 },
    place: { type: 'object', required: ['lat', 'lng'], additionalProperties: false, properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 } } },
    original: { type: 'boolean' },
  },
};
/** Formats every current browser shows. A Share converts the others (§12.2). */
const PORTABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

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
        properties: { name: TEXT, scope: TEXT, path: TEXT, hash: HASH, size: SIZE, type: TEXT, author: TEXT, created: TIME, modified: TIME, source: TEXT, meta: PHOTO_META },
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
 *   passphrase?: string, iterations?: number, app: string, now?: number, share?: { places: boolean, convert?: PhotoConvert } }} opts
 *   share: this is a Share (§12.2). Photos go only as encoded copies, older versions of photos are
 *   left out, and unless places is true, nothing says where a photo was taken.
 * @returns {Promise<{ blob: Blob, filename: string, manifest: Manifest, skipped: string[], seqs: Map<string, number> }>}
 *   skipped: photos left out of a Share because their location couldn't be removed;
 *   seqs: scope id → the last history entry the archive holds (empty without history)
 */
export async function exportArchive(store, opts) {
  const now = opts.now ?? Date.now();
  if (opts.secrets && (opts.kind !== 'everything' || !opts.passphrase)) {
    throw new ArchiveError('API keys can only be included in an encrypted backup of everything.');
  }
  const all = await store.tx(['scopes'], 'readonly', (t) => t.listScopes());
  const scopes = opts.kind === 'trip'
    ? all.filter((s) => s.kind === 'trip' && (opts.scopes ?? []).includes(s.id))
    // This device's own scope never travels (spec §12.4); the system log goes only with history.
    : all.filter((s) => s.id !== SYS_DEVICE && (s.id !== SYS || opts.include.history));
  if (!scopes.length) throw new ArchiveError('There is nothing to export.');

  /** @type {Manifest} */
  const manifest = {
    format: ARCHIVE_FORMAT, app: opts.app, kind: opts.kind, created: now, include: { ...opts.include },
    encrypted: Boolean(opts.passphrase), scopes: [], files: [], blobs: [], extras: [],
  };
  const zip = new ZipWriter();
  /** @type {Set<string>} */ const current = new Set();
  /** @type {Set<string>} */ const historic = new Set();
  /** @type {string[]} */ const skipped = [];
  /** @type {Map<string, number>} */ const seqs = new Map();

  for (const scope of scopes) {
    const dir = dirFor(scope.id);
    const { files, events } = await store.tx(['files', 'events'], 'readonly', async (t) => ({
      files: await t.listFiles(scope.id, '/'),
      events: opts.include.history ? await t.listEvents(scope.id) : [],
    }));
    const { backup: _, ...record } = scope; // a backup note belongs to the device that made it
    /** @type {ManifestScope} */
    const ms = { dir, record };
    for (const f of files) {
      if (!opts.include.memory && f.path === '/memory.md' && scope.kind !== 'sys') continue;
      const name = dir + f.path;
      const bytes = await readBlob(store, f.hash, f.path);
      // An image is known by its bytes, not by the type it was saved under.
      const sniffed = sniffImageType(bytes);
      if (!opts.include.photos && f.path.startsWith('/files/') && (sniffed !== null || f.type.startsWith('image/'))) continue;
      /** @type {{ bytes: Uint8Array, type: string, hash: string, meta?: PhotoMeta }} */
      let out = { bytes, type: f.type, hash: f.hash, meta: f.meta };
      const image = opts.share ? photoTypeOf(sniffed, f.type) : null;
      if (opts.share && image) {
        const shared = await sharePhoto({ ...f, type: image }, out.bytes, opts.share);
        if (!shared) {
          skipped.push(f.path);
          continue;
        }
        out = { ...shared, hash: shared.bytes === out.bytes ? f.hash : await sha256Hex(shared.bytes) };
      } else if (opts.share && !opts.share.places && (sniffMediaType(bytes) !== null || /^(image|video)\//.test(f.type))) {
        // Other images (GIF, TIFF and raw photos, SVG…) and videos can hold a location too: cleaned without re-encoding, or left out.
        const stripped = stripMetadata(bytes, sniffed ?? f.type);
        if (!stripped) {
          skipped.push(f.path);
          continue;
        }
        const { place: _, ...meta } = out.meta ?? {};
        out = { bytes: stripped, type: sniffed ?? f.type, hash: await sha256Hex(stripped), meta: out.meta ? meta : undefined };
      }
      await zip.add(name, out.bytes, { compress: !isCompressedType(out.type), mtime: f.modified });
      manifest.files.push({
        name, scope: scope.id, path: f.path, hash: out.hash, size: out.bytes.byteLength, type: out.type, author: f.author,
        created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}), ...validMeta(out.meta),
      });
      current.add(out.hash);
    }
    if (events.length) {
      seqs.set(scope.id, events[events.length - 1].seq);
      const name = `${dir}/.annai/events.jsonl`;
      const body = utf8(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await zip.add(name, body, { mtime: now });
      manifest.extras.push({ name, hash: await sha256Hex(body) });
      ms.events = name;
      for (const e of events) for (const h of blobsOf(e)) historic.add(h);
    }
    manifest.scopes.push(ms);
  }

  for (const hash of historic) {
    if (current.has(hash)) continue;
    const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
    if (!rec || (opts.share && (sniffMediaType(new Uint8Array(rec.data)) !== null || /^(image|video)\//.test(rec.type)))) continue; // a Share leaves out older versions of images and videos
    const name = `blobs/${hash}`;
    await zip.add(name, new Uint8Array(rec.data), { compress: !isCompressedType(rec.type), mtime: now });
    manifest.blobs.push({ name, hash, type: rec.type, size: rec.size });
  }

  if (opts.secrets) {
    const secrets = await store.tx(['secrets'], 'readonly', async (t) => {
      const out = [];
      // This device's own sign-ins and tokens stay on it (spec §12.4, §11.6): their screens promise so.
      for (const id of await t.listSecretIds()) if (!isDeviceSecret(id)) out.push({ id, value: await t.getSecret(id) });
      return out;
    });
    const name = 'system/secrets.json';
    const body = utf8(JSON.stringify(secrets));
    await zip.add(name, body, { mtime: now });
    manifest.extras.push({ name, hash: await sha256Hex(body) });
    manifest.secrets = name;
  }

  await zip.add(MANIFEST_NAME, utf8(JSON.stringify(manifest, null, 2)), { mtime: now });
  // Never write a file that can't be opened again: fail here, where the user can still act.
  const problems = validate(MANIFEST_SCHEMA, manifest);
  if (problems.length) throw new ArchiveError(`annai couldn't build a file it could open again: ${problems.join('; ')}`);
  let blob = zip.finish();
  if (opts.passphrase) blob = await encrypt(blob, opts.passphrase, opts.iterations);
  const title = opts.kind === 'trip' ? scopes[0].title : '';
  return { blob, manifest, skipped, seqs, filename: archiveName({ kind: opts.kind, title, encrypted: Boolean(opts.passphrase), now }) };
}

/**
 * The photo type of some bytes: what they are when they say (a GIF is no photo, as at ingest),
 * otherwise what they were saved as.
 * @param {string | null} sniffed @param {string} declared @returns {string | null}
 */
function photoTypeOf(sniffed, declared) {
  if (sniffed) return isPhotoType(sniffed) ? sniffed : null;
  return isPhotoType(declared) ? declared : null;
}

/**
 * A photo's details as an archive carries them: only those that pass the manifest's schema, so a
 * damaged detail (a size of 0 from an odd header) can never make the whole archive unreadable.
 * @param {PhotoMeta | undefined} meta @returns {{ meta?: PhotoMeta }}
 */
function validMeta(meta) {
  if (!meta) return {};
  /** @type {Record<string, any>} */
  const kept = {};
  for (const [key, value] of Object.entries(meta)) {
    const one = { [key]: value };
    if (validate(PHOTO_META, one).length === 0) kept[key] = value;
  }
  return Object.keys(kept).length ? { meta: kept } : {};
}

/**
 * A photo as a Share carries it (§12.2). Encoded first: a kept original, a format some browsers
 * can't show, and a photo of unknown origin (no metadata, so not added through ingest). Without
 * places, its metadata and its bytes say nothing about where it was taken: every photo is either
 * stripped or encoded here, or stays home. Nothing it was given is trusted for that (its metadata
 * may come from someone else's archive), and the reader only knows EXIF, so finding no location
 * proves nothing. null when the photo has to stay home, for example a HEIC original in a browser
 * that can't read HEIC.
 * @param {{ path: string, type: string, meta?: PhotoMeta }} f @param {Uint8Array} bytes
 * @param {{ places: boolean, convert?: PhotoConvert }} share
 * @returns {Promise<{ bytes: Uint8Array, type: string, meta?: PhotoMeta } | null>}
 */
async function sharePhoto(f, bytes, share) {
  /** @type {{ bytes: Uint8Array, type: string, meta?: PhotoMeta }} */
  let out = { bytes, type: f.type, meta: f.meta ? { ...f.meta } : undefined };
  let clean = false; // encoded or stripped here
  let tried = false;
  const encode = async () => {
    tried = true;
    const encoded = share.convert ? await share.convert(f, bytes).catch(() => null) : null;
    if (!encoded) return;
    const { original: _, ...rest } = out.meta ?? {};
    out = { bytes: encoded.bytes, type: encoded.type, meta: { ...rest, ...(encoded.width && encoded.height ? { width: encoded.width, height: encoded.height } : {}) } };
    clean = true;
  };
  if (f.meta?.original || !PORTABLE.has(f.type) || (!f.meta && isPhotoType(f.type))) await encode();
  if (share.places) return out;
  if (out.meta) delete out.meta.place;
  const stripped = clean ? null : stripMetadata(out.bytes, out.type);
  if (stripped) {
    out.bytes = stripped;
    clean = true;
  } else if (!clean && !tried) await encode(); // for example a PNG: encoding is the only way to be sure
  return clean && !readPhotoMeta(out.bytes).place ? out : null;
}

/** @param {Store} store @param {string} hash @param {string} path */
async function readBlob(store, hash, path) {
  const rec = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  if (!rec) throw new ArchiveError(`The content of ${path} is missing from storage, so it can't be exported.`);
  return new Uint8Array(rec.data);
}

/**
 * Decrypts (if needed), opens and verifies an archive, reading the file one entry
 * at a time (spec §12.1). Throws ArchiveError (or NeedsPassphraseError /
 * PassphraseError) without touching storage.
 * @param {Blob | Uint8Array} file
 * @param {string} [passphrase]
 * @returns {Promise<OpenedArchive>}
 */
export async function openArchive(file, passphrase) {
  let blob = file instanceof Blob ? file : new Blob([/** @type {BlobPart} */ (file)]);
  if (isEncrypted(new Uint8Array(await blob.slice(0, 64).arrayBuffer()))) {
    if (!passphrase) throw new NeedsPassphraseError();
    blob = await decrypt(blob, passphrase);
  }
  /** @type {ZipReader} */
  let zip;
  try {
    zip = await ZipReader.open(blob);
  } catch (e) {
    throw new ArchiveError(`This file isn't an annai file, or it is damaged (${/** @type {Error} */ (e).message}).`);
  }
  if (!zip.has(MANIFEST_NAME)) throw new ArchiveError("This zip isn't an annai file: it has no annai-archive.json.");
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text(await readEntry(zip, MANIFEST_NAME)));
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
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
    if (!zip.has(name)) problems.push(`${name} is missing`);
    else if ((await sha256Hex(await readEntry(zip, name))) !== hash) problems.push(`${name} was changed`);
  };
  for (const f of manifest.files) await check(f.name, f.hash);
  for (const b of manifest.blobs) await check(b.name, b.hash);
  for (const x of manifest.extras) await check(x.name, x.hash);
  if (problems.length) throw new ArchiveError(`This file is damaged: ${problems.join('; ')}.`);
  /** @type {Map<string, EventRecord[]>} */
  const events = new Map();
  for (const s of manifest.scopes) {
    if (s.events) events.set(s.events, readLog(s.events, await readEntry(zip, s.events)));
  }
  return { manifest, zip, events };
}

/** One entry of an archive; a damaged entry is an ArchiveError. @param {ZipReader} zip @param {string} name */
async function readEntry(zip, name) {
  try {
    return await zip.read(name);
  } catch (e) {
    throw new ArchiveError(`This file is damaged: ${/** @type {Error} */ (e).message}.`);
  }
}

/** An entry whose content must still be what the manifest says (the file may have changed since it was opened). @param {ZipReader} zip @param {string} name @param {string} hash */
async function readChecked(zip, name, hash) {
  const bytes = await readEntry(zip, name);
  if ((await sha256Hex(bytes)) !== hash) throw new ArchiveError(`This file is damaged: ${name} was changed.`);
  return bytes;
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
 * Imports an opened archive: everything or nothing. Content is stored one entry at a time,
 * then one transaction makes it all appear (see below).
 * Trips default to "new". "me", settings and plugins default to "keep".
 * @param {Store} store
 * @param {OpenedArchive} opened
 * @param {{ trips?: Record<string, 'new'|'replace'|'skip'>, me?: 'keep'|'replace', settings?: 'keep'|'replace',
 *   plugins?: 'keep'|'replace', secrets?: boolean, now?: number }} [choices]
 */
export async function importArchive(store, { manifest, zip, events: logs }, choices = {}) {
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
      continue; // kept, or the system log or this device's own scope, which belong to the device they came from
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
        try { state = JSON.parse(text(await readEntry(zip, f.name))); } catch { /* treat as empty */ }
        const off = Object.fromEntries(Object.entries(state ?? {}).map(([id, s]) => [id, { ...s, enabled: false }]));
        const bytes = utf8(JSON.stringify(off, null, 2) + '\n');
        overrides.set(f.name, { bytes, hash: await sha256Hex(bytes) });
      }
    }
  }
  /** @type {{ id: string, value: any }[]} */
  const secrets = (choices.secrets && manifest.secrets ? JSON.parse(text(await readEntry(zip, manifest.secrets))) : [])
    // Never this device's own secrets, even from an archive made before annai left them out.
    .filter((/** @type {any} */ s) => typeof s?.id === 'string' && !isDeviceSecret(s.id));

  const result = {
    trips: /** @type {string[]} */ ([]), archived: /** @type {string[]} */ ([]), me: false, settings: false, plugins: false, secrets: 0,
    /** ids of API keys in the file that were not imported because this device already has a key with that id */
    keptSecrets: /** @type {string[]} */ ([]),
  };

  // Content first, one entry at a time, each in its own transaction (spec §12.1: an archive
  // needn't fit in memory). Blobs are stored by their hash and nothing points at them yet, so
  // until the last step nothing is visible; if any step fails, the ones stored here go again.
  /** @type {Map<string, { name: string, type: string, bytes?: Uint8Array }>} */
  const content = new Map();
  for (const p of plan) {
    for (const f of p.files) {
      const o = overrides.get(f.name);
      content.set(o?.hash ?? f.hash, { name: f.name, type: f.type, bytes: o?.bytes });
    }
  }
  for (const b of manifest.blobs) if (!content.has(b.hash)) content.set(b.hash, { name: b.name, type: b.type });
  /** @type {string[]} */
  const added = [];
  try {
    for (const [hash, c] of content) {
      if (await store.tx(['blobs'], 'readonly', (t) => t.hasBlob(hash))) continue;
      const bytes = c.bytes ?? (await readChecked(zip, c.name, hash));
      await store.tx(['blobs'], 'readwrite', (t) => t.putBlob({ hash, type: c.type, size: bytes.byteLength, data: ownBuffer(bytes) }));
      added.push(hash);
    }
    await commitImport(store, { manifest, plan, overrides, secrets, now, result, hashes: [...content.keys()] });
  } catch (e) {
    await removeUnused(store, added).catch(() => {});
    throw e;
  }
  return result;
}

/**
 * The last step of an import, in one transaction: scopes, files, history and keys appear together or not at all.
 * @param {Store} store
 * @param {{ manifest: Manifest, plan: { rec: ScopeRecord, target: string, mode: 'new'|'replace'|'system', files: ManifestFile[], events: EventRecord[] }[],
 *   overrides: Map<string, { bytes: Uint8Array, hash: string }>, secrets: { id: string, value: any }[], now: number, hashes: string[],
 *   result: { trips: string[], archived: string[], me: boolean, settings: boolean, plugins: boolean, secrets: number, keptSecrets: string[] } }} job
 */
async function commitImport(store, { manifest, plan, overrides, secrets, now, result, hashes }) {
  await store.tx(['blobs', 'files', 'events', 'scopes', 'secrets'], 'readwrite', async (t) => {
    // Content stored earlier, or found already here, may have gone since: a trip removed meanwhile (spec §4.9).
    for (const h of hashes) {
      if (!(await t.hasBlob(h))) throw new ArchiveError("Part of this file's content was removed from this device while it was importing, so nothing was imported. Import it again.");
    }
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
      const { backup: _b, ...rec } = p.rec; // this device hasn't backed it up
      await t.putScope({ ...rec, id: p.target, kind, status: 'active', updated: now });
      for (const f of p.files) {
        const o = overrides.get(f.name);
        const hash = o?.hash ?? f.hash;
        const size = o?.bytes.byteLength ?? f.size;
        await t.putFile({
          scope: p.target, path: f.path, hash, size, type: f.type, author: f.author,
          created: f.created, modified: f.modified, ...(f.source ? { source: f.source } : {}), ...(f.meta ? { meta: f.meta } : {}),
        });
      }
      for (const e of p.events) await t.putEvent({ ...e, scope: p.target });
      await t.appendEvent(p.target, { ts: now, type: 'import', actor: 'user', data: { created: manifest.created, app: manifest.app, kind: manifest.kind } });
      if (p.rec.kind === 'trip') result.trips.push(p.target);
      else if (p.target === ME) result.me = true;
      else if (p.target === SYS_SETTINGS) result.settings = true;
      else if (p.target === SYS_PLUGINS) result.plugins = true;
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
}

/**
 * Deletes blobs an import stored before it failed, unless a file or a log entry now uses them.
 * @param {Store} store @param {string[]} hashes
 */
async function removeUnused(store, hashes) {
  if (!hashes.length) return;
  await store.tx(['scopes', 'files', 'events', 'blobs'], 'readwrite', async (t) => {
    for (const h of hashes) if (!(await t.blobInUse(h))) await t.deleteBlob(h);
  });
}

/**
 * "annai-<slug>-<yyyy-mm-dd>.annai.zip", or ".annai" when encrypted: the day where the phone is (tz).
 * @param {{ kind: 'trip'|'everything', title?: string, encrypted: boolean, now: number, tz?: string }} o
 */
export function archiveName({ kind, title, encrypted, now, tz = deviceZone() }) {
  const day = dayIn(now, tz);
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
