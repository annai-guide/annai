import { h } from './dom.js';
import { parseInline, parseMarkdown } from '../core/markdown.js';

/**
 * annai's own small Markdown renderer (spec §15): model output, read by src/core/markdown.js, becomes DOM nodes, never HTML.
 * @typedef {import('../core/markdown.js').Inline} Inline
 */

/** A line's words, their links, bold, italic and code drawn, never blocks: a model's words in a line annai draws (a reminder). @param {string} src */
export const inlineMarkdown = (src) => inlineNodes(parseInline(src));

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
