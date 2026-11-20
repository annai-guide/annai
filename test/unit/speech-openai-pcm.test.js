import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activate } from '../../plugins-official/speech-openai/index.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { mergePatch } from '../../src/core/patch.js';
import { encodeWav, pcm16 } from '../../src/core/voice/pcm.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { Speaker } from '../../src/core/voice/speaker.js';
import { SYS } from '../../src/core/scopes.js';
import { createMemoryStore } from '../fakes/store-memory.js';
import { fakePlatform } from './voice-fakes.js';
import { pluginWords } from './l10n-kit.js';
import { useClock } from './clock.js';

// Raw audio from the OpenAI-compatible voice (stream-voice-next): OpenRouter's voices that answer only PCM (HeyGen's, Gemini's) are
// asked for it and played as WAV, and Fish Audio's streams with the voice page's Stream switch on, always at the rate the answer
// names. The answers are shaped as OpenRouter's were in the voice probe of 2026-11-19 (test/fixtures/voices/openrouter-pcm-probe.json:
// their Content-Types, error bodies, and Fish Audio's network pieces, odd sizes among them, with their times).

/** @type {Record<string, any>} */
const types = {};
activate({ l10n: pluginWords(), providers: { register: (/** @type {any} */ t) => { types[t.type] = t; return () => {}; } },
  helpers: { ProviderError, errorFromResponse, mergePatch, wav: { encode: encodeWav, decode: pcm16 } } });
const say = types['openai-speech'];
const probe = JSON.parse(await readFile(new URL('../fixtures/voices/openrouter-pcm-probe.json', import.meta.url), 'utf8'));
/** OpenRouter's voice ability and its models, as provider-openrouter describes them. */
const router = JSON.parse(await readFile(new URL('../../plugins-official/provider-openrouter/annai-plugin.json', import.meta.url), 'utf8')).provider.abilities.voice;
const described = (/** @type {string} */ id) => router.models.find((/** @type {any} */ m) => m.providerId === id) ?? { providerId: id };

/** OpenRouter's voice ability (its Stream switch on with stream: true), as a call gets it. @param {Record<string, any>} [ability] */
const endpoint = (ability = {}) => ({ id: 'pv-or/voice', provider: 'pv-or', ability: 'voice', type: say.type, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', headers: {},
  tunables: { ...say.tunables, ...router.tunables, ...ability }, extraBody: {} });
/** One of its voices: described, or added by id or from the list (no tunables of its own). @param {string} id */
const model = (id) => /** @type {any} */ ({ id: `m-${id}`, provider: 'pv-or', ability: 'voice', name: id, providerId: id, prices: { perMillionChars: 0 }, tunables: described(id).tunables ?? {}, extraBody: {} });
/** What speechRequest is given for that voice. @param {string} id @param {Record<string, any>} [ability] */
const spec = (id, ability = {}) => { const e = endpoint(ability); const m = model(id); return { endpoint: e, model: m, key: 'sk-or-test', tunables: { ...e.tunables, ...m.tunables } }; };
const asked = (/** @type {string} */ id, /** @type {Record<string, any>} */ ability = {}) => JSON.parse(say.speechRequest({ ...spec(id, ability), text: 'Hi.' }).body).response_format;

