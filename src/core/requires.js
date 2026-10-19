import { PluginError } from './registry.js';
import { officialPlugins, download } from './llm/official.js';

/**
 * What a plugin requires (spec §5.3; milestone 1, decision 7): other plugins, by id and a range of
 * the form "^N", the same semver major, which for a protocol plugin is its interface version. An
 * official requirement comes from annai's catalog, hash-checked, with no question; a third-party one
 * must be installed first, from its own address. All or nothing: what one install added is removed
 * again when any part of it fails. Calls never install (decision 9): only adding and setting up do.
 * @typedef {import('./plugins.js').PluginHost} PluginHost
 * @typedef {import('./llm/official.js').CatalogPlugin} CatalogPlugin
 * @typedef {import('./llm/official.js').FetchOptions & { catalog?: CatalogPlugin[], tap?: boolean }} Env
 *   tap: the user's own tap asked for this, so a plugin annai switched off after repeated errors may start again (spec §5.5)
 * @typedef {import('./packages.js').Requirement} Requirement
 */

/** Whether a version is in a range: "^N" is the same major. @param {string} version @param {string} range */
export function satisfies(version, range) {
  const r = /^\^(\d+)$/.exec(String(range));
  const v = /^(\d+)\./.exec(String(version));
  return Boolean(r && v && Number(r[1]) === Number(v[1]));
}

/** Every installed plugin's stored manifest that reads, by id. @param {PluginHost} host */
async function manifests(host) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const id of Object.keys(await host.installed())) {
    const m = await host.manifestOf(id);
    if (m) out[id] = m;
  }
  return out;
}

/** The installed plugins that require one, by id and name. @param {PluginHost} host @param {string} id @returns {Promise<{ id: string, name: string }[]>} */
export async function dependents(host, id) {
  return Object.entries(await manifests(host))
    .filter(([other, m]) => other !== id && Array.isArray(m.requires) && m.requires.some((/** @type {any} */ r) => r?.id === id))
    .map(([other, m]) => ({ id: other, name: String(m.name ?? other) }));
}

/**
 * Refuses a version of a plugin that an installed plugin doesn't accept, naming that plugin: a new
 * protocol major would stop it working. @param {PluginHost} host @param {string} id @param {string} version
 * @param {string} name @param {string} [except] a plugin being replaced in the same install, whose own range is the new one's
 */
export async function refuseBreaking(host, id, version, name, except) {
  for (const [other, m] of Object.entries(await manifests(host))) {
    if (other === id || other === except) continue;
    const r = (Array.isArray(m.requires) ? m.requires : []).find((/** @type {any} */ x) => x?.id === id);
    if (r && !satisfies(version, r.version)) {
      throw new PluginError(id, `version ${version} would stop ${m.name ?? other} working: it needs ${name} ${r.version}. Update ${m.name ?? other} first, or keep this version.`);
    }
  }
}

/**
 * The official plugins to install or update first, in order, for these requirements; nothing is
 * changed. It stops, naming the requirement, when one can't be met: a third-party one that isn't
 * installed (with its homepage, when given) or is out of range; no catalog version in range; an id of
 * annai's own held by a package from elsewhere; one the user switched off (security review: never switched
 * on without asking, so the words say how to turn it on); or an update another installed plugin doesn't
 * accept. A package's own id is never its requirement.
 * @param {PluginHost} host @param {Requirement[]} requires @param {CatalogPlugin[]} catalog
 * @param {{ who?: string, except?: string }} [o] who: the plugin needing them, for the words; except: the one being installed
 * @returns {Promise<CatalogPlugin[]>}
 */
