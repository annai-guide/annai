// Opt-in: a few short sessions with the real Gemini Live API, with your own key (the Koe and Kokoro plan, K4). Never in CI.
//   GEMINI_KEY=… node --test test/live/gemini-live.test.js
// A spike result Google may change (proactive audio on v1alpha, SILENT scheduling) shows up here first.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { pcm16 } from '../../src/core/voice/pcm.js';
import { openLive } from '../../src/core/realtime/open.js';
import { activate } from '../../plugins-official/gemini-live/index.js';

const KEY = process.env.GEMINI_KEY ?? '';
const skip = KEY ? false : 'GEMINI_KEY is not set';
const MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-3.8-live';

/** @type {any} */
let TYPE = null;
activate({ providers: { register: (/** @type {any} */ x) => { TYPE = { ...x, pluginId: 'gemini-live' }; return () => {}; } }, helpers: { ProviderError, base64: { encode: toBase64, decode: fromBase64 } } });
const endpoint = { id: 'live/live', provider: 'live', ability: 'live', type: 'gemini-live', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', headers: {}, tunables: TYPE.tunables, extraBody: {} };
/** @type {any} */
const model = { id: 'live', provider: 'live', ability: 'live', name: MODEL, providerId: MODEL, input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: { input: 0.75, audioIn: 3, output: 4.5, audioOut: 12 }, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
const KOE = [
  'You are Koe, the voice of Shiori, a travel guide, talking with the user. Kokoro, your other half, looks things up.',
  'Answer at once, briefly, in one or two short sentences.',
  'Never state anything that changes (opening hours, prices, drive times, weather): say you are checking, and call tell_kokoro with the question.',
  'Text in <from_kokoro>…</from_kokoro> is a private note: use it in your own words, never mention notes or Kokoro. If it corrects you, correct yourself and apologise briefly.',
].join('\n');
const TELL = { name: 'tell_kokoro', description: 'Ask Kokoro, your other half, to look something up. Returns at once.', input: { type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'immediate'] } }, required: ['text'], additionalProperties: false } };
const PCM = (/** @type {number} */ rate) => ({ format: /** @type {const} */ ('pcm16'), rate });

/** Every session a test opened, closed after it, so a failed check never leaves a socket open. @type {any[]} */
const opened = [];
afterEach(() => { for (const s of opened.splice(0)) s.close(); });

