import { NOT_TRANSCRIBED } from '../voice/resolve.js';
import { languageOf, listedFor, named } from '../languages.js';

export { languageOf };

/**
 * Housekeeping (spec §6.5). Two limits trigger it, the context window and the maximum request
 * size: it is due at a threshold and forced before an overflow. The older part becomes a compaction
 * event; the most recent part stays word for word. Warm, the model holding the cache writes the
 * summary from the cached conversation; cold, the utility model writes it from the text.
 * @typedef {import('../llm/contract.js').Message} Message
 */

export const KEEP_EXCHANGES = 3;
/** Warm housekeeping runs this long before the cache would expire. */
export const WARM_LEAD_MS = 45_000;

/** The prompt a call sent, in tokens, from what the provider reported. @param {any} u */
export function promptTokens(u) {
  return (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0) + (u?.cacheWrite1h ?? 0);
}

/** A request's size as sent; photos count at their base64 size. @param {any} request */
export function requestBytes(request, { uploaded = false } = {}) {
  if (!uploaded) return JSON.stringify(request).length;
  // Photos uploaded to the provider count only as their id (spec §6.5).
  return JSON.stringify(request, (_k, v) => (v && typeof v === 'object' && v.type === 'image' && typeof v.data === 'string' ? { ...v, data: 'file_0123456789abcdefghijklmn' } : v)).length;
}

/**
 * @param {{ tokens: number, window: number | null, bytes: number, maxBytes: number, threshold: number }} c
 * @returns {'forced' | 'due' | null}
 */
export function compactionNeed({ tokens, window, bytes, maxBytes, threshold }) {
  if ((window && tokens > 0.9 * window) || bytes > maxBytes) return 'forced';
  if ((window && tokens >= threshold * window) || bytes >= threshold * maxBytes) return 'due';
  return null;
}

/**
 * Where to cut: the seq of the first event kept. The kept part is about keepTokens and never fewer
 * than minExchanges exchanges (an exchange starts at a wake); the oldest exchange is always
 * compacted. Null when there is nothing to compact.
 * @param {{ seq: number, tokens: number, exchange: boolean }[]} items oldest first
 * @param {{ keepTokens: number, minExchanges?: number }} c
 */
export function cutAt(items, { keepTokens, minExchanges = KEEP_EXCHANGES }) {
  const starts = items.filter((i) => i.exchange).length;
  if (starts <= minExchanges) return null;
  let kept = 0;
  let exchanges = 0;
  /** @type {number | null} */
  let cut = null;
  for (let i = items.length - 1; i >= 0; i--) {
    kept += items[i].tokens;
    if (!items[i].exchange) continue;
    exchanges++;
    if (exchanges >= starts) break;
    if (exchanges >= minExchanges) {
      cut = items[i].seq;
      if (kept >= keepTokens) break;
    }
  }
  return cut;
}

/** What Shiori is asked to do, as the request's tail. @param {string} marker @param {string} language summaryLanguage's */
export function instruction(marker, language) {
  /* en */ return `[annai: housekeeping] The conversation is getting long. Write a summary of it up to (not including) ${marker}, to replace that part. `
    + 'Keep what matters for the rest of the trip: decisions, plans, preferences, open questions, places and times, and what each tool found. '
    + 'For every photo, write one line with its path and what was said about it, like "/trip/files/2026-11-26-1904.webp: the Nepenthe menu, prices circled". '
    + 'Before you write it, you may move lasting facts into /me/memory.md or /trip/memory.md with your file tools; no other tool works now. Don\'t search the web now. '
    + `Then reply with the summary only, as plain text, in ${language}.`;
}

/** What the utility model is told. @param {string} language summaryLanguage's */
export const coldSystem = (language) => /* en */ 'You summarize a conversation between a traveler and Shiori, their guide in the annai app. '
  + /* en */ 'Keep what matters for the rest of the trip: decisions, plans, preferences, open questions, places and times, and what each tool found. '
  + /* en */ `For every photo, write one line with its path and what was said about it. Reply with the summary only, as plain text, in ${language}.`;

/**
 * The language a summary is written in, named (emulator pass: "the user's language" got a Spanish summary of an English
 * conversation). With the languages setting (phase 2): the one Shiori answers in if it is fixed; else the listed language the user
 * wrote in last, told from their last message, else their last few together (review A6); else the first they speak. With none: the
 * language the user wrote in last, guessed so; else the app's (spec §14.3: it ships in English).
 * @param {string | string[]} said their last messages, the newest last @param {import('../languages.js').LanguageSettings} [languages]
 */
export function summaryLanguage(said, languages) {
  const lines = (Array.isArray(said) ? said : [said]).map((x) => x.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (languages?.answer) /* en */ return `${languages.answer.name}, the language Shiori answers in`;
  if (languages?.explicit) {
    const guess = last ? languageOf(last) || languageOf(lines.join('\n')) : '';
    const wrote = guess ? listedFor(guess, languages.spoken) : null;
    /* en */ return wrote ? `${wrote.name}, the language the user wrote in last` : `${languages.spoken[0].name}, the first language the user speaks (${named(languages.spoken)})`;
  }
  if (!last) /* en */ return "English, the app's language (the user hasn't written anything yet)";
  const name = languageOf(last) || languageOf(lines.join('\n'));
  /* en */ return name ? `${name}, the language the user wrote in last` : `the language the user wrote in last: ${JSON.stringify(last.slice(0, 80))}`;
}

/** The most text a cold summary is written from when the utility model's window isn't known, in characters (about 100,000 tokens). */
export const SUMMARY_MAX_CHARS = 350_000;

/**
 * A conversation as plain text for the utility model, at most max characters: when longer, its start
 * and its end are kept and the middle is said to be left out, so one huge exchange can't keep the
 * conversation from ever being summarized. @param {Message[]} messages @param {number} [max]
 */
export function renderForSummary(messages, max = Infinity) {
  const full = asText(messages);
  if (full.length <= max) return full;
  const marker = (/** @type {number} */ n) => /* en */ `\n\n[… ${n} characters left out …]\n\n`;
  const room = Math.max(0, max - marker(full.length).length);
  const head = Math.floor(room / 2);
  const tail = room - head;
  return full.slice(0, head) + marker(full.length - head - tail) + full.slice(full.length - tail);
}

/** A photo in words: where it came from, and which part (spec §6.5 stubs). @param {{ path?: string, region?: number[] }} p */
export const photoStub = (p) => `[photo${p.path ? ` ${p.path}` : ''}${p.region ? `, part [${p.region.join(', ')}]` : ''}]`;

/** @param {Message[]} messages */
function asText(messages) {
  const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return messages.map((m) => m.parts.map((p) => {
    if (p.type === 'text') /* en */ return `${m.role === 'user' ? 'User' : 'Shiori (notes)'}: ${p.text}`;
    if (p.type === 'tool_call') /* en */ return `Shiori → ${p.name}(${cut(JSON.stringify(p.input ?? {}), 300)})`;
    if (p.type === 'tool_result') return `← ${cut(String(p.content), 1500)}`;
    if (p.type === 'image') /* en */ return m.role === 'user' ? `User: ${photoStub(p)}` : photoStub(p);
    if (p.type === 'document') /* en */ return '[a PDF]';
    if (p.type === 'speech') /* en */ return `User (spoke): ${p.text ?? NOT_TRANSCRIBED}`;
    if (p.type === 'audio') /* en */ return 'User: [audio]';
    return '';
  }).filter(Boolean).join('\n')).join('\n\n');
}
