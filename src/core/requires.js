import { PluginError, TAKEN, TURN_ON, takenShown, turnOnShown } from './registry.js';
import { t } from './l10n.js';
import { sentences } from './intl.js';
import { officialPlugins, download, officialName, pluginName, fetchTranslations } from './llm/official.js';
import { SYS_PLUGINS } from './scopes.js';

/**
 * What a plugin requires (spec §5.3, decision 7): plugins by id and a range "^N", the same major. An
 * official one comes from annai's catalog, hash-checked, with no question; a third party's must be
 * installed first. All or nothing. Calls never install (decision 9).
 * @typedef {import('./plugins.js').PluginHost} PluginHost
 * @typedef {import('./llm/official.js').CatalogPlugin} CatalogPlugin
 * @typedef {import('./llm/official.js').FetchOptions & { catalog?: CatalogPlugin[], tap?: boolean }} Env
 *   tap: the user's own tap asked for this, so a plugin annai switched off after errors may start again (§5.5)
 * @typedef {import('./packages.js').Requirement} Requirement
 */

/** Whether a version is in a range "^N": the same major. @param {string} version @param {string} range */
export function satisfies(version, range) {
  const r = /^\^(\d+)$/.exec(String(range));
  const v = /^(\d+)\./.exec(String(version));
  return Boolean(r && v && Number(r[1]) === Number(v[1]));
}

/** Every installed plugin's stored manifest, by id. @param {PluginHost} host */
async function manifests(host) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const id of Object.keys(await host.installed())) {
    const m = await host.manifestOf(id);
    if (m) out[id] = m;
  }
  return out;
}

/** @param {any} m @param {string} id */
const needOf = (m, id) => (Array.isArray(m.requires) ? m.requires : []).find((/** @type {any} */ r) => r?.id === id);

/**
 * Refuses a version another installed plugin doesn't accept, naming it. except: a plugin replaced in
 * the same install. @param {PluginHost} host @param {string} id @param {string} version @param {string} name @param {string} [except]
 */
export async function refuseBreaking(host, id, version, name, except) {
  const state = await host.installed();
  for (const [o, m] of Object.entries(await manifests(host))) {
    const r = o === id || o === except ? null : needOf(m, id);
    const other = m.name ?? o;
    if (!r || satisfies(version, r.version)) continue;
    // On the screens, annai's own by their own translations (pluginName), as Plugins names them.
    const [them, it] = [await pluginName(host, state[o], o, other), state[id] ? await pluginName(host, state[id], id, name) : officialName(id, name)];
    /* en */
    throw new PluginError(id, `version ${version} would stop ${other} working: it needs ${name} ${r.version}. Update ${other} first, or keep this version.`, { shown: t`version ${version} would stop ${them} working: it needs ${it} ${r.version}. Update ${them} first, or keep this version.` });
  }
}

/**
 * The official plugins to install or update first, in order; nothing changes. It stops, naming the
 * requirement, when one can't be met: a third party's not installed (with its homepage) or out of
 * range, none in range in the catalog, annai's id held by a package from elsewhere, one the user switched
 * off (never switched on without asking: security review), or an update another plugin doesn't accept.
 * @param {PluginHost} host @param {Requirement[]} requires @param {CatalogPlugin[]} catalog
 * @param {{ who?: string, except?: string }} [o] who: for the words; except: the package being installed
 * @returns {Promise<CatalogPlugin[]>}
 */
