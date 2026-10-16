import { sha256Hex } from '../hash.js';
import { utf8, text, ownBuffer } from '../bytes.js';

/**
 * Writing the conversation (spec §4.5). Each step is one event. Its long texts, and any bytes it
 * keeps, are blobs it names in refs, written in the same transaction (§4.9). It may also point at
 * content already stored, such as a photo file's.
 * @typedef {import('../types.js').Store} Store
 */

/** Texts up to this many characters stay in the event; longer ones become blobs. */
export const INLINE_MAX = 2000;
/** The model.turn tag of Shiori's own turns: only these make up the conversation. */
export const TALK_TAG = 'conversation';

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
    const hash = b.hash ?? (b.bytes ? await sha256Hex(b.bytes) : '');
    if (!hash) continue;
    blobRefs.push(hash);
    if (b.bytes) keep.push({ hash, bytes: b.bytes, type: b.type });
  }
  if (stored.length) out.stored = stored;
  const refs = [...textRefs, ...blobRefs];
  const ev = { ts: now, type, actor, data: out, ...(refs.length ? { refs } : {}) };
  return store.tx(['blobs', 'events'], 'readwrite', async (t) => {
    for (const k of keep) {
      if (!(await t.hasBlob(k.hash))) await t.putBlob({ hash: k.hash, type: k.type, size: k.bytes.byteLength, data: ownBuffer(k.bytes) });
    }
    return t.appendEvent(scope, ev);
  });
}

/** The texts an event keeps as blobs, by name (data.stored lines up with the start of refs). @param {Store} store @param {any} e */
export async function storedTexts(store, e) {
  /** @type {string[]} */
  const names = e.data?.stored ?? [];
  if (!names.length) return /** @type {Record<string, string>} */ ({});
  return store.tx(['blobs'], 'readonly', async (t) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [i, name] of names.entries()) {
      const b = await t.getBlob(e.refs?.[i]);
      if (b) out[name] = text(new Uint8Array(b.data));
    }
    return out;
  });
}

/** @param {Store} store @param {string} hash @returns {Promise<Uint8Array | null>} */
export async function blobBytes(store, hash) {
  const b = await store.tx(['blobs'], 'readonly', (t) => t.getBlob(hash));
  return b ? new Uint8Array(b.data) : null;
}
