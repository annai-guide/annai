import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/core/store-memory.js';
import { SYS } from '../../src/core/scopes.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { modelTrace } from '../../src/core/llm/trace.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { mergePatch } from '../../src/core/patch.js';
import { openLive } from '../../src/core/realtime/open.js';
import { speechCall } from '../../src/core/llm/speech.js';
import { g711 } from '../../src/core/voice/g711.js';
import { activate as activateGeminiLive } from '../../plugins-official/gemini-live/index.js';
import { activate as activateOpenaiRealtime } from '../../plugins-official/openai-realtime/index.js';
import { activate as activateSpeech } from '../../plugins-official/speech-openai/index.js';
import { loadTypes, KEY as GEMINI_KEY } from './gemini-kit.js';
import { languageSettings, modelLanguages } from '../../src/core/languages.js';
import { startRealtimeServer } from '../fakes/realtime-server.js';

// Languages you speak (phase 2): each protocol that hears is given them. The research behind each field is in the ledger and in
// the plugins' comments; these tests hold the requests to it.

const three = modelLanguages(languageSettings({ languages: { spoken: ['en', 'zh', 'ja'] } }, 'en-US'));
const english = modelLanguages(languageSettings({ languages: { spoken: ['en'] } }, 'en-US'));
const none = undefined;

/** @param {any} activate @param {any} [more] @returns {any} */
function typeOf(activate, more = {}) {
  /** @type {any} */
  let t = null;
  activate({ providers: { register: (/** @type {any} */ x) => { t = { ...x, pluginId: x.type }; return () => {}; } }, helpers: { ProviderError, errorFromResponse, mergePatch, g711, base64: { encode: toBase64, decode: fromBase64 } }, events: { append: async () => {} }, ...more });
  return t;
}

// ---- Gemini Live ----

const GEMINI = typeOf(activateGeminiLive);
const KEY = 'AIza-gemini-live-test-0123456789';
/** @param {string} baseUrl @returns {any} */
const geminiEndpoint = (baseUrl) => ({ id: 'pv-g/live', provider: 'pv-g', ability: 'live', type: 'gemini-live', name: 'Google Gemini', baseUrl, headers: {}, tunables: GEMINI.tunables, extraBody: {} });
const geminiModel = { id: 'm-l', provider: 'pv-g', ability: 'live', name: 'Gemini 3.8 Live', providerId: 'gemini-3.8-live', input: ['text'], tools: true, contextWindow: 128000, maxOutput: null, prices: {}, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
/** @param {any} s the stand-in @param {any} [o] */
function openGemini(s, o = {}) {
  const store = createMemoryStore();
  const setup = { instructions: 'You are Koe.', context: '', tools: [], audioIn: { format: /** @type {const} */ ('pcm16'), rate: 16000 }, audioOut: { format: /** @type {const} */ ('pcm16'), rate: 24000 }, ...o.setup };
  return openLive({ type: GEMINI, endpoint: geminiEndpoint(s.origin), model: geminiModel, key: KEY, tunables: { ...GEMINI.tunables, ...o.tunables }, setup, trace: modelTrace(store, SYS) });
}

test("Gemini Live: input transcription is given the languages as hints, in Google's own codes (AudioTranscriptionConfig.languageCodes); with none, nothing but the switch", async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [] });
  try {
    const a = openGemini(s, { setup: { languages: three } });
    await a.ready;
    const setup = s.received().at(-1).setup;
    assert.deepEqual(setup.inputAudioTranscription, { languageCodes: ['en', 'zh-Hans', 'ja'] });
    assert.deepEqual(setup.outputAudioTranscription, {}, "the output transcript's language is inferred from the model's response (Google's guide)");
    assert.deepEqual(Object.keys(setup.generationConfig.speechConfig), ['voiceConfig'], 'native audio models do not take a language code (Google\'s guide): none is sent, only the voice');
    assert.doesNotMatch(JSON.stringify(setup), /"languageCode"/);
    a.close();
    await a.closed;
    // The words the model is told are in the instructions it is given, whole.
    const b = openGemini(s, { setup: { instructions: 'You are Koe.\n\n# Languages\nThe user speaks English.', languages: english } });
    await b.ready;
    assert.deepEqual(s.received().at(-1).setup.inputAudioTranscription, { languageCodes: ['en'] });
    assert.match(s.received().at(-1).setup.systemInstruction.parts[0].text, /# Languages\nThe user speaks English\./);
    b.close();
    await b.closed;
    const c = openGemini(s, { setup: { languages: none } });
    await c.ready;
    assert.deepEqual(s.received().at(-1).setup.inputAudioTranscription, {});
    c.close();
    await c.closed;
    const d = openGemini(s, { setup: { languages: three }, tunables: { languageHints: false } });
    await d.ready;
    assert.deepEqual(s.received().at(-1).setup.inputAudioTranscription, {}, 'the switch: no hints');
    d.close();
    await d.closed;
  } finally {
    await s.stop();
  }
});

