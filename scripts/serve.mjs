#!/usr/bin/env node
// Static server for annai: serves the folder above this script (the repository, or a release of it)
// on 127.0.0.1 with the _headers rules applied, so the CSP is enforced during development and tests,
// and behind an HTTPS reverse proxy when annai.guide is served from a machine of its own. A release holds x.br
// beside its text files (scripts/build-release.mjs); a browser that takes brotli gets it. The source has
// none, so development serves every file as it is.
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
 * Whether an If-None-Match header names this tag (weakly compared, as RFC 9110 has it for If-None-Match), or is "*".
 * @param {string | undefined} header @param {string} tag
 */
function holds(header, tag) {
  if (!header) return false;
  return header.split(',').some((t) => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === tag; });
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
    // A .br older than its file is stale (the file was edited after build-release ran on it) and is not sent. In a
    // release, git archive gives both the commit's time.
    const b = await stat(`${file}.br`).catch(() => null);
    const packed = b?.isFile() && b.mtimeMs >= s.mtimeMs ? `${file}.br` : null;
    if (packed) res.setHeader('Vary', 'Accept-Encoding');
    const head = req.method === 'HEAD';
    const brotli = packed !== null && accepts(req.headers['accept-encoding'], 'br');
    if (brotli) res.setHeader('Content-Encoding', 'br');
    // A browser that holds the file asks again with its tag, and is told it still has it: Chromium's and WebKit's checks for a new
    // sw.js do, on every check. The tag is the sent file's size and time, as most servers make it.
    const sent = brotli ? /** @type {import('node:fs').Stats} */ (b) : s;
    const tag = `"${sent.size.toString(36)}-${Math.floor(sent.mtimeMs).toString(36)}${brotli ? '-br' : ''}"`;
    res.setHeader('ETag', tag);
    if (holds(req.headers['if-none-match'], tag)) {
      res.writeHead(304).end();
      return;
    }
    const body = await readFile(brotli ? packed : file);
    // Range is ignored, as HTTP allows: nothing annai serves is asked for in parts.
    res.writeHead(200, { 'Content-Length': body.length }).end(head ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`annai dev server: http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`));
