import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes, SYS } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { PluginHost } from '../../src/core/plugins.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { readConfig, saveProvider, saveRoles, newProvider, newModel, setKey } from '../../src/core/llm/config.js';
import { spentToday } from '../../src/core/agent/budgets.js';
import { createLlm } from '../../src/core/llm/service.js';
import { callRole, Bench } from '../../src/core/llm/fallback.js';
import { openLive, closeKind } from '../../src/core/realtime/open.js';

const KEY = 'AIza-realtime-secret-0123456789';
const PCM16 = (/** @type {number} */ rate) => ({ format: /** @type {const} */ ('pcm16'), rate });

/**
 * A WebSocket as a browser gives one, driven by the test: it opens on the next tick unless told not to,
 * records what is sent, and closes when the test says (as the server would) or when asked.
 */
class FakeSocket {
  /** @type {FakeSocket[]} */
  static made = [];
  /** @param {string} url @param {string[]} protocols */
  constructor(url, protocols, { opens = true } = {}) {
    this.url = url;
    this.protocols = protocols;
    this.binaryType = 'blob';
    /** @type {(string | Uint8Array)[]} */
    this.sent = [];
    /** @type {Record<string, ((e: any) => void)[]>} */
    this.on = {};
    this.closedWith = /** @type {{ code: number, reason: string } | null} */ (null);
    FakeSocket.made.push(this);
    if (opens) setTimeout(() => this.emit('open', {}), 0);
  }
  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) {
    (this.on[type] ??= []).push(fn);
  }
  /** @param {string} type @param {any} e */
  emit(type, e) {
    for (const fn of this.on[type] ?? []) fn(e);
  }
  /** @param {string | Uint8Array} d */
  send(d) {
    this.sent.push(d);
  }
  close(code = 1005, reason = '') {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    setTimeout(() => this.emit('close', { code, reason }), 0);
  }
  /** The server says something. @param {any} m */
  receive(m) {
    this.emit('message', { data: new TextEncoder().encode(JSON.stringify(m)).buffer });
  }
  /** The server closes. @param {number} code @param {string} reason */
  drop(code, reason) {
    this.closedWith = { code, reason };
    this.emit('close', { code, reason });
  }
}
const socket = (/** @type {string} */ url, /** @type {string[]} */ protocols) => new FakeSocket(url, protocols);

/**
 * A small realtime protocol for these tests: setup with the key in the address and a subprotocol, ready on
 * {"ready":true}, every other message an event as it is.
 * @type {any}
 */
const ECHO = {
  type: 'echo-live', name: 'Echo live', realtime: true, pluginId: 'echo',
  audio: { in: [PCM16(16000)], out: [PCM16(24000)] },
  open: (/** @type {any} */ { endpoint, key, tunables }) => ({ url: `${endpoint.baseUrl.replace(/^http/, 'ws')}/live/${tunables.version ?? 'v1'}?key=${key}`, protocols: ['echo', `key.${key}`] }),
  attach(/** @type {any} */ sock, /** @type {any} */ { setup, emit }) {
    sock.send(JSON.stringify({ setup: setup.instructions }));
    /** @type {() => void} */
    let ready = () => {};
    const p = new Promise((r) => { ready = () => r(undefined); });
    sock.on((/** @type {any} */ d) => {
      const m = JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d));
      if (m.ready) ready();
      else emit(m);
    });
    return { ready: p, audio() {}, activity() {}, text: (/** @type {string} */ t) => sock.send(JSON.stringify({ text: t })), image() {}, answer() {}, close() { sock.send('{"bye":true}'); } };
  },
  classifyClose: (/** @type {number} */ code, /** @type {string} */ reason) => (code === 1007 && /api key/i.test(reason) ? 'auth' : null),
};
/** @param {string} baseUrl @returns {any} */
const endpoint = (baseUrl) => ({ id: 'pv-1/live', provider: 'pv-1', ability: 'live', type: 'echo-live', name: 'Gemini', baseUrl, headers: {}, tunables: {}, extraBody: {} });
/** @param {any} [prices] @returns {any} */
const model = (prices = null) => ({ id: 'm-live', provider: 'pv-1', ability: 'live', name: 'Live', providerId: 'live-1', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} });
const setup = { instructions: 'You are Koe.', context: '', tools: [], audioIn: PCM16(16000), audioOut: PCM16(24000) };
/** @param {any} store */
const events = async (store) => store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, {}));
const tick = () => new Promise((r) => setTimeout(r, 5));

