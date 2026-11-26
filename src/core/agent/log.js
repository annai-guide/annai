import { sha256Hex } from '../hash.js';
import { utf8, text, toBytes } from '../bytes.js';
import { blobsOf, isName } from '../events.js';
import { reachable, refused } from '../reach.js';
import { keepBlob } from '../workspace.js';
import { talks } from '../scopes.js';

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
 * Whether a record ends a turn of hers (one Shiori's, or Kokoro's: Koe's records carry half: 'koe' and never count, it neither reads files nor files them),
 * as the conversation is read (Transcript.apply): the loop's `turn.end`, or, in a log from before the loop wrote one (cc3615ae3, 2026-11-14: its replies
 * have no `endLogged` key), a reply of hers that a model answered. A turn that was stopped, cut at its work or failed has neither, whatever it answered
 * before. @param {{ type: string, data?: any }} e
 */
export function endsHerTurn(e) {
  const d = e.data ?? {};
  if (e.type === 'turn.end') return d.half !== 'koe';
  return e.type === 'model.turn' && d.tag === TALK_TAG && !('endLogged' in d) && Boolean(d.answeredBy);
}

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
    // Bytes are kept as they are, under their own hash, never one given beside them (that would name, or overwrite,
    // other content); a string or an ArrayBuffer is made bytes first, so what is stored is what was hashed.
    /** @type {Uint8Array | undefined} */
    let bytes;
    try {
      bytes = b.bytes === undefined ? undefined : toBytes(b.bytes);
    } catch {
      /* en */ throw new Error("The content given isn't bytes: give a Uint8Array, an ArrayBuffer or a string.");
    }
    const hash = bytes ? await sha256Hex(bytes) : b.hash ?? '';
    if (bytes && b.hash && b.hash !== hash) /* en */ throw new Error(`The content given as ${b.hash.slice(0, 12)}… has another fingerprint.`);
    if (!bytes && hash && !isName(hash)) /* en */ throw new Error(`The content ${hash.slice(0, 12)}… is not stored.`);
    if (!hash) continue;
    blobRefs.push(hash);
    if (bytes) keep.push({ hash, bytes, type: b.type });
  }
  if (stored.length) out.stored = stored;
  const refs = [...textRefs, ...blobRefs];
  const ev = { ts: now, type, actor, data: out, ...(refs.length ? { refs } : {}) };
  const brought = new Set(keep.map((k) => k.hash));
  const named = blobsOf(ev).filter((h) => !brought.has(h));
  // A user's line stamps its trip's record; one with no talked key isn't filled yet, and backfillTrips reads the log for it.
  const said = talks({ type, data });
  /** @type {string | null} another scope's content this entry tried to name */
  let denied = null;
  try {
    return await store.tx(/** @type {import('../types.js').StoreName[]} */ (['blobs', 'events', ...(named.length ? ['files'] : []), ...(said ? ['scopes'] : [])]), 'readwrite', async (t) => {
      denied = null; // a store that tries again starts over
      for (const k of keep) await keepBlob(t, k.hash, k.type, k.bytes);
      // Content named by its hash alone must be stored (spec §4.9), and the scope's own (§4.1): never another trip's.
      for (const h of named) {
        const own = await reachable(t, scope, h);
        if (own && (!blobRefs.includes(h) || (await t.hasBlob(h)))) continue;
        if (!own && (await t.hasBlob(h))) denied = h;
        /* en */ throw new Error(`The content ${h.slice(0, 12)}… is not stored.`);
      }
      const done = await t.appendEvent(scope, ev);
      const rec = said ? await t.getScope(scope) : null;
      if (rec?.kind === 'trip' && 'talked' in rec) await t.putScope({ ...rec, talked: now });
      return done;
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

/** A tool.call entry's input as JSON text: a long one is stored whole as text (data.input is then that text already). @param {Record<string, any>} d the entry's data, with its stored texts merged in */
export const inputText = (d) => (typeof d.input === 'string' ? d.input : JSON.stringify(d.input ?? {}));
