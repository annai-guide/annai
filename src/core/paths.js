export class PathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

const MAX = 512;
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Normalizes a file path inside a scope: starts with "/", has no empty, "." or
 * ".." segments, no backslashes or control characters, and is at most 512
 * characters, in Unicode NFC (macOS hands out decomposed names). The first
 * segment ".annai" is reserved for archive metadata.
 * @param {string} path
 * @returns {string}
 */
export function normPath(path) {
  if (typeof path !== 'string') throw new PathError('the path must be text');
  let p = path.trim().normalize('NFC');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > MAX) throw new PathError(`the path is longer than ${MAX} characters`);
  if (BAD_CHARS.test(p)) throw new PathError('the path contains a control character or a backslash');
  const segs = p.split('/').slice(1);
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new PathError(`"${p}" has an empty, "." or ".." part`);
  if (segs[0] === '.annai') throw new PathError('the folder ".annai" is reserved');
  return p;
}

/**
 * Normalizes a folder prefix for listing: "" or "/" is the root; otherwise it
 * must be a valid path that ends in "/".
 * @param {string} prefix
 * @returns {string}
 */
export function normPrefix(prefix) {
  if (!prefix || prefix === '/') return '/';
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return normPath(trimmed) + '/';
}

/** @type {Map<string, RegExp>} */
const globCache = new Map();

/**
 * Matches a path against a glob: "*" stays inside one segment, "**" spans
 * any number of segments (including none).
 * @param {string} glob
 * @param {string} path
 */
export function matchPath(glob, path) {
  let re = globCache.get(glob);
  if (!re) {
    let src = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        src += slash ? '(?:[^/]*/)*' : '.*';
        i += slash ? 2 : 1;
      } else if (c === '*') {
        src += '[^/]*';
      } else {
        src += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    re = new RegExp('^' + src + '$');
    globCache.set(glob, re);
  }
  return re.test(path);
}

/** @type {Record<string, string>} */
const TYPES = {
  json: 'application/json', jsonl: 'application/x-ndjson', md: 'text/markdown', txt: 'text/plain',
  csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', pdf: 'application/pdf',
  ics: 'text/calendar', pkpass: 'application/vnd.apple.pkpass', zip: 'application/zip',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
  woff2: 'font/woff2',
};

/** @param {string} path @returns {string} */
export function typeForPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && TYPES[m[1].toLowerCase()]) || 'application/octet-stream';
}

/** @param {string} type */
export function isTextType(type) {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/x-ndjson' || type === 'image/svg+xml';
}

/** Types that are already compressed, so zip should store them as-is. @param {string} type */
export function isCompressedType(type) {
  if (type === 'image/svg+xml') return false;
  return type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('font/') ||
    type === 'application/pdf' || type === 'application/zip' || type === 'application/vnd.apple.pkpass';
}