/** A session, with every event kept, and its trace. @param {{ resume?: string, tools?: any[] }} [o] */
async function session(o = {}) {
  const store = createMemoryStore();
  const s = openLive({ type: TYPE, endpoint, model, key: KEY, tunables: { ...TYPE.tunables }, setup: { instructions: KOE, context: 'It is 11:40 on Saturday; the user is driving south on Highway 1 near Bixby Bridge.', tools: o.tools ?? [TELL], audioIn: PCM(16000), audioOut: PCM(24000), ...(o.resume ? { resume: o.resume } : {}) }, trace: modelTrace(store, SYS) });
  opened.push(s);
  /** @type {any[]} */
  const events = [];
  s.on((e) => events.push({ ...e, at: Date.now() }));
  await s.ready;
  /** The turns completed or cut off so far. */
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

test('Gemini Live: a typed turn is answered aloud, with its transcript, usage priced, and no key in the trace', { skip }, async () => {
  const t = await session({ tools: [] });
  t.s.text('Say OK.');
  const end = await t.turnAfter(0);
  assert.equal(end.end, 'complete');
  const audio = t.events.filter((e) => e.type === 'audio').reduce((n, e) => n + e.data.length, 0);
  assert.ok(audio > 4800, `${audio} bytes of 24 kHz audio`);
  assert.match(t.said(), /ok/i);
  const usage = t.events.find((e) => e.type === 'usage')?.usage;
  assert.ok(usage?.audioOut > 0, JSON.stringify(usage));
  assert.ok(t.s.handle, 'a resume handle came');
  t.s.close('done');
  await t.s.closed;
  const all = await t.store.tx(['events'], 'readonly', (x) => x.listEvents(SYS, {}));
  assert.ok(all.some((e) => e.type === 'net.request' && e.data.kind === 'realtime' && e.data.cost > 0));
  assert.ok(!JSON.stringify(all).includes(KEY), 'the key is in no trace entry');
  console.log(`  said "${t.said().trim()}"; ${audio} bytes; usage ${JSON.stringify(usage)}`);
});

test('Gemini Live: speech in with manual activity is heard and answered', { skip }, async () => {
  const t = await session({ tools: [] });
  const { pcm } = pcm16(new Uint8Array(await readFile(new URL('../fixtures/voice/where-lunch.wav', import.meta.url))));
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  t.s.activity('start');
  // The sentence, then the 0.7 s pause that ends it, as annai's microphone sends them.
  const all = new Uint8Array(bytes.length + 22_400);
  all.set(bytes);
  for (let i = 0; i < all.length; i += 3200) {
    t.s.audio(all.slice(i, i + 3200));
    await new Promise((r) => setTimeout(r, 100));
  }
  const cut = Date.now();
  t.s.activity('end');
  await t.turnAfter(0);
  await new Promise((r) => setTimeout(r, 1500)); // the last of the input transcript may come after the turn
  const heard = t.events.filter((e) => e.type === 'heard').map((e) => e.text).join('');
  assert.match(heard, /lunch/i);
  const first = t.events.find((e) => e.type === 'audio');
  assert.ok(first, 'it answered aloud');
  console.log(`  heard "${heard.trim()}"; said "${t.said().trim()}"; first audio ${first.at - cut} ms after activityEnd`);
  t.s.close();
});

test('Gemini Live: a live question calls tell_kokoro; answered "sent" with SILENT, no filler turn follows', { skip }, async () => {
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
  assert.equal(after.length, 0, `no filler after the silent answer; it said "${t.said(n)}"`);
  assert.doesNotMatch(t.said(), /\d{1,2}(:\d\d)?\s*(am|pm)/i, 'no hours stated');
  console.log(`  said "${t.said().trim()}"; asked Kokoro "${call.input.text}"`);
  t.s.close();
});

test('Gemini Live: an immediate note cuts Koe off mid-sentence, and the session resumes with its handle', { skip }, async () => {
  const t = await session({ tools: [] }); // a story it tells itself, never one it hands Kokoro
  t.s.text('Tell me the whole history of Bixby Bridge, in detail, slowly.');
  const start = Date.now();
  while (!t.events.some((e) => e.type === 'said')) {
    if (Date.now() - start > 30_000) throw new Error(`it never started talking: ${t.events.map((e) => e.type).join(' ')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const n = t.events.length;
  const sent = Date.now();
  t.s.text('<from_kokoro>Correction: Bixby Bridge opened in 1932; it is a concrete arch bridge, not steel.</from_kokoro>', { interrupt: true });
  const cut = await t.turnAfter(0);
  assert.equal(cut.end, 'interrupted', 'the note cut Koe off');
  console.log(`  interrupted ${cut.at - sent} ms after the note`);
  // The cut turn's own end, then the answer to the note, spoken in full.
  const m = t.events.length;
  await t.turnAfter(1, 30_000);
  const correction = t.said(m);
  console.log(`  then said "${correction.trim()}"`);
  if (process.env.DUMP) console.log(t.events.filter((e) => e.type !== 'audio').map((e) => `${e.type}${e.end ? `:${e.end}` : ''}${e.text ? ` "${e.text}"` : ''}`).join('\n'));
  assert.doesNotMatch(correction, /kokoro|note/i, 'the note is never named');
  const handle = t.s.handle;
  assert.ok(handle);
  t.s.close('drop');
  await t.s.closed;
  await new Promise((r) => setTimeout(r, 1500));
  const r = await session({ resume: handle, tools: [] });
  r.s.text('In three words: which landmark were we just talking about?');
  await r.turnAfter(0);
  console.log(`  resumed; said "${r.said().trim()}"`);
  if (process.env.DUMP) console.log(r.events.filter((e) => e.type !== 'audio').map((e) => `${e.type}${e.end ? `:${e.end}` : ''}${e.text ? ` "${e.text}"` : ''}`).join('\n'));
  assert.match(r.said(), /bixby|bridge/i, 'the resumed session remembers');
  r.s.close();
});
