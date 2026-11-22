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

/** A copy of a picture sent at an earlier place in the request. @param {any} p */
/* en */
const same = (p) => ({ type: /** @type {const} */ ('text'), text: p.page ? `[page ${p.page} of the PDF, the same picture as above]` : `[photo${p.path ? ` ${p.path}` : ''}, the same as above]` });
/** A picture left out, and how she sees it again (one with no path came from a tool's result: that tool shows it again). @param {any} p @param {boolean} byCount the count left it out, not the window */
/* en */
const notSent = (p, byCount) => ({ type: /** @type {const} */ ('text'), text: p.page ? (byCount ? `[page ${p.page} of the PDF above, not sent: this model takes fewer pictures at a time]` : `[page ${p.page} of the PDF above, not sent again: read the PDF to see it]`)
  : !p.path ? '[a picture from a tool\'s result, not sent again: read can\'t bring it back; call that tool again to see it]'
    : p.region ? `[photo ${p.path}, the part ${JSON.stringify(p.region)}, not sent again: read it with that region to see it]` : `[photo ${p.path}, not sent again: read it to see it]` });

/**
 * The pictures a request sends to a model (spec §4.8): one rule, applied once, per model, to the request as the conversation holds it.
 * From `from` on (Transcript.windowFrom: this turn's messages and the turn before's) the distinct pictures (by hash; one without a hash is its
 * own) are ranked by their newest appearance, and the model's count of them kept, newest first; within one message, its PDF's pages give way
 * before its own photos, the last page the first to go. Each goes at its earliest place from `from` on. Every other copy is a stub, a copy before
 * `from` for good, so one read again goes at the read's own place and nothing earlier changes: "the same as above", or "not sent" for a picture left out.
 * @param {Message[]} messages @param {number | null | undefined} [maxCount] none: every distinct picture, each once
 * @param {number} [from] none (a request outside a conversation's turns: a reader's, the recap's): every picture
 * @returns {Message[]}
 */
export function limitImages(messages, maxCount, from = 0) {
  /** @typedef {{ mi: number, pi: number, p: any, key: string }} Seen */
  /** @type {Seen[]} */
  const seen = [];
  messages.forEach((m, mi) => m.parts.forEach((p, pi) => {
    if (p.type === 'image') seen.push({ mi, pi, p, key: p.hash ? `h:${p.hash}` : `#${seen.length}` });
  }));
  /** @type {Map<string, { first: Seen, last: Seen }>} */
  const pictures = new Map();
  for (const s of seen) {
    if (s.mi < from) continue;
    const had = pictures.get(s.key);
    if (had) had.last = s;
    else pictures.set(s.key, { first: s, last: s });
  }
  /** Newer first: a later message; in one message its photos (the later first) before its PDF's pages (page 1 first). @param {Seen} s */
  const rank = (s) => [s.mi, s.p.page ? 0 : 1, s.p.page ? -s.p.page : s.pi];
  const newer = (/** @type {Seen} */ a, /** @type {Seen} */ b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  };
  const kept = new Set([...pictures.values()].sort((a, b) => newer(a.last, b.last)).slice(0, maxCount || Infinity).map((x) => x.first));
  if (kept.size === seen.length) return messages;
  const keptKeys = new Set([...kept].map((s) => s.key));
  const at = new Map(seen.map((s) => [`${s.mi}:${s.pi}`, s]));
  return messages.map((m, mi) => ({
    ...m,
    parts: m.parts.map((p, pi) => {
      const s = at.get(`${mi}:${pi}`);
      if (!s || kept.has(s)) return p;
      if (s.mi < from) return notSent(p, false);
      return keptKeys.has(s.key) ? same(p) : notSent(p, true);
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
