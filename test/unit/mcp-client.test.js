import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, mcpToolName, toolOutput, addressParts, fullAddress } from '../../src/plugins/mcp/client.js';
import { startMcpServer } from '../fakes/mcp.js';

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

test('8c-2: ordinary words in an address stay; a key is 8 or more characters mixing letters and digits, or 32 or more', () => {
  for (const a of ['https://mcp.example.com/model-context-protocol/mcp', 'https://mcp.example.com/my-company-name-here/mcp', 'https://mcp.example.com/mcp?topic=trailheads-and-parking&v=2']) {
    assert.deepEqual(addressParts(a), { shown: a, keys: [] }, a);
  }
  const long = 'abcdefghijklmnopqrstuvwxyzabcdefgh';
  const { shown, keys } = addressParts(`https://mcp.example.com/s/${long}/a1b2c3d4/mcp?q=${long}&n=abcdefgh&token=x`);
  assert.equal(shown, 'https://mcp.example.com/s/«key»/«key»/mcp?q=«key»&n=abcdefgh&token=«key»');
  assert.deepEqual(keys, [long, 'a1b2c3d4', long, 'x']);
});

test('an address and its keys: shown with each part that may be a key blanked, and put back whole (the third finding)', () => {
  const a = 'https://mcp.example.com/api/mcp/s/zap1a2b3c4d5e6f7g8h9/mcp?v=2&key=q9w8e7r6t5y4&k=abc&api_key=short';
  const { shown, keys } = addressParts(a);
  assert.equal(shown, 'https://mcp.example.com/api/mcp/s/«key»/mcp?v=2&key=«key»&k=abc&api_key=«key»');
  assert.deepEqual(keys, ['zap1a2b3c4d5e6f7g8h9', 'q9w8e7r6t5y4', 'short']);
  assert.equal(fullAddress(shown, keys), a);
  assert.deepEqual(addressParts('http://127.0.0.1:8080/mcp'), { shown: 'http://127.0.0.1:8080/mcp', keys: [] });
});

test("a short value under a credential name annai's trace blanks (appid, app_id) is blanked in the shown address too, and goes to secrets", () => {
  const { shown, keys } = addressParts('https://mcp.example.com/mcp?appid=abc123&app_id=x9&v=2');
  assert.equal(shown, 'https://mcp.example.com/mcp?appid=«key»&app_id=«key»&v=2');
  assert.deepEqual(keys, ['abc123', 'x9']);
});
