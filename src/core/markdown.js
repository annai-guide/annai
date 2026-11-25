import { ADDRESS_ENDS } from './address-ends.js';

/**
 * annai's own small Markdown reader (spec §15): model output becomes data, never HTML. Paragraphs, headings, lists, code blocks; bold, italic, code
 * and links to http(s) addresses; a link to anything else by its name (a phone or mail link with its number or address). Anything else, HTML included, is text. Drawn by src/ui/markdown.js; read as plain words by plainWords.
 * @typedef {{ t: 'text', v: string } | { t: 'b', c: Inline[] } | { t: 'i', c: Inline[] } | { t: 'code', c: string } | { t: 'a', href: string, c: Inline[] }} Inline
 * @typedef {{ t: 'p', c: Inline[] } | { t: 'h', c: Inline[] } | { t: 'ul', items: Inline[][] } | { t: 'ol', items: Inline[][] } | { t: 'pre', v: string }} Block
 */

export const MD_MAX = 20_000;
// A bare address runs to whitespace, `<`, `>`, an unpaired parenthesis, a `[ ] { } |` (MediaWiki refuses them in a title; so an IP-literal address, http://[::1]/,
// doesn't link) or a mark of ADDRESS_ENDS; a pair of parentheses that closes (one level of it, GFM's rule) stays in it; a last `.,;:!?'"` stays out, as a sentence's
// own stop. A `_` opens or closes italics only at the edge of a word of Latin letters or digits (CommonMark's; `_重要_` in Japanese or Chinese is italics).
// A `*`, `**` or `_` opens only before a non-space and closes only after one: the whitespace half of CommonMark's flanking rule (its punctuation half is left out,
// which is right for Japanese: `**「重要」**です` draws). What keeps a code's stars, with or without a space before them (`*1234# then *9#`, `*100*1#`, `*67,*82`, and
// `*1234#です。次に*9#` in Japanese or Chinese), is the digit rule: a `*` straight before a digit (of any script) or `#` neither opens italics nor closes them, so such a star is
// never an italic's (a code's star after its digits, `1234*`, has no such guard); the cost is an italic that starts or ends at a digit (`*3 nights*`, `*大人*1000円`), which shows its stars. A bold closes at the first `**` after it, and only when no space stands before that `**` (else it doesn't draw); of three
// stars, it closes on the last two when a word comes before them (`***very***` closes, `Card ***1234 and ***5678` doesn't), and it holds any other star as text (`**Gate code: *1234#**`,
// `**3 * 4 = 12**`); its inside is read again by these rules (`**a *b* c**`).
// A link's address may hold a space (`Big Sur`) but not before a quote, which starts a title (`[a](x 'title')` reads as `"title"` does: the address, then the words), and one with a space is a
// link only to http(s), `tel:` or `mailto:` (`[sic](and then left)` is words in brackets, then words in parentheses, as written).
// A `\` before ASCII punctuation is CommonMark's escape and reads as the mark alone, outside a code span, an address, and an emphasis opened before it (which has taken the star).
const WORD = String.raw`[\p{Script=Latin}\p{N}]`;
const IN_ADDRESS = String.raw`[^\s<>()\[\]{}|${ADDRESS_ENDS}]`;
const PAIR = String.raw`\(${IN_ADDRESS}*\)`;
const LINK_CHAR = String.raw`(?!\s['"])[^()\n"]`; // no quote, and no space before one: that is a title's
const LINK_ADDRESS = String.raw`(?:${LINK_CHAR}|\((?:${LINK_CHAR})*\))+`;
const INLINE = new RegExp([
  '`([^`\\n]+)`',
  String.raw`\*\*(?!\s)((?:[^*\n]|\*(?!\*)|(?<![*\s])\*(?=\*\*(?!\*)))+)(?<!\s)\*\*`,
  String.raw`\*(?![\s\p{Nd}#])([^*\n]+)(?<!\s)\*(?![\p{Nd}#])`,
  String.raw`(?<!${WORD})_(?!\s)([^_\n]+)(?<!\s)_(?!${WORD})`,
  String.raw`\[([^\[\]\n]+)\]\((?=\s*(?:https?|tel|mailto):|(?:[^\s()"]|\([^\s()"]*\))+\))(${LINK_ADDRESS})\)`,
  String.raw`(https?:\/\/(?:${IN_ADDRESS}|${PAIR})*(?:[^\s<>()\[\]{}|.,;:!?'"${ADDRESS_ENDS}]|${PAIR}))`,
  String.raw`\\([!-\/:-@\[-\x60{-~])`,
].join('|'), 'gu');

