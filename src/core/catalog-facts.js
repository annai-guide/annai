/**
 * A plugin's facts in the catalog (spec §5.3), for annai's and an installed one alike.
 * @typedef {{ id: string, name: string, version: string, description: string, category: string, keywords: string[], abilities: string[],
 *   free: boolean, local: boolean, code: boolean, size: number, requires: import('./packages.js').Requirement[] }} CatalogFacts
 *   abilities: the kinds of a provider's abilities, in order, once each; free: a model of it costs nothing; size: its files' bytes
 */

/** Whether prices say a model costs nothing: every price there is 0. @param {any} prices */
function isFree(prices) {
  const numbers = prices && typeof prices === 'object' ? Object.values(prices).filter((v) => typeof v === 'number') : [];
  return numbers.length > 0 && numbers.every((v) => v === 0);
}

/** A plugin's kind when its manifest names none (spec §5.2). @param {any} manifest */
export function categoryOf(manifest) {
  if (manifest.category) return String(manifest.category);
  const kinds = Object.values(manifest.provider?.abilities ?? {}).map((/** @type {any} */ a) => a?.kind);
  if (kinds.includes('chat')) return 'providers';
  if (kinds.length) return 'speech';
  if (manifest.provides?.['storage-type']?.length) return 'backup';
  if (manifest.provides?.['endpoint-type']?.length) return 'developer';
  if (!manifest.entry && (manifest.skills?.length || manifest.personalities?.length)) return 'skills';
  return 'tools';
}

/** The catalog's facts for a plugin. @param {any} manifest @param {{ size?: number }} [o] @returns {CatalogFacts} */
export function catalogFacts(manifest, { size = 0 } = {}) {
  const abilities = Object.values(manifest.provider?.abilities ?? {});
  return {
    id: String(manifest.id), name: String(manifest.name), version: String(manifest.version), description: String(manifest.description ?? ''),
    category: categoryOf(manifest), keywords: Array.isArray(manifest.keywords) ? manifest.keywords.map(String) : [],
    abilities: [...new Set(abilities.map((/** @type {any} */ a) => String(a?.kind)))],
    free: abilities.some((/** @type {any} */ a) => (a?.models ?? []).some((/** @type {any} */ m) => isFree(m?.prices))),
    local: Boolean(manifest.provider?.local), code: Boolean(manifest.entry), size, requires: Array.isArray(manifest.requires) ? manifest.requires : [],
  };
}
