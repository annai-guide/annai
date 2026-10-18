import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSink, TAKEN, BODY_MAX } from '../../scripts/trace-sink.mjs';

const script = fileURLToPath(new URL('../../scripts/trace-sink.mjs', import.meta.url));
const TOKEN = 'sink-token-0123456789abcdef';
const PAGE = 'http://127.0.0.1:8790';

/** A sink on a port of its own (port 0), writing to a file in a folder of its own. @param {string[]} [origins] */
async function sink(origins = [PAGE]) {
  const dir = await mkdtemp(join(tmpdir(), 'annai-trace-sink-'));
  const out = join(dir, 'trace.jsonl');
  /** @type {string[]} */
  const said = [];
  const s = await startSink({ port: 0, token: TOKEN, out, origins, log: (line) => said.push(line) });
  return {
    ...s, out, said,
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
  assert.match(none.stderr, /node scripts\/trace-sink\.mjs --port <p> --token <t> --out <file\.jsonl> \[--origin <allowed origin>\]/);
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
