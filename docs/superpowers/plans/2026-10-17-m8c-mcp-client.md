# Milestone 8c: The MCP Client, Its Stand-in Server, and Milestone 8's Device Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP servers as tools for Shiori (spec §5.1: "Remote servers over HTTP. A built-in MCP client plugin registers each server's tools as `mcp.<server>.<tool>`. The server must allow browser access (CORS). Auth is a URL plus headers or a bearer token. OAuth for MCP comes later."), and the rest of milestone 8:
- **A stand-in MCP server of our own** (the user's decision): MCP's Streamable HTTP transport with CORS, a bearer token, sessions, JSON and SSE answers, a few tools; port 0 in tests; a `scripts/` runner for the device check, which also serves the test packages so the phones can install a skill and a plugin from an address.
- **The client:** initialize, the session, `tools/list` (with pages), `tools/call`; every request through the traced fetch; every answer read guarded.
- **The built-in `mcp` plugin:** servers added in Settings → Tools → MCP servers (a name, an address, and none, a bearer token or headers, kept in secrets); their tools registered as `mcp_<server>_<tool>` under Settings → Tools with switches; results back to Shiori as text and images, with any secret annai keeps blanked; removing a server removes everything it stored.
- **Done when (§20 row 8), the MCP part, in Chromium and WebKit:** the stand-in added in settings with a bearer token kept in secrets, its tools registered, called by a stand-in model, each call in the trace, the token never in the trace.
- **`docs/testing/device-checklist-m8.md`:** install a skill, an MCP server (the stand-in over the tailnet) and a code plugin on both phones; use each; remove each.

**Architecture:**
- `test/fakes/mcp.js`: `startMcpServer(o)`; `scripts/mcp-stand-in.mjs`: the runner for the device check.
- `src/plugins/mcp/client.js`: `McpClient` (Streamable HTTP), `McpError`, `mcpToolName`, `toolOutput`.
- `src/plugins/mcp/index.js`: the built-in plugin: servers as files `/mcp/<server>.json` in `sys:settings` (each forgotten whole when removed), auth in the secret `plugin:mcp:<server>`, tools registered from the stored list (so they are there offline), and a `mcp-servers` service the screen uses.
- `src/ui/screens/mcp.js` (`#/mcp`), linked from Settings → Tools; Settings → Tools groups MCP tools by server.

**Tech Stack:** as 8a and 8b.

**Spec:** `docs/superpowers/specs/2026-10-15-annai-design.md`: §5.1 (MCP servers), §3 (`mcp.*` among the tools), §7.2, §9.9 (keys), §15 (the trace shows everything sent and read), §2 principle 2, §4.9, §17, §18 (device checklist), §20 row 8. MCP: the Streamable HTTP transport (spec revision 2025-06-18).

## Choices this plan makes (please check them)

1. **Tool names are `mcp_<server>_<tool>`.** Providers accept only letters, digits, `_` and `-` in a tool's name (annai's `TOOL_NAME`), so §5.1's `mcp.<server>.<tool>` is sent with `_` for `.`, as milestone 5 did for `watch.set`. Other characters in an MCP tool's name become `_`; a name longer than 64, or one that two tools would share, is cut and ends in `_` and six characters of a hash of the tool's own name. *Cost if wrong:* a rename.
2. **Streamable HTTP only** (MCP 2025-03-26 and later): annai asks for protocol version `2025-06-18` and works with `2025-03-26`, `2025-06-18` and `2025-11-25`. The older HTTP+SSE transport and the GET stream for the server's own messages aren't used: annai only asks and reads answers. A server's requests to annai (sampling, elicitation) and its notifications are skipped. *Cost if wrong:* servers that only speak the 2024 transport can't be added.
3. **A server is a name, an address and its auth:** the name is 1 to 20 lowercase letters, digits and dashes (it goes into tool names); the address is `https:` (or `http:` for this device: localhost, 127.0.0.1, as the security policy allows); auth is none, a bearer token, or headers (one `Name: value` per line). The token and the headers' values live only in the secret `plugin:mcp:<server>`; the server's file holds its name, address, what kind of auth it has and its tool list. *Cost if wrong:* OAuth servers can't be added (§5.1: later).
4. **Adding checks first:** annai connects and lists the tools before saving anything; a server that can't be reached, refuses the token, doesn't let web apps call it, or answers something annai can't read is not added, and the screen says why and what to do. *Cost if wrong:* a server that is down when added must be added again later.
5. **The tool list is kept** in the server's file, so its tools are there offline and at start without a request. **Refresh tools** asks again (also after a call answers "unknown tool"). At most 100 tools a server; the screen says when a server has more. *Cost if wrong:* a server's new tools wait for Refresh.
6. **A session** starts at the first call after annai starts (initialize, then `notifications/initialized`), is kept in memory, and is started again once when the server says it ended (HTTP 404). Removing a server ends its session (DELETE), when the server can be reached.
7. **Every MCP request goes through the traced fetch:** a call's requests are in the open trip's log under the tool's name (so Trace → Web shows them next to the call), adding and refreshing under "plugin:mcp" in the system log. Headers never reach the trace; the address is kept as `traceUrl` keeps it.
8. **What a tool answers, Shiori gets:** text parts as text; images (PNG, JPEG, WebP, GIF up to 5 MB) as images; an embedded text resource as its text; other parts described in a line; `structuredContent` as JSON when there is no text; `isError` as an error she sees. Every text has each secret annai keeps blanked, so a server that echoes the token can't put it into her context or the log. *Cost if wrong:* none.
9. **Time limits:** 30 seconds to connect or list, 120 seconds for a call; the user's Stop ends any of them.
10. **Removing a server removes everything it stored:** its file and the file's history, its secret, its tools' switches, its tools; the system log says `mcp.remove`. What its tools answered stays in the trips' conversations (it is their history). *Cost if wrong:* as 8a's choice 4.
11. **The stand-in** (`test/fakes/mcp.js`) has the tools `echo` (`{ text }` → the text), `add` (`{ a, b }` → the sum, with `structuredContent`), `map` (→ a small PNG), `whoami` (→ the Authorization header it got, to prove annai blanks it), `fail` (→ `isError`) and `slow` (waits `ms`); `--sse` answers calls as SSE streams. The runner `scripts/mcp-stand-in.mjs --port <port> --token <token> [--files <dir>]` prints its MCP address and serves `<dir>` at `/files/` with CORS.
12. **The size budget** is raised in Task 5 to what 8c needs plus about 5 KiB, rounded to 10.

