import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadTypes, KEY } from './gemini-kit.js';
import { INSTRUCTION } from '../../plugins-official/gemini-api/speech.js';
import { ProviderError } from '../../src/core/llm/contract.js';
import { decodeWav, encodeWav, pcm16 } from '../../src/core/voice/pcm.js';
import { ulawToPcm } from '../../src/core/voice/g711.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';

// Gemini's transcription and voices (G3), through the Interactions API, read from what Google sent on 2026-10-20
// (test/fixtures/gemini/tts-*, transcribe-lite.json; their audio cut short).

const types = loadTypes();
const hear = types.get('gemini-transcription');
const say = types.get('gemini-speech');
const fixture = (/** @type {string} */ name) => readFile(new URL(`../fixtures/gemini/${name}`, import.meta.url), 'utf8');
const sse = (/** @type {string} */ text) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const json = (/** @type {string} */ text) => new Response(text, { headers: { 'content-type': 'application/json; charset=UTF-8' } });
/** @param {any} type @param {string} providerId @param {any} [tunables] */
const spec = (type, providerId, tunables = {}) => ({
  endpoint: { id: 'pv-g/x', provider: 'pv-g', ability: 'x', type: type.type, name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/', headers: {}, tunables: type.tunables, extraBody: {} },
  model: { id: 'm', providerId, name: providerId, prices: null, tunables: {} }, key: KEY, tunables: { ...type.tunables, ...tunables },
});
/** Each audio delta's bytes in a recorded stream, in order. @param {string} text */
const deltas = (text) => [...text.matchAll(/"data":"([^"]+)"/g)].map((m) => fromBase64(m[1]));
/** @param {Uint8Array[]} parts */
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};
/** All of a stream's pieces. @param {AsyncIterable<any>} it */
const all = async (it) => {
  const out = [];
  for await (const x of it) out.push(x);
  return out;
};

test('the plugin registers chat, transcription and voice types (G3)', () => {
  assert.deepEqual([...types.keys()], ['gemini', 'gemini-transcription', 'gemini-speech']);
  assert.deepEqual([hear.name, hear.speech, say.name, say.speech], ['Gemini API transcription', 'in', 'Gemini API voice', 'out']);
  assert.deepEqual(hear.tunables, { audioIn: ['ogg', 'webm', 'mp4', 'aac', 'mp3', 'flac', 'wav'], language: '' });
  assert.deepEqual(say.tunables, { voice: 'Kore', format: 'pcm24', stream: true });
  assert.equal(typeof say.readSpeechStream, 'function');
});

test('transcribeRequest: a chat model is told to write down the speech, exactly, at its lowest thinking and temperature 0; the key only in its header', () => {
  const audio = { data: new Uint8Array([79, 103, 103, 83]), mediaType: 'audio/ogg' };
  const r = hear.transcribeRequest({ ...spec(hear, 'gemini-3.5-flash-lite'), audio });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.deepEqual(r.headers, { 'content-type': 'application/json', 'x-goog-api-key': KEY });
  assert.equal(typeof r.body, 'string');
  assert.deepEqual(JSON.parse(r.body), {
    model: 'gemini-3.5-flash-lite', store: false,
    input: [{ type: 'user_input', content: [{ type: 'text', text: INSTRUCTION }, { type: 'audio', data: toBase64(audio.data), mime_type: 'audio/ogg' }] }],
    generation_config: { temperature: 0, thinking_level: 'minimal' },
  });
  assert.equal(INSTRUCTION, 'Transcribe this speech exactly, in its own language. Output only the words.');
  assert.equal(`${r.url}${r.body}`.includes(KEY), false);
  // A model whose lowest level is low; one annai knows no levels for; a recorder's type and the iPhone's AAC, as Gemini names them.
  const body = (/** @type {string} */ id, /** @type {string} */ mediaType) => JSON.parse(hear.transcribeRequest({ ...spec(hear, id), audio: { ...audio, mediaType } }).body);
  assert.equal(body('gemini-3.8-flash', 'audio/ogg').generation_config.thinking_level, 'low');
  assert.deepEqual(body('gemma-4-31b-it', 'audio/ogg').generation_config, { temperature: 0 });
  assert.equal(body('gemini-3.5-flash-lite', 'audio/webm;codecs=opus').input[0].content[1].mime_type, 'audio/webm');
  assert.equal(body('gemini-3.5-flash-lite', 'audio/mp4').input[0].content[1].mime_type, 'audio/m4a');
});

