import { NOT_TRANSCRIBED } from '../voice/resolve.js';
import { NO_WORDS } from '../handover.js';
import { EITHER, LANGUAGES, MANDARIN, firstHan, hanRow, languageSettings, named, placed, units } from '../languages.js';
import { nativeOverlap } from '../llm/contract.js';

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

/** A request's size as sent; photos count at their base64 size, a native only for what it adds beyond the parts it covers (nativeOverlap). @param {any} request */
export function requestBytes(request, { uploaded = false } = {}) {
  const twice = nativeOverlap(request.messages ?? []);
  if (!uploaded) return JSON.stringify(request).length - twice;
  // Photos uploaded to the provider count only as their id (spec §6.5).
  return JSON.stringify(request, (_k, v) => (v && typeof v === 'object' && v.type === 'image' && typeof v.data === 'string' ? { ...v, data: 'file_0123456789abcdefghijklmn' } : v)).length - twice;
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

/** What the two Chinese rows are counted under, as one language (no language's id). */
/* en */ const MANDARIN_KEY = 'Mandarin';
/** The languages Han that says neither Japanese nor Chinese may join in the count: Japanese, the two Chinese rows (as one), Cantonese. */
const HAN_KEYS = ['ja', MANDARIN_KEY, 'yue'];
/** With no settings given: the app's language, English (spec §14.3, it ships in English), as a phone set to it with nothing chosen. */
const APP = languageSettings({}, 'en-US');

/**
 * The language a summary is written in, named ("the user's language" got a Spanish summary of an English conversation): compaction's and the
 * recap's, one answer for both (RULES #10). annai's own lines for no words (NO_WORDS: a photo or files sent alone, a heard line it couldn't
 * write down) are never the user's, and are left out here for every caller. With the language Shiori answers in fixed, that one. Else each of
 * the rest of 3 words or more (units: a Chinese, Japanese or Korean character is a word, the size a stray short reply has, spec §10.9) counts
 * once, for the one of the traveller's languages its writing shows (placed: the listed ones, or with nothing chosen the phone's and any a line
 * is plainly in), and a line that shows none of theirs counts for nothing; the language with the most lines is named, and a tie goes to the one
 * written in more recently. No one line decides: a trip's lines are also a closing "Thank you so much!", a place's name, a pasted booking, a
 * tap on a card or a misheard line, and each is one line among the rest (the edge: five English lines then two Japanese are English).
 * Lines of Han that say neither Japanese nor Chinese (a kanji place name; 大家好) join whichever of those has the most lines of its own (a tie:
 * the newer), so a Japanese trip full of kanji names stays Japanese and a Chinese trip Chinese; with none, they are the first of theirs written
 * in Han (the voice's rule: with nothing chosen the phone's, when it is one) where no other line counts, else no one's, whether the languages
 * are chosen or not: an English trip with kanji names is English on a Japanese or Chinese phone too, and a trip of only kanji names and
 * English questions with no kana line is English even on a Japanese phone. A language given that way, by the order and not by any line, is
 * named for that ("the first language the user speaks written in Han"), never as the one most of the lines are in. Both Chinese rows, Simplified and Traditional, are one language here (a trip in both is Chinese), and
 * the row is the one most of the lines that are Chinese by their own characters are in, a line once however long: a tie goes to the newer;
 * none telling, the first listed Chinese row (nothing chosen: the phone's, else Simplified). With no line counted: the first they speak, or
 * with nothing chosen the same answer as for her first message in a conversation (languagesText), the phone's (with no settings given, the
 * app's: spec §14.3, it ships in English).
 * @param {string | string[]} said what the user wrote and said, the newest last, as the log keeps them @param {import('../languages.js').LanguageSettings} [languages]
 */
export function summaryLanguage(said, languages) {
  const lines = (Array.isArray(said) ? said : [said]).map((x) => String(x ?? '').trim()).filter((x) => !NO_WORDS.includes(x));
  if (languages?.answer) /* en */ return `${languages.answer.name}, the language Shiori answers in`;
  const s = languages ?? APP;
  /** @param {import('../languages.js').Language} l */
  const key = (l) => (MANDARIN.includes(l.id) ? MANDARIN_KEY : l.id);
  /** Each language's lines and where its newest one is, with one of its languages to name it by. @type {Map<string, { n: number, last: number, l: import('../languages.js').Language }>} */
  const count = new Map();
  /** @param {string} k @param {import('../languages.js').Language} l @param {number} at @param {number} [n] */
  const add = (k, l, at, n = 1) => { const c = count.get(k); count.set(k, { n: (c?.n ?? 0) + n, last: Math.max(c?.last ?? -1, at), l: c?.l ?? l }); };
  /** The lines counted as Chinese, whose forms name the row where they are Chinese by their own characters (hanRow). @type {string[]} */
  const mandarin = [];
  /** Where each line of Han that says neither is. @type {number[]} */
  const either = [];
  /** Whether Han that says neither alone gave the language, by the list's order (the first they speak written in Han; nothing chosen: the phone's): no line shows it. */
  let byOrder = false;
  lines.forEach((x, at) => {
    const l = units(x) >= 3 ? placed(x, s) : null;
    if (l === EITHER) either.push(at);
    else if (l) add(key(l), l, at);
    if (l && l !== EITHER && key(l) === MANDARIN_KEY) mandarin.push(x);
  });
  /** The language a key has the most lines, ties to the newer: k1 beats k2. @param {string} k1 @param {string} k2 */
  const beats = (k1, k2) => { const [a, b] = [count.get(k1), count.get(k2)]; return !!a && (!b || a.n > b.n || (a.n === b.n && a.last > b.last)); };
  if (either.length) {
    const side = HAN_KEYS.reduce((best, k) => (beats(k, best) ? k : best), '');
    // No line of Japanese or Chinese of its own: the first of theirs written in Han, as the voice reads them (principle 10), only where no other line counts, chosen or not (nothing chosen: the phone's, when it is written in Han).
    const home = count.size ? null : firstHan(s);
    if (side) add(side, /** @type {any} */ (count.get(side)).l, /** @type {number} */ (either.at(-1)), either.length);
    else if (home) { add(key(home), home, /** @type {number} */ (either.at(-1)), either.length); byOrder = true; }
  }
  const most = [...count.keys()].reduce((best, k) => (beats(k, best) ? k : best), '');
  let language = count.get(most)?.l;
  if (most === MANDARIN_KEY) {
    // One of each script is two halves of one language, so the row is the one most of the lines that tell are in, each line once however long (a pasted
    // text is one line among those that tell, and decides when the typed lines tell nothing): a tie goes to the newer; with none that tells, the first
    // listed Chinese row (nothing chosen: the one the lines tell, whatever the phone's).
    const rows = mandarin.map(hanRow).filter(Boolean);
    const simplified = rows.filter((r) => r === 'zh').length * 2 - rows.length;
    const row = simplified > 0 ? 'zh' : simplified < 0 ? 'zh-Hant' : rows.at(-1);
    language = s.spoken.find((l) => l.id === row) ?? (row && !s.explicit ? LANGUAGES.find((l) => l.id === row) : s.spoken.find((l) => MANDARIN.includes(l.id))) ?? language;
  }
  // Han that says neither Japanese nor Chinese, with no other line: the order decided, so the request says that, not that the lines are in it (the first commits' words for the first listed).
  if (language && byOrder) {
    /* en */
    const by = languages?.explicit ? 'the first language the user speaks written in Han' : "the language of the user's phone";
    /* en */
    return `${language.name}, ${by} (what the user wrote is Han, which doesn't tell Japanese from Chinese)`;
  }
  if (language) /* en */ return `${language.name}, the language most of what the user wrote is in`;
  if (languages?.explicit) /* en */ return `${languages.spoken[0].name}, the first language the user speaks (${named(languages.spoken)})`;
  // Nothing chosen and no line of theirs counts: the same answer as the Languages section's (languagesText), the phone's. Never a quoted line.
  /* en */
  const why = lines.length ? 'nothing the user wrote names a language' : "the user hasn't written anything yet";
  /* en */
  return `${languages ? `${languages.spoken[0].name}, the language of the user's phone` : "English, the app's language"} (${why})`;
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