/** @param {any} [o] */
function open(o = {}) {
  const store = o.store ?? createMemoryStore();
  const session = openLive({ type: ECHO, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: modelTrace(store, SYS), socket, ...o });
  return { store, session, ws: () => /** @type {FakeSocket} */ (FakeSocket.made.at(-1)) };
}

test("a session opens only at its ability's origin (https → wss, http localhost → ws); another origin is refused, never opened", async () => {
  FakeSocket.made = [];
  open();
  assert.equal(FakeSocket.made[0].url, `wss://live.test/live/v1?key=${KEY}`);
  open({ endpoint: endpoint('http://127.0.0.1:9931') });
  assert.equal(FakeSocket.made[1].url, `ws://127.0.0.1:9931/live/v1?key=${KEY}`);
  open({ endpoint: endpoint('http://localhost:9931') });
  assert.equal(FakeSocket.made[2].url, `ws://localhost:9931/live/v1?key=${KEY}`);
  for (const url of [`wss://elsewhere.test/live?key=${KEY}`, `ws://live.test/live?key=${KEY}`, `wss://live.test:444/live?key=${KEY}`, `https://live.test/live?key=${KEY}`, `not an address ?key=${KEY}`]) {
    const type = { ...ECHO, open: () => ({ url }) };
    assert.throws(() => openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: null, socket }),
      (e) => e instanceof ProviderError && e.kind === 'bad-request' && !e.message.includes(KEY), url.replace(KEY, '«key»'));
  }
  // http on another computer is never an ability's address, and ws: to it never opens either.
  assert.throws(() => open({ endpoint: endpoint('http://192.168.1.9:9931') }), (e) => e instanceof ProviderError && e.kind === 'bad-request');
  assert.equal(FakeSocket.made.length, 3, 'nothing else was opened');
  // A protocol that crashes building its address counts against its plugin.
  /** @type {any[]} */
  const failed = [];
  const registry = /** @type {any} */ ({ fail: (/** @type {string} */ id, /** @type {string} */ what) => failed.push([id, what]) });
  assert.throws(() => open({ type: { ...ECHO, open: () => { throw new TypeError('oops'); } }, registry }), (e) => e instanceof ProviderError && e.kind === 'plugin');
  assert.deepEqual(failed, [['echo', 'live open']]);
});

test('the key is in no live.session or net.request entry, nor the URL or subprotocols traced', async () => {
  FakeSocket.made = [];
  const { store, session, ws } = open({ model: model({ input: 1, output: 1 }), wake: 'w-1' });
  await tick();
  assert.deepEqual(ws().protocols, ['echo', `key.${KEY}`]);
  ws().receive({ ready: true });
  await session.ready;
  ws().receive({ type: 'said', text: `I won't say ${KEY}.`, final: true });
  ws().receive({ type: 'usage', usage: { input: 100, output: 10 } });
  ws().receive({ type: 'turn', end: 'complete' });
  await tick();
  ws().drop(1007, `Something about ${KEY}.`);
  const end = await session.closed;
  assert.equal(end.code, 1007);
  assert.ok(!end.reason.includes(KEY));
  const all = await events(store);
  const lives = all.filter((/** @type {any} */ e) => e.type === 'live.session');
  assert.deepEqual(lives.map((/** @type {any} */ e) => e.data.state), ['open', 'ready', 'closed']);
  const closed = lives[2].data;
  assert.equal(closed.turns, 1);
  assert.equal(closed.code, 1007);
  assert.equal(closed.wake, 'w-1');
  assert.ok(closed.bytesIn > 0 && closed.bytesOut > 0, 'the data both ways');
  for (const e of lives) assert.ok(!('url' in e.data) && !('protocols' in e.data), 'no address or subprotocols in live.session');
  const req = all.find((/** @type {any} */ e) => e.type === 'net.request');
  assert.equal(req.data.kind, 'realtime');
  assert.equal(req.data.url, 'wss://live.test/live/v1?…');
  assert.ok(!JSON.stringify(all).includes(KEY), 'the key is in no entry');
});

