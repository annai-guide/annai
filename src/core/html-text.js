/**
 * Readable text from an HTML page, without a DOM (so it runs anywhere, and in tests): scripts,
 * styles and comments go, the main part is kept when the page marks one, blocks go on their own
 * lines, links keep their address, and entities are decoded.
 */

const NAMED = /** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥', eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', ccedil: 'ç', times: '×',
});

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n === 160 ? 32 : n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK = 'p|div|section|article|header|footer|aside|main|nav|ul|ol|table|tr|h[1-6]|blockquote|pre|figure|figcaption|dl|dt|dd|form|fieldset';

/** @param {string} html @param {string} [baseUrl] @returns {{ title: string, text: string }} */
export function htmlToText(html, baseUrl) {
  let s = String(html);
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, '');
  const part = (/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(s)?.[2]) ?? (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1]) ?? s;
  s = part
    .replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, d, single, inner) => {
      const href = decodeEntities(d ?? single ?? '');
      const text = inner.replace(/<[^>]+>/g, '');
      let abs = '';
      try {
        const u = new URL(href, baseUrl);
        if (u.protocol === 'https:' || u.protocol === 'http:') abs = u.href;
      } catch {
        // not an address
      }
      return abs && !href.startsWith('#') && text.trim() && text.trim() !== abs ? `${text} (${abs})` : text;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(s)
    .split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
