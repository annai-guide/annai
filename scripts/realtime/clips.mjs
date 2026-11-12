// The user's side of a realtime check: short travel questions as speech, made once by Gemini's text-to-speech and kept
// as small 16 kHz mono WAV files under test/fixtures/realtime/ (no key in them, no TTS call on later runs), plus the
// "clips" made here: silence, and a noise.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeWav, decodeWav, resample } from '../../src/core/voice/pcm.js';

export const SEND_RATE = 16_000;
export const DIR = new URL('../../test/fixtures/realtime/', import.meta.url);
/** Gemini's text-to-speech model, and the rate its audio comes at (16-bit little-endian PCM, mono). */
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_RATE = 24_000;

/**
 * name → what is said. kind: question, yes (a quick answer), reply (a short English reply, for the languages check), sentence (one in
 * another language), pause (a sentence with a thinking pause: parts are speech and seconds of silence), long (a long question),
 * stray (words she should leave alone: silence is right), card (stage 5: a line for annai's read_trip card, or what its voice says), scold (told off for filler: silence is right, filler is the failure),
 * relay (a line Koe should pass on as it was said: a request it could ask about, or a question about annai it can't know), stop (the user telling her to stop:
 * no reply), silence (no sound: seconds), noise
 * (made here, no file: a sound that isn't the user's words, seconds of it). voice: one of Gemini's prebuilt voices. lang: the language it is spoken in (en unless said).
 * say: what the TTS is asked to say when a tone is asked for (text stays what it means); first: only the speech before the first pause in it is kept.
 * @typedef {{ kind: 'question' | 'scold' | 'yes' | 'reply' | 'sentence' | 'pause' | 'long' | 'silence' | 'noise' | 'stray' | 'card' | 'relay' | 'stop', text?: string, parts?: (string | number)[], voice?: string, seconds?: number, lang?: 'en' | 'ja' | 'zh' | 'ko', say?: string, first?: boolean }} ClipDef
 * @type {Record<string, ClipDef>}
 */