test('close codes become kinds: 1007 "API key not valid" auth, 1008 not-found, quota rate, 1011 server, anything else network', async () => {
  const kinds = [
    [1007, 'API key not valid. Please pass a valid API key.'], [1008, 'models/gemini-nope is not found for API version v1alpha'],
    [1011, 'RESOURCE_EXHAUSTED: You exceeded your current quota.'], [1008, 'Quota exceeded for this project.'], [1011, 'Internal error occurred.'],
    [1006, ''], [1000, ''], [1007, 'Invalid JSON payload received.'],
  ].map(([code, reason]) => closeKind(ECHO, /** @type {number} */ (code), /** @type {string} */ (reason)));
  assert.deepEqual(kinds, ['auth', 'not-found', 'rate', 'rate', 'server', 'network', 'network', 'network']);
  assert.equal(closeKind({ ...ECHO, classifyClose: undefined }, 1007, 'API key not valid.'), 'auth', 'a key the provider refuses, in its words, is auth by default too');
  assert.equal(closeKind({ ...ECHO, classifyClose: () => 'bogus' }, 1011, 'Internal error occurred.'), 'server', 'a kind annai doesn\'t know is ignored');
  // Through a session: refused before it was ready, ready rejects with the kind; a socket that never opened is unreachable.
  FakeSocket.made = [];
  const a = open();
  await tick();
  a.ws().drop(1007, 'API key not valid. Please pass a valid API key.');
  await assert.rejects(a.session.ready, (e) => e instanceof ProviderError && e.kind === 'auth');
  assert.equal((await a.session.closed).kind, 'auth');
  const b = open({ socket: (/** @type {string} */ url, /** @type {string[]} */ p) => new FakeSocket(url, p, { opens: false }) });
  b.ws().drop(1006, '');
  await assert.rejects(b.session.ready, (e) => e instanceof ProviderError && e.kind === 'unreachable');
  // One annai closes is no error.
  const c = open();
  await tick();
  c.ws().receive({ ready: true });
  await c.session.ready;
  c.session.close('voice off');
  const end = await c.session.closed;
  assert.equal(end.kind, null);
  assert.ok(String(c.ws().sent.at(-1)).includes('bye'), "the protocol's close ran first");
  const lives = (await events(c.store)).filter((/** @type {any} */ e) => e.type === 'live.session');
  assert.equal(lives.at(-1).data.why, 'voice off');
  // A browser that refuses to open the socket at all (its security policy) is unreachable, in words without the address.
  const d = open({ socket: () => { throw new DOMException(`Refused to connect to wss://live.test/?key=${KEY}`, 'SecurityError'); } });
  await assert.rejects(d.session.ready, (e) => e instanceof ProviderError && e.kind === 'unreachable' && !e.message.includes(KEY));
});

