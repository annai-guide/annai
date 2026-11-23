import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { SYS, ensureBaseScopes } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { Uploads } from '../../src/core/llm/uploads.js';

// Whose failure an endpoint type's error is, by position (fail-owner-next; the design check fail-owner-design.md): annai sends the request and reads
// the reply's body, so a body whose read failed is the link's whatever the type's code then throws, and anything else the type throws that is no
// ProviderError is its plugin's, whatever its words. The call's own signal comes first (a Stop, annai's time limit).

const hears = {
  type: 'test-in', name: 'Test transcription', speech: 'in', pluginId: 'test', tunables: {},
  transcribeRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/hear`, headers: {}, body: JSON.stringify({ model: c.model.providerId, bytes: c.audio.data.length }) }),
  readTranscript: async (/** @type {Response} */ res) => ({ text: (await res.json()).text }),
};
const speaks = {
  type: 'test-out', name: 'Test voice', speech: 'out', pluginId: 'test', tunables: {},
  speechRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/say`, headers: {}, body: JSON.stringify({ text: c.text }) }),
  readSpeech: async (/** @type {Response} */ res) => ({ data: new Uint8Array(await res.arrayBuffer()), mediaType: 'audio/mpeg' }),
};
const chat = (/** @type {any} */ extra = {}) => /** @type {any} */ ({
  type: 'test', name: 'Test', pluginId: 'test-plugin',
  build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { model: c.model.providerId } }),
  read: async function* (/** @type {Response} */ res) { yield { type: 'text', text: (await res.json()).text }; },
  ...extra,
});
/** @param {string} type @param {string} [baseUrl] */
const endpoint = (type, baseUrl = 'https://speech.test/v1') => /** @type {any} */ ({ id: 'pv-1/a', provider: 'pv-1', ability: 'a', type, name: 'A', baseUrl, headers: {}, tunables: {}, extraBody: {} });
const model = () => /** @type {any} */ ({ id: 'm-1', provider: 'pv-1', ability: 'a', name: 'Ears', providerId: 'ears-1', input: ['text'], tools: true, contextWindow: 100000, maxOutput: 1000, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} });
const audio = { data: new Uint8Array(4_000), mediaType: 'audio/wav', seconds: 0.1 };
/** @type {any} */
const request = { messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hi' }] }] };
/** A reply whose headers came and whose body then fails with this error. @param {unknown} error */
const drops = (error) => async () => new Response(new ReadableStream({ start: (c) => c.error(error) }));
/** A reply whose first piece comes, then its body fails with this error. @param {unknown} error */
const breaksOff = (error) => async () => {
  let n = 0;
  return new Response(new ReadableStream({ pull: (c) => (n++ === 0 ? c.enqueue(new Uint8Array(480)) : c.error(error)) }));
};
/** A voice that streams, reading its reply with a reader of its own; what it throws for a failed read is given. @param {(e: unknown) => unknown} made */
const streamsOut = (made) => ({ ...speaks, type: 'test-stream', readSpeechStream: async function* (/** @type {Response} */ res) {
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  for (;;) {
    /** @type {ReadableStreamReadResult<Uint8Array>} */
    let r;
    try {
      r = await reader.read();
    } catch (e) {
      throw made(e);
    }
    if (r.done) return;
    yield { pcm: new Int16Array(240), rate: 24_000 };
  }
} });
/** @param {string} id @param {any} type */
const withType = (id, type) => {
  const registry = new Registry();
  registry.add(id, 'endpoint-type', type);
  return registry;
};

test("P1: a dropped reply is the link's whatever the browser calls it (words no list holds): network, never counted, for a transcription, a voice and chat", async () => {
  const errors = [new TypeError('terminated'), new TypeError('Error in body stream'), new Error('The Internet connection appears to be offline.'), new DOMException('The network connection was lost.', 'NetworkError')];
  const registry = withType('test', hears);
  registry.add('test', 'endpoint-type', speaks);
  registry.add('test', 'endpoint-type', chat());
  const stream = streamsOut(() => new Error('the voice broke off'));
  registry.add('test', 'endpoint-type', stream);
  for (const error of errors) {
    const network = (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'network' && e.said?.code === 'kind' && e.cause === error;
    await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: drops(error), registry }), network, `heard: ${error.message}`);
    await assert.rejects(speechCall({ type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model(), key: null, text: 'Hello', fetch: drops(error), registry }), network, `said: ${error.message}`);
    await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch: drops(error), registry }), network, `chat: ${error.message}`);
    // A stream's later pieces: its first came, then the reply broke off, and the type threw an error of its own for it.
    const said = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (stream), endpoint: endpoint('test-stream'), model: model(), key: null, text: 'Hello', stream: true, fetch: breaksOff(error), registry })).stream;
    await assert.rejects(async () => { for await (const _ of said.chunks); }, network, `streamed: ${error.message}`);
  }
  assert.equal(registry.isDisabled('test'), false, 'sixteen drops: the plugin is on');
});

