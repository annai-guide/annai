import { activate } from '../../plugins-official/gemini-api/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';

/** The gemini-api plugin's endpoint types, registered the way annai's plugin host would, by type id. @returns {Map<string, any>} */
export function loadTypes() {
  /** @type {Map<string, any>} */
  const types = new Map();
  activate({ providers: { register: (/** @type {any} */ t) => { types.set(t.type, { ...t, pluginId: 'gemini-api' }); return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry } });
  return types;
}

/** The chat type. @returns {any} */
export const loadGemini = () => loadTypes().get('gemini');

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