test('realtime usage is priced by audioIn and audioOut and counted in Spend per day', async () => {
  FakeSocket.made = [];
  const prices = { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 };
  const store = createMemoryStore();
  await ensureBaseScopes(new Workspace(store, { schemaFor: () => null }));
  const { session, ws } = open({ store, model: model(prices), wake: 'w-2' });
  await tick();
  ws().receive({ ready: true });
  await session.ready;
  ws().receive({ type: 'usage', usage: { input: 1000, audioIn: 2000, output: 100, audioOut: 500 } });
  ws().receive({ type: 'usage', usage: { input: 1200, audioIn: 2500, output: 50, audioOut: 300, reasoning: 20 } });
  await tick();
  session.close();
  await session.closed;
  const all = await events(store);
  const reqs = all.filter((/** @type {any} */ e) => e.type === 'net.request');
  const first = (1000 * 0.75 + 2000 * 3 + 100 * 4.5 + 500 * 12) / 1e6;
  const second = (1200 * 0.75 + 2500 * 3 + 50 * 4.5 + 300 * 12) / 1e6;
  assert.deepEqual(reqs.map((/** @type {any} */ e) => e.data.kind), ['realtime', 'realtime']);
  assert.ok(Math.abs(reqs[0].data.cost - first) < 1e-12);
  assert.equal(reqs[0].data.wake, 'w-2');
  assert.equal(reqs[1].data.usage.audioIn, 2500);
  const closed = all.filter((/** @type {any} */ e) => e.type === 'live.session').at(-1);
  assert.ok(Math.abs(closed.data.cost - (first + second)) < 1e-12);
  const spent = await spentToday(store, Date.now(), 'UTC');
  assert.ok(Math.abs(spent - (first + second)) < 1e-12, `${spent} vs ${first + second}`);
});

test("a protocol may open again, twice at most, before the session is ready, with the tunables it gives (Gemini's proactive audio, decision 11; its language hints)", async () => {
  FakeSocket.made = [];
  const type = { ...ECHO, reopen: (/** @type {number} */ code, /** @type {string} */ reason, /** @type {any} */ t) => (code === 1007 && /proactivity/.test(reason) && t.version !== 'v2' ? { ...t, version: 'v2' } : null) };
  const { store, session } = open({ type, tunables: { version: 'v1' } });
  await tick();
  FakeSocket.made[0].drop(1007, 'Unknown name "proactivity" at \'setup\'');
  await tick();
  assert.equal(FakeSocket.made.length, 2);
  assert.match(FakeSocket.made[1].url, /\/live\/v2\?/);
  FakeSocket.made[1].receive({ ready: true });
  await session.ready;
  assert.deepEqual(session.tunables, { version: 'v2' });
  const states = (await events(store)).filter((/** @type {any} */ e) => e.type === 'live.session').map((/** @type {any} */ e) => e.data.state);
  assert.deepEqual(states, ['open', 'ready']);
  // At most twice in all: a third refusal ends it (a second fix, for a second field refused, is allowed: Gemini's hints, then its proactive audio).
  const again = open({ type: { ...type, reopen: (/** @type {number} */ _c, /** @type {string} */ _r, /** @type {any} */ t) => ({ version: `v${Number(String(t.version).slice(1)) + 1}` }) }, tunables: { version: 'v1' } });
  await tick();
  again.ws().drop(1007, 'no');
  await tick();
  again.ws().drop(1007, 'still no');
  await tick();
  assert.equal(FakeSocket.made.length, 5, 'a second reopen');
  again.ws().drop(1007, 'and again no');
  await assert.rejects(again.session.ready, (e) => e instanceof ProviderError);
  assert.equal(FakeSocket.made.length, 5, 'but not a third');
  session.close();
});

