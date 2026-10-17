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
    assert.ok(web.length >= 4 && web.every((e) => e.data.url.startsWith(s.origin)), 'every MCP request of a call is in the trip\'s trace');
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

// The coordinator's third security finding (milestone 8c): a key in a server's address lives only in
// secrets; the file, list(), the log and the trace keep a shown form with it blanked.
test("a key in a server's address (in its path, ?key=, ?k=) never reaches its file, list(), the log or the trace; user:pass@ is refused", async () => {
  const s = await startMcpServer({});
  try {
    const k = await kit();
    const PATH_KEY = 'zap1a2b3c4d5e6f7g8h9';
    const KEY_Q = 'q9w8e7r6t5y4';
    const K_Q = 'k3yabcdef1234567';
    await k.servers.add({ name: 'zap', url: `${s.origin}/api/mcp/s/${PATH_KEY}/mcp` });
    await k.servers.add({ name: 'qkey', url: `${s.url}?key=${KEY_Q}` });
    await k.servers.add({ name: 'kkey', url: `${s.url}?v=2&k=${K_Q}` });
    assert.equal(await k.call('mcp_zap_echo', { text: 'tide' }), 'tide');
    assert.equal(await k.call('mcp_kkey_echo', { text: 'tide' }), 'tide');
    const rows = await k.servers.list();
    assert.deepEqual(rows.map((r) => r.url), [`${s.origin}/api/mcp/s/«key»/mcp`, `${s.url}?key=«key»`, `${s.url}?v=2&k=«key»`]);
    const all = await k.everything();
    for (const key of [PATH_KEY, KEY_Q, K_Q]) {
      assert.doesNotMatch(all, new RegExp(key), key);
      assert.doesNotMatch(JSON.stringify(rows), new RegExp(key), key);
    }
    assert.ok(s.requests.some((r) => r.rpc?.method === 'tools/call'), 'the calls reached the server at its full address');
    await assert.rejects(k.servers.add({ name: 'userinfo', url: `https://someone:pass1234@mcp.example/mcp` }), /Token or Headers field/);
    await k.servers.remove('zap');
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:zap')), undefined, 'the address is forgotten with the secret');
  } finally {
    await s.stop();
  }
});

// The coordinator's fourth finding: a refresh racing a remove, or two adds of one name.
test('removing a server while its tools are being listed leaves no file and no tools, also after a restart', async () => {
  const s = await startMcpServer({});
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url });
    s.slowList(400);
    const asked = s.requests.length;
    const refreshing = k.servers.refresh('trail');
    while (!s.requests.slice(asked).some((r) => r.rpc?.method === 'tools/list')) await new Promise((done) => setTimeout(done, 10));
    await k.servers.remove('trail');
    await assert.rejects(refreshing, /was removed/);
    assert.equal(k.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
    assert.equal(await k.ws.read(SYS_SETTINGS, '/mcp/trail.json'), undefined);
    assert.deepEqual(await k.ws.history(SYS_SETTINGS, '/mcp/trail.json'), []);
    const next = k.relaunch();
    await next.addBuiltin(new URL('../../src/plugins/mcp/index.js', import.meta.url).href);
    assert.equal(next.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
  } finally {
    await s.stop();
  }
});

test('two adds of one name at once leave exactly one server', async () => {
  const s = await startMcpServer({});
  try {
    const k = await kit();
    const [a, b] = await Promise.allSettled([k.servers.add({ name: 'trail', url: s.url }), k.servers.add({ name: 'trail', url: s.url })]);
    assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
    assert.match(String(/** @type {any} */ (a.status === 'rejected' ? a : b).reason?.message), /There is a server called trail already/);
    assert.equal((await k.servers.list()).length, 1);
    assert.equal(k.registry.list('tool').filter((t) => t.name.startsWith('mcp_trail_')).length, 6);
  } finally {
    await s.stop();
  }
});

// Fix pass 8c-3: Remove forgets everything here first, and never waits long on the server.
test('8c-3: Remove forgets the server here before it ends the session, gives up on a server that never answers after 5 seconds, and keeps no key in the trace', { timeout: 20_000 }, async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    const key = 'zap1a2b3c4d5e6f7g8h9';
    await k.servers.add({ name: 'trail', url: `${s.origin}/s/${key}/mcp`, token: TOKEN });
    await k.servers.refresh('trail');
    await setToolSwitch(k.ws, 'mcp_trail_echo', false);
    s.hangDeletes();
    const started = Date.now();
    const removing = k.servers.remove('trail');
    while (!s.requests.some((r) => r.method === 'DELETE')) await new Promise((done) => setTimeout(done, 10));
    assert.equal(k.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
    assert.deepEqual(await k.servers.list(), []);
    assert.equal(await k.ws.read(SYS_SETTINGS, '/mcp/trail.json'), undefined);
    assert.equal((await readAppSettings(k.ws)).tools?.mcp_trail_echo, undefined);
    await removing;
    const took = Date.now() - started;
    assert.ok(took >= 4_500 && took < 9_000, `gave up after ${took} ms`);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), undefined);
    const all = await k.everything();
    assert.doesNotMatch(all, new RegExp(key));
    assert.doesNotMatch(all, new RegExp(TOKEN));
  } finally {
    await s.stop();
  }
});

