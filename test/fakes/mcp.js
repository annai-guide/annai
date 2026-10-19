import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep, resolve } from 'node:path';

/**
 * A stand-in MCP server of annai's own (milestone 8: the user's decision, no outside service): MCP's
 * Streamable HTTP transport, with CORS, a bearer token, sessions, and answers as JSON or as SSE
 * streams. Tests run it on port 0; scripts/mcp-stand-in.mjs runs it for the device check, where it
 * also serves the test packages at /files/.
 */

/** Its tools (milestone 8c, choice 11). */
export const STAND_IN_TOOLS = Object.freeze([
  { name: 'echo', description: 'Says back the text it is given.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'map', description: 'A small map, as an image.', inputSchema: { type: 'object', properties: {} } },
  { name: 'whoami', description: 'Says what annai sent it to sign in.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always fails, on purpose.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Answers after ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
]);
/** A 1×1 PNG. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];
const PAGE = 3;
/** @type {Record<string, string>} */
const TYPES = { '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.png': 'image/png', '.zip': 'application/zip' };

/**
 * As the reference SDK's Streamable HTTP server does (minors 9), it refuses a POST that doesn't accept
 * both JSON and SSE (406), and a protocol version it doesn't speak (400; none is 2025-03-26); given
 * its origins, a request from any other Origin (403, as the spec's DNS-rebinding rule says). A request
 * with no Origin passes, as in the SDK's validateRequestHeaders: clients outside a browser send none.
 * @param {{ token?: string, sse?: boolean, sessions?: boolean, exposeSession?: boolean, cors?: boolean, port?: number, host?: string, files?: string,
 *   tools?: { name: string, description?: string, inputSchema?: any }[], origins?: string[] }} [o]
 */
export async function startMcpServer({ token, sse = false, sessions = true, exposeSession = true, cors = true, port = 0, host = '127.0.0.1', files, tools, origins } = {}) {
  /** @type {{ method: string, rpc: any, headers: Record<string, string | undefined>, path?: string }[]} */
  const requests = [];
  /** @type {Set<string>} */
  const live = new Set();
  let n = 0;
  let listDelay = 0;
  let hangDeletes = false;
  const list = tools ?? STAND_IN_TOOLS;
  const filesRoot = files ? resolve(files) : null;

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      /** @type {Record<string, string>} */
      const allow = cors ? { 'access-control-allow-origin': '*', ...(exposeSession ? { 'access-control-expose-headers': 'Mcp-Session-Id' } : {}) } : {};
      /** @param {number} status @param {any} [body] @param {Record<string, string>} [headers] */
      const send = (status, body, headers = {}) => {
        if (res.destroyed) return;
        const type = body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' };
        res.writeHead(status, { ...allow, ...type, ...headers }).end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method === 'OPTIONS') {
        if (!cors) return send(404, 'no browser access here');
        return send(204, undefined, {
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version'),
          'access-control-max-age': '600',
        });
      }
      if (filesRoot && req.method === 'GET' && path.startsWith('/files/')) {
        let rel = '';
        try {
          rel = decodeURIComponent(path.slice('/files/'.length));
        } catch {
          return send(400, 'not a file');
        }
        const file = normalize(join(filesRoot, rel));
        if (!file.startsWith(filesRoot + sep)) return send(403, 'not in the folder');
        /** @type {Buffer} */
        let body;
        try {
          if (!(await stat(file)).isFile()) throw new Error('not a file');
          body = await readFile(file);
        } catch {
          return send(404, 'not found');
        }
        res.writeHead(200, { ...allow, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
        return;
      }
      // Any path ending in /mcp, as hosted servers that put a key in it have ("/api/mcp/s/<key>/mcp").
      if (path !== '/mcp' && !path.endsWith('/mcp')) return send(404, 'not found');
      /** @param {number} status @param {string} message */
      const refuse = (status, message) => send(status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } });
      const origin = req.headers.origin;
      if (origins && origin && !origins.includes(origin)) return refuse(403, 'Forbidden: Origin not allowed');
      const accept = String(req.headers.accept ?? '');
      if (req.method === 'POST' && !(accept.includes('application/json') && accept.includes('text/event-stream'))) {
        return refuse(406, 'Not Acceptable: Client must accept both application/json and text/event-stream');
      }
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'This server needs its token.' } }, { 'www-authenticate': 'Bearer' });
      }
      const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
      if (req.method === 'DELETE') {
        requests.push({ method: 'DELETE', rpc: null, headers: { 'mcp-session-id': sid } });
        if (hangDeletes) return undefined; // never answered: stop() ends it
        if (sid) live.delete(sid);
        return send(204);
      }
      if (req.method !== 'POST') return send(405, 'POST only');
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      requests.push({ method: 'POST', rpc: msg, path, headers: { ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])) } });
      if (msg?.method === 'initialize') {
        const asked = String(msg.params?.protocolVersion ?? '');
        const id = sessions ? `s-${++n}-${Math.random().toString(36).slice(2, 10)}` : null;
        if (id) live.add(id);
        return send(200, {
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: SUPPORTED.includes(asked) ? asked : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'annai stand-in', version: '1.0.0' } },
        }, id ? { 'mcp-session-id': id } : {});
      }
      if (sessions) {
        if (!sid) return send(400, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32000, message: 'Bad Request: no session' } });
        if (!live.has(sid)) return send(404, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32001, message: 'Session not found' } });
      }
      if (!SUPPORTED.includes(String(req.headers['mcp-protocol-version'] ?? '2025-03-26'))) return refuse(400, 'Bad Request: Unsupported protocol version');
      if (msg?.id === undefined) return send(202);
      /** @param {any} result */
      const answer = (result) => {
        const body = { jsonrpc: '2.0', id: msg.id, result };
        if (!(sse && msg.method === 'tools/call')) return send(200, body);
        res.writeHead(200, { ...allow, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: msg.id, progress: 1 } })}\n\n`);
        res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      };
      const fail = (/** @type {number} */ code, /** @type {string} */ message) => send(200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
      if (msg.method === 'tools/list') {
        if (listDelay) await new Promise((done) => setTimeout(done, listDelay));
        const from = Number(msg.params?.cursor ?? 0) || 0;
        const page = list.slice(from, from + PAGE);
        return answer({ tools: page, ...(from + PAGE < list.length ? { nextCursor: String(from + PAGE) } : {}) });
      }
      if (msg.method === 'tools/call') {
        const name = String(msg.params?.name ?? '');
        const args = msg.params?.arguments ?? {};
        if (!list.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
        if (tools) return answer({ content: [{ type: 'text', text: name }] });
        if (name === 'echo') return answer({ content: [{ type: 'text', text: String(args.text ?? '') }] });
        if (name === 'add') {
          const sum = Number(args.a) + Number(args.b);
          return answer({ content: [{ type: 'text', text: String(sum) }], structuredContent: { sum } });
        }
        if (name === 'map') return answer({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] });
        if (name === 'whoami') return answer({ content: [{ type: 'text', text: `You sent: ${req.headers.authorization ?? 'nothing'}` }] });
        if (name === 'fail') return answer({ content: [{ type: 'text', text: 'This tool failed on purpose.' }], isError: true });
        await new Promise((done) => setTimeout(done, Number(args.ms ?? 1000)));
        return answer({ content: [{ type: 'text', text: 'Done.' }] });
      }
      return fail(-32601, `Method not found: ${msg.method}`);
    });
  });
  await new Promise((done, failed) => {
    server.once('error', failed);
    server.listen(port, host, () => done(undefined));
  });
  const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
  const origin = `http://${host}:${bound}`;
  return {
    origin,
    url: `${origin}/mcp`,
    requests,
    /** Ends every session, as a server that restarted would: the next request with one gets 404. */
    endSessions: () => live.clear(),
    /** Answers tools/list only after ms from now on, as a slow server would. @param {number} ms */
    slowList: (ms) => { listDelay = ms; },
    /** Never answers a DELETE from now on, as a server that hangs would. */
    hangDeletes: () => { hangDeletes = true; },
    stop: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(() => done(undefined));
    }),
  };
}
