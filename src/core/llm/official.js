import { sha256Hex } from '../hash.js';
import { PluginError, NOT_OWN, TURN_ON, notOwnShown, turnOnShown } from '../registry.js';
import { refuseBreaking, installRequirements } from '../requires.js';
import { t, lang } from '../l10n.js';
import { sentences } from '../intl.js';

/**
 * annai's official on-demand plugins (spec §5.3, §9.1): listed in /catalog/plugins.json with the
 * SHA-256 of every file, fetched from /plugins-official/<id>/ on annai's own origin, checked, then
 * installed like any plugin. Choosing an endpoint type whose plugin is missing installs it.
 * @typedef {import('../plugins.js').PluginHost} PluginHost
 * @typedef {import('../catalog-facts.js').CatalogFacts & { provides: Record<string, string[]>, files: Record<string, string>, featured?: string }} CatalogPlugin
 * @typedef {{ fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, keepOff?: boolean }} FetchOptions
 *   keepOff: a plugin the user switched off is never switched on by this (security review): it stops, saying how to turn it on
 */

const defaultFetch = (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => fetch(url, init);

/** A catalog entry that makes a model provider: it has abilities. A restore and the provider page install only these (reviews of the emulator-pass fixes). @param {any} entry */
export const makesProvider = (entry) => Array.isArray(entry?.abilities) && entry.abilities.length > 0;

/** @param {FetchOptions} [opts] @returns {Promise<CatalogPlugin[]>} */
export async function officialPlugins({ fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Response} */
  let res;
  try {
    res = await get(`${base}/catalog/plugins.json`, { cache: 'no-cache' });
  } catch {
    throw new PluginError('catalog', /* en */ "annai's list of plugins couldn't be loaded. Check the connection and try again.", { shown: t`annai's list of plugins couldn't be loaded. Check the connection and try again.` });
  }
  if (!res.ok) throw new PluginError('catalog', /* en */ `annai's list of plugins couldn't be loaded (HTTP ${res.status}). Try again later.`, { shown: t`annai's list of plugins couldn't be loaded (HTTP ${res.status}). Try again later.` });
  // What the catalog's plugins are named on the screens, read beside it while it isn't (no extra wait in English).
  const [json] = await Promise.all([res.json(), names ? null : catalogWords({ fetch: get, base }).then((w) => { names = w; })]);
  return Array.isArray(json?.plugins) ? json.plugins : [];
}

/** @type {Awaited<ReturnType<typeof catalogWords>>} the catalog's words, once had in this run */
let names = null;
/**
 * An official plugin that isn't installed by name as the screens show it: annai's catalog's translation (decision 10), once the catalog
 * has been read in this run, else its English. For one that is installed, pluginName. @param {string} id @param {string} name
 */
export const officialName = (id, name) => names?.[id]?.name ?? name;
/** The catalog's words officialPlugins read beside it (catalogWords), for shownEntry; null before, in English, or when they couldn't be had. */
export const officialWords = () => names;
/**
 * An installed plugin's name as the screens show it: annai's own from its own translation on the device (the running plugin's words, else
 * its stored ones, as Plugins shows it, running or off), any other as written (decision 10). No request is made.
 * @param {PluginHost} plugins @param {any} state its record @param {string} id @param {string} name @returns {Promise<string>}
 */
export async function pluginName(plugins, state, id, name) {
  if (state?.source !== 'official') return name;
  return (plugins.shownOf(id) ?? (await plugins.words(id).catch(() => null))?.manifest)?.name ?? name;
}

/**
 * annai's catalog in a language, catalog/l10n/<tag>.json, or null: plugins, each official plugin's name, description, featured sentence
 * and keywords in it; translations, the SHA-256 of each one's words in it (catalog/l10n/<tag>/<id>.json). @param {string} tag @param {FetchOptions} [opts]
 * @returns {Promise<{ plugins?: Record<string, { name?: string, description?: string, featured?: string, keywords?: string[] }>, translations?: Record<string, string> } | null>}
 */
async function catalogIn(tag, { fetch: get = defaultFetch, base = '' } = {}) {
  try {
    const res = await get(`${base}/catalog/l10n/${tag}.json`, { cache: 'no-cache' });
    const json = res.ok ? await res.json() : null;
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/** The catalog's words for the screens (localization design, section 8), from catalogIn; null in English, or when they can't be had. @param {FetchOptions} [opts] */
export async function catalogWords(opts = {}) {
  if (lang() === 'en') return null;
  const json = await catalogIn(lang(), opts);
  return json?.plugins && typeof json.plugins === 'object' ? json.plugins : null;
}

/**
 * Brings annai's own installed plugins' words in a language (their packages carry none) to the hashes catalogIn lists: each one kept
 * with other bytes gets catalog/l10n/<tag>/<id>.json, kept only when it matches; one listed with none loses its own. Words in other
 * languages than tag and the screens' go; English asks for nothing. It is no plugin update, and never fails: what can't be had leaves
 * the device as it is (else the plugin's English shows), and the next call tries again. ids: only these plugins (an install's).
 * @param {PluginHost} host @param {FetchOptions & { tag?: string, ids?: string[] }} [opts]
 */
export async function fetchTranslations(host, { tag = lang(), ids, ...opts } = {}) {
  try {
    const state = await host.installed();
    const own = Object.keys(state).filter((id) => state[id]?.source === 'official' && (!ids || ids.includes(id)));
    if (!own.length) return;
    const json = tag === 'en' ? null : await catalogIn(tag, opts);
    // Add's words for this run too, so it doesn't ask again.
    if (tag === lang() && json?.plugins && typeof json.plugins === 'object') names = json.plugins;
    const listed = json?.translations && typeof json.translations === 'object' ? json.translations : null;
    const { fetch: get = defaultFetch, base = '' } = opts;
    await Promise.all(own.map(async (id) => {
      try {
        const kept = await host.translations(id);
        /** @type {Map<string, Uint8Array | null>} */
        const changes = new Map(Object.keys(kept).filter((x) => x !== tag && x !== lang()).map((x) => [x, null]));
        const want = listed?.[id];
        if (listed && typeof want !== 'string' && kept[tag]) changes.set(tag, null);
        if (typeof want === 'string' && kept[tag] !== want) {
          const res = await get(/* en */ `${base}/catalog/l10n/${tag}/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
          const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
          if (bytes && (await sha256Hex(bytes)) === want) changes.set(tag, bytes);
        }
        if (changes.size) await host.keepTranslations(id, changes);
      } catch {
        // this one stays as it is until the next call
      }
    }));
  } catch {
    // the device keeps what it has
  }
}

/**
 * A catalog entry as the screens show it, keywords added; lang: its words' language. @template {{ id: string, keywords: string[] }} E
 * @param {E} entry @param {Awaited<ReturnType<typeof catalogWords>>} words @returns {E & { lang: string }}
 */
export function shownEntry(entry, words) {
  const w = words?.[entry.id];
  return w ? { ...entry, ...w, keywords: [...new Set([...entry.keywords, ...(w.keywords ?? [])])], lang: lang() } : { ...entry, lang: 'en' };
}

/**
 * Downloads one official plugin and checks every file against the catalog; nothing is returned
 * unless all of them match.
 * @param {CatalogPlugin} entry @param {FetchOptions} [opts] @returns {Promise<Map<string, Uint8Array>>}
 */
export async function download(entry, { fetch: get = defaultFetch, base = '' } = {}) {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [name, hash] of Object.entries(entry.files)) {
    const url = /* en */ `${base}/plugins-official/${encodeURIComponent(entry.id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    /** @type {Response} */
    let res;
    try {
      res = await get(url, { cache: 'no-cache' });
    } catch {
      throw new PluginError(entry.id, /* en */ "couldn't be downloaded. Check the connection and try again.", { shown: t`couldn't be downloaded. Check the connection and try again.` });
    }
    if (!res.ok) throw new PluginError(entry.id, /* en */ `couldn't be downloaded (${name}: HTTP ${res.status}). Try again later.`, { shown: t`couldn't be downloaded (${name}: HTTP ${res.status}). Try again later.` });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if ((await sha256Hex(bytes)) !== hash) throw new PluginError(entry.id, /* en */ `wasn't installed: ${name} doesn't match annai's catalog`, { shown: t`wasn't installed: ${name} doesn't match annai's catalog` });
    files.set(name, bytes);
  }
  return files;
}

/** Downloads, checks and installs one official plugin, then starts it. @param {PluginHost} host @param {CatalogPlugin} entry @param {FetchOptions} [opts] */
export async function installOfficial(host, entry, opts = {}) {
  await host.install(await download(entry, opts), { source: 'official' });
  await fetchTranslations(host, { ...opts, ids: [entry.id] });
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
  /** @type {{ id: string, name: string, installed: string, available: string, entry: CatalogPlugin }[]} */
  const out = [];
  for (const p of await officialPlugins(opts)) {
    const s = state[p.id];
    if (s?.source !== 'official') continue;
    // Official means matching the catalog: a changed copy is offered the catalog's files, whatever its version.
    if (s.version !== p.version || !(await host.verifyOfficial(p.id, p))) out.push({ id: p.id, name: p.name, installed: s.version, available: p.version, entry: p });
  }
  return out;
}

/**
 * Installs the catalog's version of an official plugin the user chose to update, keeping their
 * on/off choice. What the new version requires is installed first (spec §5.3), and a version another
 * installed plugin doesn't accept is refused, naming it. New code that replaces code already running
 * starts with the next start of annai.
 * @param {PluginHost} host @param {CatalogPlugin} entry @param {FetchOptions} [opts] @returns {Promise<'started' | 'restart'>}
 */
export async function updateOfficial(host, entry, opts = {}) {
  await refuseBreaking(host, entry.id, entry.version, entry.name);
  const files = await download(entry, opts);
  // Update is the user's tap: a requirement annai switched off after errors may start again (spec §5.5).
  if (entry.requires?.length) await installRequirements(host, entry.requires, { ...opts, tap: true }, { who: entry.name, id: entry.id });
  const wasOn = (await host.installed())[entry.id]?.enabled !== false;
  await host.install(files, { source: 'official' });
  await fetchTranslations(host, { ...opts, ids: [entry.id] });
  if (!wasOn) {
    await host.setEnabled(entry.id, false);
    return 'started';
  }
  if (host.needsRestart(entry.id)) return 'restart';
  await host.start(entry.id);
  return 'started';
}

/** The type ids of a kind that running plugins provide. @param {import('../registry.js').Registry} registry @param {string} kind */
const provided = (registry, kind) => new Set(registry.list(kind).map((/** @type {any} */ t) => t.type));

/**
 * Whether annai's own (a built-in, or an official plugin) provides a type now: a third party's by that name
 * doesn't keep annai's own out. @param {PluginHost} host @param {string} kind @param {string} type
 */
export async function ownProvides(host, kind, type) {
  const owner = host.registry.owner(kind, type)?.pluginId;
  return Boolean(owner && (host.builtins.has(owner) || (await host.installed())[owner]?.source === 'official'));
}

/** Makes an endpoint type available (see ensureProvided). @param {PluginHost} host @param {string} type @param {FetchOptions} [opts] */
export function ensureType(host, type, opts = {}) {
  return ensureProvided(host, 'endpoint-type', type, opts);
}

/**
 * Makes a type of a kind ("endpoint-type", "storage-type") available. Nothing to do when annai's own
 * provides it. Otherwise it starts the installed official plugin that provides it, or installs the
 * catalog's version (spec §5.3); a third party's serves when annai has none, or its catalog can't be had.
 * @param {PluginHost} host @param {string} kind @param {string} type @param {FetchOptions} [opts]
 */
export async function ensureProvided(host, kind, type, opts = {}) {
  if (await ownProvides(host, kind, type)) return;
  // Two callers at once share one install: a second install would stop the plugin the first one started.
  const running = inFlight.get(host) ?? new Map();
  inFlight.set(host, running);
  const key = `${kind} ${type}`;
  const had = running.get(key);
  if (had) return had;
  const work = ensureNow(host, kind, type, opts).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}

/** Installs or starts what provides a type, once per host, kind and type at a time. @type {WeakMap<PluginHost, Map<string, Promise<void>>>} */
const inFlight = new WeakMap();

/** @param {PluginHost} host @param {string} kind @param {string} type @param {FetchOptions} opts */
async function ensureNow(host, kind, type, opts) {
  // A third party's serves offline only for a name no official plugin provides: annai's own names are never theirs (Registry.owner).
  const theirs = provided(host.registry, kind).has(type);
  const entry = (await officialPlugins(opts).catch((e) => { if (theirs) return []; throw e; })).find((p) => p.provides?.[kind]?.includes(type));
  if (!entry && theirs) return;
  if (!entry) {
    /* en */
    if (kind === 'storage-type') throw new PluginError(type, "isn't a kind of backup place annai knows. Install a plugin that provides it.", { shown: t`isn't a kind of backup place annai knows. Install a plugin that provides it.` });
    /* en */
    throw new PluginError(type, "isn't an endpoint type annai knows. Install a plugin that provides it.", { shown: t`isn't an endpoint type annai knows. Install a plugin that provides it.` });
  }
  const state = (await host.installed())[entry.id];
  // A package from elsewhere with annai's own id is neither used nor overwritten (security review).
  if (state && state.source !== 'official') throw new PluginError(entry.id, NOT_OWN, { shown: notOwnShown() });
  // Only files that match the catalog run as an official plugin; anything else, such as a copy a
  // restored backup brought, is fetched again from annai and checked (spec §5.3).
  if (state && state.version === entry.version && (await host.verifyOfficial(entry.id, entry))) {
    // Switched off by the user, or by annai after repeated errors (spec §5.5): the user's tap turns it back on,
    // except one the user turned off when the caller keeps it off (the model service's setup taps).
    if (!state.enabled && opts.keepOff) {
      const name = await pluginName(host, state, entry.id, entry.name);
      throw new PluginError(entry.id, /* en */ `${entry.name}, which you turned off, isn't switched on by this. ${TURN_ON}`, { shown: sentences(t`${name}, which you turned off, isn't switched on by this.`, turnOnShown()) });
    }
    if (!state.enabled || host.registry.isDisabled(entry.id)) await host.setEnabled(entry.id, true);
    else await host.start(entry.id);
  } else {
    await installOfficial(host, entry, opts);
  }
  if (!provided(host.registry, kind).has(type)) {
    /* en */
    if (kind === 'storage-type') throw new PluginError(entry.id, `didn't provide a kind of backup place ${type}`, { shown: t`didn't provide a kind of backup place ${type}` });
    /* en */
    throw new PluginError(entry.id, `didn't provide an endpoint type ${type}`, { shown: t`didn't provide an endpoint type ${type}` });
  }
}

/**
 * The types of a kind annai's catalog offers, each with the name of the plugin that brings it, in the screens' words.
 * @param {string} kind @param {FetchOptions} [opts] @returns {Promise<{ type: string, name: string }[]>}
 */
export async function offeredTypes(kind, opts = {}) {
  return (await officialPlugins(opts)).flatMap((p) => (p.provides?.[kind] ?? []).map((type) => ({ type, name: officialName(p.id, p.name) })));
}
