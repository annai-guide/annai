import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, mcpToolName, toolOutput } from '../../src/plugins/mcp/client.js';
import { startMcpServer } from '../fakes/mcp.js';
import { ANSWER_MAX } from '../../src/core/answer.js';

const TOKEN = 'mcp-token-0123456789';
const get = (/** @type {string} */ url, /** @type {RequestInit} */ init) => fetch(url, init);
const client = (/** @type {string} */ url, token = TOKEN) => new McpClient({ url, server: 'trail', auth: async () => (token ? { Authorization: `Bearer ${token}` } : {}) });

test('the client: a session, every page of tools, a call; the protocol version and session go with each request', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const c = client(s.url);
    const tools = await c.listTools({ fetch: get });
    assert.deepEqual(tools.map((t) => t.name), ['echo', 'add', 'map', 'whoami', 'fail', 'slow']);
    assert.deepEqual((await c.callTool('echo', { text: 'tide' }, { fetch: get })).content, [{ type: 'text', text: 'tide' }]);
    const after = s.requests.filter((r) => r.rpc?.method !== 'initialize');
    assert.ok(after.every((r) => r.headers['mcp-protocol-version'] === '2025-06-18' && r.headers['mcp-session-id']));
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'notifications/initialized').length, 1);
  } finally {
    await s.stop();
  }
});

test('the client reads an SSE answer, skips what the server says on the way, and starts a session again once when it ended', async () => {
  const s = await startMcpServer({ sse: true });
  try {
    const c = client(s.url, '');
    assert.deepEqual((await c.callTool('add', { a: 2, b: 3 }, { fetch: get })).structuredContent, { sum: 5 });
    s.endSessions();
    assert.equal((await c.callTool('echo', { text: 'again' }, { fetch: get })).content[0].text, 'again');
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'initialize').length, 2);
  } finally {
    await s.stop();
  }
});

test('what goes wrong is a plain McpError in words: a refused token, an unknown method, a server down, a broken answer', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    await assert.rejects(client(s.url, 'wrong-token-0000000').listTools({ fetch: get }), (e) => e instanceof McpError && e.kind === 'auth' && /refused annai's key/.test(e.message));
    await assert.rejects(client(s.url).callTool('nope', {}, { fetch: get }), (e) => e instanceof McpError && e.kind === 'server' && /said: /.test(e.message));
  } finally {
    await s.stop();
  }
  await assert.rejects(client(s.url).listTools({ fetch: get }), (e) => e instanceof McpError && e.kind === 'cors' && /couldn't reach the MCP server trail/.test(e.message));
  const broken = async () => new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: broken }), (e) => e instanceof McpError && e.kind === 'answer' && !(e instanceof SyntaxError));
  const cut = async () => new Response('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: cut }), (e) => e instanceof McpError && e.kind === 'answer');
  const old = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {} } }), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: old }), /speaks MCP 2024-11-05/);
});