export const CLIPS = {
  lunch: { kind: 'question', text: 'Where should we stop for lunch?', voice: 'Kore' },
  bixby: { kind: 'question', text: 'How far is it to Bixby Bridge?', voice: 'Puck' },
  gas: { kind: 'question', text: 'Is there a gas station anywhere near here?', voice: 'Charon' },
  beach: { kind: 'question', text: "What's a good beach to stop at on the way?", voice: 'Aoede' },
  sunset: { kind: 'question', text: 'What time does the sun set today?', voice: 'Fenrir' },
  hike: { kind: 'question', text: 'Tell me about a short hike near here with a nice view.', voice: 'Leda' },
  restroom: { kind: 'question', text: 'Is there a restroom coming up soon?', voice: 'Orus' },
  yes: { kind: 'yes', text: 'Yes.', voice: 'Kore' },
  pause: { kind: 'pause', parts: ["Um, I'd like to find a place for dinner tonight,", 1.5, 'somewhere with a view of the ocean.'], voice: 'Puck' },
  long: {
    kind: 'long', voice: 'Kore',
    text: "We're driving south on Highway 1 and the kids are getting hungry, so could you tell me about a couple of good places to eat in the next hour, ideally with outdoor seating, and whether either of them needs a reservation on a Saturday?",
  },
  // The short replies the user's trace of 2026-10-22 had Gemini Live hear as "¿Qué?", "Ja, Studios testen.", "chưa" and "parco" and answer in
  // Spanish, and a sentence in each of his other languages (the user, 2026-10-23: English, Chinese and Japanese).
  sure: { kind: 'reply', text: 'Sure.', voice: 'Puck' },
  what: { kind: 'reply', text: 'What?', voice: 'Kore' },
  alright: { kind: 'reply', text: 'Alright.', voice: 'Leda' },
  no: { kind: 'reply', text: 'No.', voice: 'Aoede' },
  ja: { kind: 'sentence', text: 'この近くに、おいしいラーメン屋さんはありますか。', voice: 'Kore', lang: 'ja' },
  zh: { kind: 'sentence', text: '附近有什么好吃的餐馆吗？', voice: 'Puck', lang: 'zh' },
  // The second drive's shapes: a fact Koe wasn't told, about annai and general, a filler trap, and what it should leave alone (kind stray: she stays silent).
  'auto-gps': { kind: 'question', text: 'Is there an auto GPS mode in this app?', voice: 'Kore' },
  hello: { kind: 'question', text: 'Good morning, Shiori.', voice: 'Kore' },
  built: { kind: 'question', text: 'What year was Bixby Bridge built?', voice: 'Puck' },
  annoyed: { kind: 'scold', text: "You keep saying sorry and that you understand. Stop that, it's really annoying.", voice: 'Leda' },
  'ko-word': { kind: 'stray', text: '안녕하세요', voice: 'Aoede', lang: 'ko' },
  lyric: { kind: 'stray', text: 'Oh baby baby, dancing through the night, hold me till the morning light.', voice: 'Puck' },
  // Stage 5's card (read_trip): the user's line that has Shiori read another trip, the answers to annai's question that are and are not a yes,
  // what a passenger says, and annai's own question as its voice says it (a stand-in voice, so it plays through the page and can come back as echo).
  // say: what Gemini's TTS is asked to say, when a tone must be asked for ("Say ...: text"); words: what the clip means to say.
  tomorrow: { kind: 'card', text: "What's on tomorrow in Testville?", voice: 'Kore' },
  'yes-but': { kind: 'card', text: 'Yes, but not that one. The Osaka trip.', voice: 'Kore' },
  'no-wait': { kind: 'card', text: 'No, wait.', voice: 'Kore' },
  'no-thanks': { kind: 'card', text: 'No thanks.', voice: 'Aoede' },
  'yes-q': { kind: 'card', text: 'Yes?', say: 'Say with a questioning, rising tone, as if asking "pardon?": Yes?', voice: 'Kore' },
  hai: { kind: 'card', text: 'はい。', say: 'Say in Japanese: はい。', voice: 'Kore', lang: 'ja' },
  'hai-q': { kind: 'card', text: 'はい？', say: 'Say with a questioning, rising tone, as if asking "pardon?": はい？', voice: 'Kore', lang: 'ja' },
  // The preview TTS answers a two-character text with text ("Model tried to generate text"; 2026-11-10, five tries on two keys): said with a second sentence, and cut at the pause between them.
  hao: { kind: 'card', text: '好的。', say: '好的。没问题，谢谢你。', first: true, voice: 'Kore', lang: 'zh' },
  'mm-q': { kind: 'card', text: '嗯？', say: '嗯？你说什么？', first: true, voice: 'Puck', lang: 'zh' },
  passenger: { kind: 'stray', text: 'Turn left at the next light.', voice: 'Orus' },
  favour: { kind: 'card', text: "Could you look at what's on tomorrow in Testville for me?", voice: 'Kore' },
  'ask-q': { kind: 'card', text: 'Read Testville, Nov 10 to 17?', voice: 'Leda' },
  silence: { kind: 'silence', seconds: 8 },
  // Lines Koe passes on, made-up and synthetic: requests it could ask the user about, or answer it can't do, where the answer is Kokoro's; and
  // questions about annai that only Kokoro can answer. Made on first use: node scripts/realtime-check.mjs clips --only <names> (a free key).
  'do-all': { kind: 'relay', text: "Let's do all three of them.", voice: 'Kore' },
  'carry-on': { kind: 'relay', text: "Let's carry on in Kyoto.", voice: 'Puck' },
  'second-one': { kind: 'relay', text: 'Take us to the second one instead.', voice: 'Aoede' },
  'note-parking': { kind: 'relay', text: 'Add to my notes that we parked on level three.', voice: 'Leda' },
  'plan-beach': { kind: 'relay', text: 'Change the plan so we go to the beach first.', voice: 'Orus' },
  'why-quiet': { kind: 'relay', text: "Why didn't the reminder go off just now?", voice: 'Kore' },
  'app-louder': { kind: 'relay', text: 'Can I make your voice louder in this app?', voice: 'Puck' },
  'app-offline': { kind: 'relay', text: 'Does this app still work without a signal?', voice: 'Leda' },
  'app-new': { kind: 'relay', text: 'What changed in the latest version of this app?', voice: 'Aoede' },
  // A sound that cuts her while she says a note (someone else's voice, a bump, in headphones): voice-like and as loud as the clips' speech, so annai's
  // detector makes a turn of it that cuts her, as the user's own voice would; 0.8 s, past the 250 ms of sound a turn needs (minSpeechMs).
  bump: { kind: 'noise', seconds: 0.8 },
  // The user telling her to stop as she says a note. The preview TTS refuses some one-word texts: said with a second sentence and cut at the pause, as hao.
  stop: { kind: 'stop', text: 'Stop.', say: 'Stop. Please stop talking.', first: true, voice: 'Kore' },
};

/** The kinds made here, with no file. */
const MADE_HERE = ['silence', 'noise'];
/** Whether a clip is made here (no file, no TTS call). @param {ClipDef} c */
export const madeHere = (c) => MADE_HERE.includes(c.kind);

