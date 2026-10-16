/**
 * Image refusals (spec §4.8, §9.9): the usual messages are read by rules; the utility model reads
 * unfamiliar ones. A request over a model's photo count sends the oldest photos as stubs.
 * @typedef {{ maxBytes?: number, maxEdge?: number, formats?: string[], maxCount?: number }} Learned
 * @typedef {import('../llm/contract.js').Message} Message
 */

const FORMAT_NAMES = /** @type {Record<string, string>} */ ({ jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic' });

/** @param {string} message @returns {Learned | null} */
export function readRefusal(message) {
  const m = String(message ?? '');
  /** @type {Learned} */
  const out = {};
  const bytes = /(\d{3,})\s*bytes\s*$/i.exec(m.replace(/[.)\s]+$/, '')) ?? />\s*(\d{3,})\s*bytes/i.exec(m);
  const mb = /(?:exceeds?|limit of|at most|maximum(?: of)?|max(?:imum)?(?: size)?(?: is)?)\D{0,20}(\d+(?:\.\d+)?)\s*(MB|MiB|KB|KiB)\b/i.exec(m)
    ?? /(\d+(?:\.\d+)?)\s*(MB|MiB|KB|KiB)\s*(?:maximum|max|limit)/i.exec(m);
  if (bytes && /exceed|too large|maximum|max|limit/i.test(m)) out.maxBytes = Number(bytes[1]);
  else if (mb) out.maxBytes = Math.floor(Number(mb[1]) * (/^K/i.test(mb[2]) ? 1000 : 1_000_000));
  const edge = /(\d{3,5})\s*(?:px|pixels)/i.exec(m);
  if (edge && /dimension|size|edge|width|height|pixels/i.test(m)) out.maxEdge = Number(edge[1]);
  if (/format|mime|type|supported/i.test(m)) {
    const found = [...m.matchAll(/image\/(jpeg|jpg|png|gif|webp|avif|heic)|\b(jpeg|jpg|png|gif|webp|avif|heic)\b/gi)].map((x) => FORMAT_NAMES[(x[1] ?? x[2]).toLowerCase()]);
    if (found.length) out.formats = [...new Set(found)];
  }
  const count = /(?:max(?:imum)?(?: is)?|at most|up to)\D{0,10}(\d+)\s*(?:images|\.?\s*$)|(\d+)\s*images?\s*(?:max|maximum|at most)/i.exec(m);
  if (count && /image/i.test(m) && /many|count|max|at most|up to/i.test(m) && !out.maxBytes && !out.maxEdge) out.maxCount = Number(count[1] ?? count[2]);
  return Object.keys(out).length ? out : null;
}

/** The photos over the count, oldest first, sent as stubs. @param {Message[]} messages @param {number | null | undefined} maxCount */
export function limitImages(messages, maxCount) {
  if (!maxCount) return messages;
  const total = messages.reduce((n, m) => n + m.parts.filter((p) => p.type === 'image').length, 0);
  let drop = total - maxCount;
  if (drop <= 0) return messages;
  return messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => {
      if (p.type !== 'image' || drop <= 0) return p;
      drop--;
      return { type: /** @type {const} */ ('text'), text: `[photo ${p.path ?? ''}, not sent again: read it to see it]`.replace('photo ,', 'photo,') };
    }),
  }));
}

/** The smaller of two limits each, for saving what a refusal taught. @param {Learned} a @param {Learned} b @returns {Learned} */
export function stricter(a, b) {
  /** @type {Learned} */
  const out = { ...a };
  for (const k of /** @type {const} */ (['maxBytes', 'maxEdge', 'maxCount'])) {
    if (b[k] !== undefined) out[k] = a[k] === undefined ? b[k] : Math.min(/** @type {number} */ (a[k]), /** @type {number} */ (b[k]));
  }
  if (b.formats?.length) out.formats = a.formats?.length ? a.formats.filter((f) => b.formats?.includes(f)) : [...b.formats];
  return out;
}

/** Whether b says anything stricter than a. @param {Learned} a @param {Learned} b */
export function tighter(a, b) {
  return (['maxBytes', 'maxEdge', 'maxCount']).some((k) => /** @type {any} */ (b)[k] !== undefined && (/** @type {any} */ (a)[k] === undefined || /** @type {any} */ (b)[k] < /** @type {any} */ (a)[k]))
    || Boolean(b.formats?.length && (!a.formats?.length || a.formats.some((f) => !b.formats?.includes(f))));
}
