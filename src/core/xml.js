/**
 * Just enough XML for the answers of S3 and WebDAV servers (spec §12.4): the elements with a local
 * name, whatever their namespace prefix, and their text. No DOM: the core runs in Node too. An
 * element may not hold another of the same name, which these answers never do.
 */

/** @type {Record<string, string>} */
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** @param {string} s */
function decode(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, name) => (
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : NAMED[name.toLowerCase()]));
}

/** The inside of each element called name (with any prefix), in order; "" for an empty one. @param {string} xml @param {string} name @returns {string[]} */
export function xmlElements(xml, name) {
  const tag = `(?:[A-Za-z_][\\w.-]*:)?${name}`;
  const re = new RegExp(`<${tag}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/** The text of the first element called name, entities decoded and CDATA as it is; null when there is none. @param {string} xml @param {string} name */
export function xmlText(xml, name) {
  const [inner] = xmlElements(xml, name);
  if (inner === undefined) return null;
  return inner.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decode(part.replace(/<[^>]*>/g, ''))))
    .join('');
}