test("transcribeRequest: Google's transcription model gets its own transcription_config and the audio alone, its language when one is set", () => {
  const audio = { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/ogg' };
  assert.deepEqual(JSON.parse(hear.transcribeRequest({ ...spec(hear, 'gemini-3.5-transcribe'), audio }).body), {
    model: 'gemini-3.5-transcribe', store: false,
    input: [{ type: 'user_input', content: [{ type: 'audio', data: toBase64(audio.data), mime_type: 'audio/ogg' }] }],
    generation_config: { transcription_config: { language_codes: [] } },
  });
  const ja = JSON.parse(hear.transcribeRequest({ ...spec(hear, 'gemini-3.5-transcribe', { language: 'ja-JP, en-US' }), audio }).body);
  assert.deepEqual(ja.generation_config.transcription_config.language_codes, ['ja-JP', 'en-US']);
});

test('readTranscript: the words of the model_output, as Google sent them', async () => {
  assert.deepEqual(await hear.readTranscript(json(await fixture('transcribe-lite.json'))), { text: 'Where should we eat?' });
  const none = { status: 'completed', steps: [{ type: 'thought', signature: 'x' }] };
  assert.deepEqual(await hear.readTranscript(json(JSON.stringify(none))), { text: '' }, 'nothing heard');
  await assert.rejects(hear.readTranscript(json(JSON.stringify({ status: 'failed', error: { code: 'internal', message: 'Something broke.' } }))), (e) => e instanceof ProviderError && e.kind === 'server');
  await assert.rejects(hear.readTranscript(json('not json')), (e) => e instanceof ProviderError && e.kind === 'server');
});

test('speechRequest: full quality is 24 kHz PCM; phone quality is μ-law at 8 kHz, as Google sends it; the voice; streamed', () => {
  const r = say.speechRequest({ ...spec(say, 'gemini-3.8-flash-lite-tts'), text: 'Your train leaves at nine fifteen.' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.deepEqual(r.headers, { 'content-type': 'application/json', 'x-goog-api-key': KEY });
  assert.deepEqual(JSON.parse(r.body), {
    model: 'gemini-3.8-flash-lite-tts', store: false, stream: true,
    input: [{ type: 'user_input', content: [{ type: 'text', text: 'Your train leaves at nine fifteen.' }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 },
    generation_config: { speech_config: [{ voice: 'Kore' }] },
  });
  assert.equal(`${r.url}${r.body}`.includes(KEY), false);
  const phone = JSON.parse(say.speechRequest({ ...spec(say, 'gemini-3.8-flash-tts', { format: 'mulaw8', voice: 'Leda', stream: false }), text: 'Hi.' }).body);
  assert.deepEqual(phone.response_format, { type: 'audio', mime_type: 'audio/mulaw', sample_rate: 8000 });
  assert.deepEqual(phone.generation_config.speech_config, [{ voice: 'Leda' }]);
  assert.equal(phone.stream, true, 'streamed even when the switch is off: the whole clip comes sooner read from a stream (measured 1.1 s against 1.5–1.9 s)');
  assert.deepEqual(JSON.parse(say.speechRequest({ ...spec(say, 'x-tts', { format: 'auto' }), text: 'Hi.' }).body).response_format.mime_type, 'audio/l16', 'a format it has no name for: full quality');
});

test('readSpeechStream: each audio delta as 16-bit PCM at its rate, as it comes; μ-law decoded, at the rate Google says it sent', async () => {
  const text = await fixture('tts-stream-l16.sse');
  const pieces = await all(say.readSpeechStream(sse(text), spec(say, 'gemini-3.8-flash-lite-tts')));
  const raw = deltas(text);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map((p) => p.rate), [24000, 24000, 24000]);
  for (const [i, p] of pieces.entries()) assert.deepEqual([...p.pcm], [...new Int16Array(raw[i].buffer, raw[i].byteOffset, raw[i].length / 2)]);
  // Asked for μ-law at 16 kHz, Google sent 8 kHz (measured): the rate is the one it says.
  const mu = await fixture('tts-stream-mulaw-asked-16k.sse');
  const got = await all(say.readSpeechStream(sse(mu), spec(say, 'gemini-3.8-flash-lite-tts', { format: 'mulaw8' })));
  assert.deepEqual(got.map((p) => p.rate), [8000, 8000]);
  assert.deepEqual([...got[0].pcm], [...ulawToPcm(deltas(mu)[0])]);
});

test('readSpeechStream: a piece split mid-sample keeps its odd byte for the next; an error event, a failed interaction or a stream cut short is a ProviderError', async () => {
  const ev = (/** @type {any} */ e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`;
  const audio = (/** @type {number[]} */ bytes) => ev({ event_type: 'step.delta', index: 0, delta: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000, data: toBase64(Uint8Array.from(bytes)) } });
  const done = ev({ event_type: 'interaction.completed', interaction: { status: 'completed' } });
  const split = await all(say.readSpeechStream(sse(audio([1, 0, 2]) + audio([0, 3, 0]) + done), spec(say, 't')));
  assert.deepEqual(split.map((p) => [...p.pcm]), [[1], [2, 3]]);
  await assert.rejects(all(say.readSpeechStream(sse(audio([1, 0]) + ev({ event_type: 'error', error: { code: 'too_many_requests', message: 'Slow down.' } })), spec(say, 't'))), (e) => e instanceof ProviderError && e.kind === 'rate');
  await assert.rejects(all(say.readSpeechStream(sse(ev({ event_type: 'interaction.completed', interaction: { status: 'failed', error: { code: 'internal', message: 'Broke.' } } })), spec(say, 't'))), (e) => e instanceof ProviderError && e.kind === 'server');
  await assert.rejects(all(say.readSpeechStream(sse(audio([1, 0])), spec(say, 't'))), (e) => e instanceof ProviderError && e.kind === 'network');
});

test('readSpeech: a stream read whole is one WAV clip; so is a whole reply, μ-law decoded and WAV as it came', async () => {
  const text = await fixture('tts-stream-l16.sse');
  const clip = await say.readSpeech(sse(text), spec(say, 'gemini-3.8-flash-lite-tts'));
  assert.equal(clip.mediaType, 'audio/wav');
  const { pcm, rate } = pcm16(clip.data);
  assert.equal(rate, 24000);
  const joined = cat(deltas(text));
  assert.deepEqual([...pcm], [...new Int16Array(joined.buffer, 0, joined.length / 2)]);
  // Whole, as a server that ignores stream sends it: μ-law at 8 kHz.
  const whole = await fixture('tts-whole-mulaw.json');
  const mu = await say.readSpeech(json(whole), spec(say, 'gemini-3.8-flash-lite-tts', { format: 'mulaw8' }));
  assert.equal(decodeWav(mu.data).sampleRate, 8000);
  assert.deepEqual([...pcm16(mu.data).pcm], [...ulawToPcm(fromBase64(JSON.parse(whole).steps[0].content[0].data))]);
  // Whole as WAV (Google's default for a whole reply): the same file.
  const wav = encodeWav(Int16Array.of(5, -5, 7), 24000);
  const asWav = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: toBase64(wav) }] }] };
  assert.deepEqual(await say.readSpeech(json(JSON.stringify(asWav)), spec(say, 't')), { data: wav, mediaType: 'audio/wav' });
  await assert.rejects(say.readSpeech(json(JSON.stringify({ status: 'completed', steps: [] })), spec(say, 't')), (e) => e instanceof ProviderError && e.kind === 'server', 'no audio is no clip');
});

test('Fetch model list: voices are the TTS models; transcription, Google\'s transcription model and the flash models', async () => {
  const list = JSON.parse(await fixture('models.json'));
  assert.deepEqual(say.readList(list), [{ providerId: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash Lite TTS' }]);
  assert.deepEqual(hear.readList(list).map((/** @type {any} */ m) => m.providerId), [
    'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-transcribe', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
  ]);
  for (const t of [say, hear]) assert.equal(t.listRequest({ endpoint: spec(t, 'x').endpoint, key: KEY }).url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  assert.equal(hear.classify(429, '{"error":{"message":"Quota exceeded"}}'), 'rate');
  assert.equal(say.retryAfter('Please retry in 44s.'), 44000);
});