test('Gemini Live: a language no code of Gemini Live\'s is known for is left out; Cantonese goes as Traditional Chinese', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [] });
  try {
    const a = openGemini(s, { setup: { languages: modelLanguages(languageSettings({ languages: { spoken: ['yue', 'en', 'yue', 'zh'] } }, 'en')) } });
    await a.ready;
    assert.deepEqual(s.received().at(-1).setup.inputAudioTranscription, { languageCodes: ['zh-Hant', 'en', 'zh-Hans'] });
    a.close();
    await a.closed;
  } finally {
    await s.stop();
  }
});

test('Gemini Live: a session that refuses the hints (1007 naming languageCodes) opens once more without them, as it does for proactivity', async () => {
  const s = await startRealtimeServer({ flavour: 'gemini', key: KEY, turns: [], noLanguageCodes: true });
  try {
    const a = openGemini(s, { setup: { languages: three } });
    await a.ready;
    const setups = s.received().filter((/** @type {any} */ m) => m.setup).map((/** @type {any} */ m) => m.setup.inputAudioTranscription);
    assert.deepEqual(setups, [{ languageCodes: ['en', 'zh-Hans', 'ja'] }, {}]);
    assert.equal(a.tunables.languageHints, false, 'remembered for the next session');
    a.close();
    await a.closed;
  } finally {
    await s.stop();
  }
});

// ---- OpenAI Realtime ----

const OPENAI = typeOf(activateOpenaiRealtime);
/** @param {string} baseUrl @returns {any} */
const openaiEndpoint = (baseUrl) => ({ id: 'pv-o/realtime', provider: 'pv-o', ability: 'realtime', type: 'openai-realtime', name: 'OpenAI', baseUrl, headers: {}, tunables: OPENAI.tunables, extraBody: {} });
const openaiModel = { id: 'm-r', provider: 'pv-o', ability: 'realtime', name: 'GPT Realtime 2.1', providerId: 'gpt-realtime-2.1', input: ['text'], tools: true, contextWindow: 128000, maxOutput: 32000, prices: {}, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {} };
const OKEY = 'sk-proj-openai-realtime-test-0123456789';
/** @param {any} s @param {any} [o] */
function openOpenai(s, o = {}) {
  const setup = { instructions: 'You are Koe.', context: '', tools: [], ...o.setup };
  return openLive({ type: OPENAI, endpoint: openaiEndpoint(`${s.origin}/v1`), model: openaiModel, key: OKEY, tunables: { ...OPENAI.tunables, ...o.tunables }, setup, trace: modelTrace(createMemoryStore(), SYS) });
}
/** The transcription part of the session.update the stand-in got last. @param {any} s */
const transcription = (s) => s.received().filter((/** @type {any} */ m) => m.type === 'session.update').at(-1).session.audio.input.transcription;

