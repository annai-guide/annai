#!/usr/bin/env node
// The receiving end of annai's Remote trace plugin (plugins-official/remote-trace): a tiny server, with
// no dependencies, that takes the plugin's batches and appends each entry to a JSONL file, one line each,
// with the device it came from and the time it arrived. For a developer watching a phone as it runs.
// Detailed trace's recordings come to <any path>/clips and go under a folder clips/ beside that file, as clips/<device>/<id>.<format>.
//   node scripts/trace-sink.mjs --port <p> (--token-file <path> | --token <t>) --out <file.jsonl> [--origin <allowed origin>]...
// The token may come from TRACE_SINK_TOKEN instead; a file or the environment keeps it out of shell history and ps.
// It listens on 127.0.0.1 only: a phone reaches it through an https proxy, such as `tailscale serve`.
import http from 'node:http';
import { appendFile, chmod, readFile, mkdir, open, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Ports annai's own servers use on this machine: never the sink's. */
export const TAKEN = [8765, 8790, 8791, 8792, 8796, 8797, 18010, 18011, 18012, 18013, 18014];
/** The largest body the sink reads; the plugin sends at most half of it. */
export const BODY_MAX = 1024 * 1024;
/** The largest recording the sink reads; a turn is 15 to 30 s, well under 1 MiB even as WAV. */
export const CLIP_MAX = 8 * 1024 * 1024;
/** The most entries one batch may hold; the plugin sends at most 100. */
export const ENTRIES_MAX = 1000;
/** A recording is refused (507) when writing it would leave less than this free on the disk, so the log keeps room: a turn is up to 2.7 GiB a day as WAV. */
export const FREE_FLOOR = 2 * 1024 ** 3;
/** The origin annai is served from, always allowed. */
export const ANNAI = 'https://annai.guide';
const TOKEN_MIN = 16;
const USAGE = 'node scripts/trace-sink.mjs --port <p> (--token-file <path> | --token <t>) --out <file.jsonl> [--origin <allowed origin>]...\n(or the token in TRACE_SINK_TOKEN)';

/** What a clip's id and format may be: no dot and no slash, so a name can't leave its folder. */
const CLIP_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CLIP_FORMAT = /^[a-z0-9]{1,8}$/;

/** A request's address, or null when it isn't a clip's: a path ending /clips. @param {string} [url] */
function clipAsked(url) {
  try {
    const u = new URL(url ?? '/', 'http://sink');
    return u.pathname.endsWith('/clips') ? u.searchParams : null;
  } catch {
    return null;
  }
}

/** A device's name as a folder's: other characters become _ (a user may name a device anything). @param {unknown} name */
export const deviceFolder = (name) => String(name ?? '').slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';

const digest = (/** @type {string} */ s) => createHash('sha256').update(s).digest();

/**
 * Writes bytes to file (flag 'w': a new file, 'a': at its end) and waits until they are on the disk: the plugin forgets
 * what the sink answered for, and a crash of this machine would otherwise lose the last half minute of it.
 * @param {string} file @param {string | Buffer} bytes @param {string} flag @param {number} mode
 */
async function onDisk(file, bytes, flag, mode) {
  const fh = await open(file, flag, mode);
  try {
    await fh.writeFile(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Waits until a folder's names (a file renamed into it) are on the disk. @param {string} dir */
async function namesOnDisk(dir) {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Starts the sink on a port of this machine. log: each batch, in a line for the console; append: how lines reach the file; write: how a clip's bytes do;
 * free: the bytes free on the disk of a folder; floor: the least a clip may leave free. The log file is private (0600), as it holds the screen text.
 * @param {{ port?: number, token: string, out: string, origins?: string[], now?: () => number, log?: (line: string) => void,
 *   append?: (file: string, text: string) => Promise<void>, write?: (file: string, bytes: Buffer, o: { mode: number }) => Promise<void>,
 *   free?: (dir: string) => Promise<number>, floor?: number }} o
 */
export async function startSink({
  port = 0, token, out, origins = [], now = () => Date.now(), log = () => {}, append = (file, text) => onDisk(file, text, 'a', 0o600), write = (file, bytes, { mode }) => onDisk(file, bytes, 'w', mode),
  free = async (dir) => { const f = await statfs(dir); return f.bavail * f.bsize; }, floor = FREE_FLOOR,
}) {
  await chmod(out, 0o600).catch(() => {}); // a file from before is made private too
  const allowed = new Set([ANNAI, ...origins.map((o) => o.replace(/\/+$/, ''))]);
  const clips = join(dirname(out), 'clips');
  const want = digest(`Bearer ${token}`);
  /** Writes one after another, so lines keep the order batches came in. */
  let writing = Promise.resolve();
  /** A write failed (a full disk), and may have left a line cut short: the next starts on a new line, so the cut one stays alone. */
  let torn = false;
  const server = http.createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    /** @type {Record<string, string>} */
    const cors = origin && allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    /** @param {number} status @param {any} body @param {Record<string, string>} [more] @param {() => void} [then] once it is written */
    const answer = (status, body, more = {}, then) => {
      if (res.headersSent) return;
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...more });
      res.end(JSON.stringify(body), then);
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
    const clip = clipAsked(req.url);
    const most = clip ? CLIP_MAX : BODY_MAX;
    // Refused as soon as it is too big, whatever comes after; the answer is written before the connection goes.
    const tooBig = () => answer(413, { error: 'size', message: `The body is larger than the ${most} bytes the sink reads.` }, { Connection: 'close' }, () => req.socket.destroy());
    if (Number(req.headers['content-length'] ?? 0) > most) {
      tooBig();
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
      if (size <= most) {
        chunks.push(c);
        return;
      }
      refused = true;
      chunks.length = 0;
      tooBig();
    });
    req.on('end', () => {
      if (refused) return;
      if (clip) {
        const [id, format] = [clip.get('id') ?? '', clip.get('format') ?? ''];
        if (!CLIP_ID.test(id) || !CLIP_FORMAT.test(format) || !size) {
          answer(400, { error: 'clip', message: 'A clip has sound in its body, an id of letters, digits, - and _, and a format of lowercase letters and digits.' });
          return;
        }
        const name = join(deviceFolder(clip.get('device')), `${id}.${format}`);
        const file = join(clips, name);
        const part = `${file}.${randomBytes(4).toString('hex')}.part`;
        // Whole or not at all: a retry of the same clip replaces it, and a full disk leaves nothing behind.
        // Nothing rotates the recordings, so the disk is not filled with them: the log needs room too.
        free(dirname(out))
          .then((left) => {
            if (left - size < floor) throw Object.assign(new Error(`less than ${floor / 1024 ** 3} GiB would be left free`), { code: 'ENOSPC' });
          })
          .then(() => mkdir(dirname(file), { recursive: true, mode: 0o700 }))
          .then(() => write(part, Buffer.concat(chunks), { mode: 0o600 }))
          .then(() => rename(part, file))
          .then(() => namesOnDisk(dirname(file)))
          .then(() => {
            log(`${new Date(now()).toISOString()} ${name}: ${size} bytes`);
            answer(200, { file: name });
          }, async (/** @type {any} */ e) => {
            await rm(part, { force: true }).catch(() => {});
            const full = e?.code === 'ENOSPC' || e?.code === 'EDQUOT';
            answer(full ? 507 : 500, { error: full ? 'full' : 'write', message: full ? `The disk is full, or less than ${floor / 1024 ** 3} GiB would be left free.` : "The sink couldn't write the clip." });
            log(`couldn't write ${name}: ${e?.message ?? e}`);
          });
        return;
      }
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
      writing = writing.then(async () => {
        if (!lines) return;
        await append(out, torn ? `\n${lines}` : lines);
        torn = false;
      }).then(() => {
        log(`${received} ${device}${build ? ` (build ${build})` : ''}: ${entries.length} entries${dropped ? `, ${dropped} dropped before` : ''}`);
        answer(200, { received: entries.length });
      }, (e) => {
        torn = true;
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
  const [portArg, out, tokenFile] = [one('--port'), one('--out'), one('--token-file')];
  /** @type {string | undefined} */
  let token = one('--token');
  if (!token && tokenFile) {
    try {
      token = (await readFile(tokenFile, 'utf8')).trim();
    } catch (e) {
      quit(`The sink can't read the token file ${tokenFile}: ${/** @type {any} */ (e)?.message ?? e}`);
    }
  }
  token ||= process.env.TRACE_SINK_TOKEN?.trim();
  if (portArg === undefined || !token || !out) quit(`Usage: ${USAGE}`);
  const port = Number(portArg);
  if (!/^\d+$/.test(String(portArg)) || port > 65535) quit('--port must be a port number, such as 8798.');
  if (TAKEN.includes(port)) quit(`Port ${port} is one of annai's own on this machine (8765, 8790 to 8792, 8796, 8797, 18010 to 18014). Choose another, such as 8798.`);
  if (String(token).length < TOKEN_MIN) quit(`The token must be at least ${TOKEN_MIN} characters. Make one with: openssl rand -hex 16`);
  const origins = all('--origin');
  try {
    await appendFile(/** @type {string} */ (out), '', { mode: 0o600 });
  } catch (e) {
    quit(`The sink can't write ${out}: ${/** @type {any} */ (e)?.message ?? e}`);
  }
  const s = await startSink({ port, token: /** @type {string} */ (token), out: /** @type {string} */ (out), origins, log: (line) => console.log(line) }).catch((e) => quit(`The sink couldn't start: ${e?.message ?? e}`));
  if (!s) process.exit(1);
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) process.once(signal, () => { s.close().then(() => process.exit(0), () => process.exit(1)); });
  console.log([
    `annai trace sink: ${s.origin}/, appending to ${out}`,
    `It takes batches from ${[ANNAI, ...origins].join(', ')}, with the token. Recordings go under ${join(dirname(/** @type {string} */ (out)), 'clips')}.`,
    'A phone needs https in front of it. On a tailnet, for example:',
    `  tailscale serve --bg --https=8443 http://127.0.0.1:${s.port}`,
    'Then in annai: Settings → Plugins → Remote trace (for developers), the server address',
    "https://<this machine's name on your tailnet>:8443/, the same token, and Send on.",
    'Stop it with Ctrl-C, and the https side with: tailscale serve --https=8443 off',
  ].join('\n'));
}
