/**
 * "Search via" and "fetch via" (spec §9.5): Shiori never sees two competing tools. Provider tools
 * sit next to annai's in the tool list, with the same switches (provider:<id>).
 * @param {{ web: { searchVia?: string, fetchVia?: string }, model: { providerTools?: { id: string, kind: string }[] } | null, switches: Record<string, boolean> }} c
 * @returns {{ hide: string[], kinds: string[], off: string[] }}
 */
export function webVia({ web, model, switches }) {
  const off = (model?.providerTools ?? []).filter((t) => switches[`provider:${t.id}`] === false).map((t) => t.id);
  const has = (/** @type {string} */ kind) => (model?.providerTools ?? []).some((t) => t.kind === kind && !off.includes(t.id));
  /** @type {string[]} */
  const hide = [];
  /** @type {string[]} */
  const kinds = [];
  const search = web.searchVia ?? 'auto';
  if (search === 'off' || ((search === 'provider' || search === 'auto') && has('search'))) hide.push('web_search');
  if ((search === 'provider' || search === 'auto') && has('search')) kinds.push('search');
  const fetchVia = web.fetchVia ?? 'annai';
  if (fetchVia === 'off' || (fetchVia === 'provider' && has('fetch'))) hide.push('fetch');
  if (fetchVia === 'provider' && has('fetch')) kinds.push('fetch');
  return { hide, kinds, off };
}