test('a session that is never ready in time is closed, as a timeout', async () => {
  FakeSocket.made = [];
  const { session, ws } = open({ readyMs: 30 });
  await assert.rejects(session.ready, (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.ok(ws().closedWith);
});

test('a plugin registers a realtime type only with open(), attach() and the audio it takes and gives', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const manifest = { id: 'livey', name: 'Livey', version: '1.0.0', api: 1 };
  const good = { manifest, activate: (/** @type {any} */ a) => a.providers.register({ type: 'live-ok', realtime: true, audio: ECHO.audio, open() {}, attach() {} }) };
  await new PluginHost({ registry, workspace: ws, importModule: async () => good }).addBuiltin('good');
  assert.ok(registry.list('endpoint-type').some((t) => t.type === 'live-ok' && t.realtime));
  for (const [i, wrong] of [{ realtime: true, open() {} }, { realtime: true, open() {}, attach() {}, audio: { in: [], out: [] } }].entries()) {
    const bad = { manifest: { ...manifest, id: `livey-bad-${i}` }, activate: (/** @type {any} */ a) => a.providers.register({ type: `live-bad-${i}`, ...wrong }) };
    await assert.rejects(new PluginHost({ registry, workspace: ws, importModule: async () => bad }).addBuiltin('bad'), /the realtime type "live-bad-\d" needs open\(\) and attach\(\), and the audio it takes and gives/);
  }
});

test('callRole skips a realtime model as not-chat; a chat role never sends it a request; live() opens it, traced in its scope, and a refused key rests it', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  registry.add('echo', 'endpoint-type', { ...ECHO, open: (/** @type {any} */ c) => { opened.push(c.model.providerId); return ECHO.open(c); } });
  /** @type {string[]} */
  const opened = [];
  const p = newProvider('provider-test', { user: { name: 'Gemini', baseUrl: 'https://live.test', abilities: { live: { kind: 'realtime', type: 'echo-live' } } } });
  const m = newModel(p.id, 'live', { user: { providerId: 'live-1' } });
  await saveProvider(ws, p, [m]);
  await setKey(store, p.id, KEY);
  await saveRoles(ws, { ...(await readConfig(ws)).roles, main: { models: [m.id], level: 'off' }, 'koe-realtime': { models: [m.id], level: 'off' } });
  FakeSocket.made = [];
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: async () => { throw new Error('no request'); }, openSocket: socket });
  const cfg = await readConfig(ws);
  assert.equal(cfg.roles['koe-realtime'].models[0], m.id, 'Koe · Realtime takes a realtime model');
  const request = { messages: [{ role: /** @type {const} */ ('user'), parts: [{ type: /** @type {const} */ ('text'), text: 'hi' }] }] };
  await assert.rejects(callRole({ role: 'main', request, config: cfg, types: llm.types(), keyFor: async () => KEY, bench: new Bench() }),
    (e) => /** @type {any} */ (e).attempts[0].outcome === 'not-chat');
  assert.deepEqual(opened, []);
  const session = await llm.live(m.id, { instructions: 'You are Koe.', context: '', tools: [] }, { scope: SYS, wake: 'w-3' });
  assert.deepEqual(opened, ['live-1']);
  await tick();
  assert.match(FakeSocket.made[0].url, /^wss:\/\/live\.test\//);
  FakeSocket.made[0].drop(1007, 'API key not valid. Please pass a valid API key.');
  await assert.rejects(session.ready, (e) => e instanceof ProviderError && e.kind === 'auth');
  await tick();
  assert.ok(llm.bench.until(m.id) > Date.now(), 'a refused key rests the model');
  await assert.rejects(llm.live('m-nope', { instructions: '', context: '', tools: [] }), (e) => e instanceof ProviderError && e.kind === 'not-found');
  assert.ok(!JSON.stringify(await events(store)).includes(KEY));
});

test('what a refusal taught the protocol is remembered for the model even when the reopened attempt fails, so the next session does not pay a refused socket again (Step S4)', async () => {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  /** @type {any[]} */
  const opened = [];
  registry.add('echo', 'endpoint-type', {
    ...ECHO,
    open: (/** @type {any} */ c) => { opened.push({ ...c.tunables }); return ECHO.open(c); },
    reopen: (/** @type {number} */ code, /** @type {string} */ reason, /** @type {any} */ t) => (code === 1007 && /languageCodes/.test(reason) && t.languageHints !== false ? { ...t, languageHints: false } : null),
  });
  const p = newProvider('provider-test', { user: { name: 'Gemini', baseUrl: 'https://live.test', abilities: { live: { kind: 'realtime', type: 'echo-live' } } } });
  const m = newModel(p.id, 'live', { user: { providerId: 'live-1' } });
  await saveProvider(ws, p, [m]);
  await setKey(store, p.id, KEY);
  FakeSocket.made = [];
  const llm = createLlm({ store, ws, plugins: new PluginHost({ registry, workspace: ws }), fetch: async () => { throw new Error('no request'); }, openSocket: socket });
  const setup = { instructions: '', context: '', tools: [] };
  const first = await llm.live(m.id, setup);
  await tick();
  FakeSocket.made[0].drop(1007, 'Unknown name "languageCodes" at \'setup.input_audio_transcription\'');
  await tick();
  FakeSocket.made[1].drop(1011, 'the server had a bad moment'); // the reopened attempt fails for another reason
  await assert.rejects(first.ready, (e) => e instanceof ProviderError);
  const second = await llm.live(m.id, setup);
  await tick();
  assert.deepEqual(opened.map((t) => t.languageHints), [undefined, false, false], 'the second session starts without the hints');
  second.close();
});