test("8c-4: an SSE answer is read no further than 8 MB: more is the server's error, and the rest is never read", async () => {
  let sent = 0;
  const endless = async () => new Response(new ReadableStream({
    pull(c) {
      if (sent >= 24 * 1024 * 1024) return c.close();
      sent += 1024 * 1024;
      c.enqueue(new Uint8Array(1024 * 1024).fill(120)); // "xxx…", no line end
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: endless }), (e) => e instanceof McpError && e.kind === 'answer' && /sent more than annai reads \(8 MB\)/.test(e.message));
  assert.ok(sent <= ANSWER_MAX + 3 * 1024 * 1024, `read ${sent} bytes`);
});

test("tool names: mcp_<server>_<tool>, safe for every provider, short enough, and never two the same (choice 1)", () => {
  const taken = new Set();
  const a = mcpToolName('trail', 'echo', taken);
  assert.equal(a, 'mcp_trail_echo');
  taken.add(a);
  assert.match(mcpToolName('trail', 'files/read.v2', taken), /^mcp_trail_files_read_v2$/);
  const long = mcpToolName('trail', 'x'.repeat(80), taken);
  assert.ok(long.length <= 64 && /^mcp_trail_x+_[a-z0-9]{6}$/.test(long), long);
  taken.add('mcp_trail_a_b');
  assert.match(mcpToolName('trail', 'a.b', taken), /^mcp_trail_a_b_[a-z0-9]{6}$/);
});

test("what a tool answers, for Shiori: text, images, a resource's text, structured content, errors (choice 8)", () => {
  assert.deepEqual(toolOutput({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), { content: 'one\n\ntwo' });
  const img = toolOutput({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] });
  assert.deepEqual([img.content, img.images], ['An image (image/png).', [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }]]);
  assert.equal(toolOutput({ content: [{ type: 'resource', resource: { uri: 'file:///a.md', mimeType: 'text/markdown', text: '# A' } }] }).content, '# A');
  assert.equal(toolOutput({ content: [{ type: 'audio', data: 'x', mimeType: 'audio/wav' }] }).content, 'A sound (audio/wav), which annai doesn\'t pass on.');
  assert.equal(toolOutput({ content: [{ type: 'resource_link', uri: 'https://trails.example/a', name: 'Trail A' }] }).content, 'Trail A: https://trails.example/a');
  assert.equal(toolOutput({ content: [], structuredContent: { sum: 5 } }).content, '{"sum":5}');
  assert.deepEqual(toolOutput({ content: [{ type: 'text', text: 'no such trail' }], isError: true }), { content: 'no such trail', isError: true });
  assert.equal(toolOutput({}).content, 'The tool answered nothing.');
});

test("8c-1: an image passes on only when its data is base64; a data: address, base64url or anything else doesn't", () => {
  for (const data of ['data:image/png;base64,iVBORw0KGgo=', 'iVBORw0KGgo-_w', 'iVBO Rw0K', 'not base64!', 'iVBORw0KGgo=A', 'A', '']) {
    const out = toolOutput({ content: [{ type: 'image', data, mimeType: 'image/png' }] });
    assert.deepEqual(out, { content: "An image (image/png) that annai doesn't pass on." }, data);
  }
  assert.deepEqual(toolOutput({ content: [{ type: 'image', data: 'iVBORw0KGgo', mimeType: 'image/png' }] }).images, [{ mediaType: 'image/png', data: 'iVBORw0KGgo' }]);
  assert.deepEqual(toolOutput({ content: [{ type: 'image', data: 'iVBORw0KGgo+/A==', mimeType: 'image/png' }] }).images, [{ mediaType: 'image/png', data: 'iVBORw0KGgo+/A==' }]);
});

test('8c-5: a tool a server lists twice is listed once, the first time', async () => {
  const s = await startMcpServer({ tools: [{ name: 'echo', description: 'First.' }, { name: 'add' }, { name: 'echo', description: 'Again.' }] });
  try {
    const tools = await client(s.url, '').listTools({ fetch: get });
    assert.deepEqual(tools.map((t) => [t.name, t.description]), [['echo', 'First.'], ['add', undefined]]);
  } finally {
    await s.stop();
  }
});

/** An answer whose body never ends, and stops with the request's own reason, as a browser's does. @param {RequestInit | undefined} init @param {string} type */
const stalled = (init, type) => new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode(type === 'application/json' ? '{"jsonrpc":"2.0",' : 'event: message\n'));
    init?.signal?.addEventListener('abort', () => c.error(init.signal?.reason));
  },
}), { status: 200, headers: { 'Content-Type': type } });

test("minors 1: a time limit reached while an answer is read is the time limit, as JSON or as SSE, never \"can't read\"", async () => {
  for (const type of ['application/json', 'text/event-stream']) {
    const slow = async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => stalled(init, type);
    await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: slow, signal: AbortSignal.timeout(50) }), (e) => /** @type {any} */ (e).name === 'TimeoutError', type);
  }
  // A fetch that says so in its own words (annai's traced fetch does) is the time limit too.
  const traced = async () => { throw new Error("annai couldn't reach mcp.example (The operation timed out.). Is the device offline?"); };
  const signal = AbortSignal.timeout(1);
  await new Promise((done) => setTimeout(done, 20));
  await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: traced, signal }), (e) => /** @type {any} */ (e).name === 'TimeoutError');
});

