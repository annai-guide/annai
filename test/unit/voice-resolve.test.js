import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeardMemory, listenKind, resolveSpeech, textVersion, audioFor, NOT_TRANSCRIBED } from '../../src/core/voice/resolve.js';
import { Voice, audioIn } from '../../src/core/voice/voice.js';
import { Registry } from '../../src/core/registry.js';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { Workspace } from '../../src/core/workspace.js';
import { makeSchemaFor } from '../../src/core/schema.js';
import { kindOf, ensureBaseScopes } from '../../src/core/scopes.js';
import { encodeWav } from '../../src/core/voice/pcm.js';
import { fakePlatform, fakeLlm } from './voice-fakes.js';
import { clip, quiet, cat } from './voice-kit.js';

const enc = new TextEncoder();
/** @param {string} name @param {string[]} input */
const model = (name, input) => ({ name, input });
/** @param {string} id @param {any} [more] @returns {any} */
const segment = (id, more = {}) => ({ id, source: 'mic', audio: { data: enc.encode(`RIFF-${id}`), mediaType: 'audio/wav', seconds: 1.5 }, ms: 1500, at: 0, ...more });
/** @param {any[]} parts @returns {any} */
const asked = (parts) => ({ messages: [{ role: 'user', parts }] });
const partsOf = (/** @type {any} */ r) => r.messages[0].parts;

/** What resolution needs: the speech-in list, and transcription models that answer or fail. @param {HeardMemory} memory @param {{ failing?: string[] }} [o] */
function deps(memory, { failing = [] } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const failed = [];
  const c = {
    list: ['send-audio', 'asr-a', 'asr-b', 'dictation'], memory,
    asr: (/** @type {string} */ id) => id.startsWith('asr-') && !failed.includes(id),
    transcribe: async (/** @type {string} */ id, /** @type {any} */ kept) => {
      calls.push(`${id} ${kept.id}`);
      if (failing.includes(id)) throw new Error(`${id} is down`);
      return `words of ${kept.id} by ${id}`;
    },
    clip: async (/** @type {string} */ hash) => (hash === 'h-kept' ? { data: enc.encode('RIFF-kept'), mediaType: 'audio/wav' } : null),
    onFail: (/** @type {string} */ id) => { failed.push(id); },
  };
  return { c, calls, failed };
}

test("the spec's example: M1 (audio) → M2 (text only) → M3 (audio); ASR-A runs once however many need it (spec §10.3)", async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, calls } = deps(memory);
  const req = asked([{ type: 'text', text: '[heard]' }, { type: 'speech', id: 's-1' }]);
  assert.deepEqual(partsOf(await resolveSpeech(req, model('M1', ['text', 'audio']), c))[1], { type: 'audio', mediaType: 'audio/wav', data: Buffer.from('RIFF-s-1').toString('base64') });
  assert.deepEqual(partsOf(await resolveSpeech(req, model('M2', ['text']), c))[1], { type: 'text', text: 'words of s-1 by asr-a' });
  assert.equal(partsOf(await resolveSpeech(req, model('M3', ['text', 'audio']), c))[1].type, 'audio');
  await resolveSpeech(req, model('M2', ['text']), c);
  assert.deepEqual(calls, ['asr-a s-1']);
  const typed = asked([{ type: 'text', text: 'typed' }]);
  assert.equal(await resolveSpeech(typed, model('M2', ['text']), c), typed, 'a request with no speech is left as it is');
});

test('a transcription model that fails is benched and the next one hears it; with nothing left, the model is skipped', async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, failed } = deps(memory, { failing: ['asr-a'] });
  assert.equal(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-1' }]), model('M2', ['text']), c))[0].text, 'words of s-1 by asr-b');
  assert.deepEqual(failed, ['asr-a']);
  memory.keep(segment('s-2'));
  const none = deps(memory, { failing: ['asr-a', 'asr-b'] });
  await assert.rejects(resolveSpeech(asked([{ type: 'speech', id: 's-2' }]), model('M2', ['text']), none.c), /nothing in the speech-in list can hear it for M2/);
});