test("P2: a real connection destroyed mid-body (a local server, the engine's own error) is network, three in a row included", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
    res.write('{"text": "Where');
    setTimeout(() => res.socket?.destroy(), 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const registry = withType('test', hears);
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in', base), model: model(), key: null, audio, registry }),
        (e) => e instanceof ProviderError && e.kind === 'network');
    }
    assert.equal(registry.isDisabled('test'), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("P3: a bug in the type's own reading is its plugin's whatever its words name (a bare fetch or network, Chrome's \"Failed to execute 'fetch'\", \"Failed to fetch\"): plugin, counted, three switch it off", async () => {
  const bugs = [new TypeError("Cannot read properties of undefined (reading 'fetch')"), new TypeError('this.fetch is not a function'), new TypeError("Cannot read properties of undefined (reading 'network')"),
    new TypeError("Failed to execute 'fetch' on 'Window': Request with GET/HEAD method cannot have body."), new TypeError('Failed to fetch')];
  for (const [i, bug] of bugs.entries()) {
    const buggy = { ...hears, type: `bug-${i}`, readTranscript: async () => { throw bug; } };
    const registry = withType(`p-${i}`, buggy);
    for (let n = 0; n < 3; n++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (buggy), endpoint: endpoint(buggy.type), model: model(), key: null, audio, fetch: async () => Response.json({ text: 'x' }), registry }),
        (e) => e instanceof ProviderError && e.kind === 'plugin', bug.message);
    }
    assert.equal(registry.isDisabled(`p-${i}`), true, bug.message);
    const chatty = chat({ type: `chat-${i}`, read: async function* () { throw bug; } });
    const r2 = withType(`c-${i}`, chatty);
    for (let n = 0; n < 3; n++) await assert.rejects(callOnce({ type: chatty, endpoint: endpoint(chatty.type), model: model(), key: null, request, fetch: async () => Response.json({ text: 'x' }), registry: r2 }), (e) => e instanceof ProviderError && e.kind === 'plugin', bug.message);
    assert.equal(r2.isDisabled(`c-${i}`), true, bug.message);
  }
});

test("P4: a bug in a speech type's request builder is its plugin's: plugin, counted, traced as a failed request, three switch it off (a transcription, a voice, a voice's extraChars)", async () => {
  const bug = () => { throw new TypeError("Cannot read properties of undefined (reading 'path')"); };
  for (const [name, type, more] of /** @type {const} */ ([['hear', { ...hears, type: 'b-in', transcribeRequest: bug }, { audio }], ['say', { ...speaks, type: 'b-out', speechRequest: bug }, { text: 'Hello' }],
    ['chars', { ...speaks, type: 'b-chars', extraChars: bug }, { text: 'Hello' }]])) {
    const registry = withType(`plugin-${name}`, type);
    /** @type {any[]} */
    const lines = [];
    const trace = /** @type {any} */ ({ secret: () => {}, request: async (/** @type {any} */ r) => { lines.push(r); } });
    for (let n = 0; n < 3; n++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (type), endpoint: { ...endpoint(type.type), free: false }, model: { ...model(), prices: { perCharacter: 0.001 } }, key: null, ...more, fetch: async () => Response.json({ text: 'x' }), registry, trace }),
        (e) => e instanceof ProviderError && e.kind === 'plugin', name);
    }
    assert.equal(registry.isDisabled(`plugin-${name}`), true, `${name}: counted, and switched off`);
    assert.deepEqual(lines.map((l) => [l.outcome, l.url]), [0, 1, 2].map(() => ['plugin', name === 'hear' || name === 'say' ? `${type.type}:` : 'https://speech.test/v1/say']), `${name}: each traced once`);
  }
});

