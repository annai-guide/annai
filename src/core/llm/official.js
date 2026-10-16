import { sha256Hex } from '../hash.js';
import { PluginError } from '../registry.js';
import { endpointTypes } from './contract.js';

/**
 * annai's official on-demand plugins (spec §5.3, §9.1): listed in /catalog/plugins.json with the
 * SHA-256 of every file, fetched from /plugins-official/<id>/ on annai's own origin, checked, then
 * installed like any plugin. Choosing an endpoint type whose plugin is missing installs it.
 * @typedef {import('../plugins.js').PluginHost} PluginHost
 * @typedef {{ id: string, name: string, version: string, provides: Record<string, string[]>, files: Record<string, string> }} CatalogPlugin
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string }} FetchOptions
 */

const defaultFetch = (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => fetch(url, init);

/** @param {FetchOptions} [opts] @returns {Promise<CatalogPlugin[]>} */
export async function officialPlugins({ fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await get(`${base}/catalog/plugins.json`, { cache: 'no-cache' });
  } catch {
    throw new PluginError('catalog', "annai's list of plugins couldn't be loaded. Check the connection and try again.");
  }
  if (!res.ok) throw new PluginError('catalog', `annai's list of plugins couldn't be loaded (HTTP ${res.status}). Try again later.`);
  const json = await res.json();
  return Array.isArray(json?.plugins) ? json.plugins : [];
}

/**
 * Downloads one official plugin and checks every file against the catalog; nothing is returned
 * unless all of them match.
 * @param {CatalogPlugin} entry @param {FetchOptions} [opts] @returns {Promise<Map<string, Uint8Array>>}
 */
async function download(entry, { fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [name, hash] of Object.entries(entry.files)) {
    const url = `${base}/plugins-official/${encodeURIComponent(entry.id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    /** @type {Response} */
    let res;
    try {
      res = await get(url, { cache: 'no-cache' });
    } catch {
      throw new PluginError(entry.id, "couldn't be downloaded. Check the connection and try again.");
    }
    if (!res.ok) throw new PluginError(entry.id, `couldn't be downloaded (${name}: HTTP ${res.status}). Try again later.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash) throw new PluginError(entry.id, `wasn't installed: ${name} doesn't match annai's catalog`);
    files.set(name, bytes);
  }
  return files;
}

/** Downloads, checks and installs one official plugin, then starts it. @param {PluginHost} host @param {CatalogPlugin} entry @param {FetchOptions} [opts] */
export async function installOfficial(host, entry, opts = {}) {
  await host.install(await download(entry, opts), { source: 'official' });
  await host.start(entry.id);
}

/**
 * Official plugins that annai's catalog has another version of (spec §5.3). They are offered;
 * nothing changes until the user accepts. Plugins installed from a file aren't checked.
 * @param {PluginHost} host @param {FetchOptions} [opts]
 * @returns {Promise<{ id: string, name: string, installed: string, available: string, entry: CatalogPlugin }[]>}
 */
export async function officialUpdates(host, opts = {}) {
  const state = await host.installed();
  return (await officialPlugins(opts))
    .filter((p) => state[p.id]?.source === 'official' && state[p.id].version !== p.version)
    .map((p) => ({ id: p.id, name: p.name, installed: state[p.id].version, available: p.version, entry: p }));
}

/**
 * Installs the catalog's version of an official plugin the user chose to update, keeping their
 * on/off choice. New code that replaces code already running starts with the next start of annai.
 * @param {PluginHost} host @param {CatalogPlugin} entry @param {FetchOptions} [opts] @returns {Promise<'started' | 'restart'>}
 */
export async function updateOfficial(host, entry, opts = {}) {
  const wasOn = (await host.installed())[entry.id]?.enabled !== false;
  await host.install(await download(entry, opts), { source: 'official' });
  if (!wasOn) {
    await host.setEnabled(entry.id, false);
    return 'started';
  }
  if (host.needsRestart(entry.id)) return 'restart';
  await host.start(entry.id);
  return 'started';
}

/**
 * Makes an endpoint type available. Nothing to do when a running plugin provides it. Otherwise it
 * starts the installed official plugin that provides it, or installs the catalog's version.
 * @param {PluginHost} host @param {string} type @param {FetchOptions} [opts]
 */
export function ensureType(host, type, opts = {}) {
  if (endpointTypes(host.registry).has(type)) return Promise.resolve();
  // Two callers at once share one install: a second install would stop the plugin the first one started.
  const running = inFlight.get(host) ?? new Map();
  inFlight.set(host, running);
  const had = running.get(type);
  if (had) return had;
  const work = ensureNow(host, type, opts).finally(() => running.delete(type));
  running.set(type, work);
  return work;
}

/** Installs or starts what provides a type, once per host and type at a time. @type {WeakMap<PluginHost, Map<string, Promise<void>>>} */
const inFlight = new WeakMap();

/** @param {PluginHost} host @param {string} type @param {FetchOptions} opts */
async function ensureNow(host, type, opts) {
  const entry = (await officialPlugins(opts)).find((p) => p.provides?.['endpoint-type']?.includes(type));
  if (!entry) throw new PluginError(type, "isn't an endpoint type annai knows. Install a plugin that provides it.");
  const state = (await host.installed())[entry.id];
  if (state && state.version === entry.version) {
    if (!state.enabled) await host.setEnabled(entry.id, true);
    else await host.start(entry.id);
  } else {
    await installOfficial(host, entry, opts);
  }
  if (!endpointTypes(host.registry).has(type)) throw new PluginError(entry.id, `didn't provide the endpoint type ${type}`);
}
