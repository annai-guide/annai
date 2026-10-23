import { sha256Hex } from '../hash.js';
import { utf8, text, ownBuffer } from '../bytes.js';
import { blobsOf, isName } from '../events.js';
import { reachable, refused } from '../reach.js';

/**
 * Writing the conversation (spec §4.5). Each step is one event. Its long texts, and any bytes it
 * keeps, are blobs it names in refs, written in the same transaction (§4.9). It may also point at
 * content already stored, such as a photo file's.
 * @typedef {import('../types.js').Store} Store
 */

/** Texts up to this many characters stay in the event; longer ones become blobs. */
export const INLINE_MAX = 2000;
/** The model.turn tag of Shiori's own turns: only these make up the conversation (Kokoro's too, when she is two halves). */
export const TALK_TAG = 'conversation';
/** The model.turn tag of Koe's turns, when Shiori is two halves (the Koe and Kokoro design). */
export const KOE_TAG = 'koe';

/**
 * @param {Store} store @param {string} scope
 * @param {{ type: string, actor: string, data: Record<string, any>, texts?: [string, string][], blobs?: { hash?: string, bytes?: Uint8Array, type: string }[], now?: number }} e
 *   texts: [name, text]; a short text goes in data[name], a long one is stored and named in data.stored.
 *   blobs: content the event points at, by hash (already stored) or as bytes (stored now).
 * @returns {Promise<any>} the event as stored, with its seq
 */
export async function record(store, scope, { type, actor, data, texts = [], blobs = [], now = Date.now() }) {
  /** @type {Record<string, any>} */
  const out = { ...data };
  /** @type {string[]} */
  const stored = [];
  /** @type {{ hash: string, bytes: Uint8Array, type: string }[]} */
  const keep = [];
  /** @type {string[]} */
  const textRefs = [];
  for (const [name, value] of texts) {
    if (!value) continue;
    if (value.length <= INLINE_MAX) {
      out[name] = value;
      continue;
    }
    const bytes = utf8(value);
    const hash = await sha256Hex(bytes);
    keep.push({ hash, bytes, type: 'text/plain; charset=utf-8' });
    stored.push(name);
    textRefs.push(hash);
  }
  /** @type {string[]} */
  const blobRefs = [];
  for (const b of blobs) {
    // Bytes are kept under their own hash, never one given beside them (that would name, or overwrite, other content).
    const hash = b.bytes ? await sha256Hex(b.bytes) : b.hash ?? '';
    if (b.bytes && b.hash && b.hash !== hash) throw new Error(`The content given as ${b.hash.slice(0, 12)}… has another fingerprint.`);
    if (!b.bytes && hash && !isName(hash)) throw new Error(`The content ${hash.slice(0, 12)}… is not stored.`);
    if (!hash) continue;
    blobRefs.push(hash);
    if (b.bytes) keep.push({ hash, bytes: b.bytes, type: b.type });
  }
  if (stored.length) out.stored = stored;
  const refs = [...textRefs, ...blobRefs];
  const ev = { ts: now, type, actor, data: out, ...(refs.length ? { refs } : {}) };
  const brought = new Set(keep.map((k) => k.hash));
  const named = blobsOf(ev).filter((h) => !brought.has(h));
  /** @type {string | null} another scope's content this entry tried to name */
  let denied = null;
  try {
    return await store.tx(named.length ? ['blobs', 'events', 'files'] : ['blobs', 'events'], 'readwrite', async (t) => {
      denied = null; // a store that tries again starts over
      for (const k of keep) {
        if (!(await t.hasBlob(k.hash))) await t.putBlob({ hash: k.hash, type: k.type, size: k.bytes.byteLength, data: ownBuffer(k.bytes) });
      }
      // Content named by its hash alone must be stored (spec §4.9), and the scope's own (§4.1): never another trip's.
      for (const h of named) {
        const own = await reachable(t, scope, h);
        if (own && (!blobRefs.includes(h) || (await t.hasBlob(h)))) continue;
        if (!own && (await t.hasBlob(h))) denied = h;
        throw new Error(`The content ${h.slice(0, 12)}… is not stored.`);
      }
      return t.appendEvent(scope, ev);
    });
  } finally {
    if (denied) await refused(store, scope, denied, type);
  }
}

/**
 * The texts an event keeps as blobs, by name (data.stored lines up with the start of refs). They are the entry's own names,
 * so its scope reaches them by the rule reach.js keeps: nothing else is looked up. @param {Store} store @param {any} e a log entry as stored
 */
export async function storedTexts(store, e) {
  /** @type {string[]} */
  const names = e.data?.stored ?? [];
  if (!names.length) return /** @type {Record<string, string>} */ ({});
  return store.tx(['blobs'], 'readonly', async (t) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [i, name] of names.entries()) {
      const h = e.refs?.[i];
      const b = isName(h) ? await t.getBlob(h) : undefined; // an entry that names none, or a name an import left empty
      if (b) out[name] = text(new Uint8Array(b.data));
    }
    return out;
  });
}
