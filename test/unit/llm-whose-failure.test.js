import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createMemoryStore } from '../fakes/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { SYS, ensureBaseScopes } from '../../src/core/scopes.js';
import { Registry } from '../../src/core/registry.js';
import { ProviderError, explain } from '../../src/core/llm/contract.js';
import { callOnce } from '../../src/core/llm/call.js';
import { testModel } from '../../src/core/llm/check.js';
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
/** The plugin.error events each registry here has logged: what a count against a plugin leaves. @type {WeakMap<Registry, any[]>} */
const logs = new WeakMap();
/** @param {string} id @param {any} type */
const withType = (id, type) => {
  /** @type {any[]} */
  const errors = [];
  const registry = new Registry({ log: (ev) => { if (ev.type === 'plugin.error') errors.push(ev); } });
  logs.set(registry, errors);
  registry.add(id, 'endpoint-type', type);
  return registry;
};
/** How many failures were counted against plugins on this registry (a plugin.error each): what "never counted" means, since a plugin is switched off only at the third in a row. @param {Registry} registry */
const counted = (registry) => logs.get(registry)?.length ?? 0;

test("P1: a dropped reply is the link's whatever the browser calls it (words no list holds): network, never counted, for a transcription, a voice, a voice's stream that breaks off after its first piece, and chat", async () => {
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
  assert.equal(counted(registry), 0, 'sixteen drops: none counted against it');
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
    assert.equal(counted(registry), 0, 'none counted');
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

test("P5: a call that works ends its plugin's run of failures: two bugs, a reply, a bug leave it on; three in a row switch it off (chat, a transcription, and a voice's stream, one that breaks after its first piece too)", async () => {
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
  await assert.rejects(ask());
  await assert.rejects(ask());
  assert.equal(r2.isDisabled('flaky-c'), true, 'chat: three in a row: off');

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
  await assert.rejects(say());
  await assert.rejects(say());
  assert.equal(r3.isDisabled('flaky-s'), true, 'a stream: three in a row: off');

  // A stream's first piece is no success: three streams that give one piece and then break are three failures in a row.
  const lateBug = { ...speaks, type: 'late-out', readSpeechStream: async function* () { yield { pcm: new Int16Array(240), rate: 24_000 }; throw bug; } };
  const r4 = withType('late-s', lateBug);
  for (let n = 0; n < 3; n++) {
    const piece = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (lateBug), endpoint: endpoint('late-out'), model: model(), key: null, text: 'Hello', stream: true, fetch: async () => new Response('x'), registry: r4 })).stream;
    await assert.rejects(async () => { for await (const _ of piece.chunks); }, (e) => e instanceof ProviderError && e.kind === 'plugin', `late bug ${n}`);
    assert.equal(r4.isDisabled('late-s'), n === 2, `after ${n + 1} broken streams`);
  }
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
    assert.equal(counted(registry), 0, `${made}: none counted`);
  }
});

test("P7: a Stop or annai's time limit while a reply is read is cancelled or timeout, and a voice's stream that stalls after its first piece is stalled, whatever the type made of the read that the stop failed (Chrome gives such a body's whole read \"Failed to fetch\"); none of them counts against the plugin", async () => {
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
  registry.add('w', 'endpoint-type', chatWraps);
  const halt = new AbortController();
  setTimeout(() => halt.abort(), 20);
  await assert.rejects(callOnce({ type: chatWraps, endpoint: endpoint('chat-wrap'), model: model(), key: null, request, fetch: stalls, registry, signal: halt.signal }),
    (e) => e instanceof ProviderError && e.kind === 'cancelled');
  // A voice's stream that stalls after its first piece is stalled, though the type made its own "network" of the read annai's limit ended.
  const wrapsStream = streamsOut((e) => new ProviderError('network', 'The voice stopped before it finished.', { cause: e }));
  registry.add('w', 'endpoint-type', wrapsStream);
  const hangs = async (/** @type {any} */ url, /** @type {any} */ init) => {
    let n = 0;
    return new Response(new ReadableStream({ pull: (c) => (n++ === 0 ? c.enqueue(new Uint8Array(480)) : new Promise((_, no) => init.signal.addEventListener('abort', () => no(init.signal.reason), { once: true }))) }));
  };
  const voice = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (wrapsStream), endpoint: endpoint('test-stream'), model: model(), key: null, text: 'Hello', stream: true, fetch: hangs, timeoutMs: 20, registry })).stream;
  await assert.rejects(async () => { for await (const _ of voice.chunks); }, (e) => e instanceof ProviderError && e.kind === 'timeout' && e.said?.code === 'stalled');
  assert.equal(counted(registry), 0, 'a Stop, a limit, a Stop in chat and a stall: four calls, none counted');
});

