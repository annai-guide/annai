import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSink, deviceFolder, TAKEN, BODY_MAX, CLIP_MAX } from '../../scripts/trace-sink.mjs';

const script = fileURLToPath(new URL('../../scripts/trace-sink.mjs', import.meta.url));
const TOKEN = 'sink-token-0123456789abcdef';
const PAGE = 'http://127.0.0.1:8790';

/** A sink on a port of its own (port 0), writing to a file in a folder of its own. @param {string[]} [origins] */
async function sink(origins = [PAGE], more = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  const out = join(dir, 'trace.jsonl');
  /** @type {string[]} */
  const said = [];
  const s = await startSink({ port: 0, token: TOKEN, out, origins, log: (line) => said.push(line), ...more });
  return {
    ...s, out, said, dir,
    lines: async () => (await readFile(out, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    stop: async () => {
      await s.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** @param {any} body @param {Record<string, string>} [headers] */
const post = (/** @type {string} */ url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: PAGE, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const entry = (/** @type {number} */ seq, /** @type {string} */ type = 'msg.user') => ({ scope: 'trip:1', seq, ts: 1_800_000_000_000 + seq, type, actor: 'user', data: { text: `hi ${seq}` } });

test("the sink appends each entry of a batch as one JSONL line, with the device, the build and the time it arrived, and a line for what the phone dropped", async () => {
  const s = await sink();
  try {
    const res = await post(`${s.origin}/`, { app: 'annai 0.1.0', build: 'abcdef012345', device: 'dev0123456789abc', dropped: 7, entries: [entry(1), entry(2, 'model.turn')] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: 2 });
    assert.equal(res.headers.get('access-control-allow-origin'), PAGE);
    const lines = await s.lines();
    assert.equal(lines.length, 3);
    assert.deepEqual(Object.keys(lines[0]), ['received', 'device', 'build', 'dropped']);
    assert.equal(lines[0].dropped, 7);
    for (const l of lines) {
      assert.equal(l.device, 'dev0123456789abc');
      assert.equal(l.build, 'abcdef012345');
      assert.ok(Date.parse(l.received) > 0, 'when it arrived, as an ISO time');
    }
    assert.deepEqual(lines.slice(1).map((l) => [l.seq, l.type, l.data.text, l.scope]), [[1, 'msg.user', 'hi 1', 'trip:1'], [2, 'model.turn', 'hi 2', 'trip:1']]);
    // An entry can't pass itself off as another device, or change when it arrived.
    await post(`${s.origin}/any/path`, { device: 'dev0123456789abc', entries: [{ ...entry(3), device: 'other', received: 'never' }] });
    const last = (await s.lines()).at(-1);
    assert.equal(last.device, 'dev0123456789abc');
    assert.notEqual(last.received, 'never');
    assert.match(s.said.join('\n'), /dev0123456789abc.*2 entries.*7 dropped/);
  } finally {
    await s.stop();
  }
});

test('the sink takes nothing without the token: none, a wrong one, or another scheme; the answer is still readable by the page', async () => {
  const s = await sink();
  try {
    for (const authorization of ['', 'Bearer wrong-token-0123456789', `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`]) {
      const res = await post(s.origin, { device: 'd', entries: [entry(1)] }, { authorization });
      assert.equal(res.status, 401, authorization);
      assert.equal(res.headers.get('access-control-allow-origin'), PAGE, 'so the plugin sees 401, not a network error');
    }
    assert.deepEqual(await s.lines(), []);
  } finally {
    await s.stop();
  }
});

test('the sink answers CORS for annai.guide and each given origin, and refuses any other origin', async () => {
  const s = await sink(['https://dev.example:8443']);
  try {
    for (const origin of ['https://annai.guide', 'https://dev.example:8443']) {
      const pre = await fetch(s.origin, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', 'access-control-request-private-network': 'true' } });
      assert.equal(pre.status, 204, origin);
      assert.equal(pre.headers.get('access-control-allow-origin'), origin);
      assert.match(String(pre.headers.get('access-control-allow-methods')), /POST/);
      assert.match(String(pre.headers.get('access-control-allow-headers')), /authorization/i);
      assert.match(String(pre.headers.get('access-control-allow-headers')), /content-type/i);
      assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
      assert.match(String(pre.headers.get('vary')), /Origin/);
      assert.equal((await post(s.origin, { device: 'd', entries: [entry(1)] }, { origin })).status, 200);
    }
    const pre = await fetch(s.origin, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
    assert.equal(pre.headers.get('access-control-allow-origin'), null);
    const res = await post(s.origin, { device: 'd', entries: [entry(9)] }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal((await s.lines()).length, 2, 'only the two allowed batches');
    const get = await fetch(s.origin);
    assert.equal(get.status, 200);
    assert.match(await get.text(), /annai trace sink is running/);
  } finally {
    await s.stop();
  }
});

test('the sink caps the body: a long Content-Length, or a body that keeps coming, is refused with 413 and nothing is written', async () => {
  const s = await sink();
  try {
    const big = JSON.stringify({ device: 'd', entries: [{ ...entry(1), data: { text: 'x'.repeat(BODY_MAX) } }] });
    const res = await post(s.origin, big);
    assert.equal(res.status, 413);
    // No Content-Length: a stream that passes the cap.
    const chunks = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100_000)));
        c.close();
      },
    });
    const streamed = await fetch(s.origin, /** @type {any} */ ({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, origin: PAGE }, body: chunks, duplex: 'half' })).catch(() => null);
    assert.ok(streamed === null || streamed.status === 413);
    assert.deepEqual(await s.lines(), []);
  } finally {
    await s.stop();
  }
});

test("the sink refuses what isn't a batch: not JSON, no entries, too many", async () => {
  const s = await sink();
  try {
    assert.equal((await post(s.origin, 'not json')).status, 400);
    assert.equal((await post(s.origin, { device: 'd' })).status, 400);
    assert.equal((await post(s.origin, { device: 'd', entries: Array.from({ length: 1001 }, (_, i) => entry(i)) })).status, 400);
    assert.equal((await post(s.origin, [entry(1)])).status, 400);
    assert.deepEqual(await s.lines(), []);
    // Entries that aren't objects are skipped; a long device name is cut.
    assert.equal((await post(s.origin, { device: 'd'.repeat(500), entries: [entry(1), 'text', null] })).status, 200);
    const lines = await s.lines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].device.length, 64);
  } finally {
    await s.stop();
  }
});

