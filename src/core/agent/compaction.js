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
export function requestBytes(request) {
  return JSON.stringify(request).length;
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

/** What Shiori is asked to do, as the request's tail. @param {string} marker */
export function instruction(marker) {
  return `[annai: housekeeping] The conversation is getting long. Write a summary of it up to (not including) ${marker}, to replace that part. `
    + 'Keep what matters for the rest of the trip: decisions, plans, preferences, open questions, places and times, and what each tool found. '
    + 'For every photo, write one line with its path and what was said about it, like "/trip/files/2026-11-26-1904.webp: the Nepenthe menu, prices circled". '
    + 'Before you write it, you may move lasting facts into /me/memory.md or /trip/memory.md with your file tools; no other tool works now. '
    + 'Then reply with the summary only, as plain text, in the user\'s language.';
}

export const COLD_SYSTEM = 'You summarize a conversation between a traveler and Shiori, their guide in the annai app. '
  + 'Keep what matters for the rest of the trip: decisions, plans, preferences, open questions, places and times, and what each tool found. '
  + 'For every photo, write one line with its path and what was said about it. Reply with the summary only, as plain text, in the user\'s language.';

/** A conversation as plain text for the utility model. @param {Message[]} messages */
export function renderForSummary(messages) {
  const cut = (/** @type {string} */ s, /** @type {number} */ n) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return messages.map((m) => m.parts.map((p) => {
    if (p.type === 'text') return `${m.role === 'user' ? 'User' : 'Shiori (notes)'}: ${p.text}`;
    if (p.type === 'tool_call') return `Shiori → ${p.name}(${cut(JSON.stringify(p.input ?? {}), 300)})`;
    if (p.type === 'tool_result') return `← ${cut(String(p.content), 1500)}`;
    if (p.type === 'image') return '[a photo]';
    if (p.type === 'document') return '[a PDF]';
    return '';
  }).filter(Boolean).join('\n')).join('\n\n');
}