test("a Stop or annai's time limit is never the plugin's: three speech calls each stopped (while the request goes up, or the reply is read), three each out of time, three chat calls each stopped, and three voice streams that give a piece and then stall are cancelled, timeout or stalled, and none is counted (fail-owner-next)", async () => {
  const registry = withType('test', hears);
  registry.add('test', 'endpoint-type', chat());
  const streamed = streamsOut((e) => e);
  registry.add('test', 'endpoint-type', streamed);
  const hangs = (/** @type {any} */ url, /** @type {any} */ init) => new Promise((_, no) => init.signal.addEventListener('abort', () => no(new DOMException('Stopped.', 'AbortError')), { once: true }));
  const stalls = async (/** @type {any} */ url, /** @type {any} */ init) => new Response(new ReadableStream({ start: (c) => { init.signal.addEventListener('abort', () => c.error(new TypeError('Failed to fetch')), { once: true }); } }));
  for (const [where, fetch] of /** @type {const} */ ([['request', hangs], ['reply', stalls]])) {
    for (let n = 0; n < 3; n++) {
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 10);
      await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch, registry, signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled', `stopped in the ${where}, call ${n + 1}`);
      const halt = new AbortController();
      setTimeout(() => halt.abort(), 10);
      await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch, registry, signal: halt.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled', `chat stopped in the ${where}, call ${n + 1}`);
    }
  }
  for (let n = 0; n < 3; n++) {
    await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: stalls, registry, timeoutMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout', `out of time, call ${n + 1}`);
  }
  // A voice's stream: one piece comes, then none until annai's limit.
  const hangsAfterOne = async (/** @type {any} */ url, /** @type {any} */ init) => {
    let n = 0;
    return new Response(new ReadableStream({ pull: (c) => (n++ === 0 ? c.enqueue(new Uint8Array(480)) : new Promise((_, no) => init.signal.addEventListener('abort', () => no(init.signal.reason), { once: true }))) }));
  };
  for (let n = 0; n < 3; n++) {
    const voice = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (streamed), endpoint: endpoint('test-stream'), model: model(), key: null, text: 'Hello', stream: true, fetch: hangsAfterOne, timeoutMs: 20, registry })).stream;
    await assert.rejects(async () => { for await (const _ of voice.chunks); }, (e) => e instanceof ProviderError && e.kind === 'timeout' && e.said?.code === 'stalled', `stream stalled, ${n + 1}`);
  }
  assert.equal(registry.isDisabled('test'), false);
  assert.equal(counted(registry), 0, 'twenty-one calls, none counted');
});