/** @param {string[]} args */
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10_000 });

test("the command line refuses annai's own ports, a short token and missing parts, in plain words", () => {
  assert.deepEqual(TAKEN, [8765, 8790, 8791, 8792, 8796, 8797, 18010, 18011, 18012, 18013, 18014]);
  for (const port of TAKEN) {
    const r = run(['--port', String(port), '--token', TOKEN, '--out', join(tmpdir(), 'never.jsonl')]);
    assert.equal(r.status, 1, String(port));
    assert.match(r.stderr, new RegExp(`Port ${port} is one of annai's own`));
  }
  const short = run(['--port', '0', '--token', 'short', '--out', join(tmpdir(), 'never.jsonl')]);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /at least 16 characters/);
  const none = run([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /node scripts\/trace-sink\.mjs --port <p> \(--token-file <path> \| --token <t>\) --out <file\.jsonl> \[--origin <allowed origin>\]/);
  assert.match(none.stderr, /TRACE_SINK_TOKEN/);
  const bad = run(['--port', 'eighty', '--token', TOKEN, '--out', join(tmpdir(), 'never.jsonl')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--port must be a port number/);
});

test('the command line says where it listens and how to put https in front of it with tailscale serve, naming no machine', async () => {
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  const child = spawn(process.execPath, [script, '--port', '0', '--token', TOKEN, '--out', join(dir, 'trace.jsonl'), '--origin', PAGE], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    let said = '';
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        said += String(d);
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(said);
        if (m && /tailscale serve/.test(said)) resolve(Number(m[1]));
      });
      child.once('exit', () => reject(new Error(`the sink exited: ${said}`)));
    });
    assert.match(said, new RegExp(`tailscale serve --bg --https=\\d+ http://127\\.0\\.0\\.1:${port}`));
    assert.match(said, /https:\/\/annai\.guide/);
    assert.ok(!said.includes(TOKEN), 'the token is never printed');
    assert.ok(!/\.ts\.net/.test(said), 'no machine is named');
    const res = await post(`http://127.0.0.1:${port}/`, { device: 'd', entries: [entry(1)] });
    assert.equal(res.status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
    await rm(dir, { recursive: true, force: true });
  }
});