test('a key with characters an address escapes is blanked in both forms: in the close, the error and the trace (review)', async () => {
  FakeSocket.made = [];
  const key = 'fake+key/with=specials&0 123456789';
  const forms = [key, encodeURIComponent(key), new URLSearchParams({ k: key }).toString().slice(2)];
  assert.equal(new Set(forms).size, 3, 'three different forms');
  const store = createMemoryStore();
  const type = { ...ECHO, open: (/** @type {any} */ { endpoint, key: k }) => ({ url: `${endpoint.baseUrl.replace(/^http/, 'ws')}/live?key=${encodeURIComponent(k)}` }) };
  const session = openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key, tunables: {}, setup, trace: modelTrace(store, SYS), socket });
  await tick();
  FakeSocket.made[0].drop(1007, `Refused: wss://live.test/live?key=${forms[1]} (or ${forms[2]}) is not valid.`);
  const end = await session.closed;
  /** @type {any} */
  let err = null;
  await session.ready.catch((e) => { err = e; });
  await tick();
  const json = JSON.stringify(await events(store));
  for (const f of forms) {
    assert.ok(!end.reason.includes(f) && !err.message.includes(f) && !json.includes(f), f.replace(/./g, '·'));
  }
  assert.match(end.reason, /key=«key» \(or «key»\)/);
});

test('a session takes the audio its protocol prefers first, or the formats its tunables input and output name, and says which; a setup that names its own wins (K6)', async () => {
  FakeSocket.made = [];
  const MU = { format: /** @type {const} */ ('pcmu'), rate: 8000 };
  /** @type {any[]} */
  const attached = [];
  const type = { ...ECHO, audio: { in: [MU, PCM16(24000)], out: [PCM16(24000), MU] }, attach: (/** @type {any} */ s, /** @type {any} */ c) => (attached.push(c.setup), ECHO.attach(s, c)) };
  const bare = { instructions: 'You are Koe.', context: '', tools: [] };
  /** @param {Record<string, any>} tunables @param {any} [over] */
  const one = (tunables, over = {}) => openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables, setup: { ...bare, ...over }, trace: null, socket });
  const sessions = [one({}), one({ input: 'pcm16', output: 'pcmu' }), one({ input: 'opus' }), one({ input: 'pcm16' }, { audioIn: PCM16(16000) })];
  assert.deepEqual(sessions.map((s) => [s.audioIn, s.audioOut]), [[MU, PCM16(24000)], [PCM16(24000), MU], [MU, PCM16(24000)], [PCM16(16000), PCM16(24000)]]);
  await tick();
  assert.deepEqual(attached.map((x) => [x.audioIn, x.audioOut]), sessions.map((s) => [s.audioIn, s.audioOut]), 'the protocol is set up with the same');
  for (const s of sessions) s.close();
});

