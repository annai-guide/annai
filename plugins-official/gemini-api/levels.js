/**
 * Gemini's thinking levels by model family, as Google's thinking page documents them (2026-10-19),
 * as annai's reasoning maps (spec §9.3): off, low, medium, high and max as minimal, low, medium, high
 * and high. A family without minimal has no off, so annai's nearest-level rule asks it for low.
 * Aliases Google answers as another model (3.5-flash as 3.6-flash, 3.7-flash as 3.8-flash) have its levels.
 * gemini-4-argon is from that page's table, not checked with a call. The 2.5 models have none: the page
 * lists them, but Google refuses them to new users (404, 2026-10-19), so their thinking_level was never checked.
 */
const FAMILIES = /** @type {[string[], string[]][]} */ ([
  [['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-robotics-er-2'], ['minimal', 'low', 'medium', 'high']],
  [['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-4-argon', 'gemini-3.1-pro'], ['low', 'medium', 'high']],
  [['gemini-3-pro'], ['low', 'high']],
]);
/** Families that think with no levels annai knows: Gemma 4 takes thought summaries and thinks (measured 2026-10-20). */
const THINKERS = ['gemma-4'];
/** @param {string} id @param {string[]} ids */
const inFamily = (id, ids) => ids.some((f) => id === f || id.startsWith(`${f}-`));
const ANNAI = /** @type {Record<string, string>} */ ({ minimal: 'off', low: 'low', medium: 'medium', high: 'high' });

/** @param {string} level */
const patch = (level) => ({ generation_config: { thinking_level: level } });

/**
 * A model's reasoning map, from its family; undefined for a family Google documents no levels for,
 * which then thinks as it chooses ("Test reasoning levels" finds what it takes).
 * @param {string} providerId @returns {Record<string, any> | undefined}
 */
export function levelsFor(providerId) {
  const id = String(providerId).replace(/^models\//, '');
  const family = FAMILIES.find(([ids]) => inFamily(id, ids));
  if (!family) return undefined;
  const map = Object.fromEntries(family[1].map((l) => [ANNAI[l], patch(l)]));
  return { ...map, max: patch('high') };
}

/** Whether a model's family thinks, as far as annai knows: one with levels, or one of THINKERS. @param {string} providerId */
export function thinks(providerId) {
  const id = String(providerId).replace(/^models\//, '');
  return levelsFor(id) !== undefined || inFamily(id, THINKERS);
}
