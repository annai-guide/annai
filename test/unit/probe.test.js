import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe } from '../../plugins-official/provider-another-address/probe.js';
import { addressProblem } from '../../src/core/llm/provider-desc.js';
import { tracedFetch } from '../../src/core/agent/net.js';
import { SYS } from '../../src/core/scopes.js';
import { startFakeServer } from '../fakes/model-server.js';
import { browserFetch } from '../fakes/browser-fetch.js';
import { hostKit } from './package-kit.js';
import { readFile } from 'node:fs/promises';
import { createLlm } from '../../src/core/llm/service.js';
import { readConfig, getKey, providerOf } from '../../src/core/llm/config.js';
import { setupUi } from '../../src/ui/provider-setup.js';
import { setupOf } from '../../src/core/llm/setup.js';
import { PluginHost } from '../../src/core/plugins.js';

// Another address looks for what a server offers, at no cost (milestone 5 of providers as plugins,
// decision 18): its model list, and an empty request to each path annai knows, read against a control
// request to a path that can't exist. Stand-ins answer as each server does, reached as a page at annai's
// address reaches them (a browser's CORS rules); reach is the check a browser makes without those rules.

const ANNAI = 'https://annai.guide';
const KEY = 'sk-test-probe-0123456789';

/** @param {{ fetch?: any, reach?: (url: string) => Promise<boolean> }} [o] */
const io = (o = {}) => ({
  fetch: o.fetch ?? browserFetch(ANNAI),
  reach: o.reach ?? ((/** @type {string} */ url) => fetch(url).then(() => true, () => false)),
  problem: addressProblem,
});
/** Each finding's state, by what was looked for. @param {any} r */
const states = (r) => ({ list: r.list.state, ...Object.fromEntries(Object.entries(r.abilities).map(([id, f]) => [id, /** @type {any} */ (f).state])) });

/**
 * A server that answers every request with what answer() gives, letting any page read it (CORS), as
 * some servers in front of models do. @param {(req: http.IncomingMessage) => [number, Record<string, string>, string]} answer
 */
