import { isPluginBug } from '../registry.js';
import { KINDS } from './contract.js';

/**
 * The provider contract (decision 15; docs/plugins.md, "Model providers with code"): a provider
 * plugin's setup, registered once as 'provider-setup'. panel and returned are drawn and called by
 * src/ui/provider-setup.js; classify, headers and list adjust how its abilities are called.
 * @typedef {{ panel?: Function, keyField: boolean, returned?: Function, classify?: (status: number, body: string, ability: string) => string | null,
 *   headers?: (ability: string) => Record<string, string>, list?: (c: any) => Promise<import('./contract.js').ListedModel[]> }} Setup
 */

/** What is wrong with a setup, or null. @param {any} item */
export function checkSetup(item) {
  if (!item || typeof item !== 'object') /* en */ return 'providers.setup needs an object';
  for (const p of ['panel', 'returned', 'classify', 'headers', 'list']) if (item[p] !== undefined && typeof item[p] !== 'function') /* en */ return `providers.setup: ${p} must be a function`;
  if (item.keyField !== undefined && typeof item.keyField !== 'boolean') /* en */ return 'providers.setup: keyField must be true or false';
  return null;
}

/** A running plugin's setup, or null. @param {import('../registry.js').Registry | undefined} registry @param {string} pluginId @returns {Setup | null} */
export function setupOf(registry, pluginId) {
  return registry?.entries('provider-setup').find((e) => e.pluginId === pluginId)?.item ?? null;
}

/** A part of a setup run; a bug in it counts against its plugin (spec §5.5) and gives null. @param {any} registry @param {string} pluginId @param {string} what @param {() => any} fn */
function guarded(registry, pluginId, what, fn) {
  try {
    return fn();
  } catch (e) {
    if (!isPluginBug(e)) throw e;
    registry?.fail(pluginId, what, e);
    return null;
  }
}

/**
 * One ability's call as its plugin's setup adjusts it: its headers join the ability's, but never one
 * that carries the key (authorization, x-api-key, the provider's keyHeader: protocols put their own
 * headers after the key's), and its classify is asked before the protocol's.
 * @param {import('../registry.js').Registry | undefined} registry @param {string} pluginId @param {import('./contract.js').EndpointType} type
 * @param {import('./config.js').Endpoint} endpoint @param {string} [keyHeader]
 */
export function adjusted(registry, pluginId, type, endpoint, keyHeader = '') {
  const s = setupOf(registry, pluginId);
  /* en */ const own = s?.headers && guarded(registry, pluginId, 'provider headers', () => s.headers?.(endpoint.ability));
  const keys = ['authorization', 'x-api-key', keyHeader.toLowerCase()];
  const headers = Object.fromEntries(Object.entries(own && typeof own === 'object' ? own : {}).filter(([k, v]) => typeof v === 'string' && !keys.includes(k.toLowerCase())));
  const classify = s?.classify;
  return {
    type: classify ? { ...type, classify: (/** @type {number} */ status, /** @type {string} */ body) => {
      /* en */ const kind = guarded(registry, pluginId, 'provider classify', () => classify(status, body, endpoint.ability));
      return KINDS.has(kind) ? kind : type.classify?.(status, body) ?? null; // only a kind annai knows
    } } : type,
    endpoint: Object.keys(headers).length ? { ...endpoint, headers: { ...endpoint.headers, ...headers } } : endpoint,
  };
}
