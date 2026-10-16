import { toBase64 } from '../bytes.js';

/**
 * Speech-in list resolution (spec §10.3). What was heard stays in memory as a segment until the
 * turn that used it succeeds. For each model attempt, of any role, the speech-in list is walked
 * again against the model actually receiving it: "Send audio to the model" when that model takes
 * audio; a transcription model's words, made once per segment; or phone dictation's words, which
 * are all a dictated segment has. Text versions are made lazily (textVersion).
 * @typedef {{ id: string, source: 'mic' | 'dictation', audio?: { data: Uint8Array, mediaType: string, seconds: number }, text?: string, ms: number, at: number }} Heard
 * @typedef {Heard & { transcripts: Map<string, string> }} Kept  a segment in memory, with its words by each transcription model
 * @typedef {import('../llm/contract.js').Request} Request
 * @typedef {import('../llm/contract.js').Part} Part
 * @typedef {{ name: string, input: string[] }} Hearer  the model a request goes to
 * @typedef {{ list: string[], memory: HeardMemory, asr: (id: string) => boolean, transcribe: (id: string, kept: Kept) => Promise<string>,
 *   clip?: (hash: string) => Promise<Uint8Array | null>, onFail?: (id: string, error: unknown) => void }} Resolve
 *   list: the speech-in list; asr: whether an entry is a transcription model that can work now; onFail: one failed (bench it)
 */

/** A segment nothing could write down (spec §10.3). */
export const NOT_TRANSCRIBED = '[audio, not transcribed]';
/** Providers refuse empty text. @param {string} t */
const said = (t) => t.trim() || '(nothing clear was said)';

/** Heard segments in memory, until the turn that used them succeeds (spec §10.3). */
export class HeardMemory {
  /** @type {Map<string, Kept>} */
  #all = new Map();

  /** @param {Heard} h */
  keep(h) {
    if (!this.#all.has(h.id)) this.#all.set(h.id, { ...h, transcripts: new Map() });
  }

  /** @param {string} id @returns {Kept | null} */
  get(id) {
    return this.#all.get(id) ?? null;
  }

  /** @param {string} id */
  drop(id) {
    this.#all.delete(id);
  }

  get size() {
    return this.#all.size;
  }
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
    const data = await c.clip?.(p.clip);
    if (data) c.memory.keep({ id: p.id, source: 'mic', audio: { data, mediaType: 'audio/wav', seconds: 0 }, ms: 0, at: 0 });
  }
  const kept = c.memory.get(p.id);
  if (!kept) return { type: 'text', text: NOT_TRANSCRIBED };
  if (!kept.audio) return { type: 'text', text: said(kept.text ?? '') };
  for (const id of c.list) {
    if (id === 'send-audio') {
      if (model.input.includes('audio')) return { type: 'audio', mediaType: kept.audio.mediaType, data: toBase64(kept.audio.data) };
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
