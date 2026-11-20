import { readFileSync } from 'node:fs';

/**
 * A stand-in for what OpenRouter's speech list and audio API answer a voice, built from the real answers (RULES 12), for the unit and e2e
 * tests of a voice added by id (voice-id-next). It holds no audio: a test sends its own.
 * - The list: test/fixtures/voices/openrouter-speech-list.json, GET /api/v1/models?output_modalities=speech as it answered on 2026-11-20
 *   (41 models; each entry's id, name and supported_voices; null for Fish Audio's five, heygen/heygen-voice-1-turbo:free and
 *   bytedance-seed/seed-audio-1-0).
 * - The audio API: test/fixtures/voices/openrouter-voices-probe.json, the main session's probes of 2026-11-20 with the test key (Women
 *   KatKat's id to HeyGen and its free variant, Grok, Voxtral, Kokoro and ByteDance; a request with no voice; a voice the list gives).
 * What was never seen, and a request for it throws here rather than make an answer up: a voice that is neither one the list gives nor
 * Women KatKat's, and a request with no voice to a maker the probe didn't try. An id OpenRouter doesn't have is the one made-up answer
 * (UNKNOWN_MODEL): its real one was not recorded, so no test may pin its words.
 */
const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../fixtures/voices/${name}`, import.meta.url), 'utf8'));
/** @type {{ id: string, name: string, supported_voices: string[] | null }[]} */
export const SPEECH_LIST = fixture('openrouter-speech-list.json').data;
const probe = fixture('openrouter-voices-probe.json');
/** Women KatKat, the Fish Audio library voice OpenRouter's voice ability sends (provider-openrouter's description). @type {string} */
export const KATKAT = probe.voice;
/** The Content-Type OpenRouter gave raw 16-bit PCM from HeyGen (the voice probes of 2026-11-19 and 20). @type {string} */
export const PCM_TYPE = probe.accepted['heygen/heygen-voice-1'].contentType;
/** The reply for an id OpenRouter doesn't have: made up, its real answer not recorded. */
const UNKNOWN_MODEL = { status: 400, type: 'application/json', body: JSON.stringify({ error: { message: 'No such model (a stand-in: the real answer was not recorded)', code: 400 } }) };
/** The makers that answered 400 to a request with no voice: HeyGen, Gemini, Grok, Voxtral and Kokoro. */
const ASKED_NO_VOICE = /^(?:heygen|google|x-ai|mistralai|hexgrad)\//;
/** @param {{ status: number, contentType: string, body: string }} r */
const reply = (r) => ({ status: r.status, type: r.contentType, body: r.body });

/**
 * The voices the list gives a model, as annai reads them: its own, else its base's (the id before the last ":" of its slug).
 * @param {string} model @returns {string[] | null} null: an id the list doesn't have
 */
export function listedVoices(model) {
  const entry = SPEECH_LIST.find((m) => m.id === model);
  if (!entry) return null;
  const base = SPEECH_LIST.find((m) => m.id === model.slice(0, Math.max(0, model.lastIndexOf(':'))));
  return entry.supported_voices ?? base?.supported_voices ?? [];
}

/**
 * OpenRouter's refusal of a POST /audio/speech body, as { status, type, body }; null when its answer is audio (the test sends it).
 * @param {{ model: string, voice?: string | null }} request
 */
export function refusal({ model, voice }) {
  if (model.startsWith('fish-audio/')) return null; // takes any voice of its library, or none
  const voices = listedVoices(model);
  if (!voices) return UNKNOWN_MODEL;
  if (!voice) {
    if (probe.accepted[model]?.voice === null) return null;
    if (!ASKED_NO_VOICE.test(model)) throw new Error(`no recorded answer for ${model} with no voice`);
    return reply(model.startsWith('heygen/') ? probe.refusedNoVoice.heygen : probe.refusedNoVoice.other);
  }
  if (voices.includes(voice)) return null;
  if (voice === KATKAT && probe.refusedKatKat[model]) return reply(probe.refusedKatKat[model]);
  throw new Error(`no recorded answer for ${model} with the voice ${voice}`);
}