export async function checkRequires(host, requires, catalog, { who = 'This plugin', except } = {}) {
  const state = await host.installed();
  /** @type {CatalogPlugin[]} */
  const plan = [];
  for (const r of requires) {
    if (r.id === except) continue;
    const entry = catalog.find((p) => p.id === r.id);
    const s = state[r.id];
    if (s?.enabled === false) {
      throw new PluginError(who, `needs ${entry?.name ?? s.name ?? r.id}, which you turned off. Turn it on in Settings → Plugins, then try again.`);
    }
    if (!entry) {
      if (!s) throw new PluginError(who, `needs ${r.id}, which isn't installed. ${r.homepage ? `Install it from ${r.homepage} first` : 'Install it first'}, then try again.`);
      if (!satisfies(String(s.version), r.version)) throw new PluginError(who, `needs ${r.id} ${r.version}, and version ${s.version} is installed. Update it, then try again.`);
      continue;
    }
    if (s && s.source !== 'official') {
      throw new PluginError(who, `needs annai's ${entry.name} (${r.id}), but the ${r.id} installed came from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins, then try again.`);
    }
    if (s && satisfies(String(s.version), r.version)) continue; // in range: left alone
    if (!satisfies(entry.version, r.version)) {
      throw new PluginError(who, `needs ${entry.name} ${r.version}, and annai's catalog has version ${entry.version}${s ? ` (${s.version} is installed)` : ''}. Try again once annai has a version that fits.`);
    }
    await refuseBreaking(host, r.id, entry.version, entry.name, except);
    if (!plan.includes(entry)) plan.push(entry);
  }
  return plan;
}

/**
 * Starts an installed plugin that is on (security review): one the user switched off stays off; one
 * annai switched off after repeated errors starts again only on the user's tap, as Turn on does (spec
 * §5.5), or when this call installed it. One updated after its code ran waits for a restart.
 * @param {PluginHost} host @param {string} id @param {{ tap?: boolean, fresh?: boolean }} [o]
 */
async function running(host, id, { tap = false, fresh = false } = {}) {
  if (host.needsRestart(id)) return;
  const s = (await host.installed())[id];
  if (!s || s.enabled === false) return;
  if (host.registry.isDisabled(id)) {
    if (tap || fresh) await host.setEnabled(id, true);
    return;
  }
  await host.start(id);
}

/**
 * The plan for these requirements, with the catalog when one is needed: offline, requirements that
 * are all installed in range need nothing from it.
 * @param {PluginHost} host @param {Requirement[]} requires @param {Env} env @param {{ who: string, except?: string }} o
 * @returns {Promise<{ plan: CatalogPlugin[], catalog: CatalogPlugin[] }>}
 */
async function planFor(host, requires, env, o) {
  if (!requires.length) return { plan: [], catalog: env.catalog ?? [] };
  /** @type {CatalogPlugin[]} */
  let catalog;
  try {
    catalog = env.catalog ?? await officialPlugins(env);
  } catch (e) {
    const state = await host.installed();
    if (requires.every((r) => state[r.id] && satisfies(String(state[r.id].version), r.version))) return { plan: [], catalog: [] };
    throw e;
  }
  return { plan: await checkRequires(host, requires, catalog, o), catalog };
}

/**
 * Installs requirements and then, with install(), what needs them; every requirement and it are then
 * started. All of the downloads are made and checked first. When anything fails, whatever this call
 * newly installed is removed again, and the error goes on.
 * @param {PluginHost} host @param {Requirement[]} requires @param {Env} env @param {{ who: string, id: string, install?: () => Promise<unknown> }} o
 */
async function withRequirements(host, requires, env, { who, id, install }) {
  const { plan } = await planFor(host, requires, env, { who, except: id });
  /** @type {[CatalogPlugin, Map<string, Uint8Array>][]} */
  const got = [];
  for (const entry of plan) got.push([entry, await download(entry, env)]);
  const before = await host.installed();
  /** @type {string[]} */
  const fresh = [];
  try {
    for (const [entry, files] of got) {
      await host.install(files, { source: 'official' });
      if (!before[entry.id]) fresh.push(entry.id);
    }
    if (install) {
      await install();
      if (!before[id]) fresh.push(id);
    }
    for (const r of requires) if (r.id !== id) await running(host, r.id, { tap: env.tap, fresh: fresh.includes(r.id) });
    if (install) await running(host, id, { tap: env.tap, fresh: fresh.includes(id) });
  } catch (e) {
    for (const x of fresh.reverse()) await host.uninstall(x).catch(() => {});
    throw e;
  }
}

/** The words for a package from elsewhere that holds, or would take, the id of annai's own plugin. */
export const OWN_NAME = "annai's own plugin uses this name";