test("P5: a call that works ends its plugin's run of failures: two bugs, a reply, a bug leave it on; three in a row switch it off (chat and speech)", async () => {
  const bug = new TypeError("Cannot read properties of undefined (reading 'text')");
  let fail = true;
  const flaky = { ...hears, type: 'flaky-in', readTranscript: async (/** @type {Response} */ res) => { if (fail) throw bug; return { text: (await res.json()).text }; } };
  const registry = withType('flaky', flaky);
  const hear = () => speechCall({ type: /** @type {any} */ (flaky), endpoint: endpoint('flaky-in'), model: model(), key: null, audio, fetch: async () => Response.json({ text: 'x' }), registry });
  await assert.rejects(hear());
  await assert.rejects(hear());
  fail = false;
  assert.equal((await hear()).text, 'x');
  fail = true;
  await assert.rejects(hear());
  assert.equal(registry.isDisabled('flaky'), false, 'speech: two, a reply, one: on');
  await assert.rejects(hear());
  await assert.rejects(hear());
  assert.equal(registry.isDisabled('flaky'), true, 'speech: three in a row: off');

  let failChat = true;
  const flakyChat = chat({ type: 'flaky-chat', read: async function* (/** @type {Response} */ res) { if (failChat) throw bug; yield { type: 'text', text: (await res.json()).text }; } });
  const r2 = withType('flaky-c', flakyChat);
  const ask = () => callOnce({ type: flakyChat, endpoint: endpoint('flaky-chat'), model: model(), key: null, request, fetch: async () => Response.json({ text: 'x' }), registry: r2 });
  await assert.rejects(ask());
  await assert.rejects(ask());
  failChat = false;
  assert.equal((await ask()).text, 'x');
  failChat = true;
  await assert.rejects(ask());
  assert.equal(r2.isDisabled('flaky-c'), false, 'chat: two, a reply, one: on');

  // A voice's stream that ends ends the run too.
  let failSay = true;
  const flakySay = { ...speaks, type: 'flaky-out', readSpeech: async () => { throw bug; },
    readSpeechStream: async function* () { if (failSay) throw bug; yield { pcm: new Int16Array(240), rate: 24_000 }; yield { pcm: new Int16Array(240), rate: 24_000 }; } };
  const r3 = withType('flaky-s', flakySay);
  const say = () => speechCall({ type: /** @type {any} */ (flakySay), endpoint: endpoint('flaky-out'), model: model(), key: null, text: 'Hello', stream: true, fetch: async () => new Response('x'), registry: r3 });
  await assert.rejects(say());
  await assert.rejects(say());
  failSay = false;
  const streamed = /** @type {any} */ (await say()).stream;
  for await (const _ of streamed.chunks);
  failSay = true;
  await assert.rejects(say());
  assert.equal(r3.isDisabled('flaky-s'), false, 'a stream: two, a stream that ended, one: on');
});

test('P6: what a type makes of a dropped body does not change whose it is: its own "server" error, or a plain error of its own, after the read failed is network, not counted', async () => {
  const drop = new TypeError('terminated');
  for (const [i, made] of [new ProviderError('server', "The answer couldn't be read."), new SyntaxError('Unexpected end of JSON input'), new Error('no reply')].entries()) {
    const wraps = { ...hears, type: `wrap-${i}`, readTranscript: async (/** @type {Response} */ res) => { try { return await res.json(); } catch { throw made; } } };
    const registry = withType(`w-${i}`, wraps);
    for (let n = 0; n < 3; n++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (wraps), endpoint: endpoint(wraps.type), model: model(), key: null, audio, fetch: drops(drop), registry }),
        (e) => e instanceof ProviderError && e.kind === 'network' && e.cause === drop, String(made));
    }
    assert.equal(registry.isDisabled(`w-${i}`), false);
  }
});