test("a body that drops with an AbortError or a TimeoutError (Firefox's own words for a reply cut mid-body: \"The operation was aborted.\") is network and never counted, for a transcription, a voice, a voice's later pieces and chat, as one that drops with a TypeError is, and so is Firefox's pair (annai's read of the body fails with a TypeError, then the type's own read of it with an AbortError); a Stop or annai's limit during such a drop is still cancelled or timeout; an AbortError or TimeoutError of the type's own with no drop is read by its name (fail-owner-next, round 3 item 2)", async () => {
  const aborted = new DOMException('The operation was aborted.', 'AbortError');
  const slow = new DOMException('The operation timed out.', 'TimeoutError');
  const registry = withType('test', hears);
  registry.add('test', 'endpoint-type', speaks);
  registry.add('test', 'endpoint-type', chat());
  const stream = streamsOut((e) => e);
  registry.add('test', 'endpoint-type', stream);
  for (const error of [aborted, slow]) {
    const network = (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'network' && e.said?.code === 'kind' && e.cause === error;
    for (let n = 0; n < 3; n++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: drops(error), registry }), network, `heard: ${error.name}`);
      await assert.rejects(speechCall({ type: /** @type {any} */ (speaks), endpoint: endpoint('test-out'), model: model(), key: null, text: 'Hello', fetch: drops(error), registry }), network, `said: ${error.name}`);
      await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch: drops(error), registry }), network, `chat: ${error.name}`);
      const said = /** @type {any} */ (await speechCall({ type: /** @type {any} */ (stream), endpoint: endpoint('test-stream'), model: model(), key: null, text: 'Hello', stream: true, fetch: breaksOff(error), registry })).stream;
      await assert.rejects(async () => { for await (const _ of said.chunks); }, network, `streamed: ${error.name}`);
    }
  }
  assert.equal(registry.isDisabled('test'), false, 'twenty-four drops: the plugin is on');
  assert.equal(counted(registry), 0, 'none counted against it');
  // Firefox's own pair (measured, 155): annai's read of the body gives a TypeError, and the type's `res.json()` on it an AbortError.
  const inFirefox = { ...hears, type: 'test-in-firefox', readTranscript: async (/** @type {Response} */ res) => { try { return { text: (await res.json()).text }; } catch { throw aborted; } } };
  registry.add('test', 'endpoint-type', inFirefox);
  for (let n = 0; n < 3; n++) {
    await assert.rejects(speechCall({ type: /** @type {any} */ (inFirefox), endpoint: endpoint('test-in-firefox'), model: model(), key: null, audio, fetch: drops(new TypeError('Error in input stream')), registry }),
      (e) => e instanceof ProviderError && e.kind === 'network' && e.cause instanceof TypeError, `Firefox's pair ${n + 1}`);
  }
  // A Stop or annai's limit while such a body is read: the call's own signal comes first, though the same read failed with the same AbortError.
  const dropsOnStop = async (/** @type {any} */ url, /** @type {any} */ init) => new Response(new ReadableStream({ start: (c) => { init.signal.addEventListener('abort', () => c.error(aborted), { once: true }); } }));
  for (let n = 0; n < 3; n++) {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10);
    await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: dropsOnStop, registry, signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled', `stopped during the drop, speech ${n + 1}`);
    const halt = new AbortController();
    setTimeout(() => halt.abort(), 10);
    await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch: dropsOnStop, registry, signal: halt.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled', `stopped during the drop, chat ${n + 1}`);
    await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: dropsOnStop, registry, timeoutMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout', `out of time during the drop, speech ${n + 1}`);
    await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch: dropsOnStop, registry, firstOutputMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout', `out of time during the drop, chat ${n + 1}`);
  }
  // No drop: what the type's own code throws is read by its name, uncounted (a browser's, or the plugin's own timer).
  for (const [name, kind] of /** @type {const} */ ([['AbortError', 'cancelled'], ['TimeoutError', 'timeout']])) {
    const own = { ...hears, type: `own-${name}`, readTranscript: async () => { throw new DOMException('its own timer', name); } };
    registry.add('test', 'endpoint-type', own);
    for (let n = 0; n < 3; n++) {
      await assert.rejects(speechCall({ type: /** @type {any} */ (own), endpoint: endpoint(own.type), model: model(), key: null, audio, fetch: async () => Response.json({ text: 'x' }), registry }), (e) => e instanceof ProviderError && e.kind === kind, `${name} of its own, ${n + 1}`);
    }
  }
  assert.equal(registry.isDisabled('test'), false);
  assert.equal(counted(registry), 0, 'stops, limits and its own timers: none counted');
});

