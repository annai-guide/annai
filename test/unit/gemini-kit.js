import { activate } from '../../plugins-official/gemini-api/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/**
 * The gemini-api plugin's endpoint types, registered the way annai's plugin host would, by type id.
 * @param {{ settings?: { get: () => Promise<any>, set: (changes: any) => Promise<unknown> } }} [o] its own settings (none: nothing kept)
 * @returns {Map<string, any>}
 */
export function loadTypes({ settings } = {}) {
  /** @type {Map<string, any>} */
  const types = new Map();
  activate({ providers: { register: (/** @type {any} */ t) => { types.set(t.type, { ...t, pluginId: 'gemini-api' }); return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry }, settings });
  return types;
}

/** The chat type. @param {Parameters<typeof loadTypes>[0]} [o] @returns {any} */
export const loadGemini = (o) => loadTypes(o).get('gemini');

/** A plugin's own settings, as annai.settings keeps them (a merge into one file), in memory. */
export function memorySettings() {
  /** @type {Record<string, any>} */
  let saved = {};
  return { get: async () => structuredClone(saved), set: async (/** @type {Record<string, any>} */ changes) => { saved = { ...saved, ...structuredClone(changes) }; }, saved: () => saved };
}

export const KEY = 'AIza-stand-in-gemini-key-0123456789';
/** @param {any} type @param {any} [over] */
export const endpointOf = (type, over = {}) => ({ id: 'pv-g/chat', provider: 'pv-g', ability: 'chat', type: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/', headers: {}, tunables: { ...type.tunables }, extraBody: {}, ...over });
/** @param {any} [over] */
export const modelOf = (over = {}) => ({
  id: 'm-g', provider: 'pv-g', ability: 'chat', name: 'Gemini 3.5 Flash Lite', providerId: 'gemini-3.5-flash-lite', input: ['text', 'image', 'pdf', 'audio'], tools: true,
  contextWindow: 1048576, maxOutput: 65536, prices: null, cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {}, ...over,
});
/** A spec for one call. @param {any} type @param {any} [over] */
export const spec = (type, over = {}) => ({ endpoint: endpointOf(type), model: modelOf(), key: KEY, tunables: { ...type.tunables }, request: { messages: [] }, ...over });