test('the token can come from a file (--token-file) or TRACE_SINK_TOKEN, so it stays out of shell history and ps; a file that is missing is said plainly', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  try {
    await writeFile(join(dir, 'token'), `${TOKEN}\n`, { mode: 0o600 });
    const missing = run(['--port', '0', '--token-file', join(dir, 'nope'), '--out', join(dir, 'trace.jsonl')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /can't read the token file/);
    for (const how of [{ args: ['--token-file', join(dir, 'token')], env: {} }, { args: [], env: { TRACE_SINK_TOKEN: TOKEN } }]) {
      const child = spawn(process.execPath, [script, '--port', '0', ...how.args, '--out', join(dir, 'trace.jsonl'), '--origin', PAGE], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...how.env } });
      try {
        const port = await new Promise((resolve, reject) => {
          let said = '';
          child.stdout.on('data', (d) => {
            said += String(d);
            const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(said);
            if (m) resolve(Number(m[1]));
          });
          child.once('exit', () => reject(new Error(`the sink exited: ${said}`)));
        });
        assert.equal((await post(`http://127.0.0.1:${port}/`, { device: 'd', entries: [entry(1)] })).status, 200, JSON.stringify(how.args));
      } finally {
        if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write that fails half way (a full disk) leaves its cut line on a line of its own: the next batch starts a new line, and the plugin is told to send again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  const out = join(dir, 'trace.jsonl');
  const { appendFile: append } = await import('node:fs/promises');
  let full = true;
  const s = await startSink({
    port: 0, token: TOKEN, out, origins: [PAGE],
    append: async (/** @type {string} */ file, /** @type {string} */ text) => {
      if (!full) return append(file, text);
      full = false;
      await append(file, text.slice(0, 20));
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
  });
  try {
    assert.equal((await post(s.origin, { device: 'd', entries: [entry(1)] })).status, 500);
    assert.equal((await post(s.origin, { device: 'd', entries: [entry(1)] })).status, 200);
    const lines = (await readFile(out, 'utf8')).split('\n');
    assert.equal(lines.length, 3);
    assert.throws(() => JSON.parse(lines[0]), 'the cut line, alone');
    assert.equal(JSON.parse(lines[1]).seq, 1);
    assert.equal(lines[2], '');
  } finally {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Every file under a folder, as paths from it. @param {string} dir */
const filesIn = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1)).sort();

/** A clip sent as the plugin sends it. @param {any} s @param {Record<string, string>} q @param {any} [body] @param {Record<string, string>} [headers] */
const sendClip = (s, q, body = new Uint8Array([1, 2, 3, 0xff]), headers = {}) => fetch(`${s.origin}/trace/clips?${new URLSearchParams(q)}`, {
  method: 'POST', headers: { 'content-type': 'audio/ogg', authorization: `Bearer ${TOKEN}`, origin: PAGE, ...headers }, body,
});

test('a clip is written whole under clips/ beside the file, named by device and id, private, and writes no line; a retry replaces it', async () => {
  const s = await sink();
  try {
    const res = await sendClip(s, { device: 'dev01', id: 'h-abc_1', format: 'ogg' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { file: join('dev01', 'h-abc_1.ogg') });
    assert.equal(res.headers.get('access-control-allow-origin'), PAGE);
    const file = join(s.dir, 'clips', 'dev01', 'h-abc_1.ogg');
    assert.deepEqual([...await readFile(file)], [1, 2, 3, 0xff]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await s.lines()).length, 0);
    assert.equal((await sendClip(s, { device: 'dev01', id: 'h-abc_1', format: 'ogg' }, new Uint8Array([9]))).status, 200);
    assert.deepEqual([...await readFile(file)], [9]);
    assert.deepEqual(await filesIn(join(s.dir, 'clips')), [join('dev01', 'h-abc_1.ogg')]);
    // A batch to the same server still goes to the file.
    assert.equal((await post(`${s.origin}/trace`, { device: 'dev01', entries: [entry(1)] })).status, 200);
    assert.equal((await s.lines()).length, 1);
  } finally {
    await s.stop();
  }
});

test('a clip needs the token and an allowed origin, as a batch does, and writes nothing without them', async () => {
  const s = await sink();
  try {
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' }, undefined, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' }, undefined, { origin: 'https://other.example' })).status, 403);
    assert.deepEqual(await readdir(s.dir).then((l) => l.filter((x) => x !== 'trace.jsonl')), []);
  } finally {
    await s.stop();
  }
});

test('no name can leave the clips folder: an id or a format with a way out is refused, a device is made a plain folder name', async () => {
  const s = await sink();
  try {
    for (const id of ['../../escaped', '..', '.', 'a/b', 'a\\b', '%2e%2e%2fescaped', 'a.b', '', 'x'.repeat(81), 'a\0b']) {
      assert.equal((await sendClip(s, { device: 'd', id, format: 'ogg' })).status, 400, `id ${id}`);
    }
    for (const format of ['../../sh', 'o/g', 'OGG', '', 'a.b', 'waytoolongformat']) {
      assert.equal((await sendClip(s, { device: 'd', id: 'a', format })).status, 400, `format ${format}`);
    }
    assert.deepEqual(await readdir(s.dir).then((l) => l.filter((x) => x !== 'trace.jsonl')), []);
    for (const device of ['../../escaped', '..', '/etc', 'a/../../b', '..\\..\\c', 'my phone']) {
      assert.equal((await sendClip(s, { device, id: 'a', format: 'ogg' })).status, 200, `device ${device}`);
    }
    assert.equal((await sendClip(s, { id: 'none', format: 'ogg' })).status, 200);
    const files = await filesIn(s.dir);
    assert.ok(files.every((f) => f.startsWith(`clips${'/'}`) && f.split('/').length === 3 && !f.includes('..')), files.join());
    assert.ok(files.includes(join('clips', 'unknown', 'none.ogg')));
    assert.equal(deviceFolder('../..'), '_____');
    assert.equal(deviceFolder(''), 'unknown');
  } finally {
    await s.stop();
  }
});