test("a protocol's ready that fails with a ProviderError says why: its kind and words, the key blanked, never against its plugin; any other failure is the plugin's (K6)", async () => {
  FakeSocket.made = [];
  /** @type {string[]} */
  const failed = [];
  const registry = { fail: (/** @type {string} */ _id, /** @type {string} */ what) => { failed.push(what); } };
  /** @param {unknown} e @returns {any} */
  const failing = (e) => ({ ...ECHO, attach: (/** @type {any} */ s, /** @type {any} */ c) => ({ ...ECHO.attach(s, c), ready: Promise.reject(e) }) });
  const store = createMemoryStore();
  const refused = openLive({ type: failing(new ProviderError('auth', `Incorrect API key provided: ${KEY}.`)), endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: modelTrace(store, SYS), socket, registry });
  await assert.rejects(refused.ready, (e) => e instanceof ProviderError && e.kind === 'auth' && e.message === 'Incorrect API key provided: «key».');
  assert.equal((await refused.closed).kind, 'auth');
  assert.ok(FakeSocket.made[0].closedWith, 'annai closes the socket');
  assert.deepEqual(failed, [], "a refusal isn't the plugin's bug");
  const closed = (await events(store)).find((e) => e.type === 'live.session' && e.data.state === 'closed');
  assert.equal(closed?.data.kind, 'auth');
  assert.ok(!JSON.stringify(await events(store)).includes(KEY));
  const broken = openLive({ type: failing(new TypeError("Cannot read properties of undefined (reading 'x')")), endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: null, socket, registry });
  await assert.rejects(broken.ready, (e) => e instanceof ProviderError && e.kind === 'plugin');
  assert.deepEqual(failed, ['live ready']);
});

test('once a session has closed, nothing more is told: a protocol timer that fires late reaches no listener and no trace (K6)', async () => {
  FakeSocket.made = [];
  /** @type {(e: any) => void} */
  let late = () => {};
  const type = { ...ECHO, attach: (/** @type {any} */ s, /** @type {any} */ c) => { late = c.emit; return ECHO.attach(s, c); } };
  const store = createMemoryStore();
  const session = openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: modelTrace(store, SYS), socket });
  /** @type {any[]} */
  const heard = [];
  session.on((e) => heard.push(e));
  await tick();
  FakeSocket.made[0].receive({ ready: true });
  await session.ready;
  FakeSocket.made[0].drop(1006, '');
  await session.closed;
  late({ type: 'goaway', ms: 300_000 });
  late({ type: 'usage', usage: { input: 10 } });
  assert.deepEqual(heard, []);
  assert.deepEqual((await events(store)).map((e) => e.data.state ?? e.type), ['open', 'ready', 'closed']);
});

test("a session that closes on its own lets its protocol go too: the driver's close() is called once, as when annai closes it (review)", async () => {
  FakeSocket.made = [];
  let closes = 0;
  const type = { ...ECHO, attach: (/** @type {any} */ s, /** @type {any} */ c) => ({ ...ECHO.attach(s, c), close: () => { closes++; } }) };
  const dropped = openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: null, socket });
  await tick();
  FakeSocket.made[0].receive({ ready: true });
  await dropped.ready;
  FakeSocket.made[0].drop(1006, '');
  await dropped.closed;
  assert.equal(closes, 1, 'its timers stop with it');
  const asked = openLive({ type, endpoint: endpoint('https://live.test'), model: model(), key: KEY, tunables: {}, setup, trace: null, socket });
  await tick();
  FakeSocket.made[1].receive({ ready: true });
  await asked.ready;
  asked.close();
  await asked.closed;
  assert.equal(closes, 2, 'once each');
});

test('a live session of a provider marked free tier costs nothing, turn by turn and in all', async () => {
  FakeSocket.made = [];
  const store = createMemoryStore();
  await ensureBaseScopes(new Workspace(store, { schemaFor: () => null }));
  const { session, ws } = open({ store, model: model({ input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 }), endpoint: { ...endpoint('https://live.test'), free: true } });
  await tick();
  ws().receive({ ready: true });
  await session.ready;
  ws().receive({ type: 'usage', usage: { input: 1000, audioIn: 2000, output: 100, audioOut: 500 } });
  await tick();
  session.close();
  await session.closed;
  const all = await events(store);
  assert.deepEqual(all.filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data.cost), [0]);
  assert.equal(all.filter((/** @type {any} */ e) => e.type === 'live.session').at(-1).data.cost, 0);
});