/**
 * A clip made here: silence as zeros; a noise as a 600 Hz voice-band tone whose loudness rises and falls four times a second (test/unit/voice-kit.js's hum),
 * at 0.35: rms 0.16, as loud as the clips' speech (rms 0.07 to 0.30 where it sounds, median 0.18), so the level check that keeps quieter sound out lets it in.
 * @param {ClipDef} c
 */
function makeHere(c) {
  const n = Math.round((c.seconds ?? 8) * SEND_RATE);
  if (c.kind === 'silence') return new Float32Array(n);
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 600 * i) / SEND_RATE) * 0.35 * (0.575 + 0.425 * Math.sin((2 * Math.PI * 4 * i) / SEND_RATE)));
}

/** The words of a clip, for the report. @param {ClipDef} c */
export const wordsOf = (c) => c.text ?? (c.parts ?? []).filter((p) => typeof p === 'string').join(' ');

/**
 * Silence taken off both ends of speech (frames of 20 ms under thresholdDb), with a margin of it kept.
 * @param {Float32Array} pcm @param {{ thresholdDb?: number, marginMs?: number }} [o]
 */
export function trimSilence(pcm, { thresholdDb = -45, marginMs = 120 } = {}) {
  const frame = Math.round(SEND_RATE * 0.02);
  const limit = 10 ** (thresholdDb / 20);
  const loud = (/** @type {number} */ at) => {
    let s = 0;
    const end = Math.min(pcm.length, at + frame);
    for (let i = at; i < end; i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / Math.max(1, end - at)) > limit;
  };
  let first = -1;
  let last = -1;
  for (let at = 0; at < pcm.length; at += frame) {
    if (!loud(at)) continue;
    if (first < 0) first = at;
    last = at + frame;
  }
  if (first < 0) return new Float32Array(0);
  const margin = Math.round((marginMs * SEND_RATE) / 1000);
  return pcm.slice(Math.max(0, first - margin), Math.min(pcm.length, last + margin));
}

/**
 * The speech up to its first pause (frames of 20 ms under thresholdDb, at least minMs of them in a row, after speech began), with a margin kept.
 * @param {Float32Array} pcm @param {{ thresholdDb?: number, minMs?: number, marginMs?: number }} [o]
 */
export function firstPhrase(pcm, { thresholdDb = -45, minMs = 200, marginMs = 120 } = {}) {
  const frame = Math.round(SEND_RATE * 0.02);
  const limit = 10 ** (thresholdDb / 20);
  const quietFrames = Math.ceil(minMs / 20);
  let began = false;
  let quiet = 0;
  for (let at = 0; at < pcm.length; at += frame) {
    let s = 0;
    const end = Math.min(pcm.length, at + frame);
    for (let i = at; i < end; i++) s += pcm[i] * pcm[i];
    if (Math.sqrt(s / Math.max(1, end - at)) > limit) {
      began = true;
      quiet = 0;
    } else if (began && ++quiet >= quietFrames) return pcm.slice(0, Math.min(pcm.length, at - (quietFrames - 1) * frame + Math.round((marginMs * SEND_RATE) / 1000)));
  }
  return pcm;
}

/** Gemini's speech (16-bit little-endian PCM at 24 kHz) as samples at 16 kHz. @param {Uint8Array} bytes */
export function fromTts(bytes) {
  const n = bytes.length >> 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  return resample(Float32Array.from({ length: n }, (_, i) => dv.getInt16(i * 2, true) / 0x8000), TTS_RATE, SEND_RATE);
}

/** Speech and silences (a number: seconds) as one run of samples. @param {(Float32Array | number)[]} parts */
export function joinParts(parts) {
  const pieces = parts.map((p) => (typeof p === 'number' ? new Float32Array(Math.round(p * SEND_RATE)) : p));
  const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One text spoken by Gemini's TTS, as 24 kHz PCM bytes. A 429 moves to the next key; a reply with no audio (the preview models
 * now and then answer in text) or a 5xx is tried again, twice.
 * @param {{ text: string, voice: string, model?: string, keys: import('./keys.mjs').Keys, fetcher?: typeof fetch, pauseMs?: number, log?: (s: string) => void }} o
 * @returns {Promise<Uint8Array>}
 */