export async function checkRequires(host, requires, catalog, { who = /* en */ 'This plugin', except } = {}) {
  const state = await host.installed();
  /** @type {CatalogPlugin[]} */
  const plan = [];
  for (const r of requires) {
    if (r.id === except) continue;
    const e = catalog.find((p) => p.id === r.id);
    const s = state[r.id];
    // What it needs, in annai's English (words) and the screens' (shown).
    const no = (/** @type {string} */ words, /** @type {string} */ shown) => new PluginError(who, /* en */ `needs ${words}`, { shown });
    const named = e?.name ?? s?.name ?? r.id;
    // annai's own in the screens' words (decision 10); the English is the log's.
    const shown = e ? officialName(e.id, e.name) : named;
    /* en */
    if (s?.enabled === false) throw no(`${named}, which you turned off. ${TURN_ON}`, sentences(t`needs ${shown}, which you turned off.`, turnOnShown()));
    if (!e) {
      /* en */
      if (!s && r.homepage) throw no(`${r.id}, which isn't installed. Install it from ${r.homepage} first, then try again.`, t`needs ${r.id}, which isn't installed. Install it from ${r.homepage} first, then try again.`);
      /* en */
      if (!s) throw no(`${r.id}, which isn't installed. Install it first, then try again.`, t`needs ${r.id}, which isn't installed. Install it first, then try again.`);
      /* en */
      if (!satisfies(String(s.version), r.version)) throw no(`${r.id} ${r.version}, and version ${s.version} is installed. Update it, then try again.`, t`needs ${r.id} ${r.version}, and version ${s.version} is installed. Update it, then try again.`);
      continue;
    }
    /* en */
    if (s && s.source !== 'official') throw no(`annai's ${e.name} (${r.id}), but the ${r.id} installed came from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins, then try again.`, t`needs annai's ${shown} (${r.id}), but the ${r.id} installed came from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins, then try again.`);
    if (s && satisfies(String(s.version), r.version)) continue;
    /* en */
    if (!satisfies(e.version, r.version) && s) throw no(`${e.name} ${r.version}, and annai's catalog has version ${e.version} (${s.version} is installed). Try again once annai has a version that fits.`, t`needs ${shown} ${r.version}, and annai's catalog has version ${e.version} (${s.version} is installed). Try again once annai has a version that fits.`);
    /* en */
    if (!satisfies(e.version, r.version)) throw no(`${e.name} ${r.version}, and annai's catalog has version ${e.version}. Try again once annai has a version that fits.`, t`needs ${shown} ${r.version}, and annai's catalog has version ${e.version}. Try again once annai has a version that fits.`);
    await refuseBreaking(host, r.id, e.version, e.name, except);
    if (!plan.includes(e)) plan.push(e);
  }
  return plan;
}

/**
 * Starts a plugin that is on: one the user switched off stays off; one annai switched off after errors
 * starts again only on the user's tap (§5.5) or when this call installed it (security review).
 * @param {PluginHost} host @param {string} id @param {{ tap?: boolean, fresh?: boolean }} [o]
 */
async function running(host, id, { tap = false, fresh = false } = {}) {
  const s = (await host.installed())[id];
  if (!s || s.enabled === false || host.needsRestart(id)) return;
  if (!host.registry.isDisabled(id)) await host.start(id);
  else if (tap || fresh) await host.setEnabled(id, true);
}

/**
 * Installs what requires lists, then, with install(), what needs it, and starts them; every download
 * is checked first. When anything fails, what this call newly installed is removed again. Offline,
 * requirements all installed in range need nothing from the catalog. Updates use it too (§5.3).
 * @param {PluginHost} host @param {Requirement[]} requires @param {Env} env @param {{ who: string, id: string, install?: () => Promise<unknown> }} o
 */
export async function installRequirements(host, requires, env, { who, id, install }) {
  /** @type {CatalogPlugin[]} */
  let plan = [];
  if (requires.length) {
    const state = await host.installed();
    const catalog = env.catalog ?? await officialPlugins(env).catch((e) => {
      if (requires.every((r) => state[r.id] && satisfies(String(state[r.id].version), r.version))) return null;
      throw e;
    });
    if (catalog) plan = await checkRequires(host, requires, catalog, { who, except: id });
  }
  /** @type {[CatalogPlugin, Map<string, Uint8Array>][]} */
  const got = [];
  for (const e of plan) got.push([e, await download(e, env)]);
  const before = await host.installed();
  /** @type {string[]} */
  const fresh = [];
  /** @type {Map<string, Map<string, Uint8Array>>} the files of requirements this call updates, to put back (fix pass) */
  const was = new Map();
  try {
    for (const [e, files] of got) {
      if (before[e.id]) was.set(e.id, await storedFiles(host, e.id));
      await host.install(files, { source: 'official' });
      if (!before[e.id]) fresh.push(e.id);
    }
    if (install) {
      await install();
      if (!before[id]) fresh.push(id);
    }
    // annai's own come with their words in the screens' language, before they start (never a reason to stop).
    await fetchTranslations(host, { fetch: env.fetch, base: env.base, ids: [...got.map(([e]) => e.id), id] });
    for (const x of [...requires.map((r) => r.id).filter((x) => x !== id), ...(install ? [id] : [])]) await running(host, x, { tap: env.tap, fresh: fresh.includes(x) });
  } catch (e) {
    for (const x of fresh.reverse()) await host.uninstall(x).catch(() => {});
    for (const [x, files] of was) {
      await host.install(files, { source: 'official' }).catch(() => {});
      await running(host, x).catch(() => {});
    }
    throw e;
  }
}