test("P7: a Stop or annai's time limit while a reply is read is cancelled or timeout, whatever the type made of the read that the stop failed (Chrome gives such a body's whole read \"Failed to fetch\")", async () => {
  // As the official types read a whole reply: any failure of the read that is no AbortError is theirs to call network.
  const wraps = { ...hears, type: 'wrap', readTranscript: async (/** @type {Response} */ res) => { try { return await res.json(); } catch (e) { throw new ProviderError('network', 'The connection dropped.', { cause: e }); } } };
  const registry = withType('w', wraps);
  const stop = new AbortController();
  /** A body that fails, once the call's signal aborts, as Chrome's does: with its own TypeError, not the signal's reason. */
  const stalls = async (/** @type {any} */ url, /** @type {any} */ init) => new Response(new ReadableStream({
    start: (c) => { init.signal.addEventListener('abort', () => c.error(new TypeError('Failed to fetch')), { once: true }); },
  }));
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(speechCall({ type: /** @type {any} */ (wraps), endpoint: endpoint('wrap'), model: model(), key: null, audio, fetch: stalls, registry, signal: stop.signal }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled');
  await assert.rejects(speechCall({ type: /** @type {any} */ (wraps), endpoint: endpoint('wrap'), model: model(), key: null, audio, fetch: stalls, registry, timeoutMs: 20 }),
    (e) => e instanceof ProviderError && e.kind === 'timeout');
  // Chat the same: a Stop during the read is a stop.
  const chatWraps = chat({ type: 'chat-wrap', read: async function* (/** @type {Response} */ res) { try { yield { type: 'text', text: (await res.json()).text }; } catch (e) { throw new ProviderError('network', 'The connection dropped.', { cause: e }); } } });
  const halt = new AbortController();
  setTimeout(() => halt.abort(), 20);
  await assert.rejects(callOnce({ type: chatWraps, endpoint: endpoint('chat-wrap'), model: model(), key: null, request, fetch: stalls, registry: withType('cw', chatWraps), signal: halt.signal }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled');
  assert.equal(registry.isDisabled('w'), false);
  // A voice's stream that stalls after its first piece is stalled, though the type made its own "network" of the read annai's limit ended.
  const wrapsStream = streamsOut((e) => new ProviderError('network', 'The voice stopped before it finished.', { cause: e }));
  const hangs = async (/** @type {any} */ url, /** @type {any} */ init) => {
    let n = 0;
    return new Response(new ReadableStream({ pull: (c) => (n++ === 0 ? c.enqueue(new Uint8Array(480)) : new Promise((_, no) => init.signal.addEventListener('abort', () => no(init.signal.reason), { once: true }))) }));
  };
  const voice = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (wrapsStream), endpoint: endpoint('test-stream'), model: model(), key: null, text: 'Hello', stream: true, fetch: hangs, timeoutMs: 20 })).stream;
  await assert.rejects(async () => { for await (const _ of voice.chunks); }, (e) => e instanceof ProviderError && e.kind === 'timeout' && e.said?.code === 'stalled');
});

test('P8: a type that ends its reading early with its own error (the reply still open) keeps its kind, and a reply read whole is as it came (status, headers, bytes)', async () => {
  const early = chat({ read: async function* (/** @type {Response} */ res) {
    const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
    await reader.read();
    await reader.cancel();
    throw new ProviderError('overloaded', 'busy');
  } });
  let cancelled = false;
  const open = async () => new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('data: x\n\n')); }, cancel: () => { cancelled = true; } }));
  await assert.rejects(callOnce({ type: early, endpoint: endpoint('test'), model: model(), key: null, request, fetch: open, registry: withType('test-plugin', early) }), (e) => e instanceof ProviderError && e.kind === 'overloaded');
  assert.equal(cancelled, true, "the type's cancel reaches the real body");
  /** @type {any} */
  let got;
  const looks = { ...speaks, readSpeech: async (/** @type {Response} */ res) => { got = { status: res.status, type: res.headers.get('content-type'), ok: res.ok }; return { data: new Uint8Array(await res.arrayBuffer()), mediaType: 'audio/mpeg' }; } };
  const r = await speechCall({ type: /** @type {any} */ (looks), endpoint: endpoint('test-out'), model: model(), key: null, text: 'Hello', fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }) });
  assert.deepEqual([got, [...(r.clip?.data ?? [])]], [{ status: 200, type: 'audio/mpeg', ok: true }, [1, 2, 3]]);
});

