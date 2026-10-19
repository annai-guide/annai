/**
 * Reasoning levels (spec §9.3). Each model maps levels to a request patch; a level the map lacks
 * uses the nearest one it has, and on a tie the cheaper.
 */
export const LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max']);

/** Each role's default level, which the user can change. Koe answers at once, so it thinks little (the user, 2026-10-19: low over off). */
export const ROLE_LEVELS = Object.freeze({ main: 'medium', utility: 'low', decide: 'off', koe: 'low' });

/** @param {Record<string, any> | undefined} map @param {string} level @returns {string | null} */
export function nearestLevel(map, level) {
  const have = LEVELS.filter((l) => map && Object.hasOwn(map, l));
  if (!have.length) return null;
  const want = Math.max(0, LEVELS.indexOf(level));
  let best = have[0];
  for (const l of have) {
    const d = Math.abs(LEVELS.indexOf(l) - want);
    const bd = Math.abs(LEVELS.indexOf(best) - want);
    if (d < bd || (d === bd && LEVELS.indexOf(l) < LEVELS.indexOf(best))) best = l;
  }
  return best;
}

/** The request patch for a level, or null when the model has no reasoning map. @param {Record<string, any> | undefined} map @param {string} level */
export function levelPatch(map, level) {
  const l = nearestLevel(map, level);
  return l && map ? map[l] : null;
}