test('OpenAI Realtime: gpt-transcribe is given languages (an array); a Whisper-style model one language, only when exactly one is listed; none with none', async () => {
  const s = await startRealtimeServer({ flavour: 'openai', key: OKEY, turns: [] });
  try {
    const cases = /** @type {[string, any, any][]} */ ([
      ['gpt-transcribe', three, { model: 'gpt-transcribe', languages: ['en', 'zh', 'ja'] }],
      ['gpt-live-transcribe', three, { model: 'gpt-live-transcribe', languages: ['en', 'zh', 'ja'] }],
      ['gpt-transcribe', english, { model: 'gpt-transcribe', languages: ['en'] }],
      ['gpt-4o-transcribe', english, { model: 'gpt-4o-transcribe', language: 'en' }],
      ['whisper-1', three, { model: 'whisper-1' }],
      ['whisper-1', none, { model: 'whisper-1' }],
      ['gpt-transcribe', none, { model: 'gpt-transcribe' }],
    ]);
    for (const [model, languages, want] of cases) {
      const a = openOpenai(s, { tunables: { transcription: model }, setup: { languages } });
      await a.ready;
      assert.deepEqual(transcription(s), want, `${model}, ${languages ? languages.spoken.length : 'no'} languages`);
      a.close();
      await a.closed;
    }
    // No transcription model: none, whatever the languages.
    const off = openOpenai(s, { tunables: { transcription: '' }, setup: { languages: three } });
    await off.ready;
    assert.equal(transcription(s), null);
    off.close();
    await off.closed;
  } finally {
    await s.stop();
  }
});

// ---- Whisper-style transcription (OpenAI, Groq, OpenRouter, local servers) ----

const SPEECH = (() => {
  /** @type {Record<string, any>} */
  const types = {};
  activateSpeech({ providers: { register: (/** @type {any} */ t) => { types[t.type] = t; return () => {}; } }, helpers: { ProviderError, errorFromResponse, mergePatch } });
  return types;
})();
const hear = SPEECH['openai-transcription'];
/** @param {string} providerId @param {any} [tunables] @returns {any} */
const asr = (providerId, tunables = {}) => ({
  endpoint: { id: 'ep', type: hear.type, name: 'X', baseUrl: 'https://api.example.com/v1', headers: {}, tunables: { ...hear.tunables }, extraBody: {} },
  model: { id: 'm', name: 'Ears', providerId, tunables: {}, extraBody: {} }, key: 'sk-test', tunables: { ...hear.tunables, ...tunables },
});
const audio = { data: new Uint8Array([1, 2]), mediaType: 'audio/wav' };

test('Whisper-style transcription: one language listed is the `language` field; several are none (auto-detect), and gpt-transcribe takes them all as languages[]', () => {
  const form = (/** @type {string} */ id, /** @type {any} */ languages, /** @type {any} */ tunables) => hear.transcribeRequest({ ...asr(id, tunables), audio, languages }).body;
  assert.equal(form('whisper-large-v3', english).get('language'), 'en');
  assert.equal(form('whisper-large-v3', english).get('languages[]'), null);
  assert.equal(form('whisper-large-v3', three).get('language'), null, 'several: auto-detect, not the first (it would force a Chinese sentence into English)');
  assert.equal(form('whisper-large-v3', none).get('language'), null);
  assert.deepEqual(form('gpt-transcribe', three).getAll('languages[]'), ['en', 'zh', 'ja']);
  assert.equal(form('gpt-transcribe', three).get('language'), null, "never both (OpenAI: 'Don't send both')");
  assert.deepEqual(form('openai/gpt-transcribe', english).getAll('languages[]'), ['en']);
  // A language set by hand on the model's page wins over the setting.
  assert.equal(form('whisper-large-v3', three, { language: 'ja' }).get('language'), 'ja');
  assert.equal(form('gpt-transcribe', three, { language: 'ja' }).get('language'), 'ja');
  assert.deepEqual(form('gpt-transcribe', three, { language: 'ja' }).getAll('languages[]'), []);
});