test('P8: a type that ends its reading early with its own error (the reply still open) keeps its kind, and a reply read whole is as it came (headers and bytes; its status is 200, as the 204 test says)', async () => {
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

test("a bug in a type's upload request is its plugin's, counted once, and the photo still goes, as bytes; uploads stop there; a server's refusal, or a reply it can't read, is not counted (fail-owner-next)", async () => {
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

/**
 * A local server that answers every request with this status line (the reason phrase as it comes, raw) and body; `cut`: its length says more than
 * it sends; the connection is destroyed 30 ms after the one write of the head and body, as a link that drops. @param {number} status @param {string} reason @param {string} body
 * @param {{ cut?: boolean, headers?: string }} [o] @returns {Promise<{ base: string, close: () => void }>}
 */
async function rawServer(status, reason, body, { cut = false, headers = '' } = {}) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('error', () => {});
    s.once('data', () => {
      s.write(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body) + (cut ? 5000 : 0)}\r\nconnection: close\r\n${headers}\r\n${body}`);
      if (cut) setTimeout(() => s.destroy(), 30);
      else s.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  return { base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test("a reply whose status text the Response constructor refuses (200 成功, a control character) is read as any other: the type gets its text, and nothing is counted (fail-owner-next, fix 1)", async () => {
  for (const reason of ['成功', 'O\u0001K']) {
    const server = await rawServer(200, reason, '{"text":"x"}');
    try {
      const registry = withType('test', hears);
      registry.add('test', 'endpoint-type', chat());
      for (let n = 0; n < 3; n++) {
        assert.equal((await speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in', server.base), model: model(), key: null, audio, registry })).text, 'x', `heard: ${JSON.stringify(reason)}`);
        assert.equal((await callOnce({ type: chat(), endpoint: endpoint('test', server.base), model: model(), key: null, request, registry })).text, 'x', `chat: ${JSON.stringify(reason)}`);
      }
      assert.equal(counted(registry), 0, `${JSON.stringify(reason)}: six calls, none counted`);
    } finally {
      server.close();
    }
  }
});

/**
 * A reply as the browsers hand a 204 or a 205 over: a stream for its body, though that status allows none (Chromium and WebKit; Node gives such a
 * reply a null body, which is why a test in Node alone saw nothing). @param {number} status
 */
const withStreamAs = (status) => async () => {
  const res = new Response(new ReadableStream({ start: (c) => c.close() }));
  Object.defineProperty(res, 'status', { value: status });
  return res;
};

test("a 204 or 205 that comes with a body stream, as in the browsers, is read as any other reply: the type is told a status of 200 whatever the reply had, and nothing is counted (fail-owner-next, round 2 item 1)", async () => {
  /** @type {number[]} */
  const seen = [];
  const reads = chat({ type: 'test-reads', read: async function* (/** @type {Response} */ res) { seen.push(res.status); yield { type: 'text', text: await res.text() }; } });
  const looks = { ...speaks, type: 'test-looks', readSpeech: async (/** @type {Response} */ res) => { seen.push(res.status); return { data: new Uint8Array(await res.arrayBuffer()), mediaType: 'audio/mpeg' }; } };
  const registry = withType('test', reads);
  registry.add('test', 'endpoint-type', looks);
  for (const status of [204, 205]) {
    for (let n = 0; n < 3; n++) {
      assert.equal((await callOnce({ type: reads, endpoint: endpoint('test-reads'), model: model(), key: null, request, fetch: withStreamAs(status), registry })).text, '', `chat, ${status}`);
      assert.deepEqual([...((await speechCall({ type: /** @type {any} */ (looks), endpoint: endpoint('test-looks'), model: model(), key: null, text: 'Hello', fetch: withStreamAs(status), registry })).clip?.data ?? [1])], [], `voice, ${status}`);
    }
  }
  assert.deepEqual([...new Set(seen)], [200], 'the type is told a status of 200 whatever the reply had: annai reads the real one');
  assert.equal(counted(registry), 0, 'twelve calls, none counted');
});

test("an error reply with a status of 600 to 999, which a browser delivers and the Response constructor refuses, is read as any other: its kind, as on main, and never counted; a 503 is the control (fail-owner-next, round 2 item 1)", async () => {
  const registry = withType('test', hears);
  registry.add('test', 'endpoint-type', chat());
  for (const [status, kind] of /** @type {const} */ ([[600, 'server'], [999, 'server'], [503, 'overloaded']])) {
    const server = await rawServer(status, 'Odd', '{"error":{"message":"odd"}}');
    try {
      for (let n = 0; n < 3; n++) {
        await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test', server.base), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === kind, `chat, ${status}`);
        await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in', server.base), model: model(), key: null, audio, registry }), (e) => e instanceof ProviderError && e.kind === kind, `heard, ${status}`);
      }
    } finally {
      server.close();
    }
  }
  assert.equal(counted(registry), 0, 'eighteen calls, none counted');
  assert.equal(registry.isDisabled('test'), false);
});

test("a reply with no body reaches the type as annai's own, as any other does: its url and status text are empty, so the docs' sentence is true of every reply (fail-owner-next, fix 7)", async () => {
  /** @type {any} */
  let seen;
  const looks = { ...speaks, readSpeech: async (/** @type {Response} */ res) => { seen = { url: res.url, status: res.status, body: res.body }; return { data: new Uint8Array(), mediaType: 'audio/mpeg' }; } };
  const real = new Response(null, { status: 200 });
  Object.defineProperty(real, 'url', { value: 'https://speech.test/v1/say' });
  await speechCall({ type: /** @type {any} */ (looks), endpoint: endpoint('test-out'), model: model(), key: null, text: 'Hello', fetch: async () => real });
  assert.deepEqual(seen, { url: '', status: 200, body: null });
});

test("an error reply whose body drops while annai reads it is network, never counted, not the status's kind: a context overflow whose body is cut is no refused request (fail-owner-next, fix 4)", async () => {
  const overflow = JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } });
  const registry = withType('test', hears);
  registry.add('test', 'endpoint-type', chat());
  // The whole body: its words give the kind, as before.
  const whole = await rawServer(400, 'Bad Request', overflow);
  try {
    await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test', whole.base), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === 'context', 'chat, whole');
    await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in', whole.base), model: model(), key: null, audio, registry }), (e) => e instanceof ProviderError && e.kind === 'context', 'heard, whole');
  } finally {
    whole.close();
  }
  // Cut: the kind is not known, so it is the link's: network, three in a row included.
  for (const status of [400, 500]) {
    const cut = await rawServer(status, 'Error', overflow, { cut: true });
    try {
      for (let n = 0; n < 3; n++) {
        await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test', cut.base), model: model(), key: null, request, registry }), (e) => e instanceof ProviderError && e.kind === 'network' && e.said?.code === 'kind', `chat, ${status} cut`);
        await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in', cut.base), model: model(), key: null, audio, registry }), (e) => e instanceof ProviderError && e.kind === 'network', `heard, ${status} cut`);
      }
    } finally {
      cut.close();
    }
  }
  assert.equal(counted(registry), 0, 'cut bodies: none counted');
  // A Stop while an error body is read is still a stop, and annai's time limit a timeout.
  const stalls = async (/** @type {any} */ url, /** @type {any} */ init) => new Response(new ReadableStream({ start: (c) => { init.signal.addEventListener('abort', () => c.error(new TypeError('Failed to fetch')), { once: true }); } }), { status: 400 });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(callOnce({ type: chat(), endpoint: endpoint('test'), model: model(), key: null, request, fetch: stalls, registry, signal: stop.signal }), (e) => e instanceof ProviderError && e.kind === 'cancelled');
  await assert.rejects(speechCall({ type: /** @type {any} */ (hears), endpoint: endpoint('test-in'), model: model(), key: null, audio, fetch: stalls, registry, timeoutMs: 20 }), (e) => e instanceof ProviderError && e.kind === 'timeout');
  assert.equal(counted(registry), 0, 'a Stop and a limit while an error body is read: none counted either');
});

/**
 * One call with a photo through a type whose uploadRequest is this; what it logged, the bodies the call sent, and whether uploads went off.
 * @param {(c: any) => any} uploadRequest
 */
async function uploadedWith(uploadRequest) {
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
    uploadRequest, readUpload: (/** @type {any} */ j) => ({ id: j.id }),
    build: (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/chat`, headers: {}, body: { images: c.request.messages[0].parts.map((/** @type {any} */ p) => p.fileId ?? 'bytes') } }),
  });
  const registry = new Registry({ log: (ev) => { logged.push(ev); } });
  registry.add('test-plugin', 'endpoint-type', t);
  const withPhoto = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }] }] });
  const reply = await callOnce({ type: t, endpoint: endpoint('test', 'https://llm.test'), model: { ...model(), input: ['text', 'image'] }, key: 'k', request: withPhoto, fetch: /** @type {any} */ (get), uploads, registry });
  await new Promise((r) => setTimeout(r, 5)); // a rejected promise nobody handled would be reported by now
  return { reply, counted: logged.filter((e) => e.type === 'plugin.error').map((e) => e.data.count), bodies: bodies.map((b) => b.images[0]), off: uploads.isOff('pv-1/a') };
}

