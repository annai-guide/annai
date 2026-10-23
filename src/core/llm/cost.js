/**
 * Usage and cost (spec §9.9). Prices are USD per million tokens. A tier replaces the base prices
 * when the prompt is longer than its `above` tokens, as some providers charge more for long prompts.
 * @typedef {import('./contract.js').Usage} Usage
 * @typedef {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number, cacheWrite1h?: number, audioIn?: number, audioOut?: number, image?: number, cacheReadAudio?: number, cacheReadImage?: number }} PriceSet
 *   audioIn, audioOut, image: a realtime model's audio tokens, and its image and video tokens (K4), else priced as input and output; cacheReadAudio, cacheReadImage: cached audio and images (K6)
 * @typedef {PriceSet & { tiers?: (PriceSet & { above: number })[], perMinute?: number, perMillionChars?: number, minSeconds?: number }} PriceFields
 * @typedef {PriceFields & { schedule?: (PriceFields & { from: string })[] }} Prices
 *   perMinute: USD per minute of audio transcribed (at least minSeconds a request); perMillionChars: USD per million characters a voice says;
 *   schedule: prices that start on a date (`from`, YYYY-MM-DD, UTC midnight): from then each entry's fields replace the base ones, the latest date last
 */

/**
 * The prices in force at a time: the base, with the fields of each schedule entry that has started laid over it, in date order.
 * An entry whose date is not a real date never applies.
 * @param {Prices} prices @param {number} at ms since 1970 @returns {PriceFields}
 */
export function pricesAt(prices, at) {
  const { schedule, ...base } = prices;
  const started = (schedule ?? [])
    .map(({ from, ...entry }) => ({ start: /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? Date.parse(`${from}T00:00:00Z`) : NaN, entry }))
    .filter((e) => e.start <= at)
    .sort((a, b) => a.start - b.start);
  return Object.assign(base, ...started.map((e) => e.entry));
}

/** @type {Readonly<Usage>} */
export const NO_USAGE = Object.freeze({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });
const FIELDS = /** @type {const} */ (['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output', 'reasoning']);
/** A realtime model's audio, and image and video, tokens: in a usage only when a report gives them. */
const AUDIO = /** @type {const} */ (['audioIn', 'audioOut', 'image', 'cacheReadAudio', 'cacheReadImage']);

/**
 * The usage a stream reported so far, updated by a later report: each number given replaces the
 * earlier one (providers report running totals).
 * @param {Usage} acc @param {Partial<Usage>} part @returns {Usage}
 */
export function mergeUsage(acc, part) {
  const out = { ...acc };
  for (const k of [...FIELDS, ...AUDIO]) {
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
  for (const k of AUDIO) if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  const tools = { ...(a.serverTools ?? {}) };
  for (const [k, n] of Object.entries(b.serverTools ?? {})) tools[k] = (tools[k] ?? 0) + n;
  if (Object.keys(tools).length) out.serverTools = tools;
  return out;
}

/**
 * The cost of a call in USD: what the provider reported, else usage × prices. Undefined when
 * neither is known. Cache prices the model doesn't list cost what input costs. The provider's own
 * tools add their price per call (spec §9.5). at: when the call was made, for prices that start on a date.
 * @param {Usage} usage @param {Prices | null | undefined} prices
 * @param {{ pricePerCall?: number, usageKey?: string }[]} [providerTools] @param {number} [at] @returns {number | undefined}
 */
export function costOf(usage, prices, providerTools = [], at = Date.now()) {
  if (typeof usage.cost === 'number') return usage.cost;
  let calls = 0;
  for (const t of providerTools) if (t.usageKey && t.pricePerCall) calls += (usage.serverTools?.[t.usageKey] ?? 0) * t.pricePerCall;
  if (!prices) return calls || undefined;
  const now = pricesAt(prices, at);
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite + usage.cacheWrite1h;
  const tier = (now.tiers ?? []).filter((t) => prompt > t.above).sort((x, y) => y.above - x.above)[0];
  const p = { ...now, ...tier };
  const input = p.input ?? 0;
  const per = (/** @type {number} */ n, /** @type {number | undefined} */ price) => (n * (price ?? 0)) / 1e6;
  return per(usage.input, input) + per(usage.cacheRead, p.cacheRead ?? input) + per(usage.cacheWrite, p.cacheWrite ?? input)
    + per(usage.cacheWrite1h, p.cacheWrite1h ?? p.cacheWrite ?? input) + per(usage.output, p.output)
    + per(usage.audioIn ?? 0, p.audioIn ?? input) + per(usage.audioOut ?? 0, p.audioOut ?? p.output) + per(usage.image ?? 0, p.image ?? input)
    + per(usage.cacheReadAudio ?? 0, p.cacheReadAudio ?? p.cacheRead ?? p.audioIn ?? input) + per(usage.cacheReadImage ?? 0, p.cacheReadImage ?? p.cacheRead ?? p.image ?? input) + calls;
}

/** Two costs added up; unknown only when both are. @param {number | undefined} a @param {number | undefined} b */
export function addCost(a, b) {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/**
 * The cost of one speech call in USD (spec §9.9): a transcription by the minute of audio, a voice
 * by the character. Undefined when the model has no such price.

 * @param {Prices | null | undefined} prices @param {{ seconds?: number, chars?: number, at?: number }} amount at: when the call was made
 */
export function speechCost(prices, { seconds, chars, at = Date.now() }) {
  if (!prices) return undefined;
  prices = pricesAt(prices, at);
  if (seconds !== undefined && typeof prices.perMinute === 'number') return (Math.max(seconds, prices.minSeconds ?? 0) * prices.perMinute) / 60;
  if (chars !== undefined && typeof prices.perMillionChars === 'number') return (chars * prices.perMillionChars) / 1e6;
  return undefined;
}
