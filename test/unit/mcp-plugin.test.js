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
    await assert.rejects(k.call('mcp_trail_fail', {}), (/** @type {any} */ e) => e.constructor === Error && /failed on purpose/.test(e.message));
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
  let up = true;
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url });
    await s.stop();
    up = false;
    const next = k.relaunch();
    await next.addBuiltin(new URL('../../src/plugins/mcp/index.js', import.meta.url).href);
    const tool = next.registry.list('tool').find((t) => t.name === 'mcp_trail_echo');
    assert.ok(tool);
    await assert.rejects(tool.run({ text: 'x' }, { signal: new AbortController().signal, fetch: (/** @type {string} */ u, /** @type {any} */ i) => fetch(u, i) }), (/** @type {any} */ e) => e.constructor === Error && /couldn't reach the MCP server trail/.test(e.message));
  } finally {
    if (up) await s.stop();
  }
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