test("an uploadRequest whose result is not a request (an async function's promise, an object with no url) is its plugin's bug, counted once; the photo goes as bytes (fail-owner-next, fix 5)", async () => {
  /** @type {unknown[]} */
  const unhandled = [];
  const note = (/** @type {unknown} */ e) => { unhandled.push(e); };
  process.on('unhandledRejection', note);
  try {
    const request = (/** @type {any} */ c) => ({ url: `${c.endpoint.baseUrl}/v1/files`, headers: {}, body: new FormData() });
    for (const [name, build] of /** @type {const} */ ([
      ['an async function that returns a request', async (/** @type {any} */ c) => request(c)],
      ['an async function that throws', async () => { throw new TypeError("Cannot read properties of undefined (reading 'baseUrl')"); }],
      ['an object with no url', () => ({ headers: {} })],
      ['nothing', () => undefined],
      ['a request with a url that is no string', () => ({ url: 42, headers: {} })],
    ])) {
      const r = await uploadedWith(build);
      assert.equal(r.reply.text, 'ok', `${name}: the call answers`);
      assert.deepEqual([r.counted, r.bodies, r.off], [[1], ['bytes'], true], name);
    }
    // Its own ProviderError is its answer, not counted.
    const answers = await uploadedWith(() => { throw new ProviderError('upload', 'no files here'); });
    assert.deepEqual([answers.counted, answers.bodies, answers.off], [[], ['bytes'], true], 'a ProviderError of its own');
  } finally {
    process.off('unhandledRejection', note);
  }
  assert.deepEqual(unhandled, [], 'no rejected promise is left for the page to report');
});

