import { h } from './dom.js';
import { ADDRESS_ENDS } from '../core/address-ends.js';

/**
 * annai's own small Markdown renderer (spec §15): model output becomes DOM nodes, never HTML.
 * Paragraphs, headings, lists, code blocks; bold, italic, code and links to http(s) addresses.
 * Anything else, HTML included, is text.
 * @typedef {{ t: 'text', v: string } | { t: 'b', c: Inline[] } | { t: 'i', c: Inline[] } | { t: 'code', c: string } | { t: 'a', href: string, c: Inline[] }} Inline
 * @typedef {{ t: 'p', c: Inline[] } | { t: 'h', c: Inline[] } | { t: 'ul', items: Inline[][] } | { t: 'ol', items: Inline[][] } | { t: 'pre', v: string }} Block
 */

export const MD_MAX = 20_000;
// A bare address runs to whitespace, `<`, `>`, an unpaired bracket or a mark of ADDRESS_ENDS; a pair of brackets that closes (one level, as Wikipedia's titles
// need) stays in it (GFM's rule); a last `.,;:!?'"` stays out of it, as a sentence's own stop. A `_` opens or closes italics only at a word's edge (CommonMark's).
const WORD = String.raw`[\p{L}\p{N}]`;
const IN_ADDRESS = String.raw`[^\s<>()${ADDRESS_ENDS}]`;
const PAIR = String.raw`\(${IN_ADDRESS}*\)`;
const INLINE = new RegExp([
  '`([^`\\n]+)`',
  String.raw`\*\*([^*\n]+)\*\*`,
  String.raw`\*([^*\s][^*\n]*)\*`,
  String.raw`(?<!${WORD})_([^_\s][^_\n]*)_(?!${WORD})`,
  String.raw`\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)`,
  String.raw`(https?:\/\/(?:${IN_ADDRESS}|${PAIR})*(?:[^\s<>().,;:!?'"${ADDRESS_ENDS}]|${PAIR}))`,
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
      else text(m[0]);
    } else if (m[7] !== undefined) {
      const href = inLink ? null : safeHref(m[7]);
      if (href) out.push({ t: 'a', href: m[7], c: [{ t: 'text', v: m[7] }] });
      else text(m[0]);
    }
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

/** @param {Inline[]} c @returns {(Node | string)[]} */
function inlineNodes(c) {
  return c.map((x) => {
    if (x.t === 'text') return x.v;
    if (x.t === 'code') return h('code', { text: x.c });
    if (x.t === 'b') return h('strong', {}, ...inlineNodes(x.c));
    if (x.t === 'i') return h('em', {}, ...inlineNodes(x.c));
    return h('a', { href: x.href, target: '_blank', rel: 'noopener noreferrer' }, ...inlineNodes(x.c));
  });
}

/** @param {string} src @param {Record<string, any>} [attrs] the words' language and direction: the language is the block's, the direction each paragraph's own */
export function renderMarkdown(src, attrs = {}) {
  const { dir, ...rest } = attrs;
  return h('div', { class: 'md', ...rest }, ...parseMarkdown(src).map((b) => {
    if (b.t === 'p') return h('p', { dir }, ...inlineNodes(b.c));
    if (b.t === 'h') return h('p', { class: 'md-h', dir }, ...inlineNodes(b.c));
    if (b.t === 'pre') return h('pre', { class: 'mono', text: b.v });
    return h(b.t, { dir }, ...b.items.map((it) => h('li', {}, ...inlineNodes(it))));
  }));
}
