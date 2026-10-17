#!/usr/bin/env node
/**
 * The push relay in Node: the same Worker code, with its Durable Objects in memory, for a device
 * test on your own network, or to run the relay on a machine of your own behind a reverse proxy
 * (relay/README.md). With --data, everything waiting is written to that file before it is
 * answered, and comes back after a restart; without it, a restart forgets the reminders waiting.
 *   node relay/serve.mjs --port 8796 --origin https://annai.example [--data FILE] [--keys FILE] [--subject URI] [--host 127.0.0.1]
 */
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeRelay, LIMITS } from './src/relay.js';
import { newVapidJwk, readVapidKey } from './src/vapid.js';
import { memoryNamespace, memoryLimiter } from './memory.js';

/** Ports annai's own servers use on this machine: never the relay's. */
const TAKEN = [8765, 8790, 8791, 8792];

/** The VAPID key in file, made there (readable by its owner alone) the first time (choice 11). @param {string} file */
export async function keyFile(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
  }
  const jwk = await newVapidJwk();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, jwk, { mode: 0o600, flag: 'wx' });
  return jwk;
}

/**
 * The address the rate limit counts (spec §11.6). Behind a proxy on this machine (`tailscale serve`),
 * the last X-Forwarded-For entry, the one the proxy added: the client may have written the others.
 * Otherwise the connection's own address; X-Forwarded-For from elsewhere is not believed.
 * @param {import('node:http').IncomingMessage} req
 */
export function clientAddress(req) {
  const peer = req.socket.remoteAddress ?? '';
  const local = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
  return (local && forwarded) || peer || 'unknown';
}

/**
 * Starts the relay on a port of this machine. data: the file that keeps what is waiting across restarts.
 * @param {{ port?: number, host?: string, origins?: string[], jwk?: string, keys?: string, subject?: string, extraPushOrigins?: string[],
 *   now?: () => number, timers?: boolean, limit?: number, data?: string, send?: (url: string, init: RequestInit) => Promise<Response> }} [o]
 */
export async function startRelay({ port = 0, host = '127.0.0.1', origins = [], jwk, keys, subject, extraPushOrigins = [], now = () => Date.now(), timers = true, limit = 60, data, send } = {}) {
  const secret = jwk ?? (await keyFile(keys ?? join(homedir(), '.config', 'annai-relay', 'vapid.json')));
  const { publicKey } = await readVapidKey(secret);
  const { worker, PushRelay } = makeRelay({ now, ...(send ? { send } : {}) });
  /** @type {any} */
  const env = { VAPID_KEY: secret, VAPID_SUBJECT: subject ?? 'https://annai.guide', ORIGINS: origins.join(','), EXTRA_PUSH_ORIGINS: extraPushOrigins.join(','), LIMIT: memoryLimiter({ limit, now }) };
  env.RELAY = memoryNamespace(PushRelay, env, { now, timers, ...(data ? { file: data } : {}) });
  await env.RELAY.load();
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let refused = false;
    // Read no more than the relay would: a larger body is refused as soon as it is, whatever comes after.
    req.on('data', (c) => {
      if (refused) return;
      size += c.length;
      if (size <= LIMITS.body) {
        chunks.push(c);
        return;
      }
      refused = true;
      chunks.length = 0;
      res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
      res.end(JSON.stringify({ error: 'size', message: `The request is larger than the ${LIMITS.body} bytes the relay reads.` }), () => req.socket.destroy());
    });
    req.on('end', async () => {
      if (refused) return;
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        headers.set('CF-Connecting-IP', clientAddress(req));
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
        const answer = await worker.fetch(new Request(`http://${host}${req.url ?? '/'}`, { method: req.method, headers, body }), env);
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The relay failed to answer.');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    origin: `http://${host}:${bound}`,
    key: publicKey,
    env,
    close: () => new Promise((resolve) => {
      env.RELAY.close();
      server.closeAllConnections?.();
      server.close(() => resolve(undefined));
    }),
  };
}

// Run as a script, also through a link (a release behind a "current" link): Node names this module by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const one = (/** @type {string} */ name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const all = (/** @type {string} */ name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
  const port = Number(one('--port') ?? 8796);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be a port number, such as 8796.');
    process.exit(1);
  }
  if (TAKEN.includes(port)) {
    console.error(`Port ${port} is one of annai's own on this machine (8765, 8790 to 8792). Choose another, such as 8796.`);
    process.exit(1);
  }
  const origins = all('--origin');
  if (!origins.length) {
    console.error("Give the address annai is served from, so the relay answers it: --origin https://your-machine.your-tailnet.ts.net:8792");
    process.exit(1);
  }
  const data = one('--data');
  const r = await startRelay({ port, host: one('--host') ?? '127.0.0.1', origins, keys: one('--keys'), subject: one('--subject'), ...(data ? { data } : {}) });
  console.log(data
    ? `annai push relay, keeping what is waiting in ${data}: ${r.origin}/ for ${origins.join(', ')}`
    : `annai push relay, in memory (a restart forgets what is waiting): ${r.origin}/ for ${origins.join(', ')}`);
  console.log(`VAPID public key: ${r.key}`);
}