/** An installed package's files, by name inside it. @param {PluginHost} host @param {string} id */
async function storedFiles(host, id) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const f of await host.ws.list(SYS_PLUGINS, `/${id}/`)) {
    const got = await host.ws.read(SYS_PLUGINS, f.path);
    if (got) files.set(f.path.slice(id.length + 2), got.bytes);
  }
  return files;
}

/**
 * Refuses a package from a file or an address whose id is annai's own (security review): in its
 * catalog or, offline, installed from it. @param {PluginHost} host @param {string} id @param {string | undefined} source @param {Env} [env]
 */
export async function checkPackageId(host, id, source, env = {}) {
  if (source === 'official') return;
  const own = (env.catalog ?? await officialPlugins(env).catch(() => null))?.find((p) => p.id === id);
  if (own || (await host.installed())[id]?.source === 'official') throw new PluginError(id, TAKEN, { shown: takenShown() });
}

/**
 * Installs a package with what it requires, all or nothing, and starts them. @param {PluginHost} host
 * @param {Map<string, Uint8Array>} files @param {{ source?: 'file' | 'url' | 'official', file?: string, url?: string }} opts @param {Env} [env]
 * @returns {Promise<any>} its manifest
 */
export async function installWith(host, files, opts, env = {}) {
  const pkg = await host.inspect(files);
  await checkPackageId(host, pkg.id, opts.source, env);
  await installRequirements(host, pkg.requires, env, { who: pkg.name, id: pkg.id, install: () => host.install(files, opts) });
  return pkg.manifest;
}

/**
 * An official catalog entry with what it requires; one installed and current is started, with any
 * requirement it misses. One from elsewhere, or switched off by the user, is refused, saying so.
 * @param {PluginHost} host @param {string} id @param {Env} [env] @returns {Promise<any>} its manifest
 */
export async function addFromCatalog(host, id, env = {}) {
  const catalog = env.catalog ?? await officialPlugins(env);
  const entry = catalog.find((p) => p.id === id);
  if (!entry) throw new PluginError(id, /* en */ "isn't in annai's catalog.", { shown: t`isn't in annai's catalog.` });
  const s = (await host.installed())[id];
  /* en */
  if (s && s.source !== 'official') throw new PluginError(id, "is installed from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins to add annai's.", { shown: t`is installed from elsewhere, so it isn't annai's own. Remove it in Settings → Plugins to add annai's.` });
  /* en */
  if (s?.enabled === false) throw new PluginError(id, `${entry.name}, which you turned off, isn't switched on by adding it. ${TURN_ON}`, { shown: sentences(t`${officialName(entry.id, entry.name)}, which you turned off, isn't switched on by adding it.`, turnOnShown()) });
  const requires = entry.requires ?? [];
  if (s && s.version === entry.version && (await host.verifyOfficial(id, entry))) {
    await installRequirements(host, requires, { ...env, catalog }, { who: entry.name, id });
    await running(host, id, { tap: env.tap });
    return host.manifestOf(id);
  }
  await checkRequires(host, requires, catalog, { who: entry.name, except: id }); // before any download
  return installWith(host, await download(entry, env), { source: 'official' }, { ...env, catalog });
}

/**
 * The official protocol plugins nothing needs (decision 10): ones providing endpoint types no installed
 * plugin requires and no ability uses; a third party's stays. gone: plugins counted as removed already.
 * @param {PluginHost} host @param {Set<string>} inUseTypes @param {Set<string>} [gone] @returns {Promise<string[]>}
 */
export async function pruneable(host, inUseTypes, gone = new Set()) {
  const all = await manifests(host);
  const required = new Set(Object.entries(all).filter(([id]) => !gone.has(id)).flatMap(([, m]) => (Array.isArray(m.requires) ? m.requires.map((/** @type {any} */ r) => r?.id) : [])));
  return Object.entries(await host.installed()).filter(([id, s]) => {
    const types = all[id]?.provides?.['endpoint-type'];
    return !gone.has(id) && s.source === 'official' && types?.length && !required.has(id) && !types.some((/** @type {string} */ t) => inUseTypes.has(t));
  }).map(([id]) => id).sort();
}

/** Removes the protocol plugins pruneable() names. @param {PluginHost} host @param {Set<string>} inUseTypes @returns {Promise<string[]>} the ids removed */
export async function prune(host, inUseTypes) {
  const removed = await pruneable(host, inUseTypes);
  for (const id of removed) await host.uninstall(id);
  return removed;
}
