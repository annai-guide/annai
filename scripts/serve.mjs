#!/usr/bin/env node
// Static server for annai: serves the folder above this script (the repository, or a release of it)
// on 127.0.0.1 with the _headers rules applied, so the CSP is enforced during development and tests,
// and behind an HTTPS reverse proxy when annai.guide is served from a machine of its own. A release holds x.br
// and x.gz beside its text files (scripts/build-release.mjs); a browser that takes one of them gets it. The
// source has none, so development serves every file as it is.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeaders, headersFor } from './headers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const argPort = process.argv.indexOf('--port');
const port = Number(argPort > 0 ? process.argv[argPort + 1] : process.env.PORT ?? 8790);
/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.zip': 'application/zip', '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
};
/** The stored forms of a file, best first: [Content-Encoding, the file's suffix]. */
const ENCODINGS = [['br', '.br'], ['gzip', '.gz']];

/**
 * Whether an Accept-Encoding header takes a coding: named with a q above 0, or else covered by "*".
 * @param {string | undefined} header @param {string} coding
 */
function accepts(header, coding) {
  let star = false;
  for (const part of (header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((p) => p.trim());
    const q = params.find((p) => p.startsWith('q='));
    const ok = q === undefined || Number(q.slice(2)) > 0;
    if (name === coding) return ok;
    if (name === '*') star = ok;
  }
  return star;
}

/**
 * The one byte range a Range header asks for, as [first, last]; null when the file has none of those bytes;
 * undefined for a header this server doesn't serve (several ranges, other units), which gets the whole file.
 * @param {string} header @param {number} size
 * @returns {[number, number] | null | undefined}
 */
function byteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  if (m[1] === '') return Number(m[2]) === 0 || size === 0 ? null : [Math.max(0, size - Number(m[2])), size - 1];
  const first = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < first) return undefined;
  return first >= size ? null : [first, Math.min(m[2] === '' ? size - 1 : Number(m[2]), size - 1)];
}

const rules = parseHeaders(await readFile(join(root, '_headers'), 'utf8'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const [k, v] of headersFor(rules, url.pathname)) res.setHeader(k, v);
  if (req.method === 'POST') {
    // Only reached when the service worker did not handle a share (e.g. before it installed).
    res.writeHead(303, { Location: '/#/import' }).end();
    return;
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('bad request: the path is not valid percent-encoding');
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || file.includes(`${sep}.git${sep}`)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
    const stored = [];
    for (const [coding, suffix] of ENCODINGS) if ((await stat(file + suffix).catch(() => null))?.isFile()) stored.push([coding, file + suffix]);
    if (stored.length) res.setHeader('Vary', 'Accept-Encoding');
    const head = req.method === 'HEAD';
    // A Range request gets the file itself: its ranges count the file's own bytes.
    const range = req.headers.range;
    const pick = range === undefined ? stored.find(([coding]) => accepts(req.headers['accept-encoding'], coding)) : undefined;
    if (pick) {
      const body = await readFile(pick[1]);
      res.writeHead(200, { 'Content-Encoding': pick[0], 'Content-Length': body.length }).end(head ? undefined : body);
      return;
    }
    const body = await readFile(file);
    res.setHeader('Accept-Ranges', 'bytes');
    const span = range === undefined ? undefined : byteRange(range, body.length);
    if (span === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
      return;
    }
    const part = span ? body.subarray(span[0], span[1] + 1) : body;
    if (span) res.setHeader('Content-Range', `bytes ${span[0]}-${span[1]}/${body.length}`);
    res.writeHead(span ? 206 : 200, { 'Content-Length': part.length }).end(head ? undefined : part);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`annai dev server: http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`));
