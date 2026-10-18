#!/usr/bin/env node
// The receiving end of annai's Remote trace plugin (plugins-official/remote-trace): a tiny server, with
// no dependencies, that takes the plugin's batches and appends each entry to a JSONL file, one line each,
// with the device it came from and the time it arrived. For a developer watching a phone as it runs.
//   node scripts/trace-sink.mjs --port <p> --token <t> --out <file.jsonl> [--origin <allowed origin>]...
// It listens on 127.0.0.1 only: a phone reaches it through an https proxy, such as `tailscale serve`.
import http from 'node:http';
import { appendFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Ports annai's own servers use on this machine: never the sink's. */
export const TAKEN = [8765, 8790, 8791, 8792, 8796, 8797, 18010, 18011, 18012, 18013, 18014];
/** The largest body the sink reads; the plugin sends at most half of it. */
export const BODY_MAX = 1024 * 1024;
/** The most entries one batch may hold; the plugin sends at most 100. */
export const ENTRIES_MAX = 1000;
/** The origin annai is served from, always allowed. */
export const ANNAI = 'https://annai.guide';
const TOKEN_MIN = 16;
const USAGE = 'node scripts/trace-sink.mjs --port <p> --token <t> --out <file.jsonl> [--origin <allowed origin>]...';

const digest = (/** @type {string} */ s) => createHash('sha256').update(s).digest();

/**
 * Starts the sink on a port of this machine. log: each batch, in a line for the console.
 * @param {{ port?: number, token: string, out: string, origins?: string[], now?: () => number, log?: (line: string) => void }} o
 */
export async function startSink({ port = 0, token, out, origins = [], now = () => Date.now(), log = () => {} }) {
  const allowed = new Set([ANNAI, ...origins.map((o) => o.replace(/\/+$/, ''))]);
  const want = digest(`Bearer ${token}`);
  /** Writes one after another, so lines keep the order batches came in. */
  let writing = Promise.resolve();
  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    /** @type {Record<string, string>} */
    const cors = origin && allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    /** @param {number} status @param {any} body */
    const answer = (status, body, more = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...more });
      res.end(JSON.stringify(body));
    };
    if (origin && !allowed.has(origin)) {
      req.resume();
      answer(403, { error: 'origin', message: `${origin} isn't an origin this sink takes batches from. Start it with --origin ${origin}.` });
      return;
    }
    if (req.method === 'OPTIONS') {
      req.resume();
      res.writeHead(204, {
        ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600',
        // Chrome asks before a public page calls an address on a private network.
        ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
      }).end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      req.resume();
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(req.method === 'GET' ? 'annai trace sink is running. annai POSTs its trace here.\n' : undefined);
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      answer(405, { error: 'method', message: 'The sink takes POST.' }, { Allow: 'GET, POST, OPTIONS' });
      return;
    }
    const tooBig = () => answer(413, { error: 'size', message: `The body is larger than the ${BODY_MAX} bytes the sink reads.` }, { Connection: 'close' });
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) {
      tooBig();
      req.destroy();
      return;
    }
    const got = digest(String(req.headers.authorization ?? ''));
    if (!timingSafeEqual(got, want)) {
      req.resume();
      answer(401, { error: 'token', message: 'The token is missing or wrong.' });
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (c) => {
      if (refused) return;
      size += c.length;
      if (size <= BODY_MAX) {
        chunks.push(c);
        return;
      }
      refused = true;
      chunks.length = 0;
      tooBig();
      req.destroy();
    });
    req.on('end', () => {
      if (refused) return;
      /** @type {any} */
      let batch;
      try {
        batch = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        answer(400, { error: 'json', message: 'The body is not JSON.' });
        return;
      }
      if (!batch || typeof batch !== 'object' || Array.isArray(batch) || !Array.isArray(batch.entries) || batch.entries.length > ENTRIES_MAX) {
        answer(400, { error: 'batch', message: `A batch is a JSON object with entries, a list of at most ${ENTRIES_MAX}.` });
        return;
      }
      const received = new Date(now()).toISOString();
      const device = String(batch.device ?? 'unknown').slice(0, 64);
      const build = typeof batch.build === 'string' ? batch.build.slice(0, 64) : null;
      const head = { received, device, build };
      const dropped = Number.isInteger(batch.dropped) && batch.dropped > 0 ? batch.dropped : 0;
      const entries = batch.entries.filter((/** @type {unknown} */ e) => e && typeof e === 'object' && !Array.isArray(e));
      // The sink's own fields come first, and an entry can't overwrite them.
      const lines = [...(dropped ? [{ dropped }] : []), ...entries].map((e) => `${JSON.stringify({ ...head, ...e, ...head })}\n`).join('');
      writing = writing.then(() => (lines ? appendFile(out, lines) : undefined)).then(() => {
        log(`${received} ${device}${build ? ` (build ${build})` : ''}: ${entries.length} entries${dropped ? `, ${dropped} dropped before` : ''}`);
        answer(200, { received: entries.length });
      }, (e) => {
        answer(500, { error: 'write', message: "The sink couldn't write the file." });
        log(`${received} couldn't write ${out}: ${/** @type {any} */ (e)?.message ?? e}`);
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://127.0.0.1:${bound}`,
    port: bound,
    /** Stops taking batches, after what is being written. */
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections?.();
      });
      await writing.catch(() => {});
    },
  };
}

// Run as a script, also through a link: Node names this module by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const one = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const all = (/** @type {string} */ name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  const quit = (/** @type {string} */ words) => {
    console.error(words);
    process.exit(1);
  };
  const [portArg, token, out] = [one('--port'), one('--token'), one('--out')];
  if (portArg === undefined || !token || !out) quit(`Usage: ${USAGE}`);
  const port = Number(portArg);
  if (!/^\d+$/.test(String(portArg)) || port > 65535) quit('--port must be a port number, such as 8798.');
  if (TAKEN.includes(port)) quit(`Port ${port} is one of annai's own on this machine (8765, 8790 to 8792, 8796, 8797, 18010 to 18014). Choose another, such as 8798.`);
  if (String(token).length < TOKEN_MIN) quit(`The token must be at least ${TOKEN_MIN} characters. Make one with: openssl rand -hex 16`);
  const origins = all('--origin');
  try {
    await appendFile(/** @type {string} */ (out), '');
  } catch (e) {
    quit(`The sink can't write ${out}: ${/** @type {any} */ (e)?.message ?? e}`);
  }
  const s = await startSink({ port, token: /** @type {string} */ (token), out: /** @type {string} */ (out), origins, log: (line) => console.log(line) }).catch((e) => quit(`The sink couldn't start: ${e?.message ?? e}`));
  if (!s) process.exit(1);
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.once(signal, () => { s.close().then(() => process.exit(0), () => process.exit(1)); });
  console.log([
    `annai trace sink: ${s.origin}/, appending to ${out}`,
    `It takes batches from ${[ANNAI, ...origins].join(', ')}, with the token.`,
    'A phone needs https in front of it. On a tailnet, for example:',
    `  tailscale serve --bg --https=8443 http://127.0.0.1:${s.port}`,
    'Then in annai: Settings → Plugins → Remote trace (for developers), the server address',
    "https://<this machine's name on your tailnet>:8443/, the same token, and Send on.",
    'Stop it with Ctrl-C, and the https side with: tailscale serve --https=8443 off',
  ].join('\n'));
}
