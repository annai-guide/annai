/**
 * Nominatim allows one request a second to the whole app (its usage policy; spec §7.2). Every part of annai that asks it,
 * the places tools and free search's floor, takes its turn here.
 */

/** The gap between two requests, a little more than a second. */
export const NOMINATIM_GAP = { ms: 1100 };

let next = 0;

/** Resolves when it is this request's turn; the next one's turn is a gap later. */
export async function nominatimTurn() {
  const wait = next - Date.now();
  next = Math.max(Date.now(), next) + NOMINATIM_GAP.ms;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Forgets the turns taken: for tests that don't want to wait for an earlier one's. */
export function nominatimReset() {
  next = 0;
}