/** n samples of a tone, and the same as 16-bit little-endian bytes, as a voice sends them. @param {number} n */
function tone(n) {
  const pcm = Int16Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin(i / 7)) - (i % 3));
  const bytes = new Uint8Array(n * 2);
  const dv = new DataView(bytes.buffer);
  pcm.forEach((x, i) => dv.setInt16(i * 2, x, true));
  return { pcm, bytes };
}
/** Bytes cut where Fish Audio's answer was cut on the network (the probe's piece sizes, over and over). @param {Uint8Array} bytes @returns {Uint8Array[]} */
function cutAsFish(bytes) {
  const out = [];
  for (let at = 0, i = 0; at < bytes.length; i++) {
    const n = probe.fishPcm.pieces[i % probe.fishPcm.pieces.length][1];
    out.push(bytes.slice(at, (at += n)));
  }
  return out;
}
const tick = (/** @type {number} */ ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenRouter's voice endpoint as the probe found it: a PCM-only voice (HeyGen's, Gemini's) answers a 400 with its own words to anything
 * but pcm; asked for pcm, any voice answers raw audio in Fish Audio's pieces at the probe's times (ms after the first; `fail`: the
 * connection drops after that many), under the Content-Type its vendor gives (or `type`); asked for mp3, a whole clip.
 * @param {{ samples?: number, type?: string, fail?: number }} [o]
 */
function openRouter({ samples = 44100, type, fail } = {}) {
  /** @type {any[]} */
  const bodies = [];
  const { bytes } = tone(samples);
  const fetch = async (/** @type {string} */ _url, /** @type {RequestInit} */ init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const pcmOnly = /^heygen\//.test(body.model) ? probe.heygenMp3Refused : /^google\//.test(body.model) ? probe.geminiMp3Refused : null;
    if (pcmOnly && body.response_format !== 'pcm') return new Response(pcmOnly.body, { status: pcmOnly.status, headers: { 'content-type': pcmOnly.contentType } });
    if (body.response_format !== 'pcm') return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { 'content-type': probe.fishMp3.contentType } });
    const header = type ?? (/^google\//.test(body.model) ? probe.geminiPcm.contentType : /^heygen\//.test(body.model) ? probe.heygenPcm.contentType : probe.fishPcm.contentType);
    const signal = init.signal;
    const t0 = Date.now();
    const pieces = cutAsFish(bytes);
    const stream = new ReadableStream({
      async start(ctl) {
        signal?.addEventListener('abort', () => { try { ctl.error(signal.reason); } catch { /* closed */ } }, { once: true });
        for (const [i, piece] of pieces.entries()) {
          await tick(Math.max(0, t0 + probe.fishPcm.pieces[i % probe.fishPcm.pieces.length][0] + 3000 * Math.floor(i / probe.fishPcm.pieces.length) - Date.now()));
          if (signal?.aborted) return;
          if (i === fail) return void ctl.error(new TypeError('terminated'));
          ctl.enqueue(piece);
        }
        ctl.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': header } });
  };
  return { fetch, bodies };
}
/**
 * Where two runs of samples first differ (their length's end, when one is longer), or -1: compared this way, not with assert's equal, whose
 * message for a large array or clip runs out of memory (Node 26.13.1: 1 GB was not enough for one 264 KB clip). @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
function firstDiff(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : Math.min(a.length, b.length);
}
/** All of a stream's samples, in one. @param {AsyncIterable<Int16Array>} chunks */
async function drain(chunks) {
  const got = [];
  for await (const pcm of chunks) got.push(...pcm);
  return Int16Array.from(got);
}

test("a voice that answers only raw audio (OpenRouter's HeyGen and Gemini voices: a 400 for mp3 and for wav, the probe) is asked for it and plays as a WAV clip at the rate its answer names", async () => {
  assert.deepEqual(router.tunables.pcmOnly, ['heygen/', 'google/'], "provider-openrouter names them by their ids' start: any of theirs, from the list or added by id");
  assert.equal(asked('heygen/heygen-voice-1'), 'pcm');
  assert.equal(asked('google/gemini-3.8-flash-lite-tts'), 'pcm');
  for (const id of ['fish-audio/s2.1-pro-free:free', 'x-ai/grok-voice-tts-1.0', 'mistralai/voxtral-mini-tts-2603', 'hexgrad/kokoro-82m', 'openai/gpt-4o-mini-tts']) assert.equal(asked(id), 'mp3', `${id}: MP3, as before`);
  const { pcm, bytes } = tone(4411); // an odd count of bytes over the network pieces: the last byte has no sample, as on the wire
  const clip = await say.readSpeech(new Response(bytes, { headers: { 'content-type': probe.heygenPcm.contentType } }), spec('heygen/heygen-voice-1'));
  assert.equal(clip.mediaType, 'audio/wav');
  const back = pcm16(clip.data);
  assert.equal(back.rate, 44100, "at HeyGen's rate, from its Content-Type");
  assert.equal(firstDiff(back.pcm, pcm), -1);
  // Through a call: Gemini's 24 kHz, asked for raw audio straight away, so no 400 is spent.
  const or = openRouter({ samples: 2400 });
  const r = await speechCall({ type: say, endpoint: endpoint(), model: model('google/gemini-3.8-flash-tts'), key: null, text: 'Hello.', fetch: or.fetch, plays: ['mp3', 'wav'] });
  assert.equal(or.bodies.length, 1);
  assert.equal(or.bodies[0].response_format, 'pcm');
  assert.equal(r.clip?.mediaType, 'audio/wav');
  assert.equal(pcm16(/** @type {any} */ (r.clip).data).rate, 24000);
  assert.equal(firstDiff(pcm16(/** @type {any} */ (r.clip).data).pcm, tone(2400).pcm), -1);
  // Without the description's prefixes (another server, or an older provider-openrouter), it is asked for MP3 and refuses, as before.
  const plain = await speechCall({ type: say, endpoint: endpoint({ pcmOnly: [] }), model: model('heygen/heygen-voice-1'), key: null, text: 'Hello.', fetch: or.fetch }).catch((e) => e);
  assert.ok(plain instanceof ProviderError && plain.kind === 'bad-request' && /only supports response_format/.test(plain.message), String(plain));
});

test('raw audio whose answer names no rate, or one outside our rule, fails that voice, with the Content-Type as evidence: never a guess (RULES principle 9)', async (t) => {
  useClock(t);
  const { bytes } = tone(100);
  const heygen = spec('heygen/heygen-voice-1');
  const read = (/** @type {string | null} */ type) => say.readSpeech(new Response(bytes, type === null ? {} : { headers: { 'content-type': type } }), heygen);
  for (const ok of [probe.fishPcm.contentType, 'audio/pcm;rate=24000', 'AUDIO/PCM; channels=1; rate=16000', 'audio/pcm;rate=48000;channels=1;foo=bar']) {
    assert.equal((await read(ok)).mediaType, 'audio/wav', ok);
  }
  for (const bad of ['audio/pcm', 'audio/pcm;channels=1', 'audio/pcm;rate=44.1k', 'audio/pcm;rate=', 'audio/pcm;rate=12345', 'audio/pcm;rate=-24000', 'audio/pcm;rate=44100;rate=24000',
    'audio/pcm;rate=44100;channels=2', 'audio/pcm;rate=44100;channels=1;channels=1', 'audio/pcm; rate = 44100']) {
    await assert.rejects(read(bad), (e) => e instanceof ProviderError && e.kind === 'server' && /no rate annai can play it at/.test(e.message) && e.message.includes(bad.slice(0, 80)), bad);
  }
  // Asked for raw audio, an answer with no audio type can't be read either; one in another audio format plays as it came.
  await assert.rejects(read('application/octet-stream'), (e) => e instanceof ProviderError && e.kind === 'server' && /"application\/octet-stream", not the raw audio/.test(e.message));
  await assert.rejects(read(null), (e) => e instanceof ProviderError && e.kind === 'server');
  assert.equal((await read('audio/mpeg')).mediaType, 'audio/mpeg');
  // Streamed, the same rule, at its first piece.
  const first = (/** @type {string} */ type) => say.readSpeechStream(new Response(bytes, { headers: { 'content-type': type } }), heygen)[Symbol.asyncIterator]().next();
  await assert.rejects(first('audio/pcm'), (e) => e instanceof ProviderError && e.kind === 'server');
  await assert.rejects(first('audio/pcm;rate=96000'), (e) => e instanceof ProviderError && e.kind === 'server');
  // Through a call: the failure is the voice's (the server's), so the next voice speaks; nothing is played or paid for.
  const store = createMemoryStore();
  const or = openRouter({ type: 'audio/pcm;channels=1' });
  await assert.rejects(speechCall({ type: say, endpoint: endpoint(), model: model('heygen/heygen-voice-1'), key: null, text: 'Hi.', fetch: or.fetch, trace: modelTrace(store, SYS) }),
    (e) => e instanceof ProviderError && e.kind === 'server');
  const [req] = (await store.tx(['events'], 'readonly', (/** @type {any} */ t) => t.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
  assert.equal(req.outcome, 'server');
  assert.equal(req.cost, undefined);
});

test("Fish Audio's voice streams with the voice page's Stream switch on, at the rate its answer names; off (its default), it is asked for MP3 whole, as before", async (t) => {
  useClock(t);
  const fish = model('fish-audio/s2.1-pro-free:free');
  assert.equal(say.tunables.stream, false, 'no OpenAI-compatible voice streams unless its page turns it on');
  assert.equal(typeof say.choices.stream.label, 'string');
  assert.equal(router.tunables.stream, false, 'OpenRouter names it, so its page shows the switch, off (chief\'s decision C135)');
  // Off: MP3, a whole clip, even where the player could stream.
  const off = openRouter();
  const whole = await speechCall({ type: say, endpoint: endpoint(), model: fish, key: null, text: 'Hello there.', fetch: off.fetch, stream: true });
  assert.equal(off.bodies[0].response_format, 'mp3');
  assert.ok(!whole.stream, 'not streamed');
  assert.equal(whole.clip?.mediaType, 'audio/mpeg');
  // On: raw audio, read as it comes in Fish Audio's pieces (30 of the 120 the probe saw end mid-sample), at 44.1 kHz.
  const store = createMemoryStore();
  const on = openRouter({ samples: 3 * 44100 });
  const r = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hello there.', fetch: on.fetch, stream: true, trace: modelTrace(store, SYS) });
  assert.equal(on.bodies[0].response_format, 'pcm');
  assert.ok(!r.clip, 'not a whole clip');
  assert.equal(r.stream?.rate, 44100);
  assert.equal(firstDiff(await drain(/** @type {any} */ (r.stream).chunks), tone(3 * 44100).pcm), -1, 'every sample, in order, the odd bytes carried across pieces');
  const [req] = (await store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
  assert.equal(req.outcome, 'ok');
  assert.equal(req.format, 'streamed PCM at 44.1 kHz');
  // On, before a tap has unlocked sound (the caller can't play a stream): the same raw audio, whole, as a WAV clip.
  const early = openRouter({ samples: 4410 });
  const clip = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hello there.', fetch: early.fetch });
  assert.equal(early.bodies[0].response_format, 'pcm');
  assert.equal(clip.clip?.mediaType, 'audio/wav');
  assert.equal(pcm16(/** @type {any} */ (clip.clip).data).rate, 44100);
  // The voices the probe found gaining little stay whole with it on: provider-openrouter says stream: false on each.
  for (const id of ['x-ai/grok-voice-tts-1.0', 'mistralai/voxtral-mini-tts-2603', 'hexgrad/kokoro-82m']) {
    const or = openRouter();
    const got = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: model(id), key: null, text: 'Hi.', fetch: or.fetch, stream: true });
    assert.equal(or.bodies[0].response_format, 'mp3', id);
    assert.ok(!got.stream, id);
  }
});

test('a server that ignores the ask for raw audio fails a streamed voice; a stream cut partway is a network failure, not the plugin\'s', async (t) => {
  useClock(t);
  const fish = model('fish-audio/s2.1-pro-free:free');
  await assert.rejects(speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hi.', stream: true, fetch: openRouter({ type: probe.fishMp3.contentType }).fetch }),
    (e) => e instanceof ProviderError && e.kind === 'server' && /"audio\/mpeg", not the raw audio \(PCM\) annai asked for/.test(e.message));
  const store = createMemoryStore();
  const r = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hi.', stream: true, fetch: openRouter({ samples: 2 * 44100, fail: 30 }).fetch, trace: modelTrace(store, SYS) });
  await assert.rejects(drain(/** @type {any} */ (r.stream).chunks), (e) => e instanceof ProviderError && e.kind === 'network');
  const [req] = (await store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
  assert.equal(req.outcome, 'network');
  assert.equal(req.cost, undefined, 'paid for once, by the voice that says it');
  // Whole, too: a clip cut partway is the network's.
  await assert.rejects(speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hi.', fetch: openRouter({ fail: 3 }).fetch }), (e) => e instanceof ProviderError && e.kind === 'network');
});

test("Fish Audio's stream cut partway: its player stream stops, the voice is benched, and the same sentence goes to the next voice (as Gemini's)", async (t) => {
  useClock(t);
  const p = fakePlatform();
  /** @type {{ id: string, kind: string }[]} */
  const benched = [];
  /** @type {string[]} */
  const said = [];
  const speaker = new Speaker({
    entries: async () => [{ id: 'fish', name: 'Fish Audio', kind: /** @type {const} */ ('api') }, { id: 'next', name: 'Next voice', kind: /** @type {const} */ ('api') }].filter((e) => !benched.some((b) => b.id === e.id)),
    bench: (id, e) => { benched.push({ id, kind: /** @type {any} */ (e)?.kind }); }, platform: () => /** @type {any} */ (p), locale: 'en',
    synthesize: async (entry, text, signal) => {
      said.push(`${entry.id}: ${text}`);
      // Fish Audio drops after 30 pieces (about 0.55 s in, some 1.3 s of sound, after it started playing); the next voice sends all of it.
      const r = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: model('fish-audio/s2.1-pro-free:free'), key: null, text, stream: true, signal,
        fetch: openRouter({ samples: 2 * 44100, ...(entry.id === 'fish' ? { fail: 30 } : {}) }).fetch });
      return /** @type {any} */ (r.stream ?? r.clip);
    },
  });
  const u = speaker.begin();
  u.end('Bixby Bridge is two miles ahead.');
  const done = await u.done;
  assert.deepEqual(said, ['fish: Bixby Bridge is two miles ahead.', 'next: Bixby Bridge is two miles ahead.']);
  assert.deepEqual(benched, [{ id: 'fish', kind: 'network' }]);
  assert.deepEqual(p.streams.map((s) => [s.rate, s.stopped, s.ended]), [[44100, true, false], [44100, false, true]], "Fish Audio's stream played, then stopped; the next voice's played to its end");
  assert.ok(p.streams[0].ms > 0, 'some of it had played');
  assert.equal(done.said, 1);
  assert.deepEqual(done.voices, ['Fish Audio', 'Next voice']);
});
