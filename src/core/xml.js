/**
 * Just enough XML for the answers of S3 and WebDAV servers (spec §12.4): the elements with a local
 * name, whatever their namespace prefix, and their text. No DOM: the core runs in Node too. An
 * element may not hold another of the same name, which these answers never do.
 *
 * A server's answer may be broken or hostile, so reading it never throws and never takes more
 * than one pass: each search goes forward from where the last one ended (no regular expression
 * that could backtrack over the whole answer).
 */

/** @type {Record<string, string>} */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** A code point as text; one XML can't hold (out of range, a surrogate, NUL) is U+FFFD. @param {number} n */
function char(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '�';
}

/** @param {string} s */
function decode(s) {
  return s.replace(/&(?:#x([0-9a-f]{1,8})|#(\d{1,10})|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) => (
    hex ? char(parseInt(hex, 16)) : dec ? char(Number(dec)) : NAMED[name.toLowerCase()]));
}

/** The text outside tags. @param {string} s */
function strip(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return out + s.slice(i);
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt);
    if (gt < 0) return out;
    i = gt + 1;
  }
}

/**
 * The inside of each element called name (with any prefix), in order; "" for an empty one. An
 * element without its closing tag ends the reading: nothing after it can close it either.
 * @param {string} xml @param {string} name @returns {string[]}
 */
export function xmlElements(xml, name) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) return out;
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return out;
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag[0] === '/' || tag[0] === '?' || tag[0] === '!') continue;
    const empty = tag.endsWith('/');
    const qualified = (empty ? tag.slice(0, -1) : tag).trim().split(/[\s/]/, 1)[0];
    if (qualified.slice(qualified.indexOf(':') + 1) !== name) continue;
    if (empty) {
      out.push('');
      continue;
    }
    const close = `</${qualified}`;
    let at = xml.indexOf(close, i);
    // "</Key" may begin "</KeyCount>": the closing tag is the one followed by ">" (spaces allowed).
    while (at >= 0) {
      let k = at + close.length;
      while (k < xml.length && /\s/.test(xml[k])) k++;
      if (xml[k] === '>') break;
      at = xml.indexOf(close, at + close.length);
    }
    if (at < 0) return out;
    out.push(xml.slice(i, at));
    i = xml.indexOf('>', at) + 1;
  }
}

/** The text of the first element called name, entities decoded and CDATA as it is; null when there is none. @param {string} xml @param {string} name */
export function xmlText(xml, name) {
  const [inner] = xmlElements(xml, name);
  if (inner === undefined) return null;
  let out = '';
  let i = 0;
  for (;;) {
    const open = inner.indexOf('<![CDATA[', i);
    if (open < 0) return out + decode(strip(inner.slice(i)));
    out += decode(strip(inner.slice(i, open)));
    const end = inner.indexOf(']]>', open + 9);
    if (end < 0) return out + inner.slice(open + 9);
    out += inner.slice(open + 9, end);
    i = end + 3;
  }
}