test('8c-3: a Remove that fails partway can be done again, and nothing comes back at the next start', async () => {
  const s = await startMcpServer({});
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url, token: TOKEN });
    const tx = k.store.tx.bind(k.store);
    /** Makes the next write to this store fail once, as a full disk would. @param {string} store */
    const failNext = (store) => {
      k.store.tx = /** @type {any} */ ((/** @type {any} */ stores, /** @type {any} */ mode, /** @type {any} */ fn) => {
        if (mode !== 'readwrite' || !stores.includes(store)) return tx(stores, mode, fn);
        k.store.tx = tx;
        return Promise.reject(new Error('The disk is full.'));
      });
    };
    failNext('files');
    await assert.rejects(k.servers.remove('trail'), /disk is full/);
    await k.servers.remove('trail');
    assert.equal(await k.ws.read(SYS_SETTINGS, '/mcp/trail.json'), undefined);
    assert.deepEqual(await k.ws.history(SYS_SETTINGS, '/mcp/trail.json'), []);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), undefined);
    assert.equal(k.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
    // The secret last: when that fails and annai closes, the next start forgets it.
    await k.servers.add({ name: 'tides', url: s.url, token: TOKEN });
    failNext('secrets');
    await assert.rejects(k.servers.remove('tides'), /disk is full/);
    const next = k.relaunch();
    await next.addBuiltin(new URL('../../src/plugins/mcp/index.js', import.meta.url).href);
    assert.equal(next.registry.list('tool').filter((t) => t.name.startsWith('mcp_')).length, 0);
    assert.deepEqual(await next.registry.list('mcp-servers')[0].list(), []);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:tides')), undefined);
  } finally {
    await s.stop();
  }
});

test("8c-5: a tool's input schema reaches the model without $schema, $id or $comment, at any depth, and its description is 1,024 characters at most", async () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://trails.example/find', $comment: 'internal',
    type: 'object',
    properties: {
      $id: { type: 'string', description: 'A property that is called $id stays.' },
      where: { type: 'object', $comment: 'nested', properties: { near: { $id: '#near', type: 'string' } } },
      tags: { type: 'array', items: [{ $schema: 'x', type: 'string' }] },
    },
    required: ['where'],
  };
  const s = await startMcpServer({ tools: [{ name: 'find', description: 'Finds a trail. '.repeat(200), inputSchema: schema }] });
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url });
    const tool = k.registry.list('tool').find((t) => t.name === 'mcp_trail_find');
    assert.deepEqual(tool.input, {
      type: 'object',
      properties: {
        $id: { type: 'string', description: 'A property that is called $id stays.' },
        where: { type: 'object', properties: { near: { type: 'string' } } },
        tags: { type: 'array', items: [{ type: 'string' }] },
      },
      required: ['where'],
    });
    assert.ok(tool.description.length <= 1024, `${tool.description.length} characters`);
    assert.match(tool.description, /^Finds a trail\. .*… \(from the MCP server trail\)$/s);
  } finally {
    await s.stop();
  }
});

test('minors 2: adding a server starts one session, and its tools are called in that session', async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    await k.servers.add({ name: 'trail', url: s.url, token: TOKEN });
    assert.equal(await k.call('mcp_trail_echo', { text: 'tide' }), 'tide');
    const inits = s.requests.filter((r) => r.rpc?.method === 'initialize');
    assert.equal(inits.length, 1, 'no session is left behind by the check');
    const sessions = new Set(s.requests.filter((r) => r.rpc && r.rpc.method !== 'initialize').map((r) => r.headers['mcp-session-id']));
    assert.equal(sessions.size, 1);
  } finally {
    await s.stop();
  }
});

test('minors 2: an add that fails after the server started a session ends that session', async () => {
  const s = await startMcpServer({});
  try {
    const k = await kit();
    // The server starts a session, then fails its tools/list.
    k.host.connect({ fetch: async (/** @type {string} */ url, /** @type {RequestInit} */ init) => (String(init?.body ?? '').includes('tools/list') ? new Response('broken', { status: 500 }) : fetch(url, init)) });
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url }), /answered 500/);
    const [init] = s.requests.filter((r) => r.rpc?.method === 'initialize');
    assert.ok(init);
    assert.ok(s.requests.some((r) => r.method === 'DELETE' && r.headers['mcp-session-id']), 'its session was ended');
    assert.deepEqual(await k.servers.list(), []);
  } finally {
    await s.stop();
  }
});

test("minors 6 and 7: headers annai sets itself are refused, and so is a token or header value a web request can't carry, each in words that say what is wrong", async () => {
  const s = await startMcpServer({ token: TOKEN });
  try {
    const k = await kit();
    for (const name of ['Content-Type', 'accept', 'MCP-Protocol-Version', 'mcp-session-id']) {
      await assert.rejects(k.servers.add({ name: 'trail', url: s.url, headers: `Authorization: Bearer ${TOKEN}\n${name}: text/plain` }), new RegExp(`annai sends ${name} itself`, 'i'), name);
    }
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url, token: `${TOKEN}…` }), (/** @type {any} */ e) => /The token has a character a web request can't carry: U\+2026, its 21st/.test(e.message) && !/CORS/.test(e.message));
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url, headers: 'X-Api-Key: it’s-a-key' }), /The header X-Api-Key has a character a web request can't carry: U\+2019, its 3rd/);
    await assert.rejects(k.servers.add({ name: 'trail', url: s.url, token: 'abc\u0000def12345' }), /U\+0000, its 4th/);
    assert.equal(s.requests.length, 0, 'nothing was sent');
    assert.deepEqual(await k.servers.list(), []);
    assert.equal(await k.store.tx(['secrets'], 'readonly', (t) => t.getSecret('plugin:mcp:trail')), undefined);
    // Latin-1 is a byte a request carries.
    await k.servers.add({ name: 'trail', url: s.url, headers: `Authorization: Bearer ${TOKEN}\nX-Note: café` });
  } finally {
    await s.stop();
  }
});
