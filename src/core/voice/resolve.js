import { toBase64 } from '../bytes.js';
import { pickFormat, formatOf, mediaTypeOf, rankOf } from './formats.js';
import { encodeWav, pcm16, resample, SEND_RATE } from './pcm.js';

/**
 * Speech-in list resolution (spec §10.3). What was heard stays in memory as a segment until the
 * turn that used it succeeds. For each model attempt, of any role, the speech-in list is walked
 * again against the model actually receiving it: "Send audio to the model" when that model takes
 * audio; a transcription model's words, made once per segment; or phone dictation's words, which
 * are all a dictated segment has. Text versions are made lazily (textVersion).
 * @typedef {{ id: string, source: 'mic' | 'dictation', audio?: { data: Uint8Array, mediaType: string, seconds: number }, text?: string, ms: number, at: number,
 *   encoded?: Map<string, Promise<Uint8Array | null>> }} Heard  audio: the microphone's 16 kHz WAV, or a kept clip; encoded: its other files, by format
 * @typedef {Heard & { transcripts: Map<string, string>, encoded: Map<string, Promise<Uint8Array | null>>, pcm?: Promise<{ pcm: Int16Array, rate: number }> }} Kept
 * @typedef {import('../llm/contract.js').Request} Request
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {import('./platform.js').Encoder} Encoder
 * @typedef {{ id?: string, name: string, input: string[] }} Hearer  the model a request goes to
 * @typedef {{ list: string[], memory: HeardMemory, asr: (id: string) => boolean, transcribe: (id: string, kept: Kept) => Promise<string>,
 *   clip?: (hash: string) => Promise<{ data: Uint8Array, mediaType: string } | null>, onFail?: (id: string, error: unknown) => void,
 *   accepts?: (id: string) => string[], encoder?: Encoder | null, plain?: boolean }} Resolve
 *   list: the speech-in list; asr: whether an entry is a transcription model that can work now; onFail: one failed (bench it);
 *   accepts: a model's audioIn; plain: send WAV (another format was refused)
 */

/** A segment nothing could write down (spec §10.3). */
export const NOT_TRANSCRIBED = '[audio, not transcribed]';
/** Providers refuse empty text. @param {string} t */
const said = (t) => t.trim() || '(nothing clear was said)';

/** How much heard sound memory holds, in bytes: about 8 minutes of speech as it is sent. */
export const HEARD_MAX_BYTES = 16 * 1024 * 1024;

/** @param {Heard} h */
const bytesOf = (h) => (h.audio?.data.byteLength ?? 0) + (h.text?.length ?? 0);

/**
 * Heard segments in memory, until the turn that used them succeeds (spec §10.3). Past the cap
 * (turns failing for a long time) the oldest go first; they are then written as not transcribed.
 */
export class HeardMemory {
  /** @type {Map<string, Kept>} */
  #all = new Map();
  #bytes = 0;

