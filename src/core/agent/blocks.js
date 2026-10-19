/**
 * What one half reads of the other (the Koe and Kokoro design, "What each half sees"): Kokoro reads
 * the conversation as labelled blocks, the words in them quoted, and Koe reads Kokoro's notes inside
 * markers that nobody else can write, since they are stripped from everything else it reads (plan
 * decision 14; the security review of K1).
 */

/** Brackets a model may read as a tag's. */
const OPEN = '<‹〈＜《⟨';
const CLOSE = '>›〉＞》⟩';
/** A marker-like tag: any bracket, a slash, the name with any separator and case, attributes, and the closing bracket if there is one. */
const TAG = new RegExp(`[${OPEN}]\\s*\\/?\\s*from[\\s_-]*kokoro\\b[^${OPEN}${CLOSE}]*[${CLOSE}]?`, 'gi');
/** The marker's own name, bare: never in prose, so it goes too, with the brackets around it. */
const NAME = new RegExp(`[${OPEN}]?\\s*\\/?\\s*from_kokoro\\b\\s*\\/?\\s*[${CLOSE}]?`, 'gi');

/**
 * Text without the note markers, in any case, spacing or bracket, so a note can't be faked or broken
 * out of. Stripped until nothing changes: a marker hidden inside another is taken out too.
 * @param {string} text
 */
export function stripMarkers(text) {
  let out = String(text ?? '');
  for (let was = ''; was !== out;) {
    was = out;
    out = out.replace(TAG, '').replace(NAME, '');
  }
  return out;
}

/** Words inside a label, quoted, so a label or a new line in them can't pass for annai's. @param {unknown} text */
export const quote = (text) => JSON.stringify(String(text ?? ''));

/** A note from Kokoro as Koe reads it, wrapped once. @param {string} text */
export function wrapNote(text) {
  return `<from_kokoro>${stripMarkers(text)}</from_kokoro>`;
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