/**
 * Refuses a package from a file or an address whose id is one of annai's own (security review): one
 * in annai's catalog, or, offline, one installed from it. Nothing is stored or changed.
 * @param {PluginHost} host @param {string} id @param {string | undefined} source @param {Env} [env]
 */
export async function checkPackageId(host, id, source, env = {}) {
  if (source === 'official') return;
  const catalog = env.catalog ?? await officialPlugins(env).catch(() => null);
  const own = catalog?.find((p) => p.id === id);
  if (own || (await host.installed())[id]?.source === 'official') {
    throw new PluginError(id, `${OWN_NAME} (${own?.name ?? id}), so a package from elsewhere can't have it. Ask its author to rename it.`);
  }
}

/**
 * Installs a package with what it requires (all or nothing), and starts them. @param {PluginHost} host
 * @param {Map<string, Uint8Array>} files @param {{ source?: 'file' | 'url' | 'official', file?: string, url?: string }} opts @param {Env} [env]
 * @returns {Promise<any>} its manifest
 */
export async function installWith(host, files, opts, env = {}) {
  const pkg = await host.inspect(files);
  await checkPackageId(host, pkg.id, opts.source, env);
  await withRequirements(host, pkg.requires, env, { who: pkg.name, id: pkg.id, install: () => host.install(files, opts) });
  return pkg.manifest;
}

/**
 * Installs what an update requires, before the update itself (spec §5.3: resolved when the user taps
 * Update). Nothing of it stays when it fails. @param {PluginHost} host @param {Requirement[]} requires @param {Env} env @param {{ who: string, id: string }} o
 */
export function installRequirements(host, requires, env, o) {
  return withRequirements(host, requires, env, o);
}

/**
 * An official catalog entry, installed with what it requires; one installed and current is started,
 * with any requirement it is missing. An id of annai's own that a package from elsewhere holds is
 * refused, saying so. @param {PluginHost} host @param {string} id @param {Env} [env] @returns {Promise<any>} its manifest
 */
export async function addFromCatalog(host, id, env = {}) {
  const catalog = env.catalog ?? await officialPlugins(env);
  const entry = catalog.find((p) => p.id === id);
  if (!entry) throw new PluginError(id, "isn't in annai's catalog.");
  const s = (await host.installed())[id];
  if (s && s.source !== 'official') throw new PluginError(id, "is installed from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins to add annai's.");
  if (s?.enabled === false) throw new PluginError(id, `${entry.name}, which you turned off, isn't switched on by adding it. Turn it on in Settings → Plugins, then try again.`);
  const requires = entry.requires ?? [];
  if (s && s.version === entry.version && (await host.verifyOfficial(id, entry))) {
    await withRequirements(host, requires, { ...env, catalog }, { who: entry.name, id });
    await running(host, id, { tap: env.tap });
    return host.manifestOf(id);
  }
  await checkRequires(host, requires, catalog, { who: entry.name, except: id }); // a requirement that can't be met stops it before any download
  return installWith(host, await download(entry, env), { source: 'official' }, { ...env, catalog });
}

/**
 * Removes the official protocol plugins nothing needs any more (decision 10): those that provide
 * endpoint types, which no installed plugin requires and no configured ability uses. A third-party
 * one stays, as it would need its address again. @param {PluginHost} host @param {Set<string>} inUseTypes
 * @returns {Promise<string[]>} the ids removed
 */
export async function prune(host, inUseTypes) {
  const state = await host.installed();
  const all = await manifests(host);
  const required = new Set(Object.values(all).flatMap((m) => (Array.isArray(m.requires) ? m.requires.map((/** @type {any} */ r) => r?.id) : [])));
  /** @type {string[]} */
  const removed = [];
  for (const [id, s] of Object.entries(state)) {
    const types = all[id]?.provides?.['endpoint-type'];
    if (s.source !== 'official' || !Array.isArray(types) || !types.length) continue;
    if (required.has(id) || types.some((t) => inUseTypes.has(t))) continue;
    await host.uninstall(id);
    removed.push(id);
  }
  return removed.sort();
}
