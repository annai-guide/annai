import { chatType } from './chat.js';
import { transcriptionType, speechType } from './speech.js';

/**
 * Gemini's own API (spec §9.1): the Interactions API at generativelanguage.googleapis.com, with the
 * key in a header. It registers the `gemini` chat type, and transcription and voice types (G3);
 * provider-gemini uses them in place of Chat Completions, so every audio format goes in, Gemini 3's
 * thought signatures come back exactly, and Shiori's voice can stream.
 * @param {any} annai
 */
export function activate(annai) {
  const offs = [chatType(annai), transcriptionType(annai), speechType(annai)].map((t) => annai.providers.register(t));
  return () => { for (const off of offs) off(); };
}
