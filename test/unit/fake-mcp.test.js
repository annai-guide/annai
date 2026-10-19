import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcpServer } from '../fakes/mcp.js';

/** One JSON-RPC message to the stand-in. @param {string} url @param {any} msg @param {Record<string, string>} [headers] */
const rpc = (url, msg, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(msg) });

test('the stand-in speaks Streamable HTTP: a session, tools in pages, calls, and the token it asks for', async () => {
  const s = await startMcpServer({ token: 'mcp-token-0123456789' });
  try {
    const auth = { Authorization: 'Bearer mcp-token-0123456789' };
    assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).status, 401);
    const init = await rpc(s.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, auth);
    const session = String(init.headers.get('mcp-session-id'));
    assert.equal((await init.json()).result.protocolVersion, '2025-06-18');
    const h = { ...auth, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18' };
    assert.equal((await rpc(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, h)).status, 202);
    const page1 = (await (await rpc(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, h)).json()).result;
    assert.equal(page1.tools.length, 3);
    const page2 = (await (await rpc(s.url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: page1.nextCursor } }, h)).json()).result;
    assert.deepEqual([...page1.tools, ...page2.tools].map((t) => t.name), ['echo', 'add', 'map', 'whoami', 'fail', 'slow']);
    const echo = (await (await rpc(s.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'tide' } } }, h)).json()).result;
    assert.deepEqual(echo.content, [{ type: 'text', text: 'tide' }]);
    assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, { ...auth, 'Mcp-Session-Id': 'gone' })).status, 404);
    s.endSessions();
    assert.equal((await rpc(s.url, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} }, h)).status, 404);
    const pre = await fetch(s.url, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8790', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, mcp-session-id' } });
    assert.match(String(pre.headers.get('access-control-allow-headers')), /mcp-session-id/i);
    assert.equal(s.requests.filter((r) => r.rpc?.method === 'tools/call').length, 1);
  } finally {
    await s.stop();
  }
});

test('the stand-in can answer a call as an SSE stream, with a notification first', async () => {
  const s = await startMcpServer({ sse: true, sessions: false });
  try {
    const res = await rpc(s.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } });
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /notifications\/progress/);
    assert.match(body, /"structuredContent":\{"sum":5\}/);
  } finally {
    await s.stop();
  }
});

test("minors 9: the stand-in checks what the reference SDK checks: Accept (406), MCP-Protocol-Version (400) and, when given its origins, Origin (403)", async () => {
  const s = await startMcpServer({ origins: ['http://127.0.0.1:8790'] });
  try {
    const hello = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const post = (/** @type {any} */ msg, /** @type {Record<string, string>} */ headers) => fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(msg) });
    assert.equal((await post(hello, { Accept: 'application/json' })).status, 406);
    assert.equal((await post(hello, { Accept: 'text/event-stream' })).status, 406);
    assert.equal((await post(hello, { Accept: 'application/json, text/event-stream', Origin: 'https://evil.example' })).status, 403);
    const init = await post(hello, { Accept: 'application/json, text/event-stream', Origin: 'http://127.0.0.1:8790' });
    assert.equal(init.status, 200);
    const session = String(init.headers.get('mcp-session-id'));
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    const h = { Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': session };
    assert.equal((await post(list, { ...h, 'MCP-Protocol-Version': '2024-01-01' })).status, 400);
    assert.equal((await post(list, { ...h, 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
    assert.equal((await post(list, h)).status, 200, 'none is taken as 2025-03-26, as the SDK does');
    assert.equal((await fetch(s.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': session, Origin: 'https://evil.example' } })).status, 403);
  } finally {
    await s.stop();
  }
});

test("small fixes 12: given its origins, the stand-in lets a request with no Origin through, as the reference SDK does, and refuses the opaque Origin null", async () => {
  const s = await startMcpServer({ origins: ['http://127.0.0.1:8790'] });
  try {
    const hello = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const post = (/** @type {Record<string, string>} */ headers) => fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: hello });
    assert.equal((await post({})).status, 200, 'no Origin: a client outside a browser');
    const opaque = await post({ Origin: 'null' });
    assert.equal(opaque.status, 403);
    assert.match((await opaque.json()).error.message, /Origin/);
  } finally {
    await s.stop();
  }
});
