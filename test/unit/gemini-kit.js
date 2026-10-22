import { activate } from '../../plugins-official/gemini-api/index.js';
import { sse } from '../../src/core/llm/sse.js';
import { parsePartialJSON } from '../../src/core/llm/partial-json.js';
import { retry } from '../../src/core/llm/retry.js';
import { ProviderError, errorFromResponse } from '../../src/core/llm/contract.js';
import { toBase64, fromBase64 } from '../../src/core/bytes.js';
import { g711 } from '../../src/core/voice/g711.js';
import { encodeWav, pcm16 } from '../../src/core/voice/pcm.js';

/**
 * The gemini-api plugin's endpoint types, registered the way annai's plugin host would, by type id.
 * @param {{ settings?: { get: () => Promise<any>, set: (changes: any) => Promise<unknown> } }} [o] its own settings (none: nothing kept)
 * @returns {Map<string, any>}
 */
export function loadTypes({ settings } = {}) {
  /** @type {Map<string, any>} */
  const types = new Map();
  activate({ providers: { register: (/** @type {any} */ t) => { types.set(t.type, { ...t, pluginId: 'gemini-api' }); return () => {}; } }, helpers: { sse, parsePartialJSON, ProviderError, errorFromResponse, retry, base64: { encode: toBase64, decode: fromBase64 }, g711, wav: { encode: encodeWav, decode: pcm16 } }, settings });
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

/**
 * A trip in a memory workspace with annai's record formats and Shiori's file tools (write, patch, …), as she has them,
 * to run calls Gemini made. @returns {Promise<{ ws: any, trip: string, tools: Record<string, any>, run: (name: string, input: any) => Promise<any> }>}
 */
export async function tripFiles() {
  const { Registry } = await import('../../src/core/registry.js');
  const { createMemoryStore } = await import('../../src/core/store-memory.js');
  const { Workspace } = await import('../../src/core/workspace.js');
  const { makeSchemaFor } = await import('../../src/core/schema.js');
  const { kindOf, ensureBaseScopes, createTrip } = await import('../../src/core/scopes.js');
  const { PluginHost } = await import('../../src/core/plugins.js');
  const registry = new Registry();
  const ws = new Workspace(createMemoryStore(), { schemaFor: makeSchemaFor(registry, kindOf) });
  await ensureBaseScopes(ws);
  const host = new PluginHost({ registry, workspace: ws, importModule: (/** @type {string} */ u) => import(u) });
  await host.addBuiltin(new URL('../../src/plugins/core-schemas/index.js', import.meta.url).href);
  await host.addBuiltin(new URL('../../src/plugins/files/index.js', import.meta.url).href);
  const trip = await createTrip(ws, { title: 'Big Sur' });
  /** @type {Record<string, any>} */
  const tools = Object.fromEntries(registry.entries('tool').map((/** @type {any} */ e) => [e.item.name, e.item]));
  const run = (/** @type {string} */ name, /** @type {any} */ input) => tools[name].run(input, { scope: trip, trip, signal: new AbortController().signal, model: { input: ['text'] }, wake: 'w', author: 'shiori' });
  return { ws, trip, tools, run };
}
