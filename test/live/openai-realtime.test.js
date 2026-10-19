// Opt-in: a few short sessions with the real OpenAI Realtime API, with your own key (the Koe and Kokoro plan, K6). Never in CI.
//   OPENAI_KEY=… node --test test/live/openai-realtime.test.js
// OPENAI_REALTIME_MODEL picks the model (gpt-realtime-2.1-mini by default, the cheaper); OPENAI_REALTIME_URL another address.
// The first test is the open question: whether OpenAI takes a standard key from a browser, as the subprotocol
// openai-insecure-api-key.<key>, with a browser's Origin. Its docs show only short-lived keys there.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { pcm16, resample } from '../../src/core/voice/pcm.js';
import { openLive, testLive } from '../../src/core/realtime/open.js';
import { activate } from '../../plugins-official/openai-realtime/index.js';

const KEY = process.env.OPENAI_KEY ?? '';
const skip = KEY ? false : 'OPENAI_KEY is not set';
const MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1-mini';

/** @type {any} */
let TYPE = null;
/** @type {any[]} */
const notes = [];
activate({
  providers: { register: (/** @type {any} */ x) => { TYPE = { ...x, pluginId: 'openai-realtime' }; return () => {}; } },
  helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 } },
  events: { append: async (/** @type {string} */ _s, /** @type {string} */ type, /** @type {any} */ data) => { notes.push([type, data]); } },
});
const endpoint = { id: 'live/realtime', provider: 'live', ability: 'realtime', type: 'openai-realtime', name: 'OpenAI', baseUrl: process.env.OPENAI_REALTIME_URL ?? 'https://api.openai.com/v1', headers: {}, tunables: TYPE.tunables, extraBody: {} };
/** @type {any} */
const model = { id: 'live', provider: 'live', ability: 'realtime', name: MODEL, providerId: MODEL, input: ['text', 'image'], tools: true, contextWindow: 128000, maxOutput: 32000,
  prices: MODEL.endsWith('mini') ? { input: 0.6, cacheRead: 0.06, audioIn: 10, cacheReadAudio: 0.3, image: 0.8, cacheReadImage: 0.08, output: 2.4, audioOut: 20 } : { input: 4, cacheRead: 0.4, audioIn: 32, cacheReadAudio: 0.4, image: 5, cacheReadImage: 0.5, output: 24, audioOut: 64 },
  cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
const KOE = [
  'You are Koe, the voice of Shiori, a travel guide, talking with the user. Kokoro, your other half, looks things up.',
  'Answer at once, briefly, in one or two short sentences.',
  'Never state anything that changes (opening hours, prices, drive times, weather): say you are checking, and call tell_kokoro with the question.',
  'Text in <from_kokoro>…</from_kokoro> is a private note: use it in your own words, never mention notes or Kokoro. If it corrects you, correct yourself and apologise briefly.',
].join('\n');
const TELL = { name: 'tell_kokoro', description: 'Ask Kokoro, your other half, to look something up. Returns at once.', input: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'immediate'] } }, required: ['text'], additionalProperties: false } };
/** A browser's WebSocket, as near as Node's comes: the subprotocols, and annai's Origin. @param {string} url @param {string[]} protocols */
const socket = (url, protocols) => new WebSocket(url, /** @type {any} */ ({ protocols, headers: { origin: 'https://annai.guide' } }));

/** Every session a test opened, closed after it, so a failed check never leaves a socket open. @type {any[]} */
const opened = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); });

/** A session, with every event kept, and its trace. @param {{ tools?: any[], tunables?: Record<string, any> }} [o] */
async function session(o = {}) {
  const store = createMemoryStore();
  const s = openLive({ type: TYPE, endpoint, model, key: KEY, tunables: { ...TYPE.tunables, ...o.tunables }, socket,
    setup: { instructions: KOE, context: 'It is 11:40 on Saturday; the user is driving south on Highway 1 near Bixby Bridge.', tools: o.tools ?? [TELL] }, trace: modelTrace(store, SYS) });
  opened.push(s);
  /** @type {any[]} */
  const events = [];
  s.on((e) => events.push({ ...e, at: Date.now() }));
  await s.ready;
  const ends = () => events.filter((e) => e.type === 'turn');
  /** Waits for a turn to end after n ended. @param {number} n */
  const turnAfter = async (n, ms = 30_000) => {
    const end = Date.now() + ms;
    while (ends().length <= n) {
      if (Date.now() > end) throw new Error(`no turn ended in ${ms} ms: ${events.map((e) => e.type).join(' ')}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return ends()[n];
  };
  const said = (/** @type {number} */ from = 0) => events.slice(from).filter((e) => e.type === 'said').map((e) => e.text).join('');
  return { s, store, events, ends, turnAfter, said };
}

/** The where-lunch clip, at a rate, as 16-bit PCM bytes, with the 0.7 s pause that ends it. @param {number} rate */
async function clip(rate) {
  const { pcm } = pcm16(new Uint8Array(await readFile(new URL('../fixtures/voice/where-lunch.wav', import.meta.url))));
  const at = resample(Float32Array.from(pcm, (v) => v / 32768), 16_000, rate);
  const out = new Int16Array(at.length + Math.round(rate * 0.7));
  out.set(Int16Array.from(at, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767)));
  return new Uint8Array(out.buffer);
}

test('OpenAI Realtime: a standard key, given as a browser gives it, opens a session (the first device-check question)', { skip }, async () => {
  try {
    const t = await session({ tools: [] });
    console.log(`  ready: ${MODEL} took the key from a browser-style connection`);
    t.s.close();
  } catch (e) {
    const err = /** @type {any} */ (e);
    assert.fail(`OpenAI refused the session (${err.kind}: ${err.message}). If the key works for chat, OpenAI refuses standard keys from browsers: its realtime voice needs a short-lived token from a server, which annai doesn't have.`);
  }
});

test('OpenAI Realtime: a typed turn is answered aloud, with its transcript, usage priced, and no key in the trace', { skip }, async () => {
  const t = await session({ tools: [] });
  t.s.text('Say OK.');
  const end = await t.turnAfter(0);
  assert.equal(end.end, 'complete');
  const audio = t.events.filter((e) => e.type === 'audio').reduce((n, e) => n + e.data.length, 0);
  assert.ok(audio > 4800, `${audio} bytes of 24 kHz audio`);
  assert.match(t.said(), /ok/i);
  const usage = t.events.find((e) => e.type === 'usage')?.usage;
  assert.ok(usage?.audioOut > 0, JSON.stringify(usage));
  t.s.close('done');
  await t.s.closed;
  const all = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(SYS, {}));
  assert.ok(all.some((e) => e.type === 'net.request' && e.data.kind === 'realtime' && e.data.cost > 0));
  assert.ok(!JSON.stringify(all).includes(KEY), 'the key is in no trace entry');
  console.log(`  said "${t.said().trim()}"; ${audio} bytes; usage ${JSON.stringify(usage)}`);
});

