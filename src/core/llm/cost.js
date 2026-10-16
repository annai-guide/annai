/**
 * Usage and cost (spec §9.9). Prices are USD per million tokens. A tier replaces the base prices
 * when the prompt is longer than its `above` tokens, as some providers charge more for long prompts.
 * @typedef {import('./contract.js').Usage} Usage
 * @typedef {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, cacheWrite1h?: number }} PriceSet
 * @typedef {PriceSet & { tiers?: (PriceSet & { above: number })[] }} Prices
 */

/** @type {Readonly<Usage>} */
export const NO_USAGE = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });
const FIELDS = /** @type {const} */ (['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output', 'reasoning']);

/**
 * The usage a stream reported so far, updated by a later report: each number given replaces the
 * earlier one (providers report running totals).
 * @param {Usage} acc @param {Partial<Usage>} part @returns {Usage}
 */
export function mergeUsage(acc, part) {
  const out = { ...acc };
  for (const k of FIELDS) {
    const v = part[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  if (typeof part.cost === 'number' && Number.isFinite(part.cost)) out.cost = part.cost;
  if (part.serverTools && typeof part.serverTools === 'object') out.serverTools = { ...(acc.serverTools ?? {}), ...part.serverTools };
  return out;
}

/** The tokens of two calls added up (costs are added with addCost). @param {Partial<Usage>} a @param {Partial<Usage>} b @returns {Usage} */
export function addUsage(a, b) {
  const out = { ...NO_USAGE };
  for (const k of FIELDS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  const tools = { ...(a.serverTools ?? {}) };
  for (const [k, n] of Object.entries(b.serverTools ?? {})) tools[k] = (tools[k] ?? 0) + n;
  if (Object.keys(tools).length) out.serverTools = tools;
  return out;
}

/**
 * The cost of a call in USD: what the provider reported, else usage × prices. Undefined when
 * neither is known. Cache prices the model doesn't list cost what input costs. The provider's own
 * tools add their price per call (spec §9.5).
 * @param {Usage} usage @param {Prices | null | undefined} prices
 * @param {{ pricePerCall?: number, usageKey?: string }[]} [providerTools] @returns {number | undefined}
 */
export function costOf(usage, prices, providerTools = []) {
  if (typeof usage.cost === 'number') return usage.cost;
  let calls = 0;
  for (const t of providerTools) if (t.usageKey && t.pricePerCall) calls += (usage.serverTools?.[t.usageKey] ?? 0) * t.pricePerCall;
  if (!prices) return calls || undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h;
  const tier = (prices.tiers ?? []).filter((t) => prompt > t.above).sort((x, y) => y.above - x.above)[0];
  const p = { ...prices, ...tier };
  const input = p.input ?? 0;
  const per = (/** @type {number} */ n, /** @type {number | undefined} */ price) => (n * (price ?? 0)) / 1e6;
  return per(usage.input, input) + per(usage.cacheRead, p.cacheRead ?? input) + per(usage.cacheWrite, p.cacheWrite ?? input)
    + per(usage.cacheWrite1h, p.cacheWrite1h ?? p.cacheWrite ?? input) + per(usage.output, p.output) + calls;
}

/** Two costs added up; unknown only when both are. @param {number | undefined} a @param {number | undefined} b */
export function addCost(a, b) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