async function tiny(answer) {
  /** @type {{ method: string, path: string, headers: any }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? '') };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: { ...req.headers } });
    const [status, headers, body] = answer(req);
    res.writeHead(status, { ...cors, ...headers }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { origin: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve(undefined)); }) };
}

test('a router like maiGo: the list, Chat Completions and Responses are found; Messages and the audio paths are absent; without the key, the paths it has say they ask for one', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY });
  try {
    const r = await probe(`${s.origin}/v1`, KEY, io());
    assert.deepEqual([r.base, r.root], [`${s.origin}/v1`, s.origin]);
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'absent', transcription: 'absent', voice: 'absent' });
    assert.equal(r.list.count, 1);
    const bare = await probe(`${s.origin}/v1/`, null, io());
    assert.deepEqual(states(bare), states(r), 'an unknown path is 404 without the key, so a 401 says the path is there');
    assert.match(bare.abilities['chat-completions'].why ?? '', /asks for a key/);
    assert.equal(bare.list.count, undefined, 'it listed nothing without the key');
  } finally {
    await s.stop();
  }
});

test('llama.cpp: the list, Chat Completions, Responses and Messages at the root are found', async () => {
  const s = await startFakeServer({ flavour: 'llamacpp' });
  try {
    const r = await probe(`${s.origin}/v1`, null, io());
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'found', transcription: 'absent', voice: 'absent' });
    assert.equal(r.root, s.origin, 'Anthropic Messages adds /v1/messages to the address without /v1');
    assert.ok(s.requests.some((q) => q.method === 'POST' && q.path === '/v1/messages' && q.headers['anthropic-version'] === '2023-06-01'), 'asked as Anthropic Messages asks');
  } finally {
    await s.stop();
  }
});

test('a server that answers 401 on every path without a key reports unknown, never found, and says to give the key; with the key it finds what it has (Review Focus 5)', async () => {
  const s = await startFakeServer({ flavour: 'whole', key: KEY, authEverywhere: true });
  try {
    const r = await probe(`${s.origin}/v1`, null, io());
    assert.deepEqual(Object.values(states(r)).filter((x) => x === 'found'), []);
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
    assert.match(r.abilities['chat-completions'].why ?? '', /give the key/);
    assert.equal(r.list.state, 'unknown');
    const keyed = await probe(`${s.origin}/v1`, KEY, io());
    assert.deepEqual(states(keyed), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'unknown', transcription: 'absent', voice: 'absent' },
      'Messages sends the key its own way (x-api-key), which this server refuses at any address: no telling');
    assert.match(keyed.abilities.messages.why ?? '', /key/);
  } finally {
    await s.stop();
  }
});

test('a web app that answers 200 with a page for any path finds nothing (Review Focus 5)', async () => {
  const s = await startFakeServer({ flavour: 'whole', spa: true });
  try {
    const r = await probe(`${s.origin}/app`, null, io());
    assert.deepEqual(states(r), { list: 'absent', 'chat-completions': 'absent', responses: 'absent', messages: 'absent', transcription: 'absent', voice: 'absent' });
    assert.match(r.abilities.voice.why ?? '', /web page/);
  } finally {
    await s.stop();
  }
  // One that answers JSON to anything, the address that can't exist too, is no telling either; but a real list of models it gives is a list.
  const any = await tiny(() => [200, { 'content-type': 'application/json' }, '{"ok":true}']);
  try {
    const r = await probe(`${any.origin}/v1`, null, io());
    assert.deepEqual(Object.values(states(r)).filter((x) => x === 'found'), []);
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
  } finally {
    await any.stop();
  }
  const listed = await tiny((req) => {
    if (req.method === 'GET' && req.url === '/v1/models') return [200, { 'content-type': 'application/json' }, '{"object":"list","data":[{"id":"m"}]}'];
    if (req.method === 'POST' && req.url === '/v1/chat/completions') return [400, { 'content-type': 'application/json' }, '{"error":"model required"}'];
    return [200, { 'content-type': 'application/json' }, '{"error":"not found"}'];
  });
  try {
    const r = await probe(`${listed.origin}/v1`, null, io());
    assert.deepEqual([r.list.state, r.list.count, r.abilities['chat-completions'].state, r.abilities.responses.state], ['found', 1, 'found', 'unknown']);
  } finally {
    await listed.stop();
  }
});

test("a server that doesn't allow web apps is blocked, told apart from one that isn't there (unreachable)", async () => {
  const s = await startFakeServer({ flavour: 'whole', cors: false });
  let asked = 0;
  try {
    const r = await probe(`${s.origin}/v1`, KEY, io({ reach: (url) => { asked += 1; return fetch(url).then(() => true, () => false); } }));
    assert.deepEqual(new Set(Object.values(states(r))), new Set(['blocked']));
    assert.match(r.abilities['chat-completions'].why ?? '', /doesn't allow web apps/);
    assert.equal(asked, 1, 'the server is checked for once');
  } finally {
    await s.stop();
  }
  const gone = await tiny(() => [200, {}, '']);
  const address = `${gone.origin}/v1`;
  await gone.stop();
  const r = await probe(address, KEY, io());
  assert.deepEqual(new Set(Object.values(states(r))), new Set(['unreachable']));
  assert.match(r.list.why ?? '', /couldn't reach/);
});

test('an address without /v1 is looked at with /v1 first, and as given only when that finds nothing, its Messages asked once; 429 and 5xx are unknown, 501 is absent', async () => {
  const s = await startFakeServer({ flavour: 'llamacpp' });
  try {
    const r = await probe(s.origin, null, io());
    assert.deepEqual([r.base, r.root], [`${s.origin}/v1`, s.origin]);
    assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'found', messages: 'found', transcription: 'absent', voice: 'absent' });
    assert.ok(!s.requests.some((q) => q.path === '/models' || q.path === '/chat/completions'), '/v1 found what it has: the address as given is not asked');
    // One that lists its models at both but talks only at /v1, as the user's Unsloth Studio does (measured 2026-10-19).
    const both = await tiny((req) => {
      const list = [200, { 'content-type': 'application/json' }, '{"object":"list","data":[{"id":"m"}]}'];
      if (req.method === 'GET') return /** @type {any} */ (req.url === '/models' || req.url === '/v1/models' ? list : [404, {}, '']);
      return req.url === '/v1/chat/completions' || req.url === '/v1/messages' ? [400, { 'content-type': 'application/json' }, '{}'] : [405, { 'content-type': 'application/json' }, '{}'];
    });
    try {
      const r = await probe(both.origin, null, io());
      assert.equal(r.base, `${both.origin}/v1`);
      assert.deepEqual(states(r), { list: 'found', 'chat-completions': 'found', responses: 'absent', messages: 'found', transcription: 'absent', voice: 'absent' });
    } finally {
      await both.stop();
    }
    // An address with a path is looked at as given.
    const path = await probe(`${s.origin}/llm`, null, io());
    assert.equal(path.base, `${s.origin}/llm`);
    assert.equal(path.abilities['chat-completions'].state, 'absent');
  } finally {
    await s.stop();
  }
  // A server that talks at the address as given, and not at /v1: looked at both ways, Messages (the same address either way) asked once.
  const plain = await tiny((req) => {
    if (req.method === 'GET' && req.url === '/models') return [200, { 'content-type': 'application/json' }, '{"data":[{"id":"m"}]}'];
    return req.method === 'POST' && req.url === '/chat/completions' ? [400, { 'content-type': 'application/json' }, '{}'] : [404, {}, ''];
  });
  try {
    const r = await probe(plain.origin, null, io());
    assert.equal(r.base, plain.origin);
    assert.deepEqual([r.list.state, r.abilities['chat-completions'].state, r.abilities.messages.state], ['found', 'found', 'absent']);
    assert.equal(plain.requests.filter((q) => q.method === 'POST' && q.path === '/v1/messages').length, 1);
    assert.equal(plain.requests.filter((q) => q.method === 'POST' && q.path.startsWith('/v1/annai-probe-') && q.headers['anthropic-version']).length, 1);
  } finally {
    await plain.stop();
  }
  // llama.cpp answers 501 for transcription with a model that can't listen: the server says it doesn't do this.
  const no = await tiny((req) => (req.url === '/v1/audio/transcriptions' ? [501, { 'content-type': 'application/json' }, '{"error":{"code":501,"message":"This server does not support transcriptions."}}'] : [404, {}, '']));
  try {
    const r = await probe(`${no.origin}/v1`, null, io());
    assert.equal(r.abilities.transcription.state, 'absent');
    assert.match(r.abilities.transcription.why ?? '', /doesn't do this/);
  } finally {
    await no.stop();
  }
  for (const status of [429, 500, 503]) {
    const t = await tiny(() => [status, { 'content-type': 'application/json' }, '{"error":{"message":"later"}}']);
    try {
      const r = await probe(`${t.origin}/v1`, null, io());
      assert.deepEqual(new Set(Object.values(states(r))), new Set(['unknown']), String(status));
      assert.equal(r.abilities.responses.status, status);
    } finally {
      await t.stop();
    }
  }
});

