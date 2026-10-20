import { chatType } from './chat.js';

/**
 * Gemini's own API (spec §9.1): the Interactions API at generativelanguage.googleapis.com, with the
 * key in a header. It registers the `gemini` chat type; provider-gemini uses it in place of Chat
 * Completions, so every audio format goes in and Gemini 3's thought signatures come back exactly.
 * @param {any} annai
 */
export function activate(annai) {
  return annai.providers.register(chatType(annai));
}