test("a bug in a type's upload request is its plugin's, counted once, and the photo still goes, as bytes; uploads stop there (fail-owner-next)", async () => {
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const uploads = new Uploads(ws);
  /** @type {any[]} */
  const logged = [];
  /** @type {any[]} */
  const bodies = [];
  const get = async (/** @type {string} */ url, /** @type {any} */ init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ text: 'ok' });
  };
  const t = chat({
    uploadRequest: () => { throw new TypeError("Cannot read properties of undefined (reading 'baseUrl')"); },
    readUpload: (/** @type {any} */ j) => ({ id: j.id }),
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
  });
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  registry.add('test-plugin', 'endpoint-type', t);
  const withPhoto = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }] }] });
  const m = { ...model(), input: ['text', 'image'] };
  const reply = await callOnce({ type: t, endpoint: endpoint('test', 'https://llm.test'), model: m, key: 'k', request: withPhoto, fetch: /** @type {any} */ (get), uploads, registry, trace: modelTrace(store, SYS) });
  assert.equal(reply.text, 'ok', 'the call answers');
  assert.deepEqual(bodies.map((b) => b.images[0]), ['bytes'], 'the photo went as bytes');
  assert.equal(uploads.isOff('pv-1/a'), true, 'uploads stop there');
  await callOnce({ type: t, endpoint: endpoint('test', 'https://llm.test'), model: m, key: 'k', request: withPhoto, fetch: /** @type {any} */ (get), uploads, registry });
  assert.deepEqual(logged.filter((e) => e.type === 'plugin.error').map((e) => [e.actor, e.data.count]), [['plugin:test-plugin', 1]], 'counted once against its plugin');
  const lines = (await store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(SYS))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
  assert.deepEqual(lines.map((d) => [d.kind, d.status, d.error]), [['upload', 0, "Cannot read properties of undefined (reading 'baseUrl')"], ['model', 200, undefined]], 'the failed upload is traced, then the call');
  assert.equal(registry.isDisabled('test-plugin'), false);
  // An upload the server refused (a 500), or answered without an id the type can read, is no bug of the plugin's: not counted.
  for (const answer of [() => new Response('no', { status: 500 }), () => Response.json({})]) {
    const refused = chat({
      uploadRequest: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: new FormData() }),
      readUpload: (/** @type {any} */ j) => { if (!j.id) throw new Error('the upload answered without a file id'); return { id: j.id }; },
      build: t.build,
    });
    /** @type {any[]} */
    const seen = [];
    const r2 = new Registry({ log: (ev) => { seen.push(ev); } });
    r2.add('test-plugin', 'endpoint-type', refused);
    const answers = async (/** @type {string} */ url, /** @type {any} */ init) => (url.endsWith('/v1/files') ? answer() : get(url, init));
    await callOnce({ type: refused, endpoint: endpoint('test', 'https://llm.test'), model: m, key: 'k', request: withPhoto, fetch: /** @type {any} */ (answers), uploads: new Uploads(ws), registry: r2 });
    assert.deepEqual(seen.filter((e) => e.type === 'plugin.error'), [], 'the server\'s answer is not counted');
  }
});
