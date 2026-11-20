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

/** The OpenAI-compatible voice type, activated in a shell that gives these helpers. @param {Record<string, any>} helpers */
function load(helpers) {
  /** @type {Record<string, any>} */
  const types = {};
  activate({ l10n: pluginWords(), providers: { register: (/** @type {any} */ t) => { types[t.type] = t; return () => {}; } }, helpers });
  return types['openai-speech'];
}
const say = load({ ProviderError, errorFromResponse, mergePatch, wav: { encode: encodeWav, decode: pcm16 } });
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
 * but pcm; asked for pcm, every voice answers raw audio in Fish Audio's pieces at Fish Audio's times (ms after the first; `fail`: the
 * connection drops after that many) under the Content-Type its vendor gives (or `type`): for HeyGen and Gemini that is a stand-in (the
 * probe saw nearly all of their bytes arrive at once), and the first piece comes at once, where Fish Audio's first byte took 460 ms.
 * Asked for mp3, a whole clip.
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
          // A longer answer repeats the probe's 120 pieces, each round 3000 ms after the last: one ends at 2398.3 ms, so the pieces stay in order.
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
/** What a call traced, in order. @param {any} store */
const traced = async (store) => (await store.tx(['events'], 'readonly', (/** @type {any} */ x) => x.listEvents(SYS, {}))).filter((/** @type {any} */ e) => e.type === 'net.request').map((/** @type {any} */ e) => e.data);
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
  const { pcm, bytes } = tone(4411);
  const cut = bytes.slice(0, -1); // an odd count of bytes, as one cut on the wire is: the last byte is half a sample
  assert.equal(cut.length % 2, 1);
  const clip = await say.readSpeech(new Response(cut, { headers: { 'content-type': probe.heygenPcm.contentType } }), spec('heygen/heygen-voice-1'));
  assert.equal(clip.mediaType, 'audio/wav');
  const back = pcm16(clip.data);
  assert.equal(back.rate, 44100, "at HeyGen's rate, from its Content-Type");
  assert.equal(firstDiff(back.pcm, pcm.subarray(0, 4410)), -1, 'every whole sample, the odd byte dropped');
  // Through a call: Gemini's 24 kHz, asked for raw audio straight away, so no 400 is spent.
  const or = openRouter({ samples: 2400 });
  const r = await speechCall({ type: say, endpoint: endpoint(), model: model('google/gemini-3.8-flash-tts'), key: null, text: 'Hello.', fetch: or.fetch });
  assert.equal(or.bodies.length, 1);
  assert.equal(or.bodies[0].response_format, 'pcm');
  assert.equal(r.clip?.mediaType, 'audio/wav');
  assert.equal(pcm16(/** @type {any} */ (r.clip).data).rate, 24000);
  assert.equal(firstDiff(pcm16(/** @type {any} */ (r.clip).data).pcm, tone(2400).pcm), -1);
  // A voice whose tunables say nothing of stream is not asked for raw audio (the switch is on only where it says so).
  const bare = { ...spec('fish-audio/s2.1-pro-free:free'), tunables: { voice: 'x', format: 'auto', audioOut: ['mp3'] } };
  assert.equal(JSON.parse(say.speechRequest({ ...bare, text: 'Hi.' }).body).response_format, 'mp3');
  // Without the description's prefixes (another server, or an older provider-openrouter), it is asked for MP3 and refuses, as before.
  const plain = await speechCall({ type: say, endpoint: endpoint({ pcmOnly: [] }), model: model('heygen/heygen-voice-1'), key: null, text: 'Hello.', fetch: or.fetch }).catch((e) => e);
  assert.ok(plain instanceof ProviderError && plain.kind === 'bad-request' && /only supports response_format/.test(plain.message), String(plain));
});