export async function askTts({ text, voice, model = TTS_MODEL, keys, fetcher = fetch, pauseMs = 3000, log = () => {} }) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  let last = '';
  /** Replies with no audio (a 5xx, or text where speech was asked): each costs a free key's request, so three end it, as the doc says "twice". */
  let bare = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys.key }, body,
    });
    const raw = await res.text();
    /** @type {any} */
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      // not JSON: said below
    }
    if (res.status === 429) {
      last = `429 ${String(json?.error?.status ?? '')}`.trim();
      const was = keys.line;
      if (!keys.advance()) throw new Error(keys.scrub(`Gemini TTS said ${last}: ${String(json?.error?.message ?? raw).slice(0, 200)}, and there is no key left.`));
      log(`  key ${was ?? '(env)'} is out of quota (429); trying line ${keys.line}`);
      await wait(pauseMs);
      continue;
    }
    const data = json?.candidates?.[0]?.content?.parts?.find((/** @type {any} */ p) => p?.inlineData?.data)?.inlineData?.data;
    if (res.ok && data) return new Uint8Array(Buffer.from(data, 'base64'));
    last = res.ok ? 'no audio in the reply' : `${res.status} ${String(json?.error?.message ?? raw).slice(0, 160)}`;
    if (res.status >= 400 && res.status < 500) break;
    if (++bare >= 3) break;
    await wait(pauseMs);
  }
  throw new Error(keys.scrub(`Gemini TTS failed: ${last}`));
}

/**
 * Makes the clips that are missing (or all, with force): one TTS call for each spoken part, trimmed, joined, written as 16 kHz
 * WAV, and listed in clips.json (words, voice, model, length, size, hash: no key). Returns the names it made.
 * @param {{ keys: import('./keys.mjs').Keys, only?: string[], force?: boolean, model?: string, pauseMs?: number, log?: (s: string) => void }} o
 */
export async function makeClips({ keys, only, force = false, model = TTS_MODEL, pauseMs = 6000, log = console.log }) {
  await mkdir(DIR, { recursive: true });
  /** @type {Record<string, any>} */
  const manifest = await readFile(new URL('clips.json', DIR), 'utf8').then(JSON.parse, () => ({ model, clips: {} }));
  /** Lists a file in clips.json (words, voice, length, size, hash: no key), written at once so a stop later keeps it. @param {string} name @param {Uint8Array} wav */
  const list = async (name, wav) => {
    const def = CLIPS[name];
    manifest.clips[name] = { words: wordsOf(def), voice: def.voice, ...(def.lang ? { lang: def.lang } : {}), seconds: Math.round(((wav.length - 44) / 2 / SEND_RATE) * 100) / 100, bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex').slice(0, 16) };
    keys.assertClean(JSON.stringify(manifest), 'clips.json');
    await writeFile(new URL('clips.json', DIR), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const made = /** @type {string[]} */ ([]);
  let calls = 0;
  for (const [name, def] of Object.entries(CLIPS)) {
    if (madeHere(def) || (only && !only.includes(name))) continue;
    const had = await readFile(new URL(`${name}.wav`, DIR)).then((b) => new Uint8Array(b), () => null);
    if (had && !force) {
      if (!manifest.clips[name]) await list(name, had);
      continue;
    }
    /** @type {(Float32Array | number)[]} */
    const pieces = [];
    for (const part of def.parts ?? [def.say ?? def.text ?? '']) {
      if (typeof part === 'number') {
        pieces.push(part);
        continue;
      }
      if (calls++) await wait(pauseMs);
      log(`  TTS ${name}: "${part}" (${def.voice})`);
      const spoken = trimSilence(fromTts(await askTts({ text: part, voice: def.voice ?? 'Kore', model, keys, pauseMs, log })));
      pieces.push(def.first ? firstPhrase(spoken) : spoken);
    }
    const wav = encodeWav(joinParts(pieces), SEND_RATE);
    await writeFile(new URL(`${name}.wav`, DIR), wav);
    manifest.model = model;
    await list(name, wav);
    made.push(name);
  }
  return made;
}

/**
 * Every clip there is as samples at 16 kHz: speech from its file, silence and noise made here. A clip not made yet (its file missing) is left out: a run that
 * needs it says which to make (missingClips).
 * @returns {Promise<Record<string, { kind: string, words: string, pcm: Float32Array, seconds: number, lang: string }>>}
 */
export async function loadClips() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, def] of Object.entries(CLIPS)) {
    const pcm = madeHere(def) ? makeHere(def) : await readFile(new URL(`${name}.wav`, DIR)).then((b) => decodeWav(new Uint8Array(b)).pcm, () => null);
    if (pcm) out[name] = { kind: def.kind, words: wordsOf(def), pcm, seconds: pcm.length / SEND_RATE, lang: def.lang ?? 'en' };
  }
  return out;
}

/** The clips some scenarios play that have no file yet, in order, once each. @param {{ steps: any[] }[]} scenarios @param {Record<string, unknown>} loaded */
export const missingClips = (scenarios, loaded) => [...new Set(scenarios.flatMap((sc) => sc.steps.flatMap((st) => ('say' in st && !loaded[st.say] ? [st.say] : []))))];
