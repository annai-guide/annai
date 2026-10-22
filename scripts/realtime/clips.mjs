// The user's side of a realtime check: short travel questions as speech, made once by Gemini's text-to-speech and kept
// as small 16 kHz mono WAV files under test/fixtures/realtime/ (no key in them, no TTS call on later runs), plus the
// "clips" that are only time: a thinking pause inside one sentence, and silence.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeWav, decodeWav, resample } from '../../src/core/voice/pcm.js';

export const SEND_RATE = 16_000;
export const DIR = new URL('../../test/fixtures/realtime/', import.meta.url);
/** Gemini's text-to-speech model, and the rate its audio comes at (16-bit little-endian PCM, mono). */
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TTS_RATE = 24_000;

/**
 * name → what is said. kind: question, yes (a quick answer), pause (a sentence with a thinking pause: parts are speech and
 * seconds of silence), long (a long question), silence (no sound: seconds). voice: one of Gemini's prebuilt voices.
 * @typedef {{ kind: 'question' | 'yes' | 'pause' | 'long' | 'silence', text?: string, parts?: (string | number)[], voice?: string, seconds?: number }} ClipDef
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
  silence: { kind: 'silence', seconds: 8 },
};

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
    manifest.clips[name] = { words: wordsOf(def), voice: def.voice, seconds: Math.round(((wav.length - 44) / 2 / SEND_RATE) * 100) / 100, bytes: wav.length, sha256: createHash('sha256').update(wav).digest('hex').slice(0, 16) };
    keys.assertClean(JSON.stringify(manifest), 'clips.json');
    await writeFile(new URL('clips.json', DIR), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const made = /** @type {string[]} */ ([]);
  let calls = 0;
  for (const [name, def] of Object.entries(CLIPS)) {
    if (def.kind === 'silence' || (only && !only.includes(name))) continue;
    const had = await readFile(new URL(`${name}.wav`, DIR)).then((b) => new Uint8Array(b), () => null);
    if (had && !force) {
      if (!manifest.clips[name]) await list(name, had);
      continue;
    }
    /** @type {(Float32Array | number)[]} */
    const pieces = [];
    for (const part of def.parts ?? [def.text ?? '']) {
      if (typeof part === 'number') {
        pieces.push(part);
        continue;
      }
      if (calls++) await wait(pauseMs);
      log(`  TTS ${name}: "${part}" (${def.voice})`);
      pieces.push(trimSilence(fromTts(await askTts({ text: part, voice: def.voice ?? 'Kore', model, keys, pauseMs, log }))));
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
 * Every clip as samples at 16 kHz: speech from its file, silence as zeros.
 * @returns {Promise<Record<string, { kind: string, words: string, pcm: Float32Array, seconds: number }>>}
 */
export async function loadClips() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, def] of Object.entries(CLIPS)) {
    const pcm = def.kind === 'silence' ? new Float32Array(Math.round((def.seconds ?? 8) * SEND_RATE))
      : decodeWav(new Uint8Array(await readFile(new URL(`${name}.wav`, DIR)))).pcm;
    out[name] = { kind: def.kind, words: wordsOf(def), pcm, seconds: pcm.length / SEND_RATE };
  }
  return out;
}