test("dictation's words go to every model; words written down win; a kept clip still works; nothing left is said so", async () => {
  const memory = new HeardMemory();
  memory.keep({ id: 'd-1', source: 'dictation', text: 'is there a gas station', ms: 0, at: 0 });
  const { c } = deps(memory);
  const audio = model('M1', ['text', 'audio']);
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'd-1' }]), audio, c))[0], { type: 'text', text: 'is there a gas station' });
  memory.keep(segment('s-3'));
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-3', text: 'already written' }]), audio, c))[0], { type: 'text', text: 'already written' });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 's-3', text: '' }]), audio, c))[0], { type: 'text', text: '(nothing clear was said)' });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'gone', clip: 'h-kept' }]), audio, c))[0], { type: 'audio', mediaType: 'audio/wav', data: Buffer.from('RIFF-kept').toString('base64') });
  assert.deepEqual(partsOf(await resolveSpeech(asked([{ type: 'speech', id: 'lost' }]), audio, c))[0], { type: 'text', text: NOT_TRANSCRIBED });
});

test('how to listen: the first usable entry against the model expected to hear; dictation is exclusive (spec §10.3)', () => {
  const audio = model('M1', ['text', 'audio']);
  const text = model('M2', ['text']);
  const asr = (/** @type {string} */ id) => id === 'asr-a';
  assert.equal(listenKind({ list: ['send-audio', 'dictation'], model: audio, asr, dictation: true }).kind, 'record');
  assert.equal(listenKind({ list: ['send-audio', 'dictation'], model: text, asr, dictation: true }).kind, 'dictation');
  assert.equal(listenKind({ list: ['send-audio', 'asr-a', 'dictation'], model: text, asr, dictation: true }).kind, 'record');
  assert.equal(listenKind({ list: ['dictation', 'send-audio'], model: audio, asr, dictation: true }).kind, 'dictation');
  const none = /** @type {any} */ (listenKind({ list: ['send-audio', 'dictation'], model: text, asr, dictation: false }));
  assert.equal(none.kind, null);
  assert.match(none.why, /M2 doesn't take audio/);
  assert.match(none.why, /Add a transcription model in Settings → Models/);
  assert.match(/** @type {any} */ (listenKind({ list: [], model: null, asr, dictation: true })).why, /speech-in list is empty/);
});

test('text versions: a transcript made already, dictation, the hearing model for sent audio, then the list in order (spec §10.3)', async () => {
  const memory = new HeardMemory();
  memory.keep(segment('s-1'));
  const { c, calls } = deps(memory);
  const one = /** @type {any} */ (memory.get('s-1'));
  one.transcripts.set('asr-b', 'from before');
  assert.deepEqual(await textVersion(one, c), { text: 'from before', by: 'asr-b' });
  assert.deepEqual(await textVersion({ id: 'd', source: 'dictation', text: 'hi', ms: 0, at: 0, transcripts: new Map(), encoded: new Map() }, c), { text: 'hi', by: 'dictation' });
  memory.keep(segment('s-2'));
  const two = /** @type {any} */ (memory.get('s-2'));
  assert.deepEqual(await textVersion(two, { ...c, hearer: async () => 'heard by the model' }), { text: 'heard by the model', by: 'send-audio' });
  assert.deepEqual(await textVersion(two, c), { text: 'words of s-2 by asr-a', by: 'asr-a' });
  assert.deepEqual(calls, ['asr-a s-2']);
  memory.keep(segment('s-4'));
  assert.equal(await textVersion(/** @type {any} */ (memory.get('s-4')), { ...c, list: ['dictation'] }), null);
  memory.drop('s-4');
  assert.equal(memory.get('s-4'), null);
  assert.equal(memory.size, 2);
});

test('heard sound in memory has a cap: past it the oldest segments go first, and the newest always stays (spec §10.3)', () => {
  const memory = new HeardMemory({ maxBytes: 20 }); // each segment here is 8 bytes of sound
  for (const id of ['s-1', 's-2', 's-3']) memory.keep(segment(id));
  assert.deepEqual(['s-1', 's-2', 's-3'].map((id) => Boolean(memory.get(id))), [false, true, true]);
  memory.keep(segment('s-big', { audio: { data: new Uint8Array(50), mediaType: 'audio/wav', seconds: 9 } }));
  assert.equal(memory.size, 1);
  assert.ok(memory.get('s-big'));
  memory.drop('s-big');
  memory.keep(segment('s-4'));
  assert.equal(memory.size, 1);
  assert.ok(new HeardMemory().get('x') === null);
});

const dec = new TextDecoder();
const lunch = cat(quiet(0.5), await clip('where-lunch'), quiet(1));
/** The formats the receivers below take, as their providers declare them. */
const GROQ = ['webm', 'ogg', 'mp4', 'mp3', 'flac', 'wav'];
const GEMINI = ['wav', 'mp3'];
const OPENROUTER = ['ogg', 'aac', 'mp4', 'mp3', 'flac', 'wav'];

/**
 * A Voice on a phone whose encoder makes these formats, with Gemini and OpenRouter chat models that take audio, a text-only one, and Groq's transcription.
 * @param {{ makes?: string[], records?: { type: string, format: string }[], fails?: string[], plays?: string[] }} [d] @param {Parameters<typeof fakeLlm>[0]} [o]
 */
async function phone({ makes = ['ogg', 'webm'], records, fails, plays } = {}, o = {}) {
  const registry = new Registry();
  const store = createMemoryStore();
  const ws = new Workspace(store, { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const platform = fakePlatform({ encoder: { makes, records, fails }, plays });
  registry.add('voice-browser', 'voice-platform', platform);
  const llm = fakeLlm({
    main: [{ id: 'gem', input: ['text', 'audio'] }, { id: 'or', input: ['text', 'audio'] }, { id: 'txt', input: ['text'] }], asr: ['groq'], speechIn: ['send-audio', 'groq'],
    audioIn: { gem: GEMINI, or: OPENROUTER, groq: GROQ }, ...o,
  });
  const voice = new Voice({ llm, ws, registry, store, locale: 'en', where: 'ios' });
  voice.retryMs = [0, 0];
  /** Says the lunch question into an open session; gives what was heard. */
  const hear = async () => {
    /** @type {any[]} */
    const got = [];
    const s = await voice.open({ kind: 'record', onSegment: (h) => got.push(h), onError: (e) => assert.fail(e) });
    platform.mic.feed(lunch, 16_000);
    s.stop();
    return got[0];
  };
  /** The heard segment as one model gets it. @param {any} h @param {string} id @param {boolean} [plain] */
  const to = async (h, id, plain) => {
    const m = /** @type {any} */ ({ gem: ['text', 'audio'], or: ['text', 'audio'], txt: ['text'] })[id];
    return /** @type {any} */ ((await voice.resolver('trip-1', 'w-1')({ id, name: id, input: m }, asked([{ type: 'speech', id: h.id }]), plain)).messages[0].parts[0]);
  };
  return { voice, platform, llm, store, hear, to, encodes: () => platform.log.filter((/** @type {string} */ l) => l.startsWith('encode ')) };
}

test("a model's formats: its type's audioIn, then its ability's, then its own; WAV when none says", () => {
  const cfg = {
    providers: { p: { id: 'p', plugin: 'x', template: null, user: { abilities: { t: { kind: 'transcription', type: 'hear', tunables: { audioIn: ['ogg', 'wav'] } }, c: { kind: 'chat', type: 'chat' } } }, created: 0 } },
    models: {
      a: { id: 'a', provider: 'p', ability: 't', template: null, user: { providerId: 'a' }, created: 0 },
      b: { id: 'b', provider: 'p', ability: 't', template: null, user: { providerId: 'b', tunables: { audioIn: ['mp3'] } }, created: 0 },
      c: { id: 'c', provider: 'p', ability: 'c', template: null, user: { providerId: 'c' }, created: 0 },
    },
  };
  const types = new Map([['hear', { tunables: { audioIn: ['webm', 'wav'] } }], ['chat', {}]]);
  assert.deepEqual(audioIn(cfg, types, 'a'), ['ogg', 'wav']);
  assert.deepEqual(audioIn(cfg, types, 'b'), ['mp3']);
  assert.deepEqual(audioIn(cfg, types, 'c'), ['wav']);
  assert.deepEqual(audioIn(cfg, new Map(), 'gone'), ['wav']);
});

test('a segment goes to Groq as webm and to a Gemini chat model as wav, each encoded once however many attempts', async () => {
  const k = await phone();
  const h = await k.hear();
  assert.equal(h.audio.mediaType, 'audio/wav', 'what the microphone heard stays 16-bit PCM until a receiver needs a format');
  assert.deepEqual((await k.to(h, 'txt')).text, 'what was said', 'a text-only model gets Groq\'s words');
  assert.deepEqual(k.llm.uploads.map((u) => [u.modelId, u.mediaType]), [['groq', 'audio/webm']], "Groq's first Opus file");
  assert.equal(dec.decode(k.llm.uploads[0].data), `webm<${h.audio.data.length / 2 - 22}@16000>`, 'the 16-bit samples, at 16 kHz');
  const gem = await k.to(h, 'gem');
  assert.equal(gem.mediaType, 'audio/wav');
  assert.equal(Buffer.from(gem.data, 'base64').subarray(0, 4).toString(), 'RIFF');
  const or = await k.to(h, 'or');
  assert.equal(or.mediaType, 'audio/ogg', 'OpenRouter takes Ogg, not WebM');
  for (let i = 0; i < 3; i++) assert.deepEqual(await k.to(h, 'or'), or, 'another attempt sends the same bytes');
  assert.deepEqual(k.encodes(), ['encode webm', 'encode ogg'], 'each format made once');
});

test('a failed transcription retries with the identical bytes', async () => {
  const k = await phone({}, { flaky: { groq: 2 } });
  const h = await k.hear();
  assert.deepEqual((await k.to(h, 'txt')).text, 'what was said');
  assert.equal(k.llm.uploads.length, 3);
  assert.ok(k.llm.uploads.every((u) => u.data === k.llm.uploads[0].data && u.mediaType === 'audio/webm'), 'the very same bytes, three times');
  assert.deepEqual(k.encodes(), ['encode webm']);
  assert.equal(k.llm.bench.until('groq'), 0, 'it worked: not benched');
  const down = await phone({}, { flaky: { groq: 5 } });
  await assert.rejects(down.to(await down.hear(), 'txt'), /nothing in the speech-in list can hear it/);
  assert.equal(down.llm.uploads.length, 3, 'two more tries, then the next entry');
  assert.ok(down.llm.bench.until('groq') > Date.now());
});

test('a receiver that refuses the format it declared gets WAV, and WAV from then on; a format that fails to encode gives way to the next', async () => {
  const k = await phone({}, { refuses: { groq: 'audio/webm' } });
  assert.deepEqual((await k.to(await k.hear(), 'txt')).text, 'what was said');
  assert.deepEqual(k.llm.uploads.map((u) => u.mediaType), ['audio/webm', 'audio/wav']);
  await k.to(await k.hear(), 'txt');
  assert.deepEqual(k.llm.uploads.map((u) => u.mediaType), ['audio/webm', 'audio/wav', 'audio/wav'], 'straight to WAV');
  const h = await k.hear();
  assert.equal((await k.to(h, 'or', true)).mediaType, 'audio/wav', 'a chat model that refused (plain) gets WAV');
  assert.equal((await k.to(h, 'or')).mediaType, 'audio/wav', 'and keeps getting it');
  const broken = await phone({ fails: ['ogg'] });
  assert.equal((await broken.to(await broken.hear(), 'or')).mediaType, 'audio/wav', "OpenRouter's next format the phone makes: WAV, the last resort");
  const none = await phone({ makes: [] });
  assert.equal((await none.to(await none.hear(), 'or')).mediaType, 'audio/wav', 'no encoder: WAV, as before');
});

test('where the encoder makes nothing a receiver takes but MediaRecorder does, it records alongside and that file is sent', async () => {
  const mp4 = { type: 'audio/mp4;codecs=mp4a.40.2', format: 'mp4' };
  const k = await phone({ makes: [], records: [mp4] }, { audioIn: { gem: GEMINI, or: OPENROUTER, groq: ['webm', 'mp4', 'mp3', 'wav'] } });
  const h = await k.hear();
  assert.equal(k.platform.log[0], 'mic open, recording audio/mp4;codecs=mp4a.40.2');
  assert.deepEqual((await k.to(h, 'txt')).text, 'what was said');
  assert.deepEqual(k.llm.uploads.map((u) => [u.mediaType, dec.decode(u.data)]), [['audio/mp4', 'audio/mp4;codecs=mp4a.40.2 file 1']]);
  assert.equal((await k.to(h, 'or')).mediaType, 'audio/mp4', 'OpenRouter takes the recorded file too');
  assert.equal((await k.to(h, 'gem')).mediaType, 'audio/wav');
  const opus = await phone({ makes: ['ogg', 'webm'], records: [mp4] });
  await opus.hear();
  assert.equal(opus.platform.log[0], 'mic open', 'the encoder makes something smaller for every receiver: no second recorder');
});

test("audioFor: a clip kept in a compressed format is sent as it is where it's taken, and read back to PCM for a receiver that wants another", async () => {
  const p = fakePlatform({ encoder: { makes: ['ogg', 'webm'] } });
  const memory = new HeardMemory();
  memory.keep({ id: 'k', source: 'mic', audio: { data: new TextEncoder().encode('ogg<16000@16000>'), mediaType: 'audio/ogg', seconds: 0 }, ms: 0, at: 0 });
  const kept = /** @type {any} */ (memory.get('k'));
  const same = await audioFor(kept, OPENROUTER, p.encoder);
  assert.equal(same?.format, 'ogg');
  assert.equal(dec.decode(same?.data), 'ogg<16000@16000>');
  assert.deepEqual(p.log, [], 'nothing made');
  const webm = await audioFor(kept, GROQ, p.encoder);
  assert.equal(webm?.format, 'ogg', 'an Opus file Groq takes already beats making its first choice');
  const wav = await audioFor(kept, GEMINI, p.encoder);
  assert.equal(wav?.mediaType, 'audio/wav');
  assert.equal(wav?.data.length, 44 + 16_000 * 2, 'decoded at 48 kHz, back at 16 kHz');
  assert.deepEqual(p.log, ['decode']);
  assert.equal(await audioFor(kept, ['pcm16'], p.encoder), null, 'nothing annai can make');
  assert.equal(await audioFor({ ...kept, audio: undefined }, GEMINI, p.encoder), null);
  const plain = new HeardMemory();
  plain.keep({ id: 'w', source: 'mic', audio: { data: encodeWav(new Float32Array(160), 16_000), mediaType: 'audio/wav', seconds: 0.01 }, ms: 10, at: 0 });
  assert.equal((await audioFor(/** @type {any} */ (plain.get('w')), ['ogg'], null)), null, 'no encoder, and the receiver takes no WAV');
});