test('no request carries a model or an input, and a chat path is asked for one token at most, so a lax server that runs it anyway makes next to nothing; the key goes only in its header, only to the address, never past a redirect, and is in no trace entry', async () => {
  const k = await hostKit();
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY });
  const elsewhere = await startFakeServer({ flavour: 'whole' });
  const moved = await tiny(() => [307, { location: `${elsewhere.origin}/v1/chat/completions` }, '']);
  try {
    const traced = tracedFetch(k.store, SYS, { tool: 'plugin:provider-another-address' }, browserFetch(ANNAI));
    await probe(s.origin, KEY, io({ fetch: traced }));
    assert.ok(s.requests.filter((q) => q.method !== 'OPTIONS').length >= 8, 'with /v1, which found what it has');
    assert.ok(s.requests.some((q) => q.method === 'POST' && q.path === '/v1/chat/completions'));
    for (const q of s.requests) {
      if (q.method === 'POST') {
        const limit = /\/(chat\/completions|messages)$/.test(q.path) ? { max_tokens: 1 } : /\/responses$/.test(q.path) ? { max_output_tokens: 1 } : {};
        assert.deepEqual(q.body, limit, `${q.path}: empty but for its output limit`);
      } else assert.equal(q.body, '', `${q.method} ${q.path}`); // a GET, or a browser's preflight
      assert.ok(!q.path.includes(KEY), q.path);
      const holding = Object.entries(q.headers).filter(([, v]) => String(v).includes(KEY)).map(([h, v]) => `${h}: ${v}`);
      assert.ok(holding.every((x) => x === `authorization: Bearer ${KEY}` || x === `x-api-key: ${KEY}`), holding.join(', '));
    }
    const trace = JSON.stringify(await k.log());
    assert.ok(trace.includes('net.request') && trace.includes('/v1/chat/completions'), 'each request is in the trace');
    assert.ok(!trace.includes(KEY), 'the key is in no trace entry');

    const r = await probe(`${moved.origin}/v1`, KEY, io());
    assert.equal(elsewhere.requests.length, 0, 'a redirect is never followed');
    assert.equal(r.abilities['chat-completions'].state, 'unknown');
    assert.match(r.abilities['chat-completions'].why ?? '', /redirect/);
  } finally {
    await Promise.all([s.stop(), elsewhere.stop(), moved.stop()]);
  }
});

