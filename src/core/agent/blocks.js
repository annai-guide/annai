/**
 * What one half reads of the other (the Koe and Kokoro design, "What each half sees"): Kokoro reads
 * the conversation as labelled blocks, the words in them quoted, and Koe reads Kokoro's notes inside
 * a marker nobody else can write: it carries Koe's session nonce, and every other text Koe reads has
 * its angle brackets escaped (plan decision 14; the security reviews of K1).
 */

/** The longest text Koe reads from one place, cut before anything else is done with it (a guard). */
export const MAX_TEXT = 100_000;

/**
 * Text that isn't annai's own, as Koe reads it: its angle brackets made look-alikes, so no tag of any
 * spelling survives, a marker least of all (the security reviews of K1). Linear, and cut to MAX_TEXT first.
 * @param {string} text
 */
export function escapeTags(text) {
  const s = String(text ?? '');
  return (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s).replace(/</g, '‹').replace(/>/g, '›');
}

/** Words inside a label, quoted, so a label or a new line in them can't pass for annai's. @param {unknown} text */
export const quote = (text) => JSON.stringify(String(text ?? ''));

/**
 * A note from Kokoro as Koe reads it: annai's own marker, with Koe's session nonce, which Koe's
 * instructions say is the only one to trust, around words that can't close it.
 * @param {string} text @param {string} nonce
 */
export function wrapNote(text, nonce) {
  return `<from_kokoro id="${nonce}">${escapeTags(text)}</from_kokoro>`;
}

/** A nonce for Koe's session: fresh each time annai starts, so text from anywhere else can't carry it. */
export function newNonce() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A note from Koe is a question when it ends with "?", otherwise a note. @param {string} text @returns {'asks' | 'notes'} */
export function asksOrNotes(text) {
  return /\?\s*$/.test(String(text ?? '')) ? 'asks' : 'notes';
}

/** A card in a line: its title and text, else what it holds, cut. @param {any} card */
export function cardText(card) {
  const c = card && typeof card === 'object' ? card : {};
  const words = [c.title, c.text].filter((x) => typeof x === 'string' && x.trim()).join(': ');
  const out = words || JSON.stringify(c);
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** An ask in a line: the question and its options, quoted. @param {any} d */
const askText = (d) => `${quote(d.question)} (options: ${JSON.stringify((Array.isArray(d.options) ? d.options : []).map(String))})`;

/**
 * Kokoro's block for an event of the conversation it didn't write: what the user typed (to Koe), what
 * Koe said, showed and asked, Koe's notes, and annai's instruction blocks. Null: not a block of Kokoro's.
 * @param {any} e @param {Record<string, string>} texts its texts, stored ones included
 * @returns {string | null}
 */
export function blockFor(e, texts) {
  const d = e.data ?? {};
  const text = String(texts.text ?? '');
  if (e.type === 'msg.user' && d.split) {
    if (d.chose) return `[the user chose] ${quote(text)}`;
    if (d.images?.length) return text && text !== '(a photo)' ? `[the user sent a photo] ${quote(text)}` : '[the user sent a photo]';
    return `[the user typed] ${quote(text)}`;
  }
  if (d.half === 'koe' && e.type === 'out.speak') return `${d.voice ? '[Koe said aloud]' : '[Koe said]'} ${quote(text)}`;
  if (d.half === 'koe' && e.type === 'out.show') return `[Koe showed] ${quote(cardText(d.card))}`;
  if (d.half === 'koe' && e.type === 'out.ask') return `[Koe asked] ${askText(d)}`;
  if (e.type === 'note' && d.from === 'koe') return `[Koe ${asksOrNotes(text)}] ${quote(text)}`;
  if (e.type === 'halves') return `[annai] ${text}`;
  return null;
}

/**
 * Koe's line for what Shiori said to the user without it (Kokoro talking directly, while Koe was down
 * or before Shiori was two halves), so Koe knows what was said. Null: not one.
 * @param {any} e @param {Record<string, string>} texts @returns {string | null}
 */
export function saidWithout(e, texts) {
  const d = e.data ?? {};
  if (d.half === 'koe') return null;
  if (e.type === 'out.speak') return `[said to the user] ${quote(texts.text)}`;
  if (e.type === 'out.show') return `[shown to the user] ${quote(cardText(d.card))}`;
  if (e.type === 'out.ask') return `[asked the user] ${askText(d)}`;
  return null;
}
