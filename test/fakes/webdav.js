import http from 'node:http';

/**
 * A stand-in WebDAV server: folders and files in memory; PROPFIND (Depth 0 and 1) answered as
 * Nextcloud answers (the "d:" prefix), MKCOL, PUT, GET and DELETE; Basic authentication; and CORS,
 * with OPTIONS answered without a password. Tests and the end-to-end suite run it on a port of its
 * own (port 0).
 */

export const USER = 'annai';
export const PASSWORD = 'standin-password-0001';

/** @param {string} path */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
/** The folder a path is in, with its slash. @param {string} path */
const parentOf = (path) => path.replace(/\/+$/, '').replace(/[^/]*$/, '');

/** @param {{ folders?: string[], cors?: boolean }} [o] folders: those that exist, each ending in "/" */
export async function startWebDAV({ folders = ['/dav/'], cors = true } = {}) {
  /** @type {Set<string>} */
  const dirs = new Set(folders);
  /** @type {Map<string, { data: Buffer, modified: Date }>} */
  const files = new Map();
  /** @type {{ method: string, path: string, status: number }[]} */
  const log = [];
  const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
  /** @type {{ method: string, body: string, status?: number } | null} */
  let garble = null;

  /** @param {string} href @param {{ data: Buffer, modified: Date } | null} f null for a folder */
  const entry = (href, f) => `<d:response><d:href>${encodePath(href)}</d:href><d:propstat><d:prop>${f
    ? `<d:resourcetype/><d:getcontentlength>${f.data.length}</d:getcontentlength><d:getlastmodified>${f.modified.toUTCString()}</d:getlastmodified>`
    : '<d:resourcetype><d:collection/></d:resourcetype>'}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = decodeURIComponent(url.pathname);
      const method = req.method ?? 'GET';
      /** @param {number} status @param {string | Buffer} [out] @param {Record<string, string>} [headers] */
      const reply = (status, out = '', headers = {}) => {
        log.push({ method, path, status });
        res.writeHead(status, { ...(cors ? { 'access-control-allow-origin': '*' } : {}), ...headers });
        res.end(out);
      };
      if (method === 'OPTIONS') {
        return reply(cors ? 200 : 403, '', cors ? {
          'access-control-allow-methods': 'GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, Depth', 'access-control-max-age': '3600', dav: '1, 2',
        } : {});
      }
      if (req.headers.authorization !== expected) return reply(401, 'Unauthorized', { 'www-authenticate': 'Basic realm="annai stand-in"' });
      if (garble && method === garble.method) {
        const g = garble;
        garble = null;
        return reply(g.status ?? 200, g.body, { 'content-type': 'application/xml; charset=utf-8' });
      }
      const folder = path.endsWith('/') ? path : `${path}/`;
      if (method === 'PROPFIND') {
        const file = files.get(path);
        if (!dirs.has(folder) && !file) return reply(404, 'Not Found');
        /** @type {string[]} */
        const items = [];
        if (file) items.push(entry(path, file));
        else {
          items.push(entry(folder, null));
          if (String(req.headers.depth ?? 'infinity') !== '0') {
            for (const d of dirs) if (d !== folder && parentOf(d) === folder) items.push(entry(d, null));
            for (const [p, f] of files) if (parentOf(p) === folder) items.push(entry(p, f));
          }
        }
        return reply(207, `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">${items.join('')}</d:multistatus>`, { 'content-type': 'application/xml; charset=utf-8' });
      }
      if (method === 'MKCOL') {
        if (dirs.has(folder)) return reply(405, 'Method Not Allowed');
        if (!dirs.has(parentOf(folder))) return reply(409, 'Conflict');
        dirs.add(folder);
        return reply(201);
      }
      if (method === 'PUT') {
        if (!dirs.has(parentOf(path))) return reply(409, 'Conflict');
        const had = files.has(path);
        files.set(path, { data: body, modified: new Date() });
        return reply(had ? 204 : 201);
      }
      if (method === 'GET') {
        const f = files.get(path);
        return f ? reply(200, f.data, { 'content-type': 'application/octet-stream' }) : reply(404, 'Not Found');
      }
      if (method === 'DELETE') return reply(files.delete(path) ? 204 : 404);
      return reply(405, 'Method Not Allowed');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return {
    origin, log,
    files: () => new Map([...files].map(([p, f]) => [p, f.data])),
    dirs: () => new Set(dirs),
    /** The next request with this method gets this answer instead: a broken or hostile server. @param {{ method: string, body: string, status?: number }} g */
    garbleNext: (g) => { garble = g; },
    /** A file another device or program put there. @param {string} path @param {string | Buffer} data */
    putAs: (path, data) => { files.set(path, { data: Buffer.from(data), modified: new Date() }); },
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}