test('a clip too big is refused, by what it says and by what it sends; an empty one is refused', async () => {
  const s = await sink();
  try {
    assert.equal((await sendClip(s, { device: 'd', id: 'big', format: 'ogg' }, new Uint8Array(CLIP_MAX + 1))).status, 413);
    assert.equal((await sendClip(s, { device: 'd', id: 'fits', format: 'ogg' }, new Uint8Array(BODY_MAX + 1))).status, 200, "a batch's limit isn't a clip's");
    assert.equal((await sendClip(s, { device: 'd', id: 'empty', format: 'ogg' }, new Uint8Array(0))).status, 400);
    assert.deepEqual(await filesIn(join(s.dir, 'clips')), [join('d', 'fits.ogg')]);
    assert.equal((await post(`${s.origin}/`, 'x'.repeat(BODY_MAX + 1))).status, 413, 'a batch keeps its limit');
  } finally {
    await s.stop();
  }
});

test('a full disk answers 507 and leaves no part of the clip, so the phone keeps it and tries later; once there is room it goes', async () => {
  let full = true;
  const s = await sink([PAGE], {
    write: async (/** @type {string} */ file, /** @type {Buffer} */ bytes, /** @type {any} */ o) => {
      if (!full) return writeFile(file, bytes, o);
      await writeFile(file, bytes.subarray(0, 1), o); // as a disk that fills part of the way
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
  });
  try {
    const res = await sendClip(s, { device: 'd', id: 'a', format: 'ogg' });
    assert.equal(res.status, 507);
    assert.equal((await res.json()).error, 'full');
    assert.deepEqual(await filesIn(join(s.dir, 'clips')), []);
    full = false;
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' })).status, 200);
    assert.deepEqual(await filesIn(join(s.dir, 'clips')), [join('d', 'a.ogg')]);
  } finally {
    await s.stop();
  }
});

test('a clip folder that can\'t be made answers 500, and the sink goes on', async () => {
  const s = await sink();
  try {
    await writeFile(join(s.dir, 'clips'), 'in the way');
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' })).status, 500);
    assert.equal((await post(`${s.origin}/`, { entries: [entry(1)] })).status, 200);
  } finally {
    await s.stop();
  }
});


test('a clip is refused with 507 while less than the floor would be left free on the disk, and batches still go; with room it is written', async () => {
  const GIB = 1024 ** 3;
  let free = 1.5 * GIB;
  const s = await sink([PAGE], { floor: 2 * GIB, free: async () => free });
  try {
    const res = await sendClip(s, { device: 'd', id: 'a', format: 'ogg' });
    assert.equal(res.status, 507);
    const body = await res.json();
    assert.equal(body.error, 'full');
    assert.match(body.message, /2 GiB/);
    assert.deepEqual(await filesIn(join(s.dir, 'clips')).catch(() => []), []);
    assert.equal((await post(`${s.origin}/`, { entries: [entry(1)] })).status, 200, 'the log goes on: the floor keeps room for it');
    free = 2 * GIB + 2; // the clip's own 4 bytes count against what is left
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' })).status, 507, 'a clip that would take it under the floor');
    free = 3 * GIB;
    assert.equal((await sendClip(s, { device: 'd', id: 'a', format: 'ogg' })).status, 200);
  } finally {
    await s.stop();
  }
});

test('the log file is private: made readable by its user only, and an existing one too, since it holds the screen text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  try {
    const old = join(dir, 'old.jsonl');
    await writeFile(old, '{"a":1}\n', { mode: 0o644 });
    const s = await startSink({ port: 0, token: TOKEN, out: old, origins: [PAGE] });
    assert.equal((await stat(old)).mode & 0o777, 0o600);
    assert.equal((await post(`${s.origin}/`, { entries: [entry(1)] })).status, 200);
    assert.equal((await stat(old)).mode & 0o777, 0o600);
    await s.close();
    const fresh = join(dir, 'fresh.jsonl');
    const t = await startSink({ port: 0, token: TOKEN, out: fresh, origins: [PAGE] });
    assert.equal((await post(`${t.origin}/`, { entries: [entry(1)] })).status, 200);
    assert.equal((await stat(fresh)).mode & 0o777, 0o600);
    await t.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
