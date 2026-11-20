/**
 * Nominatim allows one request a second to the whole app (its usage policy; spec §7.2). Every part of annai that asks it,
 * the places tools and free search's floor, takes its turn here.
 */

/** The gap between two requests, a little more than a second. */
export const NOMINATIM_GAP = { ms: 1100 };

let next = 0;

/** Resolves at this request's turn, the next a gap later. A signal ends the wait, rejecting (a turn it booked stays booked). @param {AbortSignal} [signal] */
export async function nominatimTurn(signal) {
  signal?.throwIfAborted();
  const wait = next - Date.now();
  next = Math.max(Date.now(), next) + NOMINATIM_GAP.ms;
  if (wait > 0) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)));
    });
  }
}

/** Nominatim's accept-language: the order's languages, each then its ISO code (zh-Hant, then zh; ISO 639-1 where there is one, as Cantonese's yue is ISO 639-3), so a name tagged by either is found. @param {import('./languages.js').Language[]} order */
export const nominatimLanguages = (order) => [...new Set(order.flatMap((l) => [l.id, l.iso]))].join(',');

/** Forgets the turns taken: for tests that don't want to wait for an earlier one's. */
export function nominatimReset() {
  next = 0;
}