for (const [input, rate] of /** @type {const} */ ([['pcmu', 8000], ['pcm16', 24_000]])) {
  test(`OpenAI Realtime: speech in as ${input} at ${rate / 1000} kHz, committed at annai's cut, is heard and answered`, { skip }, async () => {
    const t = await session({ tools: [], tunables: { input } });
    assert.equal(t.s.audioIn.rate, rate);
    const bytes = await clip(rate);
    const chunk = rate / 5; // 100 ms of 16-bit samples
    t.s.activity('start');
    for (let i = 0; i < bytes.length; i += chunk) {
      t.s.audio(bytes.slice(i, i + chunk));
      await new Promise((r) => setTimeout(r, 100));
    }
    const cut = Date.now();
    t.s.activity('end');
    await t.turnAfter(0);
    await new Promise((r) => setTimeout(r, 1500)); // the input transcript may come after the answer
    const heard = t.events.filter((e) => e.type === 'heard').map((e) => e.text).join('');
    const first = t.events.find((e) => e.type === 'audio');
    console.log(`  ${input}: heard "${heard.trim()}"; said "${t.said().trim()}"; first audio ${first ? first.at - cut : '–'} ms after the cut; sent ${t.s.bytes.out} bytes`);
    assert.match(heard, /lunch/i);
    assert.ok(first, 'it answered aloud');
    t.s.close();
  });
}

test('OpenAI Realtime: a live question calls tell_kokoro; answered "sent" silently, no response follows', { skip }, async () => {
  const t = await session();
  t.s.text('Is the restaurant Nepenthe in Big Sur open right now?');
  const start = Date.now();
  while (!t.events.some((e) => e.type === 'tool')) {
    if (Date.now() - start > 30_000) throw new Error(`no tool call: said "${t.said()}"`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const call = t.events.find((e) => e.type === 'tool');
  assert.equal(call.name, 'tell_kokoro');
  t.s.answer(call.id, call.name, 'sent', { silent: true });
  await t.turnAfter(0);
  const n = t.events.length;
  await new Promise((r) => setTimeout(r, 6000));
  const after = t.events.slice(n).filter((e) => e.type === 'said' || e.type === 'audio');
  assert.equal(after.length, 0, `nothing after the silent answer; it said "${t.said(n)}"`);
  assert.doesNotMatch(t.said(), /\d{1,2}(:\d\d)?\s*(am|pm)/i, 'no hours stated');
  console.log(`  said "${t.said().trim()}"; asked Kokoro "${call.input.text}"`);
  t.s.close();
});

test('OpenAI Realtime: an immediate note cancels and truncates Koe mid-sentence, and she corrects herself without naming the note', { skip }, async () => {
  const t = await session({ tools: [] });
  t.s.text('Tell me the whole history of Bixby Bridge, in detail, slowly.');
  const start = Date.now();
  while (!t.events.some((e) => e.type === 'audio')) {
    if (Date.now() - start > 30_000) throw new Error(`it never started talking: ${t.events.map((e) => e.type).join(' ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 1500));
  t.s.text('<from_kokoro>Correction: Bixby Bridge opened in 1932; it is a concrete arch bridge, not steel.</from_kokoro>', { interrupt: true });
  const cut = await t.turnAfter(0);
  assert.equal(cut.end, 'interrupted');
  const m = t.events.length;
  await t.turnAfter(1, 30_000);
  const correction = t.said(m);
  console.log(`  then said "${correction.trim()}"`);
  assert.doesNotMatch(correction, /kokoro|note/i, 'the note is never named');
  assert.deepEqual(notes.filter(([type]) => type === 'live.error'), [], 'OpenAI took the cancel and the truncate');
  t.s.close();
});

test("OpenAI Realtime: a realtime model's Test passes against the real model", { skip }, async () => {
  const s = openLive({ type: TYPE, endpoint, model, key: KEY, tunables: { ...TYPE.tunables }, socket, setup: { instructions: 'This is a connection test. Answer in a word or two.', context: '', tools: [] }, trace: null });
  opened.push(s);
  let bytes = 0;
  const r = await testLive(s, { onAudio: (d) => { bytes += d.length; } });
  console.log(`  ${r.steps.map((x) => `${x.ok ? '✓' : '✗'} ${x.detail}`).join(' ')} (${bytes} bytes)`);
  assert.ok(r.ok);
});