test("a typed address is checked by annai, by state, before any builder runs: one that doesn't parse (an empty one included) is bad-request, never counted, with no builder called; a builder's own `new URL` failure at a good address is its plugin's bug, counted (fail-owner-next, round 2 item 2); a request a builder made to another address, or to one that isn't an address, keeps the built-address words, and both of those said codes (no-address, before and after the build, and origin) name the ability as the other said codes do, in a call, a speech call and a Test (round 4 items 3 and 5, round 5)", async () => {
  /** @type {string[]} */
  const built = [];
  const request1 = (/** @type {string} */ who, /** @type {any} */ c) => { built.push(who); return { url: `${c.endpoint.baseUrl}/x`, headers: {}, body: '{}' }; };
  const kinds = /** @type {const} */ ([
    ['chat', chat({ type: 'addr-chat', build: (/** @type {any} */ c) => request1('build', c) }), (/** @type {any} */ t, /** @type {any} */ registry, /** @type {string} */ at) => callOnce({ type: t, endpoint: endpoint('addr-chat', at), model: model(), key: null, request, registry })],
    ['hear', { ...hears, type: 'addr-in', transcribeRequest: (/** @type {any} */ c) => request1('transcribeRequest', c) }, (/** @type {any} */ t, /** @type {any} */ registry, /** @type {string} */ at) => speechCall({ type: t, endpoint: endpoint('addr-in', at), model: model(), key: null, audio, registry })],
    ['say', { ...speaks, type: 'addr-out', speechRequest: (/** @type {any} */ c) => request1('speechRequest', c), extraChars: () => { built.push('extraChars'); return 0; } },
      (/** @type {any} */ t, /** @type {any} */ registry, /** @type {string} */ at) => speechCall({ type: t, endpoint: endpoint('addr-out', at), model: model(), key: null, text: 'Hello', registry })],
  ]);
  for (const [name, type, call] of kinds) {
    for (const address of ['', 'not an address', 'https://']) {
      const registry = withType(`a-${name}`, type);
      // The words say what is wrong and where to fix it (the address, in Settings → Models), not that a request was built to an address that isn't one,
      // and never repeat the typed text, which may hold a key.
      const words = "A's a has no working address. Give its address in Settings → Models.";
      for (let n = 0; n < 3; n++) {
        await assert.rejects(call(type, registry, address), (e) => e instanceof ProviderError && e.kind === 'bad-request' && e.said?.code === 'no-address' && e.message === words && explain(e) === words && !(address && e.message.includes(address)), `${name} at ${JSON.stringify(address)}`);
      }
      assert.deepEqual([counted(registry), registry.isDisabled(`a-${name}`)], [0, false], `${name} at ${JSON.stringify(address)}: not counted`);
    }
  }
  // The words name the ability as the other codes do: the name its description gives, else its kind's; a caller with no ability leaves the endpoint's id of it.
  // The address check before the build and the one after it (the builder's own request) both name it: a builder that goes to another host is refused in the same words.
  const hear = /** @type {any} */ ({ ...hears, type: 'addr-named-in' });
  const away = /** @type {any} */ ({ ...hears, type: 'addr-away-in', transcribeRequest: () => ({ url: 'https://other.test/x', headers: {}, body: '{}' }) });
  for (const [ability, shown, said] of /** @type {[any, string, any][]} */ ([
    [{ id: 'chat', kind: 'chat', name: 'Chat', named: false }, 'Chat', { abilityKind: 'chat' }],
    [{ id: 'chat-completions', kind: 'chat', name: 'Chat Completions', named: true }, 'Chat Completions', { ability: 'Chat Completions' }],
    [undefined, 'a', { ability: 'a' }],
  ])) {
    const words = `A's ${shown} has no working address. Give its address in Settings → Models.`;
    const type = chat({ type: 'addr-named' });
    const errors = [
      await callOnce({ type, endpoint: endpoint('addr-named', ''), ability, model: model(), key: null, request, registry: withType('a-named', type) }).catch((e) => e),
      await speechCall({ type: hear, endpoint: endpoint('addr-named-in', ''), ability, model: model(), key: null, audio, registry: withType('a-named-in', hear) }).catch((e) => e),
    ];
    for (const e of errors) assert.ok(e instanceof ProviderError && e.kind === 'bad-request' && e.said?.code === 'no-address' && e.message === words && explain(e) === words, words);
    const tested = await testModel({ type, endpoint: endpoint('addr-named', ''), ability, model: model(), key: null });
    assert.deepEqual([tested.ok, tested.steps[0].detail], [false, words], `Test: ${words}`);
    // The builder's own request, at a good address, to another host: the origin words, with the same ability name.
    const toOther = `A's ${shown} built a request to https://other.test, not its address https://speech.test. Check its tunables.`;
    const other = chat({ type: 'addr-away', build: () => ({ url: 'https://other.test/x', headers: {}, body: '{}' }) });
    const moved = [
      await callOnce({ type: other, endpoint: endpoint('addr-away', 'https://speech.test/v1'), ability, model: model(), key: null, request, registry: withType('a-away', other) }).catch((e) => e),
      await speechCall({ type: away, endpoint: endpoint('addr-away-in', 'https://speech.test/v1'), ability, model: model(), key: null, audio, registry: withType('a-away-in', away) }).catch((e) => e),
    ];
    for (const e of moved) assert.ok(e instanceof ProviderError && e.kind === 'bad-request' && e.message === toOther && explain(e) === toOther && e.said?.code === 'origin'
      && e.said.ability === said.ability && e.said.abilityKind === said.abilityKind, toOther);
  }
  // A photo's upload is a builder too: with such an address it is never asked.
  const store = createMemoryStore();
  const ws = new Workspace(store);
  await ensureBaseScopes(ws);
  const withUpload = chat({ type: 'addr-up', uploadRequest: (/** @type {any} */ c) => request1('uploadRequest', c), readUpload: (/** @type {any} */ j) => ({ id: j.id }), build: (/** @type {any} */ c) => request1('build', c) });
  const withPhoto = /** @type {any} */ ({ messages: [{ role: 'user', parts: [{ type: 'image', mediaType: 'image/webp', data: 'AAAA', hash: 'h1' }] }] });
  await assert.rejects(callOnce({ type: withUpload, endpoint: endpoint('addr-up', ''), model: { ...model(), input: ['text', 'image'] }, key: 'k', request: withPhoto, uploads: new Uploads(ws), registry: withType('a-up', withUpload) }), (e) => e instanceof ProviderError && e.kind === 'bad-request');
  assert.deepEqual(built, [], 'no builder of any type was called with an address that does not parse');
  // A request a builder made to another address, at a good one, keeps its own words (what the built-address check says): the address it built, not the typed one.
  const elsewhere = chat({ type: 'addr-else', build: () => ({ url: 'https://other.test/x', headers: {}, body: '{}' }) });
  await assert.rejects(callOnce({ type: elsewhere, endpoint: endpoint('addr-else', 'https://speech.test/v1'), model: model(), key: null, request, registry: withType('a-else', elsewhere) }),
    (e) => e instanceof ProviderError && e.kind === 'bad-request' && e.said?.code === 'origin' && /built a request to https:\/\/other\.test, not its address https:\/\/speech\.test/.test(e.message));
  // A builder whose address isn't one, at a good address (a relative path): the words say so and name the address it should have gone to, never the built text, which may hold a key.
  const relative = chat({ type: 'addr-rel', build: () => ({ url: '/v1/chat?key=sk-secret', headers: {}, body: '{}' }) });
  await assert.rejects(callOnce({ type: relative, endpoint: endpoint('addr-rel', 'https://speech.test/v1'), model: model(), key: null, request, registry: withType('a-rel', relative) }),
    (e) => e instanceof ProviderError && e.kind === 'bad-request' && e.said?.code === 'origin' && e.said.to === '' && explain(e) === "A's a built a request to an address that isn't one, not its address https://speech.test. Check its tunables." && !explain(e).includes('sk-secret'));
  // A builder that parses something of its own, at a good address, and gets it wrong: its bug, whatever words the engine gives.
  for (const [name, type, call] of kinds) {
    const bad = () => new URL('not an address');
    const buggy = { ...type, type: `${type.type}-bug`, build: bad, transcribeRequest: bad, speechRequest: bad };
    const registry = withType(`bug-${name}`, buggy);
    for (let n = 0; n < 3; n++) await assert.rejects(call(buggy, registry, 'https://speech.test/v1'), (e) => e instanceof ProviderError && e.kind === 'plugin', name);
    assert.deepEqual([counted(registry), registry.isDisabled(`bug-${name}`)], [3, true], `${name}: counted, and switched off at the third`);
  }
});