test('raw audio whose answer is not audio/pcm with one known rate (and, if it says, one channel) fails that voice, with the Content-Type as evidence: never a guess (RULES principle 9)', async (t) => {
  useClock(t);
  const { bytes } = tone(100);
  const heygen = spec('heygen/heygen-voice-1');
  const read = (/** @type {string | null} */ type) => say.readSpeech(new Response(bytes, type === null ? {} : { headers: { 'content-type': type } }), heygen);
  for (const ok of [probe.fishPcm.contentType, 'audio/pcm;rate=24000', 'AUDIO/PCM; channels=1; rate=16000']) {
    assert.equal((await read(ok)).mediaType, 'audio/wav', ok);
  }
  // A rate that isn't a plain count in our set, a second rate or channel, a channel count but one, a parameter that isn't ours (it may change
  // what the bytes are), and another name for raw audio (audio/L16 is big-endian): the whole clip and the stream's first piece both refuse them.
  const bad = ['audio/pcm', 'audio/pcm;channels=1', 'audio/pcm;rate=44.1k', 'audio/pcm;rate=', 'audio/pcm;rate=12345', 'audio/pcm;rate=-24000', 'audio/pcm;rate=44100;rate=24000',
    'audio/pcm;rate=44100;channels=2', 'audio/pcm;rate=44100;channels=1;channels=1', 'audio/pcm; rate = 44100', 'audio/pcm;rate=2.4e4', 'audio/pcm;rate=0x5dc0',
    'audio/pcm;rate=24000;encoding=f32le', 'audio/pcm;rate=48000;channels=1;foo=bar', 'audio/L16;rate=24000;channels=1', 'audio/l16;rate=24000', 'audio/x-pcm;rate=24000'];
  const rejected = (/** @type {string} */ type) => (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'server' && /raw audio \(PCM\) in a form annai can't play/.test(e.message) && e.message.includes(type.slice(0, 80));
  for (const type of bad) {
    await assert.rejects(read(type), rejected(type), `whole: ${type}`);
    await assert.rejects(say.readSpeechStream(new Response(bytes, { headers: { 'content-type': type } }), heygen)[Symbol.asyncIterator]().next(), rejected(type), `streamed: ${type}`);
  }
  // Asked for raw audio, an answer with no audio type can't be read either, rate or not; one in another audio format plays as it came.
  const named = (/** @type {string} */ type) => (/** @type {any} */ e) => e instanceof ProviderError && e.kind === 'server' && e.message.includes(`"${type}", not the raw audio (PCM) annai asked for`);
  await assert.rejects(read('application/octet-stream'), named('application/octet-stream'));
  await assert.rejects(read('application/octet-stream;rate=24000'), named('application/octet-stream;rate=24000'));
  await assert.rejects(read(null), (e) => e instanceof ProviderError && e.kind === 'server' && /no content type, not the raw audio/.test(e.message));
  assert.equal((await read('audio/mpeg')).mediaType, 'audio/mpeg');
  // A streamed ask answered with anything but raw audio (a server that ignored it) fails that voice, and its unread answer is let go.
  for (const type of ['audio/mpeg', 'audio/wav', 'application/json']) {
    let cancelled = false;
    const unread = new Response(new ReadableStream({ pull: (ctl) => ctl.enqueue(bytes), cancel: () => { cancelled = true; } }), { headers: { 'content-type': type } });
    await assert.rejects(say.readSpeechStream(unread, heygen)[Symbol.asyncIterator]().next(), named(type), type);
    await tick();
    assert.ok(cancelled, `${type}: the connection is let go, not left to be collected`);
  }
  // Through a call: the failure is the voice's (the server's), so the next voice speaks; nothing is paid for.
  const store = createMemoryStore();
  const or = openRouter({ type: 'audio/pcm;channels=1' });
  await assert.rejects(speechCall({ type: say, endpoint: endpoint(), model: model('heygen/heygen-voice-1'), key: null, text: 'Hi.', fetch: or.fetch, trace: modelTrace(store, SYS) }),
    (e) => e instanceof ProviderError && e.kind === 'server' && e.message.includes('audio/pcm;channels=1'));
  const [req, ...more] = await traced(store);
  assert.equal(more.length, 0, 'traced once');
  assert.equal(req.outcome, 'server');
  assert.equal(req.cost, undefined);
});

test('a shell without the WAV helper (annai not yet restarted after an update) refuses a request for raw audio before sending it, in words that say what to do; MP3 voices speak on', async () => {
  const old = load({ ProviderError, errorFromResponse, mergePatch });
  assert.throws(() => old.speechRequest({ ...spec('heygen/heygen-voice-1'), text: 'Hi.' }), /needs a newer annai for raw audio: restart annai to update it/);
  assert.throws(() => old.speechRequest({ ...spec('fish-audio/s2.1-pro-free:free', { stream: true }), text: 'Hi.' }), /needs a newer annai/);
  assert.equal(JSON.parse(old.speechRequest({ ...spec('fish-audio/s2.1-pro-free:free'), text: 'Hi.' }).body).response_format, 'mp3');
});

test("Fish Audio's voice streams with the voice page's Stream switch on, at the rate its answer names; off (its default), it is asked for MP3 whole, as before", async (t) => {
  useClock(t);
  const fish = model('fish-audio/s2.1-pro-free:free');
  assert.equal(say.tunables.stream, false, 'no OpenAI-compatible voice streams unless its page turns it on');
  assert.equal(typeof say.choices.stream.label, 'string');
  assert.equal(router.tunables.stream, false, 'OpenRouter names it, so its page shows the switch, off');
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
  const [req, ...more] = await traced(store);
  assert.equal(more.length, 0, 'a stream is traced once (the budget sums every request)');
  assert.equal(req.outcome, 'ok');
  assert.equal(req.format, 'streamed PCM at 44.1 kHz');
  // Gemini's voice through OpenRouter answers at 24 kHz: the stream plays at the rate its own answer names, not Fish Audio's.
  const gemini = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: model('google/gemini-3.8-flash-lite-tts'), key: null, text: 'Hi.', fetch: openRouter({ samples: 2 * 24000 }).fetch, stream: true });
  assert.equal(gemini.stream?.rate, 24000);
  assert.equal(firstDiff(await drain(/** @type {any} */ (gemini.stream).chunks), tone(2 * 24000).pcm), -1);
  // On, before a tap has unlocked sound (the caller can't play a stream): the same raw audio, whole, as a WAV clip.
  const early = openRouter({ samples: 4410 });
  const clip = await speechCall({ type: say, endpoint: endpoint({ stream: true }), model: fish, key: null, text: 'Hello there.', fetch: early.fetch });
  assert.equal(early.bodies[0].response_format, 'pcm');
  assert.equal(clip.clip?.mediaType, 'audio/wav');
  assert.equal(pcm16(/** @type {any} */ (clip.clip).data).rate, 44100);
  assert.equal(firstDiff(pcm16(/** @type {any} */ (clip.clip).data).pcm, tone(4410).pcm), -1, 'every sample of it');
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
  const [req, ...more] = await traced(store);
  assert.equal(more.length, 0, 'a stream is traced once, however it ends');
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
      // Fish Audio drops after 30 pieces (about 0.55 s in, some 1.1 s of sound, after it started playing); the next voice sends all of it.
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
  assert.ok(/** @type {number} */ (p.streams[0].playedMs) > 0, 'some of it had played');
  assert.equal(done.said, 1);
  assert.deepEqual(done.voices, ['Fish Audio', 'Next voice']);
});