test('speechCall hands the languages to the transcription request, and to nothing that speaks', async () => {
  /** @type {any[]} */
  const seen = [];
  const type = { ...hear, transcribeRequest: (/** @type {any} */ c) => { seen.push(c.languages); return hear.transcribeRequest(c); } };
  const { endpoint, model, key } = asr('whisper-1');
  await speechCall({ type, endpoint, model, key, audio, languages: english, fetch: async () => Response.json({ text: 'hi' }) });
  assert.deepEqual(seen, [english]);
  /** @type {any[]} */
  const said = [];
  const voice = { type: 'v', name: 'V', speech: 'out', speechRequest: (/** @type {any} */ c) => { said.push(Object.keys(c)); return { url: 'https://api.example.com/v1/audio/speech', headers: {}, body: '' }; }, readSpeech: async () => ({ data: new Uint8Array([1]), mediaType: 'audio/wav' }) };
  await speechCall({ type: /** @type {any} */ (voice), endpoint, model, key, text: 'Hello', fetch: async () => new Response(new Uint8Array([1])) });
  assert.ok(!said[0].includes('languages'), 'no voice API takes a language (they follow the text)');
});

// ---- Gemini transcription ----

const GEM = loadTypes();
const geminiHear = GEM.get('gemini-transcription');
const geminiSay = GEM.get('gemini-speech');
/** @param {any} type @param {string} providerId @param {any} [tunables] */
const gspec = (type, providerId, tunables = {}) => ({
  endpoint: { id: 'pv-g/x', provider: 'pv-g', ability: 'x', type: type.type, name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/', headers: {}, tunables: type.tunables, extraBody: {} },
  model: { id: 'm', providerId, name: providerId, prices: null, tunables: {} }, key: GEMINI_KEY, tunables: { ...type.tunables, ...tunables },
});

test("Gemini transcription: Google's transcription model gets language_codes in its own tags; a chat model is told in words; a language set by hand wins", () => {
  const body = (/** @type {string} */ id, /** @type {any} */ languages, /** @type {any} */ tunables) => JSON.parse(geminiHear.transcribeRequest({ ...gspec(geminiHear, id, tunables), audio, languages }).body);
  assert.deepEqual(body('gemini-3.5-transcribe', three).generation_config.transcription_config, { language_codes: ['en-US', 'cmn-Hans-CN', 'ja-JP'] });
  assert.deepEqual(body('gemini-3.5-transcribe', none).generation_config.transcription_config, { language_codes: [] }, 'none: it detects');
  assert.deepEqual(body('gemini-3.5-transcribe', three, { language: 'ja-JP' }).generation_config.transcription_config, { language_codes: ['ja-JP'] });
  // A language Google's model has no tag for is left out.
  const tamil = modelLanguages(languageSettings({ languages: { spoken: ['ta', 'en'] } }, 'en'));
  assert.deepEqual(body('gemini-3.5-transcribe', tamil).generation_config.transcription_config, { language_codes: ['en-US'] });
  const text = body('gemini-3-flash', three).input[0].content[0].text;
  assert.equal(text, 'Transcribe this speech exactly, in its own language. The speaker uses English, Chinese (Mandarin) or Japanese: write each in the language spoken and never translate. Output only the words.');
  assert.equal(body('gemini-3-flash', none).input[0].content[0].text, 'Transcribe this speech exactly, in its own language. Output only the words.');
  assert.equal(body('gemini-3-flash', english).input[0].content[0].text, 'Transcribe this speech exactly, in its own language. The speaker uses English: write it in the language spoken and never translate. Output only the words.');
});

test("Gemini's voice is given no language: it follows the text (Google's speech guide)", () => {
  const req = geminiSay.speechRequest({ ...gspec(geminiSay, 'gemini-3.8-flash-tts'), text: 'こんにちは', languages: three });
  assert.doesNotMatch(req.body, /language/i);
});
