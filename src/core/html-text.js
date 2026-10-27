/**
 * Readable text from an HTML page, without a DOM (so it runs anywhere, and in tests): scripts,
 * styles and comments go, the main part is kept when the page marks one, blocks go on their own
 * lines, links keep their address, and entities are decoded.
 *
 * It reads the page in one forward pass, so a hostile or huge page takes linear time: no
 * pattern scans ahead for a closing tag more than once, and a page is read up to HTML_MAX.
 */

/** The most of a page that is read, in characters. Text is cut far sooner for the model anyway. */
export const HTML_MAX = 2_000_000;
/** The longest tag (with its attributes) that is read as a tag; anything longer is text. */
const TAG_MAX = 4000;

/* en */ const NAMED = /** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', euro: '€', pound: '£', yen: '¥',
  eacute: 'é', egrave: 'è', agrave: 'à', uuml: 'ü', ouml: 'ö', auml: 'ä', ntilde: 'ñ', ccedil: 'ç', times: '×',
});

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n === 160 ? 32 : n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'ul', 'ol', 'table', 'tr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'form', 'fieldset']);
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'textarea']);
/** A tag at a position: its name and attributes, bounded so a missing ">" can't make it scan far. */
const TAG = new RegExp(`<(/?)([a-zA-Z][a-zA-Z0-9-]{0,30})([^<>]{0,${TAG_MAX}})>`, 'y');

/** The first position at or after from where re matches, or -1; re must be global. @param {RegExp} re @param {string} s @param {number} from */
function find(re, s, from) {
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index : -1;
}

/** The part of the page to read: <main> or <article> if there is one, else <body>, else all. @param {string} s */
function mainPart(s) {
  for (const name of ['main', 'article', 'body']) {
    const open = new RegExp(`<${name}\\b[^<>]{0,${TAG_MAX}}>`, 'i').exec(s);
    if (!open) continue;
    const start = open.index + open[0].length;
    const end = find(new RegExp(`</${name}\\s*>`, 'gi'), s, start);
    return s.slice(start, end < 0 ? s.length : end);
  }
  return s;
}

/** @param {string} attrs @param {string} [baseUrl] @returns {string} */
function hrefOf(attrs, baseUrl) {
  const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  const href = decodeEntities(m ? m[2] ?? m[3] ?? m[4] ?? '' : '');
  if (!href || href.startsWith('#')) return '';
  try {
    const u = new URL(href, baseUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

/** @param {string} html @param {string} [baseUrl] @returns {{ title: string, text: string }} */
export function htmlToText(html, baseUrl) {
  const page = String(html).slice(0, HTML_MAX);
  const t = /<title\b[^<>]{0,200}>([^<]{0,500})/i.exec(page);
  const title = decodeEntities((t?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const s = mainPart(page);
  /** @type {string[]} */
  const out = [];
  /** @type {{ href: string, at: number } | null} the link being read */
  let link = null;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(s);
    if (!m) {
      out.push('<'); // not a tag: text
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (!closing && SKIP.has(name)) {
      const end = find(new RegExp(`</${name}\\s*>`, 'gi'), s, i);
      i = end < 0 ? s.length : s.indexOf('>', end) + 1;
      continue;
    }
    if (name === 'a') {
      if (!closing) {
        const href = hrefOf(m[3], baseUrl);
        link = href ? { href, at: out.length } : null;
      } else if (link) {
        const text = out.slice(link.at).join('').trim();
        if (text && decodeEntities(text) !== link.href) out.push(` (${link.href})`);
        link = null;
      }
    } else if (name === 'br') out.push('\n');
    else if (name === 'li') out.push(closing ? '' : '\n- ');
    else if (BLOCK.has(name)) out.push('\n');
  }
  const text = decodeEntities(out.join(''))
    .split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