  constructor({ maxBytes = HEARD_MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
  }

  /** @param {Heard} h */
  keep(h) {
    if (this.#all.has(h.id)) return;
    this.#all.set(h.id, { ...h, transcripts: new Map(), encoded: new Map(h.encoded) });
    this.#bytes += bytesOf(h);
    for (const id of this.#all.keys()) {
      if (this.#bytes <= this.maxBytes || id === h.id) break;
      this.drop(id);
    }
  }

  /** @param {string} id @returns {Kept | null} */
  get(id) {
    return this.#all.get(id) ?? null;
  }

  /** @param {string} id */
  drop(id) {
    const kept = this.#all.get(id);
    if (kept) this.#bytes -= bytesOf(kept);
    this.#all.delete(id);
  }

  get size() {
    return this.#all.size;
  }
}

/**
 * A segment in the smallest format both sides handle (spec §10.6), made once and kept, so a retry
 * sends the same bytes; one of the same codec made already goes instead. A format that can't be
 * made gives way to the next, down to WAV. null: the receiver takes nothing annai can make.
 * @param {Kept} kept @param {string[]} accepts @param {Encoder | null} [encoder]
 * @returns {Promise<{ data: Uint8Array, mediaType: string, format: string } | null>}
 */
export async function audioFor(kept, accepts, encoder) {
  const audio = kept.audio;
  if (!audio) return null;
  const own = formatOf(audio.mediaType);
  const makes = (await encoder?.makes().catch(() => null)) ?? [];
  for (let wants = accepts; ;) {
    const best = pickFormat(wants, [...makes, ...kept.encoded.keys(), ...(own ? [own] : [])]);
    if (!best) return null;
    const format = wants.find((f) => rankOf(f) === rankOf(best) && (f === own || kept.encoded.has(f))) ?? best;
    if (format === own) return { data: audio.data, mediaType: audio.mediaType, format };
    let made = kept.encoded.get(format);
    if (!made) kept.encoded.set(format, (made = make(kept, format, encoder).catch(() => null)));
    const data = await made;
    if (data) return { data, mediaType: mediaTypeOf(format), format };
    wants = wants.filter((f) => f !== format);
  }
}

/** @param {Kept} kept @param {string} format @param {Encoder | null | undefined} encoder */
async function make(kept, format, encoder) {
  kept.pcm ??= pcmOf(/** @type {NonNullable<Kept['audio']>} */ (kept.audio), encoder);
  const { pcm, rate } = await kept.pcm;
  if (format === 'wav') return encodeWav(pcm, rate);
  if (!encoder) throw new Error(`annai can't make ${format} here.`);
  return encoder.encode(pcm, rate, format);
}

/** @param {NonNullable<Kept['audio']>} audio @param {Encoder | null | undefined} encoder */
async function pcmOf(audio, encoder) {
  if (formatOf(audio.mediaType) === 'wav') return pcm16(audio.data);
  if (!encoder?.decode) throw new Error("This device can't read a kept clip back.");
  const { pcm, rate } = await encoder.decode(audio.data, audio.mediaType);
  const at = resample(pcm, rate, SEND_RATE);
  return { pcm: Int16Array.from(at, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))), rate: SEND_RATE };
}

/**
 * How to listen (spec §10.3): the first usable entry of the speech-in list, judged against the
 * model expected to hear it, chooses recording or phone dictation. Dictation is exclusive: when it
 * comes first, segments arrive as text only. With nothing usable, the reason says what to add.
 * @param {{ list: string[], model: Hearer | null, asr: (id: string) => boolean, dictation: boolean }} c  dictation: this browser has it, and it hasn't failed
 * @returns {{ kind: 'record' | 'dictation' } | { kind: null, why: string }}
 */
export function listenKind({ list, model, asr, dictation }) {
  for (const id of list) {
    if (id === 'send-audio') {
      if (model?.input.includes('audio')) return { kind: 'record' };
    } else if (id === 'dictation') {
      if (dictation) return { kind: 'dictation' };
    } else if (asr(id)) {
      return { kind: 'record' };
    }
  }
  if (!list.length) return { kind: null, why: "Shiori can't hear you: the speech-in list is empty. Add an entry in Settings → Models → Speech in." };
  const hearing = model ? `${model.name} doesn't take audio` : 'no main model is set';
  return {
    kind: null,
    why: `Shiori can't hear you yet: ${hearing}, and the speech-in list has no transcription model that works${dictation ? '' : ' (and this browser has no phone dictation)'}. Add a transcription model in Settings → Models, such as OpenAI or Groq, or a main model that takes audio.`,
  };
}

/**
 * The request as one model can take it (spec §10.3): each speech part becomes audio or words.
 * Throws when nothing in the speech-in list can hear a segment for this model, which is then
 * skipped like any capability gap (§9.6).
 * @param {Request} request @param {Hearer} model @param {Resolve} c @returns {Promise<Request>}
 */
export async function resolveSpeech(request, model, c) {
  if (!request.messages.some((m) => m.parts.some((p) => p.type === 'speech'))) return request;
  /** @type {import('../llm/contract.js').Message[]} */
  const messages = [];
  for (const m of request.messages) {
    /** @type {Part[]} */
    const parts = [];
    for (const p of m.parts) parts.push(p.type === 'speech' ? await resolvePart(p, model, c) : p);
    messages.push({ role: m.role, parts });
  }
  return { ...request, messages };
}

/** @param {{ id: string, text?: string, clip?: string }} p @param {Hearer} model @param {Resolve} c @returns {Promise<Part>} */
async function resolvePart(p, model, c) {
  // Words written down already are what every later request sends (spec §10.3).
  if (p.text !== undefined) return { type: 'text', text: said(p.text) };
  if (!c.memory.get(p.id) && p.clip) {
    // A kept voice clip (spec §10.2) stands in for audio that has left memory.
    const got = await c.clip?.(p.clip);
    if (got) c.memory.keep({ id: p.id, source: 'mic', audio: { ...got, seconds: 0 }, ms: 0, at: 0 });
  }
  const kept = c.memory.get(p.id);
  if (!kept) return { type: 'text', text: NOT_TRANSCRIBED };
  if (!kept.audio) return { type: 'text', text: said(kept.text ?? '') };
  for (const id of c.list) {
    if (id === 'send-audio') {
      if (!model.input.includes('audio')) continue;
      const a = await audioFor(kept, c.plain ? ['wav'] : (model.id && c.accepts?.(model.id)) || ['wav'], c.encoder);
      if (a) return { type: 'audio', mediaType: a.mediaType, data: toBase64(a.data) };
      continue;
    }
    if (id === 'dictation' || !c.asr(id)) continue; // dictation can't read recorded audio
    const had = kept.transcripts.get(id);
    if (had !== undefined) return { type: 'text', text: said(had) };
    try {
      const text = await c.transcribe(id, kept);
      kept.transcripts.set(id, text);
      return { type: 'text', text: said(text) };
    } catch (e) {
      c.onFail?.(id, e);
    }
  }
  throw new Error(`nothing in the speech-in list can hear it for ${model.name}`);
}

/**
 * A segment's words, for when only text can carry them (spec §10.3, made lazily): a transcript
 * made already, dictation's words, or the first entry of the list that can write it down. "Send
 * audio to the model" writes it down through the model that heard it (hearer). null: nothing could.
 * @param {Kept} kept @param {Resolve & { hearer?: (kept: Kept) => Promise<string> }} c
 * @returns {Promise<{ text: string, by: string } | null>} by: 'dictation', 'send-audio', or the transcription model's id
 */
export async function textVersion(kept, c) {
  if (!kept.audio) return { text: kept.text ?? '', by: 'dictation' };
  const [made] = kept.transcripts;
  if (made) return { text: made[1], by: made[0] };
  for (const id of c.list) {
    if (id === 'send-audio') {
      if (!c.hearer) continue;
      try {
        return { text: await c.hearer(kept), by: 'send-audio' };
      } catch {
        continue; // the next entry may write it down
      }
    }
    if (id === 'dictation' || !c.asr(id)) continue;
    try {
      const text = await c.transcribe(id, kept);
      kept.transcripts.set(id, text);
      return { text, by: id };
    } catch (e) {
      c.onFail?.(id, e);
    }
  }
  return null;
}