test('minors 3: after close(), a call says the server was removed, also one in flight that sees the session gone; no session starts again', async () => {
  const s = await startMcpServer({});
  try {
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((done) => { release = () => done(undefined); });
    // tools/call waits until the session was ended, so the server answers it 404.
    const gated = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      if (String(init?.body ?? '').includes('tools/call')) await held;
      return fetch(url, init);
    };
    const c = client(s.url, '');
    await c.listTools({ fetch: get });
    const inFlight = c.callTool('echo', { text: 'tide' }, { fetch: gated });
    await new Promise((done) => setTimeout(done, 20));
    await c.close({ fetch: get });
    release();
    await assert.rejects(inFlight, (e) => e instanceof McpError && /The MCP server trail was removed/.test(e.message));
    await assert.rejects(c.callTool('echo', { text: 'again' }, { fetch: get }), /The MCP server trail was removed/);
    await assert.rejects(c.listTools({ fetch: get }), /was removed/);
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'initialize').length, 1);
  } finally {
    await s.stop();
  }
});

test('minors 3: a session that starts while the client closes is ended at once', async () => {
  const s = await startMcpServer({});
  try {
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((done) => { release = () => done(undefined); });
    const gated = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      if (String(init?.body ?? '').includes('"initialize"')) await held;
      return fetch(url, init);
    };
    const c = client(s.url, '');
    const listing = c.listTools({ fetch: gated });
    await new Promise((done) => setTimeout(done, 20));
    await c.close({ fetch: get });
    release();
    await assert.rejects(listing, /The MCP server trail was removed/);
    assert.equal(s.requests.filter((r) => r.method === 'DELETE').length, 1, 'the session it got was ended');
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'tools/list').length, 0);
  } finally {
    await s.stop();
  }
});

test("minors 4: two calls wait for one session start; stopping one doesn't stop the other, and stopping both stops the start", async () => {
  const s = await startMcpServer({});
  try {
    /** @type {AbortSignal[]} */
    const initSignals = [];
    const slowInit = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      if (String(init?.body ?? '').includes('"initialize"')) {
        if (init.signal) initSignals.push(init.signal);
        await new Promise((done) => setTimeout(done, 80));
        init.signal?.throwIfAborted();
      }
      return fetch(url, init);
    };
    const c = client(s.url, '');
    const a = new AbortController();
    const first = c.callTool('echo', { text: 'one' }, { fetch: slowInit, signal: a.signal });
    const second = c.callTool('echo', { text: 'two' }, { fetch: slowInit, signal: new AbortController().signal });
    await new Promise((done) => setTimeout(done, 20));
    a.abort();
    await assert.rejects(first, (e) => /** @type {any} */ (e).name === 'AbortError');
    assert.equal((await second).content[0].text, 'two');
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'initialize').length, 1);

    const lone = client(s.url, '');
    const b = new AbortController();
    const only = lone.listTools({ fetch: slowInit, signal: b.signal });
    await new Promise((done) => setTimeout(done, 20));
    b.abort();
    await assert.rejects(only, (e) => /** @type {any} */ (e).name === 'AbortError');
    assert.ok(initSignals.at(-1)?.aborted, 'the start stopped once no one waited for it');
  } finally {
    await s.stop();
  }
});

test("minors 5: a 400's words are read no further than their start; the rest is never read", async () => {
  for (const said of ['Bad Request: no session', 'Bad Request']) {
    let sent = 0;
    const fake = async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
      const m = JSON.parse(String(init.body));
      if (m.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
      if (!('id' in m)) return new Response(null, { status: 202 });
      // A session the browser couldn't see, refused with words that go on and on.
      return new Response(new ReadableStream({
        pull(c) {
          if (sent >= 24 * 1024 * 1024) return c.close();
          c.enqueue(new TextEncoder().encode(sent === 0 ? said.padEnd(1024 * 1024) : ' '.repeat(1024 * 1024)));
          sent += 1024 * 1024;
        },
      }), { status: 400 });
    };
    await assert.rejects(client('https://mcp.example/mcp').listTools({ fetch: fake }), (e) => e instanceof McpError && (/session/.test(said) ? e.kind === 'cors' : /answered 400/.test(e.message)));
    assert.ok(sent <= 3 * 1024 * 1024, `read ${sent} bytes`);
  }
});