## Global Constraints

- All of 8a's and 8b's Global Constraints hold (zero runtime dependencies; `npm run stamp && npm run check` before every commit, chained with `&&`; the attribution lines; `SHELL` lists every shipped file; e2e only in Docker; stand-in servers on port 0; never host ports 8765, 8790, 8791, 8792, 8796, 8797, 18010–18014).
- **The MCP test server is our own** (the user's decision): no outside MCP service.
- **"MCP tools appear under Settings → Tools with switches, and every MCP request is in the trace"** (the user's decision); prompt injection through MCP results is the user's responsibility, and switches and the trace are the mitigations.
- **"Keys and tokens never appear in context, files, events or the trace; they live only in secrets (MCP bearer tokens and headers included)."**
- **"Anything parsed from a server's answer (MCP included) goes through readAnswer/answerJSON or is guarded, so a broken answer is a plain Error, never a TypeError/SyntaxError/RangeError that quarantines the plugin."**
- **"Removing a plugin, skill or MCP server removes everything it stored."**

## Review Focus

1. **Servers that misbehave:** a 401, a 404 for an ended session, a 500, an answer that isn't JSON, an SSE stream that never sends the answer or is cut off, a JSON-RPC error, a tool list with odd names or no `inputSchema`: a plain error in words, never a crash that counts against the plugin; a session that ended starts again once. Pinned in Task 2.
2. **A token in places it mustn't be:** the server echoing it in a result, an error message holding it, the address holding a key in its query: blanked in what Shiori sees and in the log; never in a file. Pinned in Tasks 3 and 5.
3. **Offline or a server that is down:** at start the tools are there from the stored list; a call says the server can't be reached; adding says why and saves nothing. Pinned in Task 3.
4. **Two servers, or many tools:** tools of two servers never collide; names that sanitize to the same thing differ; more than 100 tools are cut and said. Pinned in Tasks 2 and 3.
5. **Removing a server while its tools are switched off or in use:** its switches go; a call already running ends with its answer or an error; its file's history goes. Pinned in Task 3.

## File map

| File | Task | Responsibility |
|---|---|---|
| `test/fakes/mcp.js`, `scripts/mcp-stand-in.mjs` | 1 | the stand-in MCP server and its runner |
| `src/plugins/mcp/client.js` | 2 | `McpClient`, `McpError`, `mcpToolName`, `toolOutput` |
| `src/plugins/mcp/index.js`, `src/app/main.js` | 3 | the built-in plugin: servers, tools, the service |
| `src/ui/screens/mcp.js`, `src/ui/screens/tools.js`, `src/ui/shell.js`, `src/ui/router.js` | 4 | Settings → Tools → MCP servers; MCP tools grouped by server |
| `test/e2e/mcp.spec.js`, `docs/testing/device-checklist-m8.md`, `docs/plugins.md`, `README.md`, `scripts/size.mjs` | 5 | end to end; the device checklist; the guide; the budget |

---

### Task 1: The stand-in MCP server

**Files:**
- Create: `test/fakes/mcp.js`, `scripts/mcp-stand-in.mjs`
- Test: `test/unit/fake-mcp.test.js`

**Interfaces:**
- Produces: `startMcpServer({ token?, sse?: boolean, sessions?: boolean, exposeSession?: boolean, cors?: boolean, port?: number, host?: string, files?: string, tools?: any[] } = {}): Promise<{ origin: string, url: string, requests: { method: string, rpc: any, headers: Record<string, string | undefined> }[], endSessions(): void, stop(): Promise<void> }>` — `url` is `<origin>/mcp`. POST `/mcp` takes one JSON-RPC message: `initialize` answers `{ protocolVersion: <the one asked for when supported, else '2025-06-18'>, capabilities: { tools: {} }, serverInfo: { name: 'annai stand-in', version: '1.0.0' } }` with a new `Mcp-Session-Id` (when `sessions`); `notifications/initialized` and other notifications: 202; `tools/list` (`{ cursor? }`): the tools in pages of 3 (`nextCursor`); `tools/call`: Choice 11's tools; an unknown method: JSON-RPC error -32601; a missing or ended session: 404; a wrong token: 401 with `WWW-Authenticate: Bearer`; DELETE `/mcp`: ends the session (204). Answers are `application/json`, or for `tools/call` with `sse`, a `text/event-stream` that sends a `notifications/progress` first, then the answer, and ends. CORS (unless `cors: false`, which sends no CORS headers at all): any origin; `OPTIONS` answers the methods and headers asked for; `Access-Control-Expose-Headers: Mcp-Session-Id` (unless `exposeSession: false`). `tools` replaces the six tools (each answering its own name). With `files`, GET `/files/<path>` serves that folder with CORS (no `..`).
- The runner: `node scripts/mcp-stand-in.mjs --port <port> [--host <host>] [--token <token>] [--files <dir>] [--sse]` prints `MCP stand-in: <url>` and, with files, `Files: <origin>/files/`; it refuses annai's own ports (8765, 8790–8792, 8796, 8797, 18010–18014) with a plain message.

- [ ] **Step 1: Write the failing test**

`test/unit/fake-mcp.test.js`:
```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/unit/fake-mcp.test.js`
Expected: FAIL — `test/fakes/mcp.js` can't be found.

- [ ] **Step 3: Implement** `test/fakes/mcp.js` and `scripts/mcp-stand-in.mjs` as the Interfaces say (Node's `http`; the PNG for `map` a fixed 1×1 image).

- [ ] **Step 4: Run it to make sure it passes**

Run: `node --test test/unit/fake-mcp.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "A stand-in MCP server of annai's own: Streamable HTTP with CORS, a token, sessions, JSON and SSE answers, and a runner for the device check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 2: The MCP client

**Files:**
- Create: `src/plugins/mcp/client.js`
- Modify: `sw.js` (`SHELL`)
- Test: `test/unit/mcp-client.test.js`

**Interfaces:**
- Consumes: `answerJSON` (`src/core/answer.js`), `sse` (`src/core/llm/sse.js`), `TOOL_NAME` (`src/core/agent/tools.js`).
- Produces:
  - `class McpError extends Error` with `kind: 'auth' | 'cors' | 'session' | 'server' | 'answer' | 'network'`.
  - `class McpClient` — `constructor({ url, server, auth: () => Promise<Record<string, string>> })` (`server`: its name, for messages; `auth`: the headers to send); `connect({ fetch, signal })`; `listTools({ fetch, signal }): Promise<any[]>` (all pages, at most 10 pages); `callTool(name, args, { fetch, signal }): Promise<any>` (the `result`; connects first when there is no session; on a 404 with a session, connects again once and retries); `close({ fetch })` (DELETE, best effort). `SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26']`; `ASKED = '2025-06-18'`.
  - Messages: 401/403 → `McpError('auth', "The MCP server <server> refused annai's key. Check its token or headers in Settings → Tools → MCP servers.")`; a fetch that throws a `TypeError` → `McpError('cors', "annai couldn't reach the MCP server <server>. Check its address, that it is running, and that it lets web apps call it (CORS).")` (a `tracedFetch`'s plain error passes through as `network`); another status → `McpError('server', "The MCP server <server> answered <status>.")`; a JSON-RPC error → `McpError('server', "The MCP server <server> said: <message>")`; an answer annai can't read (not JSON, no answer for its id, an SSE stream that ends or breaks first) → `McpError('answer', "The MCP server <server> sent an answer annai can't read.")`; a protocol version annai doesn't speak → `McpError('server', "The MCP server <server> speaks MCP <v>; annai speaks 2025-03-26 to 2025-11-25.")`; a session the server sent but the browser can't read (no `Mcp-Session-Id` though the next request is refused with 400): `McpError('cors', "The MCP server <server> started a session annai can't see. It must list Mcp-Session-Id in Access-Control-Expose-Headers.")`.
  - `mcpToolName(server: string, tool: string, taken: Set<string>): string` — Choice 1 (FNV-1a of the tool's name, base 36, 6 characters).
  - `toolOutput(result: any): { content: string, images?: { mediaType: string, data: string }[], isError?: boolean }` — Choice 8, without the blanking (the plugin blanks).

- [ ] **Step 1: Write the failing tests**

`test/unit/mcp-client.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClient, McpError, mcpToolName, toolOutput } from '../../src/plugins/mcp/client.js';
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
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/mcp-client.test.js`
Expected: FAIL — `src/plugins/mcp/client.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. JSON answers through `answerJSON` (its errors become `McpError('answer')`, except the status ones handled first); SSE answers through `sse(res.body)`, each event's data parsed in a `try`, stopping at the message with our id; the reader cancelled once it is found. Add `'/src/plugins/mcp/client.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/mcp-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "annai's MCP client: Streamable HTTP sessions, every page of tools, calls answered as JSON or SSE, and plain words for what goes wrong

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 3: The built-in MCP plugin

**Files:**
- Create: `src/plugins/mcp/index.js`
- Modify: `src/app/main.js` (`addBuiltin` the MCP plugin), `sw.js` (`SHELL`)
- Test: `test/unit/mcp-plugin.test.js`

**Interfaces:**
- Consumes: Task 2; `annai.files` (the workspace), `annai.net.fetch`, `annai.tools.register`, `annai.register`; `forget` (`src/core/forget.js`), `withoutSecrets` (`src/core/agent/net.js`), `updateAppSettings`.
- Produces:
  - `manifest`: `{ id: 'mcp', name: 'MCP servers', version: VERSION, api: 1, description: 'Tools from MCP servers you add in Settings → Tools.' }`.
  - At `activate`: each stored server's tools are registered (`group: 'MCP: <server>'`, the description the server gave plus ` (from the MCP server <server>)`, the input schema the server gave, an object schema when it gave none); a `mcp-servers` service is registered:
    - `list(): Promise<{ name, url, auth: 'none' | 'token' | 'headers', tools: { name, mcp }[], more: number, refreshed }[]>` (`url` as `traceUrl` keeps it; `more`: tools past the 100);
    - `add({ name, url, token?, headers? }): Promise<{ tools: number }>` — Choice 3 and 4; errors in words, e.g. `'A server\'s name is 1 to 20 lowercase letters, digits and dashes, like trail.'`, `'There is a server called trail already.'`, `'The address must start with https:// (or http://localhost or http://127.0.0.1 on this device).'`, `'Each header is one line: Name: value.'`;
    - `refresh(name): Promise<{ tools: number }>`;
    - `remove(name): Promise<void>` — Choice 10.
  - A tool's `run(input, call)`: `client.callTool(<its MCP name>, input, { fetch: call.fetch, signal: AbortSignal.any([call.signal, AbortSignal.timeout(120_000)]) })` → `toolOutput` → every text through `withoutSecrets`; `isError` throws an `Error` with that text; an `McpError` (and a timeout) is rethrown as a plain `Error` with its words, so it is Shiori's answer, never the plugin's crash. An answer naming an unknown tool refreshes the list once.

- [ ] **Step 1: Write the failing tests**

`test/unit/mcp-plugin.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostKit } from './package-kit.js';
import { startMcpServer } from '../fakes/mcp.js';
import { createTrip, SYS_SETTINGS } from '../../src/core/scopes.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { setToolSwitch } from '../../src/core/agent/tools.js';
import { readAppSettings } from '../../src/core/settings.js';
import { text } from '../../src/core/bytes.js';

const TOKEN = 'mcp-token-0123456789';

async function kit() {
  const k = await hostKit();
  await k.host.addBuiltin(new URL('../../src/plugins/mcp/index.js', import.meta.url).href);
  const servers = k.registry.list('mcp-servers')[0];
  const trip = await createTrip(k.ws, { title: 'Big Sur' });
  /** Calls a registered tool as the agent would: with the open trip's traced fetch. @param {string} name @param {any} input */
  const call = async (name, input) => {
    const tool = k.registry.list('tool').find((t) => t.name === name);
    return tool.run(input, { trip, scope: trip, signal: new AbortController().signal, fetch: tracedFetch(k.store, trip, { tool: name }) });
  };
  /** Every text annai keeps anywhere: files, log entries and stored content. */
  const everything = async () => k.store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (t) => {
    const out = [];
    for (const s of await t.listScopes()) {
      out.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
    }
    for (const b of await t.listBlobs()) out.push(text(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
    return out.join('\n');
  });
  return { ...k, servers, trip, call, everything };
}

test('a server added with a bearer token: its tools registered as mcp_<server>_<tool> under Settings → Tools, called, each request in the trace, the token never kept anywhere but secrets', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    assert.deepEqual(await k.servers.add({ name: 'trail', url: s.url, token: TOKEN }), { tools: 6 });
    const tools = k.registry.list('tool').filter((t) => t.name.startsWith('mcp_'));
    assert.deepEqual(tools.map((t) => t.name), ['mcp_trail_echo', 'mcp_trail_add', 'mcp_trail_map', 'mcp_trail_whoami', 'mcp_trail_fail', 'mcp_trail_slow']);
    assert.ok(tools.every((t) => t.group === 'MCP: trail'));
    assert.match(tools[0].description, /\(from the MCP server trail\)$/);
    assert.equal(await k.call('mcp_trail_echo', { text: 'tide' }), 'tide');
    const who = await k.call('mcp_trail_whoami', {});
    assert.doesNotMatch(JSON.stringify(who), new RegExp(TOKEN));
    await assert.rejects(k.call('mcp_trail_fail', {}), (e) => e.constructor === Error && /failed on purpose/.test(e.message));
    const img = await k.call('mcp_trail_map', {});
    assert.equal(img.images[0].mediaType, 'image/png');
    const web = (await k.store.tx(['events'], 'readonly', (t) => t.listEvents(k.trip, { types: ['net.request'] })));
    assert.ok(web.length >= 5 && web.every((e) => e.data.url.startsWith(s.origin)), 'every MCP request of a call is in the trip\'s trace');
    assert.ok(web.some((e) => e.data.tool === 'mcp_trail_echo'));
    assert.doesNotMatch(await k.everything(), new RegExp(TOKEN));
    assert.deepEqual(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), { token: TOKEN });
    const [row] = await k.servers.list();
    assert.deepEqual([row.name, row.auth, row.tools.length], ['trail', 'token', 6]);
  } finally {
    await s.stop();
  }
});

test('a server is checked before it is added; nothing is kept when it fails, and the reason is plain', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url, token: 'wrong-token-00000' }), /refused annai's key/);
    await assert.rejects(k.servers.add({ name: 'Trail!', url: s.url }), /lowercase letters, digits and dashes/);
    await assert.rejects(k.servers.add({ name: 'trail', url: 'ftp://x' }), /must start with https:\/\//);
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url, headers: 'no colon here' }), /one line: Name: value/);
    assert.deepEqual(await k.servers.list(), []);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), undefined);
    await k.servers.add({ name: 'trail', url: s.url, headers: `Authorization: Bearer ${TOKEN}` });
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url }), /a server called trail already/);
  } finally {
    await s.stop();
  }
});

test("the tools are there at the next start from the stored list, offline too; a call then says the server can't be reached", async () => {
  const s = await startMcpServer({});
  const k = await kit();
  await k.servers.add({ name: 'trail', url: s.url });
  await s.stop();
  const next = k.relaunch();
  await next.addBuiltin(new URL('../../src/plugins/mcp/index.js', import.meta.url).href);
  const tool = next.registry.list('tool').find((t) => t.name === 'mcp_trail_echo');
  assert.ok(tool);
  await assert.rejects(tool.run({ text: 'x' }, { signal: new AbortController().signal, fetch: (/** @type {string} */ u, /** @type {any} */ i) => fetch(u, i) }), (e) => e.constructor === Error && /couldn't reach the MCP server trail/.test(e.message));
});

test('removing a server removes everything it stored: its file and history, its secret, its switches, its tools (choice 10)', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url, token: TOKEN });
    await k.servers.refresh('trail');
    await setToolSwitch(k.ws, 'mcp_trail_echo', false);
    await k.servers.remove('trail');
    assert.equal(k.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
    assert.equal(await k.ws.read(SYS_SETTINGS, '/mcp/trail.json'), undefined);
    assert.deepEqual(await k.ws.history(SYS_SETTINGS, '/mcp/trail.json'), []);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), undefined);
    assert.equal((await readAppSettings(k.ws)).tools?.mcp_trail_echo, undefined);
    assert.ok(s.requests.some((r) => r.method === 'DELETE'), 'its session was ended');
  } finally {
    await s.stop();
  }
});

test('two servers never share a tool name; more than 100 tools are cut and said', async () => {
  const many = Array.from({ length: 105 }, (_, i) => ({ name: `t${i}`, description: `Tool ${i}.`, inputSchema: { type: 'object' } }));
  const a = await startMcpServer({});
  const b = await startMcpServer({ tools: many });
  try {
    const k = await kit();
    await k.servers.add({ name: 'one', url: a.url });
    assert.deepEqual(await k.servers.add({ name: 'two', url: b.url }), { tools: 100 });
    const names = k.registry.list('tool').map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.equal((await k.servers.list()).find((r) => r.name === 'two')?.more, 5);
  } finally {
    await a.stop();
    await b.stop();
  }
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test test/unit/mcp-plugin.test.js`
Expected: FAIL — `src/plugins/mcp/index.js` can't be found.

- [ ] **Step 3: Implement** as the Interfaces say. `main.js` adds the plugin after the skills plugin. Add `'/src/plugins/mcp/index.js'` to `SHELL`.

- [ ] **Step 4: Run them to make sure they pass**

Run: `node --test test/unit/mcp-plugin.test.js test/unit/mcp-client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "MCP servers give Shiori tools: added with a token kept in secrets, registered as mcp_<server>_<tool>, each request in the trace, removed with everything they stored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 4: Settings → Tools → MCP servers

**Files:**
- Create: `src/ui/screens/mcp.js`
- Modify: `src/ui/screens/tools.js` (an "MCP servers" section linking to `#/mcp`; MCP tools grouped by their `MCP: <server>` group), `src/ui/shell.js` (`SCREENS.mcp`), `src/ui/router.js` (doc comment), `sw.js`
- Test: `test/e2e/mcp.spec.js` (Task 5's first test is written here, failing first)

**Interfaces:**
- Consumes: the `mcp-servers` service (Task 3).
- Produces: `renderMcp(ctx)`: crumbs ← Tools; title "MCP servers"; a line on what an MCP server is and that its tools appear under Settings → Tools; a note on browser access ("The server must let web apps call it (CORS): allow annai's address, the headers Content-Type, Accept, Authorization, Mcp-Session-Id and MCP-Protocol-Version, and expose Mcp-Session-Id."); each server as a card: its name, its address (as kept), its auth ("No key", "A bearer token, kept on this device", "Headers, kept on this device"), its tools' names, "and N more it has" when cut, **Refresh tools**, **Remove** ("Tap again to remove"); the form **Add a server**: **Name**, **Address**, a choice **Key** (None / Bearer token / Headers), **Token** (password) or **Headers** (a textarea, one `Name: value` a line), **Add server**; errors under it (`role=alert`); while adding, the button reads "Checking…".

- [ ] **Step 1: Write the failing test**

`test/e2e/mcp.spec.js`:
```js
import { test, expect } from '@playwright/test';
import { startModelServer, anthropicToolReply, modelSetUp, filterTrace } from './helpers.js';
import { startMcpServer } from '../fakes/mcp.js';

const sse = (/** @type {string} */ body) => ({ status: 200, type: 'text/event-stream', body });
const TOKEN = 'mcp-e2e-token-0123456789';

/** Everything annai keeps in IndexedDB, as one text: no secret may be in it. @param {any} page */
async function dumpAll(page) {
  return page.evaluate(async () => {
    const at = (/** @type {string} */ p) => p;
    const { createIdbStore } = await import(at('/src/core/store-idb.js'));
    const store = await createIdbStore();
    const out = await store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
      const parts = [];
      for (const s of await t.listScopes()) parts.push(JSON.stringify(await t.listFiles(s.id)), JSON.stringify(await t.listEvents(s.id)));
      for (const b of await t.listBlobs()) parts.push(new TextDecoder().decode((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0)));
      return parts.join('\n');
    });
    store.close();
    return out;
  });
}

test('an MCP server added with a bearer token: its tools under Settings → Tools, called by Shiori, each request in the trace, the token in no trace or file; removed, it is gone (spec §5.1)', async ({ page }) => {
  const mcp = await startMcpServer({ token: TOKEN });
  const llm = await startModelServer({ '/b/v1/messages': [
    sse(anthropicToolReply([{ name: 'mcp_trail_echo', input: { text: 'Low tide at 5:40.' } }])),
    sse(anthropicToolReply([{ name: 'mcp_trail_whoami', input: {} }])),
    sse(anthropicToolReply([{ name: 'speak', input: { text: 'Low tide is at 5:40.' } }, { name: 'sleep', input: {} }])),
  ] });
  try {
    await modelSetUp(page, llm.origin);
    await page.goto('/#/tools');
    await page.getByRole('link', { name: 'MCP servers' }).click();
    await page.getByLabel('Name', { exact: true }).fill('trail');
    await page.getByLabel('Address').fill(mcp.url);
    await page.getByLabel('Key').selectOption('token');
    await page.getByLabel('Token').fill(TOKEN);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.locator('.card', { hasText: 'trail' }).getByText('A bearer token, kept on this device')).toBeVisible();
    await expect(page.getByText('mcp_trail_echo')).toBeVisible();
    await page.goto('/#/tools');
    await expect(page.getByRole('heading', { name: 'MCP: trail' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'mcp_trail_echo', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Type' }).click();
    await page.getByLabel('Message to Shiori').fill('When is low tide?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.convo .shiori p')).toHaveText('Low tide is at 5:40.');
    const bodies = llm.bodies('/b/v1/messages').map((b) => JSON.stringify(b));
    expect(bodies[0]).toContain('mcp_trail_echo');
    expect(bodies[1]).toContain('Low tide at 5:40.');
    expect(bodies.join('\n')).not.toContain(TOKEN);
    expect(mcp.requests.filter((r) => r.rpc?.method === 'tools/call').map((r) => r.rpc.params.name)).toEqual(['echo', 'whoami']);
    await page.goto('/#/trace');
    await filterTrace(page, { kind: 'Web' });
    await expect(page.locator('ol.trace li', { hasText: 'mcp_trail_echo' }).first()).toBeVisible();
    expect(await page.content()).not.toContain(TOKEN);
    expect(await dumpAll(page)).not.toContain(TOKEN);
    await page.goto('/#/mcp');
    await page.locator('.card', { hasText: 'trail' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('.card', { hasText: 'trail' }).getByRole('button', { name: 'Tap again to remove' }).click();
    await expect(page.getByText('mcp_trail_echo')).toHaveCount(0);
    await page.goto('/#/tools');
    await expect(page.getByRole('heading', { name: 'MCP: trail' })).toHaveCount(0);
  } finally {
    await llm.stop();
    await mcp.stop();
  }
});

test("a server that doesn't let web apps call it, or refuses the token, isn't added, and the screen says why", async ({ page }) => {
  const closed = await startMcpServer({ token: TOKEN, cors: false });
  try {
    await modelSetUp(page, 'http://127.0.0.1:9');
    await page.goto('/#/mcp');
    await page.getByLabel('Name', { exact: true }).fill('closed');
    await page.getByLabel('Address').fill(closed.url);
    await page.getByRole('button', { name: 'Add server' }).click();
    await expect(page.getByRole('alert')).toContainText('lets web apps call it (CORS)');
    await expect(page.locator('.card', { hasText: 'closed' })).toHaveCount(0);
  } finally {
    await closed.stop();
  }
});
```
(`modelSetUp` with an unreachable model origin still sets up the trip.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test test/e2e/mcp.spec.js`
Expected: FAIL — no "MCP servers" link on Settings → Tools.

- [ ] **Step 3: Implement** as the Interfaces say. Add `'/src/ui/screens/mcp.js'` to `SHELL`.

- [ ] **Step 4: Run it to make sure it passes** — the same command. Expected: PASS in Chromium and WebKit.

- [ ] **Step 5: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Settings → Tools → MCP servers: add one with a token or headers, see its tools, refresh them, remove it; MCP tools are switched by server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```

---

### Task 5: The device checklist, the guide, the README and the budget

**Files:**
- Create: `docs/testing/device-checklist-m8.md`
- Modify: `docs/plugins.md` (MCP servers for plugin authors: what annai needs from a server), `README.md` (milestone 8 in what annai does; where the stand-in is), `scripts/size.mjs`

**Interfaces:**
- The checklist (both phones, annai from the Home Screen, a model set up): **The stand-in** (on the machine that serves annai: `node scripts/mcp-stand-in.mjs --port <port> --token <a long random token> --files test/fixtures/extensions`, then `tailscale serve --bg --https=<port+1> http://127.0.0.1:<port>`; the port is given by the main session, never 8765, 8790–8792, 8796, 8797 or 18010–18014); **A skill** (install `tide-pools` from `https://<machine>.<tailnet>.ts.net:<port+1>/files/tide-pools/SKILL.md`; the install screen says what a skill is; ask about tide pools: Shiori loads it, Trace → Tools shows `skill`; remove it: gone from Settings → Plugins and from the next answers); **An MCP server** (Settings → Tools → MCP servers: add `trail` at `…/mcp` with the token; its six tools under Settings → Tools; ask Shiori to echo something and to say who she is to the server: the answer names no token; Trace → Web: the requests, no token; switch `mcp_trail_echo` off: she no longer has it; remove the server: its tools gone); **A code plugin** (install `tides` from `…/files/tides/annai-plugin.json`: the full-trust sentence; the "Tide 1.0.0" chip in the dock; ask for today's tides; close and reopen annai: still there; remove it: chip and tool gone, restart annai when asked); **Updates** (with annai closed, edit `test/fixtures/extensions/tides/lib.js` and its manifest to 1.1.0 on the machine; reopen: the card offers it; nothing changes until Update; after the restart the chip reads 1.1.0; put the files back); **Things only a phone shows** (the dock's chip row on a small screen with a plugin chip; a plugin's dock action button size; the install screen with the keyboard open; iOS: installing from the Files app as a `.zip`).

- [ ] **Step 1: Write the checklist, the guide's section and the README lines** as the Interfaces say.

- [ ] **Step 2: The budget** — `scripts/size.mjs`: what `npm run size` needs plus about 5 KiB, rounded to 10; its comment says so for milestone 8c.

- [ ] **Step 3: The whole suite** — `npm run stamp && npm run check`, then the full e2e run in Docker into the plan's workspace log. Expected: all pass in Chromium and WebKit.

- [ ] **Step 4: Commit**

```bash
npm run stamp && npm run check && git add -A && git commit -m "Milestone 8's device checklist: a skill, an MCP server and a code plugin installed, used and removed on both phones; the guide and README say how

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Sd8FfGz4XdS8PHc3KbmAcB"
```