/** An http(s) address, or null. @param {string} href */
function safeHref(href) {
  try {
    const u = new URL(href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * What a phone or mail link adds to its name, so the number or address reaches the traveller though the link is not drawn: ` (+81-00-0000-0000)`, not when the name holds it
 * already (a number is compared by its digits as written, so a local and an international form of one number show both; an address without regard to case), and a
 * `mailto:`'s `?subject=…` left out; '' for any other link.
 * @param {string} name the link's name as written @param {string} dest its destination
 */
function reach(name, dest) {
  const m = /^\s*(tel|mailto):([^?]*)/i.exec(dest);
  if (!m) return '';
  const to = m[2].trim();
  const held = m[1].toLowerCase() === 'tel' ? name.replace(/\P{Nd}/gu, '').includes(to.replace(/\P{Nd}/gu, '')) : name.toLowerCase().includes(to.toLowerCase());
  return held ? '' : ` (${to})`;
}

/** @param {string} s @param {boolean} [inLink] the text of a [link](address): its own bare addresses stay text, not a link in a link @returns {Inline[]} */
export function parseInline(s, inLink = false) {
  /** @type {Inline[]} */
  const out = [];
  const text = (/** @type {string} */ v) => {
    if (!v) return;
    const last = out.at(-1);
    if (last?.t === 'text') last.v += v;
    else out.push({ t: 'text', v });
  };
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    text(s.slice(at, m.index));
    at = /** @type {number} */ (m.index) + m[0].length;
    if (m[1] !== undefined) out.push({ t: 'code', c: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'b', c: parseInline(m[2], inLink) });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'i', c: parseInline(m[3] ?? m[4], inLink) });
    else if (m[5] !== undefined) {
      const href = safeHref(m[6]);
      if (href) out.push({ t: 'a', href: m[6] === href ? m[6] : href, c: parseInline(m[5], true) });
      else { // tel:, mailto:, a path, a script: by its name, never a link
        for (const x of parseInline(m[5], inLink)) if (x.t === 'text') text(x.v); else out.push(x);
        text(reach(m[5], m[6]));
      }
    } else if (m[7] !== undefined) {
      const href = inLink ? null : safeHref(m[7]);
      if (href) out.push({ t: 'a', href: m[7], c: [{ t: 'text', v: m[7] }] });
      else text(m[0]);
    } else text(m[8]);
  }
  text(s.slice(at));
  return out;
}

/** @param {string} src @returns {Block[]} */
export function parseMarkdown(src) {
  let s = String(src ?? '');
  if (s.length > MD_MAX) s = `${s.slice(0, MD_MAX)}…`;
  /** @type {Block[]} */
  const blocks = [];
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      blocks.push({ t: 'pre', v: body.join('\n') });
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ t: 'h', c: parseInline(line.replace(/^#{1,6}\s+/, '')) });
      i++;
    } else if (/^\s*[-*]\s/.test(line) || /^\s*\d+[.)]\s/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
      const items = [];
      for (; i < lines.length && re.test(lines[i]); i++) items.push(parseInline(lines[i].replace(re, '')));
      blocks.push(ordered ? { t: 'ol', items } : { t: 'ul', items });
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i]); i++) para.push(lines[i]);
      blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    }
  }
  return blocks;
}

/**
 * An address as words: its site as written (no scheme, no `www.`, cut at the first `/ ? # :`; not URL's punycode), then the parts of its path that hold other
 * than ASCII, percent-decoded (`+` a space; each run of escapes on its own, so one stray `%` loses nothing else): a title in Japanese or Cyrillic, or the words written right after it with no space, which the parser took into it (a known limitation),
 * so a Japanese answer keeps them. @param {string} address
 */
function addressWords(address) {
  const bare = address.replace(/^https?:\/\//i, '');
  const [site] = bare.split(/[/?#:]/);
  const path = bare.slice(site.length).replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run; // a cut or foreign escape: as written
    }
  });
  return [site.replace(/^www\./i, ''), ...path.split(/[/?#&=]/).filter((p) => /\P{ASCII}/u.test(p)).map((p) => p.replace(/_/g, ' '))].join(' ');
}

/**
 * A model's Markdown as plain words, for what draws no link and no mark: the card annai shows Kokoro's words in, and the voice (loop.js remind). The drawer's
 * reading, as words, one line at a time (every rule of the inline reader is within a line): a link by its name, one named by its address (a bare one) by
 * addressWords; no marks of bold, italic, code, a heading or a bullet; a star the parser pairs with nothing stays as written (a gate code's, and an italic's that starts
 * or ends at a digit); a number as written (the block reader keeps none, a blank line or a nested bullet
 * would restart a count); a fenced block as written; no blank line and no fence line. @param {string} src
 */
export function plainWords(src) {
  /** @param {Inline[]} c @returns {string} */
  const words = (c) => c.map((x) => {
    if (x.t === 'text') return x.v;
    if (x.t === 'code') return x.c;
    if (x.t !== 'a') return words(x.c);
    const name = words(x.c);
    return safeHref(name) ? addressWords(name) : name; // its name as written, as the line shows it
  }).join('');
  /** @type {string[]} */
  const lines = [];
  let fenced = false;
  for (const line of String(src ?? '').slice(0, MD_MAX).replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('```')) {
      fenced = !fenced;
      continue;
    }
    const text = fenced ? line : words(parseInline(line.replace(/^(?:#{1,6}|\s*[-*])\s+/, '').trim()));
    if (text.trim()) lines.push(text);
  }
  return lines.join('\n');
}