test('at most four requests are out at once, each given its time from when it is sent; /V1 in capitals is a /v1', async () => {
  let out = 0;
  let most = 0;
  const slow = await tiny(() => {
    out += 1;
    most = Math.max(most, out);
    return [404, {}, ''];
  });
  const later = (/** @type {any} */ url, /** @type {any} */ init) => new Promise((resolve) => setTimeout(resolve, 30)).then(() => browserFetch(ANNAI)(url, init)).finally(() => { out -= 1; });
  try {
    const r = await probe(slow.origin, null, io({ fetch: later }));
    assert.ok(most > 0 && most <= 4, `${most} at once`);
    assert.equal(r.base, slow.origin, 'nothing found at /v1 either');
    const caps = await probe(`${slow.origin}/V1`, null, io());
    assert.equal(caps.root, slow.origin);
    assert.ok(slow.requests.some((q) => q.path === '/v1/messages'), 'Messages at the root, without /V1');
  } finally {
    await slow.stop();
  }
});

test('an address annai takes keys to, alone, is checked before anything is sent: https, or http only for this device', async () => {
  let sent = 0;
  const counting = io({ fetch: async () => { sent += 1; return new Response('{}'); } });
  await assert.rejects(probe('http://192.168.1.20:8080/v1', KEY, counting), /HTTPS in front of it/);
  await assert.rejects(probe('llm.example.com/v1', KEY, counting), /isn't a web address/);
  // A key pasted into the address field isn't shown back.
  await assert.rejects(probe(KEY, null, counting), (/** @type {any} */ e) => /isn't a web address/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(probe('https://me:secret@llm.example.com/v1', KEY, counting), /alone/);
  await assert.rejects(probe('https://llm.example.com/v1?key=abc', KEY, counting), /alone/);
  await assert.rejects(probe('', KEY, counting), /Give the server's address/);
  await assert.rejects(probe('https://llm.example.com/v1', 'sk-two\nlines', counting), /paste it again/);
  assert.equal(sent, 0);
});

/**
 * annai's DOM builder stood in for: plain elements holding their attributes (handlers among them), children,
 * text, value and state. @param {string} tag @param {any} [attrs] @param {...any} children
 */
const fakeH = (tag, attrs = {}, ...children) => {
  const keep = (/** @type {any[]} */ c) => c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false);
  /** @type {any} */
  const el = {
    tag, attrs: { ...attrs }, value: attrs?.value ?? '', disabled: Boolean(attrs?.disabled), textContent: attrs?.text ?? '', children: [],
    replaceChildren: (/** @type {any[]} */ ...c) => { el.children = keep(c); },
    append: (/** @type {any[]} */ ...c) => { el.children.push(...keep(c)); },
  };
  el.replaceChildren(...children);
  return el;
};
/** @param {any} el @returns {any[]} */
const all = (el) => [el, ...(el?.children ?? []).flatMap((/** @type {any} */ c) => (typeof c === 'object' ? all(c) : []))];
/** @param {any} el @returns {string} */
const textOf = (el) => (typeof el === 'object' ? [el.textContent, ...el.children.map(textOf)].join(' ') : String(el)).replace(/\s+/g, ' ').trim();
/** @param {any} el @param {string} text */
const buttonOf = (el, text) => all(el).find((x) => x.tag === 'button' && textOf(x) === text);

/** Every text annai keeps: files, log entries and stored content. @param {any} store */
const everything = (store) => store.tx(['files', 'events', 'blobs', 'scopes'], 'readonly', async (/** @type {any} */ t) => {
  const out = [];
  for (const sc of await t.listScopes()) out.push(JSON.stringify(await t.listFiles(sc.id)), JSON.stringify(await t.listEvents(sc.id)));
  for (const b of await t.listBlobs()) out.push(new TextDecoder().decode(new Uint8Array((await t.getBlob(b.hash))?.data ?? new ArrayBuffer(0))));
  return out.join('\n');
});

/**
 * The model service, with annai's catalog and official plugins from this repository; the stand-ins at 127.0.0.1 are
 * reached as a page at annai's address reaches them, by annai and by plugins (annai.net.fetch).
 */
async function device() {
  const k = await hostKit();
  const root = new URL('../../', import.meta.url);
  // Installed from annai's catalog; loaded from this repository, as Node has no service worker to serve them (they are
  // hash-checked against the catalog, so they are these files), which lets a plugin's modules import each other.
  const host = new PluginHost({ registry: k.registry, workspace: k.ws, importModule: (/** @type {string} */ url) => {
    const m = /^\/plugins\/([^/]+)\/(.+)$/.exec(url);
    return import(m ? new URL(`plugins-official/${m[1]}/${m[2]}`, root).href : url);
  } });
  const asBrowser = browserFetch(ANNAI);
  const get = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const u = new URL(String(url), 'http://annai.test');
    if (u.hostname === '127.0.0.1') return asBrowser(String(url), init);
    try {
      return new Response(await readFile(new URL(`.${u.pathname}`, root)));
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  host.connect({ fetch: get });
  const llm = createLlm({ store: k.store, ws: k.ws, plugins: host, fetch: get, probe: (url) => fetch(url).then(() => true, () => false) });
  /** @type {string[]} the providers its panel added, in turn */
  const added = [];
  const ctx = { llm, store: k.store, registry: k.registry, plugins: host, notices: { card: () => {}, toast: () => {} }, render: () => {}, go: () => {} };
  const ui = () => ({ ...setupUi(ctx, 'provider-another-address', { added: (/** @type {string} */ id) => { added.push(id); } }), h: fakeH });
  return { ...k, host, llm, ctx, ui, added };
}

test('Add with these turns on what was found, Messages at the root address, and only the protocol plugins those need are installed; the key is kept once, by annai, and is in no file, log entry or trace', async () => {
  const d = await device();
  const s = await startFakeServer({ flavour: 'llamacpp', key: KEY });
  try {
    // Add on Another address: its plugin, and nothing else, for its own Add flow.
    assert.equal(await d.llm.startAdd('provider-another-address', { official: true, roles: 'recommended' }), null);
    assert.deepEqual(Object.keys(await d.host.installed()), ['provider-another-address']);
    const setup = /** @type {any} */ (setupOf(d.registry, 'provider-another-address'));
    assert.equal(setup.panel(d.ui(), { id: 'pv-1', name: 'Mine', key: false }), null, "a provider's own page has the standard switches");
    const panel = setup.panel(d.ui(), null);
    assert.equal(buttonOf(panel, 'Add with these'), undefined, 'nothing to add before a look');
    all(panel).find((x) => x.attrs.id === 'probe-address').value = s.origin;
    all(panel).find((x) => x.attrs.id === 'probe-key').value = KEY;
    await buttonOf(panel, 'Look for what it offers').attrs.onclick();
    const shown = textOf(panel);
    for (const line of ['✓ Model list: 1 model', '✓ Chat Completions', '✓ OpenAI Responses', '✓ Anthropic Messages', '✗ Transcription: not found', '✗ Voice: not found']) assert.ok(shown.includes(line), `${line} in: ${shown}`);
    assert.match(shown, /Nothing here costs money; Test sends real requests/);
    assert.ok(s.requests.filter((q) => q.method === 'POST').every((q) => !['model', 'messages', 'input', 'prompt'].some((f) => f in q.body)), 'only empty requests');

    await buttonOf(panel, 'Add with these').attrs.onclick();
    assert.equal(d.added.length, 1, 'the provider it added is opened');
    const cfg = await readConfig(d.ws);
    const rec = cfg.providers[d.added[0]];
    const p = providerOf(rec);
    assert.deepEqual([rec.plugin, p.name, p.baseUrl], ['provider-another-address', new URL(s.origin).host, `${s.origin}/v1`]);
    assert.deepEqual(Object.fromEntries(Object.entries(p.abilities).map(([id, a]) => [id, a.on])), { 'chat-completions': true, responses: true, messages: true, transcription: false, voice: false, realtime: false }, 'a realtime voice is never looked for: it is switched on by hand (K6)');
    assert.equal(p.abilities.messages.baseUrl, s.origin, 'Messages at the address without /v1');
    assert.equal(p.abilities.responses.baseUrl, `${s.origin}/v1`);
    assert.deepEqual(Object.keys(await d.host.installed()).sort(), ['anthropic-messages', 'chat-completions', 'openai-responses', 'provider-another-address'], 'no speech plugin: nothing found needs it');
    assert.equal(await getKey(d.store, rec.id), KEY);
    assert.deepEqual(await d.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds()), [`llm:${rec.id}`]);
    assert.ok(!(await everything(d.store)).includes(KEY), 'the key is in no file, log entry or trace');
    assert.ok((await everything(d.store)).includes('plugin:provider-another-address'), 'its requests are in the trace');
  } finally {
    await s.stop();
  }
});

test("Add with these doesn't switch on a protocol plugin the user turned off: it says so, and nothing is added; changing the address after a look asks for another", async () => {
  const d = await device();
  const s = await startFakeServer({ flavour: 'whole' });
  try {
    await d.llm.ensureType('chat-completions');
    await d.host.setEnabled('chat-completions', false);
    assert.equal(await d.llm.startAdd('provider-another-address', { official: true }), null);
    const panel = /** @type {any} */ (setupOf(d.registry, 'provider-another-address')).panel(d.ui(), null);
    const address = all(panel).find((x) => x.attrs.id === 'probe-address');
    for (const typed of ['h', 'ht']) {
      address.value = typed;
      address.attrs.oninput();
    }
    assert.doesNotMatch(textOf(panel), /changed/, 'typing before any look says nothing');
    address.value = `${s.origin}/v1`;
    await buttonOf(panel, 'Look for what it offers').attrs.onclick();
    assert.ok(textOf(panel).includes('✓ Chat Completions'));
    await buttonOf(panel, 'Add with these').attrs.onclick();
    assert.match(textOf(panel), /which you turned off, isn't switched on/);
    assert.equal((await d.host.installed())['chat-completions'].enabled, false);
    assert.deepEqual(Object.keys((await readConfig(d.ws)).providers), []);
    assert.deepEqual(d.added, []);
    // A look is for the address it looked at: one changed after it, or while it runs, asks for another.
    address.value = 'https://elsewhere.example/v1';
    address.attrs.oninput();
    assert.equal(buttonOf(panel, 'Add with these'), undefined);
    address.value = `${s.origin}/v1`;
    const looking = buttonOf(panel, 'Look for what it offers').attrs.onclick();
    address.value = `${s.origin}/v2`;
    address.attrs.oninput();
    await looking;
    assert.equal(buttonOf(panel, 'Add with these'), undefined, 'what was found at the address before is not shown');
    assert.doesNotMatch(textOf(panel), /✓/);
    assert.match(textOf(panel), /The address changed: look again\./);
  } finally {
    await s.stop();
  }
});

test("the plugin asks whether a server is there at all as the Test button does: a no-cors GET with no key, body or cookies, which browsers send only if it may follow a redirect", async () => {
  const { activate } = await import('../../plugins-official/provider-another-address/index.js');
  /** @type {[string, any][]} */
  const sent = [];
  const annai = {
    net: { fetch: async (/** @type {string} */ url, /** @type {any} */ init = {}) => { sent.push([url, init]); throw new TypeError('Failed to fetch'); } },
    helpers: { addressProblem },
    providers: { setup: (/** @type {any} */ s) => s },
  };
  const setup = activate(annai);
  const panel = setup.panel({ h: fakeH }, null);
  all(panel).find((x) => x.attrs.id === 'probe-address').value = 'https://llm.example.test/v1';
  all(panel).find((x) => x.attrs.id === 'probe-key').value = KEY;
  await buttonOf(panel, 'Look for what it offers').attrs.onclick();
  const reach = sent.filter(([, init]) => init.mode === 'no-cors');
  assert.equal(reach.length, 1, 'once');
  assert.deepEqual([reach[0][1].method, reach[0][1].headers, reach[0][1].body, reach[0][1].credentials, reach[0][1].redirect], [undefined, undefined, undefined, 'omit', undefined]);
  for (const [url, init] of sent.filter(([, i]) => i.mode !== 'no-cors')) assert.equal(init.redirect, 'manual', `${url}: the requests that may carry the key never follow a redirect`);
  assert.match(textOf(panel), /annai couldn't reach llm\.example\.test/);
});

test("a speech path a server answers is there, but Test says whether a model there can listen or speak: Add with these switches it on only where the model list names such a model", async () => {
  const d = await device();
  const s = await tiny((req) => {
    if (req.method === 'GET' && req.url === '/v1/models') return [200, { 'content-type': 'application/json' }, '{"object":"list","data":[{"id":"llama3.2"},{"id":"whisper-large-v3"}]}'];
    if (req.method === 'POST' && ['/v1/chat/completions', '/v1/audio/transcriptions', '/v1/audio/speech'].includes(req.url ?? '')) return [400, { 'content-type': 'application/json' }, '{}'];
    return [404, {}, ''];
  });
  try {
    assert.equal(await d.llm.startAdd('provider-another-address', { official: true }), null);
    const panel = /** @type {any} */ (setupOf(d.registry, 'provider-another-address')).panel(d.ui(), null);
    all(panel).find((x) => x.attrs.id === 'probe-address').value = `${s.origin}/v1`;
    await buttonOf(panel, 'Look for what it offers').attrs.onclick();
    const shown = textOf(panel);
    assert.ok(shown.includes('✓ Transcription: the path is there; Test says whether a model there can listen'), shown);
    assert.ok(shown.includes("✓ Voice: the path is there; Test says whether a model there can speak. Its model list names no voice, so it's added switched off."), shown);
    await buttonOf(panel, 'Add with these').attrs.onclick();
    const p = providerOf((await readConfig(d.ws)).providers[d.added[0]]);
    assert.deepEqual(Object.fromEntries(Object.entries(p.abilities).map(([id, a]) => [id, a.on])), { 'chat-completions': true, responses: false, messages: false, transcription: true, voice: false, realtime: false });
  } finally {
    await s.stop();
  }
});
