import { SYS } from '../scopes.js';
import { readConfig, getKey, endpointOf, modelOf, saveModel, saveProvider, providerOf, providerBase, sendKey, removeProviderRecords } from './config.js';
import { decide as decideWith } from './decide.js';
import { logEvent } from '../events.js';
import { testModel, testLevels } from './check.js';
import { endpointTypes, ProviderError, typeError, sameOrigin, noRedirect, explain } from './contract.js';
import { ensureType } from './official.js';
import { addProvider as addProviderRecords, syncProviders, useSuggestion } from './providers.js';
import { addFromCatalog, prune, pruneable } from '../requires.js';
import { officialPlugins, makesProvider } from './official.js';
import { PluginError, NOT_OWN, TURN_ON, isPluginBug } from '../registry.js';
import { adjusted, setupOf } from './setup.js';
import { callRole, Bench, candidates, COOLDOWN_MS } from './fallback.js';
import { modelTrace } from './trace.js';
import { Uploads } from './uploads.js';
import { Kept, keyPrint } from './kept.js';
import { speechCall } from './speech.js';
import { withoutSecretsIn } from '../agent/net.js';
import { openLive, testLive } from '../realtime/open.js';

/**
 * Everything the UI needs to talk to models (spec §9): providers and their settings, the protocol
 * plugins they need installed when they are set up (never by a call: decision 9), and role calls
 * with fallback, traced.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, plugins: import('../plugins.js').PluginHost,
 *   fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, ready?: Promise<unknown>, pluginsCanLoad?: () => Promise<unknown>,
 *   probe?: (url: string) => Promise<boolean>, openSocket?: (url: string, protocols: string[]) => any, whyNoPlugins?: () => string | undefined }} c
 *   ready: settles once the installed plugins have started; pluginsCanLoad: settles when a plugin's files can be loaded
 *   (in browsers, once a service worker controls the page), else throws why; whyNoPlugins: why plugins can't load on this
 *   page, if they can't, said for a missing protocol (spec §5.3); probe: whether a server answers at an address at all, asked
 *   in no-cors mode, which a browser lets through to any server, to tell "blocks web apps" from "down" (spec §9.8);
 *   openSocket: makes a live session's WebSocket (tests)
 */
export function createLlm({
  store, ws, plugins, fetch: get = (url, init) => fetch(url, init), base = '', ready = Promise.resolve(), pluginsCanLoad = () => Promise.resolve(),
  probe = (/** @type {string} */ url) => get(url, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false), openSocket, whyNoPlugins = () => undefined,
}) {
  const bench = new Bench();
  /** Tunables a live model had to open with instead (decision 11: v1beta without proactive audio), until annai restarts. @type {Map<string, Record<string, any>>} */
  const liveTunables = new Map();
  /** Photos uploaded to providers, by provider and ability (spec §4.8). */
  const uploads = new Uploads(ws);
  /** Providers going, or their key or address changing (G2). @type {Set<string>} */
  const removing = new Set();
  let erasing = false;
  /** Conversations' calls under way, for Erase. @type {Set<Promise<unknown>>} */
  const inflight = new Set();
  /** p, for up to ms. @param {Promise<unknown>} p @param {number} ms */
  const within = async (p, ms) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    await Promise.race([p.catch(() => {}), new Promise((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
  };
  /** An endpoint id as calls see it now, with its key's print; null: not reachable. @param {string} endpointId */
  const reachEndpoint = async (endpointId) => {
    const pRec = (await readConfig(ws)).providers[endpointId.split('/')[0]];
    const to = pRec ? await reach(pRec, endpointId.slice(endpointId.indexOf('/') + 1)) : null;
    return to?.secret ? { ...to, print: await keyPrint(to.secret, to.endpoint.baseUrl) } : null;
  };
  /** Kept turns (G2): kept only while the provider is there and not going, with the same key and address, the switch on and the trip there. */
  const kept = new Kept({
    ws,
    alive: async ({ endpoint, scope, key }) => {
      if (erasing || removing.has(endpoint.split('/')[0])) return false;
      const to = await reachEndpoint(endpoint);
      return Boolean(to && to.endpoint.tunables.keep !== false && to.print === key && (await store.tx(['scopes'], 'readonly', (t) => t.getScope(scope))));
    },
  });
  /** Kept turns' deletions waiting, sent (spec §4.9). @param {AbortSignal} [signal] */
  const drainKept = async (signal) => {
    await ready;
    return kept.drain({
      fetch: get, signal, trace: modelTrace(store, SYS),
      scopes: async () => new Set((await store.tx(['scopes'], 'readonly', (t) => t.listScopes())).map((x) => x.id)),
      resolve: reachEndpoint,
    });
  };
  /** The deletions waiting, sent for up to ms. @param {number} ms */
  const drainFor = async (ms) => {
    if ((await kept.count()).waiting) await within(drainKept(AbortSignal.timeout(ms)), ms);
  };
  ready.then(() => drainKept()).catch((e) => console.warn("kept turns' deletions couldn't be sent", e));
  /** After a trip went or a switch went off: its turns, deleted. @param {{ scope?: string, endpoint?: string }} which */
  const forgetSoon = async (which) => {
    const queued = await kept.queue(which);
    if (queued) drainKept().catch(() => {});
    return { queued };
  };
  /**
   * The provider marked as going, its turns are deleted with their key for up to 10 s; then work runs (a key, an address
   * or the provider going), and once it has, what is left is let go. gone: for good.
   * @template T @param {string} id @param {() => Promise<T>} work @param {boolean} [gone] @returns {Promise<T>}
   */
  const releasing = async (id, work, gone = false) => {
    removing.add(id);
    let done = false;
    try {
      await kept.queue({ provider: id });
      await drainFor(10_000);
      const out = await work();
      done = true;
      await kept.drop(id).catch(() => {});
      return out;
    } finally {
      // A removal that failed leaves the provider as it was, its turns kept again (verification, 2026-10-21).
      if (!gone || !done) removing.delete(id);
    }
  };
  const types = () => endpointTypes(plugins.registry);
  /**
   * Makes a protocol's type available, installing its official plugin: setup actions only (adding,
   * turning an ability on, Test, Fetch model list, Try this model), never a call (decision 9). A
   * plugin the user switched off stays off (security review). @param {string} type
   */
  const ensure = async (type) => {
    await ready;
    await pluginsCanLoad();
    await ensureType(plugins, type, { fetch: get, base, keepOff: true });
  };
  /** The started provider plugins' descriptions. @returns {import('./providers.js').ProviderSource[]} */
  const providers = () => plugins.registry.list('provider');
  /**
   * A model with what calling it needs. install: a setup action, which may install its protocol;
   * a call never does, and says so when its type isn't running.
   * @param {string} modelId @param {{ install?: boolean }} [o]
   */
  const resolve = async (modelId, { install = false } = {}) => {
    const cfg = await readConfig(ws);
    const rec = cfg.models[modelId];
    const pRec = rec ? cfg.providers[rec.provider] : undefined;
    const provider = pRec ? providerOf(pRec) : null;
    const ability = rec && provider ? provider.abilities[rec.ability] : undefined;
    if (!rec || !pRec || !provider || !ability) throw new ProviderError('not-found', 'That model no longer exists.');
    if (install) await ensure(ability.type);
    else await ready;
    const type = types().get(ability.type);
    if (!type) throw new ProviderError('type-missing', whyNoPlugins() ?? `${provider.name}'s ${ability.name} needs its plugin, which isn't running. Open ${provider.name} in Settings → Models to install it.`);
    return { rec, .../** @type {NonNullable<Awaited<ReturnType<typeof reach>>>} */ (await reach(pRec, rec.ability, type)), model: modelOf(rec) };
  };
  /**
   * A provider's ability as calls see it: its type, endpoint and key (secret; key: the protocol's). null: no type running.
   * @param {import('./config.js').ProviderRecord} pRec @param {string} abilityId @param {import('./contract.js').EndpointType} [was]
   */
  const reach = async (pRec, abilityId, was) => {
    const provider = providerOf(pRec);
    const type = was ?? types().get(provider.abilities[abilityId]?.type ?? '');
    if (!type) return null;
    const secret = await getKey(store, pRec.id);
    const set = adjusted(plugins.registry, pRec.plugin, type, endpointOf(pRec, abilityId, type.tunables), provider.keyHeader);
    return { type: set.type, ...sendKey(set.endpoint, secret, provider.keyHeader), secret };
  };
  /**
   * A speech model with what calling it needs, and its role's time limit (spec §9.6: configurable).
   * @param {string} modelId @param {'in' | 'out'} dir
   */
  const speechOf = async (modelId, dir, scope = SYS) => {
    const { type, endpoint, model, key, secret } = await resolve(modelId);
    if (type.speech !== dir) throw new ProviderError('bad-request', dir === 'in' ? `${model.name} isn't a transcription model.` : `${model.name} isn't a voice.`);
    const role = (await readConfig(ws)).roles[dir === 'in' ? 'speech-in' : 'speech-out'];
    // The trace learns the key, though a keyHeader gives the protocol none (fix pass).
    const trace = modelTrace(store, scope);
    if (secret) trace.secret(secret);
    return { type, endpoint, model, key, trace, timeoutMs: (role?.firstOutputSeconds ?? (dir === 'in' ? 15 : 10)) * 1000 };
  };
  /** The types the providers' switched-on abilities use: their protocol plugins stay. @param {import('./config.js').ProviderRecord[]} list */
  const inUse = (list) => new Set(list.flatMap((p) => Object.values(providerOf(p).abilities).filter((a) => a.on).map((a) => a.type)));
  /**
   * Uninstalls a provider plugin no provider comes from, then the protocol plugins nothing needs any
   * more (decision 10). @param {string} plugin @returns {Promise<string[]>} the protocols removed
   */
  const drop = async (plugin) => {
    if ((await plugins.installed())[plugin]) await plugins.uninstall(plugin);
    return prune(plugins, inUse(Object.values((await readConfig(ws)).providers)));
  };
  /** Plugins Add's tap installed for their own Add flow, until it is left. @type {Set<string>} */
  const brought = new Set();
  /** @type {Promise<unknown>} adding and the featured start's install go one at a time: they share requirements */
  let line = Promise.resolve();
  /** @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  const queued = (work) => {
    const run = line.then(work);
    line = run.catch(() => {});
    return run;
  };
  /** Removes annai's own provider plugins no provider comes from (the featured start's, once another is added), unless turned off. */
  const tidy = async () => {
    const cfg = await readConfig(ws);
    for (const [id, s] of Object.entries(await plugins.installed())) {
      if (s.source !== 'official' || s.enabled === false || Object.values(cfg.providers).some((p) => p.plugin === id)) continue;
      if ((await plugins.manifestOf(id))?.provider) await drop(id);
    }
  };
  /** Brings providers up to date with their plugins' descriptions (decision 4); writes only when a version differs. */
  const sync = () => syncProviders({ ws }, providers());
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let syncing;
  ready.then(() => {
    sync().catch((e) => console.warn("providers couldn't be brought up to date", e));
    // After each change of what plugins provide (a provider plugin updated, started or stopped), once things settle.
    plugins.registry.onChange(() => {
      clearTimeout(syncing);
      syncing = setTimeout(() => { sync().catch((e) => console.warn("providers couldn't be brought up to date", e)); }, 250);
      /** @type {any} */ (syncing)?.unref?.();
    });
  });
  const service = {
    bench,
    ready,
    types,
    config: () => readConfig(ws),
    providers,
    syncProviders: sync,
    /** A provider's one key. @param {string} providerId */
    keyFor: (providerId) => getKey(store, providerId),
    ensureType: ensure,
    /**
     * A provider plugin, running, with what it requires (spec §5.3): an official one from annai's
     * catalog, hash-checked, with no question; a third-party one must be installed already. official:
     * it must be annai's own (the featured start, the catalog's Add): a copy from elsewhere with that id is never
     * used (security review), and annai's own whose files no longer match the catalog is fetched again.
     * tap: the user's, so one annai switched off after errors may start again (§5.5).
     * @param {string} plugin @param {{ official?: boolean, tap?: boolean }} [o] @returns {Promise<import('./providers.js').ProviderSource>}
     */
    async installProvider(plugin, { official = false, tap = true } = {}) {
      await ready;
      const running = () => providers().find((p) => p.plugin === plugin);
      const state = (await plugins.installed())[plugin];
      if (state && state.source !== 'official') {
        if (official) throw new PluginError(plugin, NOT_OWN);
        if (running()) return /** @type {import('./providers.js').ProviderSource} */ (running());
        throw new PluginError(plugin, state.enabled === false ? `is turned off. ${TURN_ON}` : "isn't running. Look at it in Settings → Plugins.");
      }
      if (state && running()) {
        // Hash-checked against the catalog when it can be reached; offline, it was checked when it was installed.
        const entry = (await officialPlugins({ fetch: get, base }).catch(() => []))?.find((p) => p.id === plugin);
        if (!entry || entry.version !== state.version || (await plugins.verifyOfficial(plugin, entry))) return /** @type {import('./providers.js').ProviderSource} */ (running());
      }
      await pluginsCanLoad();
      await addFromCatalog(plugins, plugin, { fetch: get, base, tap });
      const src = running();
      // Not a tap: one annai switched off after errors stays off (§5.5), said in words, by its name.
      if (!src && plugins.registry.isDisabled(plugin)) throw new Error(`${(await plugins.installed())[plugin]?.name ?? plugin} was switched off after errors. ${TURN_ON}`);
      if (!src) throw new PluginError(plugin, "didn't provide a model provider.");
      return src;
    },
    /**
     * Adds a provider (spec §9.8): its plugin and what it requires, the protocols of the abilities
     * that start on, then the provider with its models and one key: a function giving it is called once
     * all that is in, so a sign-in's key is never lost to a failed install. Then tidy().
     * @param {string} plugin @param {Omit<import('./providers.js').AddOptions, 'key'> & { key?: string | null | (() => Promise<string>), official?: boolean }} [o]
     *   official: it must be annai's own @returns {Promise<string>} the provider's id
     */
    addProvider: (plugin, { official, key, ...o } = {}) => queued(async () => {
      const had = (await plugins.installed())[plugin];
      let id;
      try {
        const src = await service.installProvider(plugin, { official });
        for (const [ability, a] of Object.entries(src.provider.abilities)) if (o.abilities?.[ability]?.on ?? a.on !== false) await ensure(a.type);
        id = await addProviderRecords({ ws, store }, src, { ...o, key: typeof key === 'function' ? await key() : key });
      } catch (e) {
        // A failed add leaves no provider plugin it brought without a provider, nor what that alone required (fix pass).
        const cfg = await readConfig(ws).catch(() => null);
        if (!had && cfg && !Object.values(cfg.providers).some((p) => p.plugin === plugin)) await drop(plugin).catch(() => {});
        throw e;
      }
      await tidy().catch((e) => console.warn("a provider plugin with no provider couldn't be removed", e));
      return id;
    }),
    /**
     * Add's tap on a provider with code: its plugin, with what it requires; then null when the plugin has its own
     * Add flow (a panel, decision 15), which adds it, or the provider added. @param {string} plugin
     * @param {{ official?: boolean, roles?: 'recommended' | 'free' | null, filled?: string[], costs?: Record<string, string> }} [o] @returns {Promise<string | null>} the provider's id
     */
    async startAdd(plugin, { official, roles, filled, costs } = {}) {
      const had = (await plugins.installed())[plugin];
      await queued(() => service.installProvider(plugin, { official }));
      if (setupOf(plugins.registry, plugin)?.panel) {
        if (!had) brought.add(plugin);
        return null;
      }
      try {
        return await service.addProvider(plugin, { official, roles, filled, costs });
      } catch (e) {
        // As a failed add: the plugin it brought goes.
        if (!had && !Object.values((await readConfig(ws)).providers).some((p) => p.plugin === plugin)) await drop(plugin).catch(() => {});
        throw e;
      }
    },
    /** Leaving a plugin's own Add flow: one Add's tap installed, with no provider from it, goes, as before the tap. @param {string} plugin */
    leaveAdd: (plugin) => queued(async () => {
      if (brought.delete(plugin) && !Object.values((await readConfig(ws)).providers).some((p) => p.plugin === plugin)) await drop(plugin);
    }),
    /**
     * After a restore brought providers back with the settings (spec §12.3), in the same step: the plugins they and their
     * abilities that are on use, annai's own from its catalog, hash-checked, as Add installs them. A record may name any
     * plugin (an archive can be crafted), so only a model provider's is installed, checked before any download, and one
     * this installed that then brings no provider goes again, with what only it required (review R1). One that isn't
     * annai's own, or can't be had now, is named with what to do, each reason once. imported: the same import brought the
     * plugins, all switched off, and says so: those stay as they came, with no line (review R3).
     * @param {{ imported?: boolean }} [o] @returns {Promise<{ installed: string[], failed: string[] }>}
     *   installed: the plugins' names; failed: a line for each reason, naming its providers
     */
    restorePlugins: ({ imported = false } = {}) => queued(async () => {
      await ready;
      await pluginsCanLoad();
      const had = await plugins.installed();
      /** @type {import('./official.js').CatalogPlugin[] | Error} */
      const catalog = await officialPlugins({ fetch: get, base }).catch((e) => e);
      /** Whether a plugin describes a model provider: by annai's catalog, or by its own manifest when installed from elsewhere. @param {string} id */
      const isProvider = async (id) => {
        const entry = Array.isArray(catalog) ? catalog.find((x) => x.id === id) : undefined;
        if (entry) return makesProvider(entry);
        if (had[id]) return Boolean((await plugins.manifestOf(id).catch(() => null))?.provider);
        if (!Array.isArray(catalog)) throw catalog;
        throw new Error("its plugin isn't annai's own. Install it again from where it came from.");
      };
      /** @type {Map<string, string[]>} each reason, and the providers it holds back */
      const failed = new Map();
      for (const rec of Object.values((await readConfig(ws)).providers)) {
        const p = providerOf(rec);
        if (imported && had[rec.plugin]?.enabled === false) continue;
        try {
          if (!(await isProvider(rec.plugin))) throw new Error("the plugin it names doesn't provide models, so it wasn't installed.");
          await service.installProvider(rec.plugin);
          for (const a of Object.values(p.abilities)) if (a.on) await ensure(a.type);
        } catch (e) {
          const why = String(/** @type {any} */ (e)?.message ?? e).replace(/^[\w.-]+: /, '');
          failed.set(why, [...(failed.get(why) ?? []), p.name]);
        }
        if (!had[rec.plugin] && (await plugins.installed())[rec.plugin] && !providers().some((x) => x.plugin === rec.plugin)) await drop(rec.plugin).catch(() => {});
      }
      const now = await plugins.installed();
      return { installed: Object.keys(now).filter((id) => !had[id]).map((id) => String(now[id].name ?? id)), failed: [...failed].map(([why, names]) => `${names.join(', ')}: ${why}`) };
    }),
    /**
     * The featured start's plugin, installed in the background while no provider exists (spec §9.8); not a
     * tap, so one switched off stays off. @param {string} plugin @returns {Promise<import('./providers.js').ProviderSource | null>} null: a provider exists
     */
    prepareStart: (plugin) => queued(async () => {
      if (Object.keys((await readConfig(ws)).providers).length) return null;
      return service.installProvider(plugin, { official: true, tap: false });
    }),
    /**
     * Removes a provider: its key, models and their places in roles (spec §4.9). The last provider
     * made from a plugin takes that plugin with it, then the official protocol plugins nothing needs
     * any more (decision 10). @param {string} id @returns {Promise<{ plugin: string | null, protocols: string[] }>}
     */
    async removeProvider(id) {
      const rec = (await readConfig(ws)).providers[id];
      if (!rec) return { plugin: null, protocols: [] };
      // What it keeps of the conversations is deleted first, while its key is here (spec §4.9); what is left was named before the tap.
      for (const m of await releasing(id, () => removeProviderRecords(ws, store, id), true)) bench.clear(m);
      uploads.reload(); // removeProviderRecords took its uploads out of the file
      const last = !Object.values((await readConfig(ws)).providers).some((p) => p.plugin === rec.plugin) && Boolean((await plugins.installed())[rec.plugin]);
      return { plugin: last ? rec.plugin : null, protocols: last ? await drop(rec.plugin) : await prune(plugins, inUse(Object.values((await readConfig(ws)).providers))) };
    },
    /**
     * What removing a provider would take with it, for the words by Remove: its plugin when it is the
     * last made from it, and the protocol plugins nothing would need then. @param {string} id
     * @returns {Promise<{ plugin: string | null, protocols: string[] }>}
     */
    async removalOf(id) {
      const cfg = await readConfig(ws);
      const rec = cfg.providers[id];
      if (!rec) return { plugin: null, protocols: [] };
      const left = Object.values(cfg.providers).filter((p) => p.id !== id);
      const plugin = !left.some((p) => p.plugin === rec.plugin) && (await plugins.installed())[rec.plugin] ? rec.plugin : null;
      return { plugin, protocols: await pruneable(plugins, inUse(left), new Set(plugin ? [plugin] : [])) };
    },
    /**
     * Uninstalls a provider plugin (spec §4.9): the providers made from it go first, each with its key,
     * models and places in roles, then the plugin, then the protocol plugins nothing needs any more.
     * @param {string} plugin
     */
    async removeProviderPlugin(plugin) {
      for (const p of Object.values((await readConfig(ws)).providers)) if (p.plugin === plugin) await service.removeProvider(p.id);
      await drop(plugin);
    },
    /**
     * Switches an ability on or off, saved at once. Turning one on installs its official protocol
     * first; when that can't be done (offline), it says so and stays off.
     * @param {string} providerId @param {string} abilityId @param {boolean} on
     */
    async setAbility(providerId, abilityId, on) {
      const find = async () => {
        const rec = (await readConfig(ws)).providers[providerId];
        const a = rec ? providerOf(rec).abilities[abilityId] : undefined;
        if (!rec || !a) throw new ProviderError('not-found', 'That provider or ability no longer exists.');
        return { rec, a };
      };
      if (on) await ensure((await find()).a.type);
      const { rec } = await find();
      const { on: _, ...mine } = rec.user?.abilities?.[abilityId] ?? {};
      const layer = providerBase(rec).abilities[abilityId]?.on === on ? mine : { ...mine, on };
      await saveProvider(ws, { ...rec, user: { ...rec.user, abilities: { ...rec.user?.abilities, [abilityId]: layer } } });
      await service.unbench(providerId);
    },
    /**
     * "Use the recommended models" (or the free ones): each ability the suggestion names that is off by its description's
     * default (or new in an update) is switched on first, installing its protocol (a setup action); one the user switched
     * off stays off. Then every role it can fill is filled, Koe's too, whatever a switch did.
     * @param {string} providerId @param {string} which @returns {Promise<{ on: string[], failed: { name: string, error: unknown }[] }>} the abilities by name
     */
    async useSuggestion(providerId, which) {
      const cfg = await readConfig(ws);
      const rec = cfg.providers[providerId];
      const src = providers().find((s) => s.plugin === rec?.plugin);
      if (!rec || !src) throw new ProviderError('not-found', "That provider no longer exists, or its plugin isn't running.");
      const named = new Set(Object.values(src.provider.roles?.[which] ?? {}).flat());
      /** @type {{ on: string[], failed: { name: string, error: unknown }[] }} */
      const out = { on: [], failed: [] };
      for (const a of Object.values(providerOf(rec).abilities)) {
        if (a.on || (rec.user?.abilities?.[a.id]?.on === false && !rec.template?.added?.includes(a.id))) continue;
        if (!Object.values(cfg.models).some((m) => m.provider === providerId && m.ability === a.id && named.has(modelOf(m).providerId))) continue;
        try {
          await service.setAbility(providerId, a.id, true);
          out.on.push(a.name);
        } catch (error) {
          out.failed.push({ name: a.name, error });
        }
      }
      await useSuggestion({ ws }, providerId, src, which);
      return out;
    },
    /**
     * Marks a provider's key as on its free tier, or not, saved at once: on, its calls cost nothing.
     * @param {string} providerId @param {boolean} on
     */
    async setFree(providerId, on) {
      const rec = (await readConfig(ws)).providers[providerId];
      if (!rec) throw new ProviderError('not-found', 'That provider no longer exists.');
      const { free: _, ...user } = rec.user ?? {};
      await saveProvider(ws, { ...rec, user: on ? { ...user, free: true } : user });
    },
    /**
     * A role call with fallback, traced in scope (spec §9.6).
     * @param {{ role?: string, request: import('./contract.js').Request, level?: string, onEvent?: (e: import('./contract.js').StreamEvent) => void,
     *   signal?: AbortSignal, scope?: string, record?: { tag?: string, wake?: string, prefix?: string, context?: { from: number, to: number }, keepParts?: boolean },
     *   prefer?: string, repairImages?: Parameters<typeof callRole>[0]['repairImages'], speech?: Parameters<typeof callRole>[0]['speech'], firstOutputMs?: number }} c
     *   prefer: the model whose cache is warm, tried first; repairImages: fixes a refused photo (spec §9.6, §9.9); speech: resolves heard
     *   speech for each attempt (§10.3); firstOutputMs: how long the first words may take, when not the role's own setting
     */
    async call({ role = 'main', request, level, onEvent, signal, scope = SYS, record, prefer, repairImages, speech, firstOutputMs }) {
      await ready;
      const run = callRole({
        role, request, level, config: await readConfig(ws), types: types(), keyFor: (id) => getKey(store, id), bench, missing: whyNoPlugins(),
        fetch: get, signal, onEvent, trace: modelTrace(store, scope), registry: plugins.registry, record, prefer, repairImages, uploads, speech, firstOutputMs, kept, scope, tally: ws,
      });
      if (!record?.keepParts) return run;
      inflight.add(run);
      try {
        return await run;
      } finally {
        inflight.delete(run);
        // A deletion the turn left (one that failed, a chain gone), sent in the background.
        kept.count().then((n) => { if (n.waiting) drainKept().catch(() => {}); }, () => {});
      }
    },
    /** Sends the kept turns' deletions waiting (G2). */
    drainKept: () => drainKept(),
    /** A removed trip's kept turns, deleted (spec §4.9). @param {string} scope */
    forgetScope: (scope) => forgetSoon({ scope }),
    /** An ability's kept turns, its switch saved off. @param {string} endpoint */
    forgetEndpoint: (endpoint) => forgetSoon({ endpoint }),
    /** A key or address changing, or the key going: what the provider keeps goes first, with the old key. @template T @param {string} id @param {() => Promise<T>} save */
    reconnect: (id, save) => releasing(id, save),
    /**
     * Before Erase: nothing more is kept; the calls under way settle, for up to 5 s (each deleting what it kept); then
     * every kept turn is deleted, for up to timeoutMs. How many are left. @param {{ timeoutMs?: number }} [o] @returns {Promise<{ left: number }>}
     */
    async forgetAll({ timeoutMs = 10_000 } = {}) {
      erasing = true;
      await within(Promise.allSettled([...inflight]), 5000);
      await kept.queue();
      await drainFor(timeoutMs);
      const n = await kept.count();
      return { left: n.turns + n.waiting };
    },
    /**
     * What providers keep (G2), for words before a removal: turns, deletions waiting, days until the last expires, who.
     * plugin: its providers' together. @param {{ scope?: string, provider?: string, endpoint?: string, plugin?: string }} [o] @returns {Promise<{ turns: number, waiting: number, days: number, who: string[] }>}
     */
    async keptCount(o = {}) {
      const cfg = await readConfig(ws);
      const n = await kept.count(o.plugin ? { provider: Object.values(cfg.providers).filter((p) => p.plugin === o.plugin).map((p) => p.id) } : o);
      const who = new Set();
      for (const e of n.endpoints) {
        const pRec = cfg.providers[e.split('/')[0]];
        if (!pRec) continue;
        const p = providerOf(pRec);
        who.add(types().get(p.abilities[e.slice(e.indexOf('/') + 1)]?.type ?? '')?.keeps?.name ?? p.name);
      }
      return { turns: n.turns, waiting: n.waiting, days: n.until ? Math.ceil((n.until - Date.now()) / 86_400_000) : 0, who: [...who] };
    },
    /**
     * One chat model, no fallback ("Try this model"), at main's reasoning level, traced as a "try"
     * turn. A resting model is asked all the same, a failure doesn't rest it, and an answer ends its rest.
     * @param {{ modelId: string, request: import('./contract.js').Request, onEvent?: (e: import('./contract.js').StreamEvent) => void, signal?: AbortSignal }} c
     */
    async callModel({ modelId, request, onEvent, signal }) {
      await resolve(modelId, { install: true }); // a setup action: its protocol may be installed; a model gone throws
      const config = await readConfig(ws);
      const r = await callRole({
        role: 'try', models: [modelId], level: config.roles.main?.level, request, config, types: types(), keyFor: (id) => getKey(store, id), bench: new Bench(),
        fetch: get, signal, onEvent, trace: modelTrace(store, SYS), registry: plugins.registry, uploads, tally: ws,
      });
      bench.clear(modelId);
      return r;
    },
    /**
     * A quick decision (spec §9.7), recorded as a decide event.
     * @param {{ prompt: string, options: { id: string, label: string }[], threshold?: number, scope?: string, tag?: string }} c
     *   tag: whose decision it is ("plugin:<id>"), kept on its entries
     * @returns {Promise<Record<string, number>>}
     */
    async decide({ prompt, options, threshold, scope = SYS, tag }) {
      const cfg = await readConfig(ws);
      const firstId = candidates(cfg, 'decide')[0];
      const first = firstId && cfg.models[firstId] ? modelOf(cfg.models[firstId]) : null;
      // The main model is asked at level off (or the nearest it has), so a quick decision stays quick.
      const call = (/** @type {string} */ role, /** @type {any} */ request) => service.call({ role, request, scope, ...(role === 'decide' ? {} : { level: 'off' }), record: { tag: tag ?? 'decide' } });
      const r = await decideWith({ prompt, options, threshold, call, logprobs: Boolean(first?.logprobs) });
      await logEvent(store, scope, { type: 'decide', data: { prompt: prompt.slice(0, 500), options: options.map((o) => o.id), result: r.probabilities, by: r.by, ...(tag ? { tag } : {}) } }).catch(() => {});
      return r.probabilities;
    },
    /**
     * A live session with one realtime model (K4), traced in scope: annai opens it at the ability's origin, with the key
     * in the trace's secrets. A key refused, a rate limit or a server failure rests the model, as a call's would; "not found" too, unless
     * it was a resume handle the provider no longer keeps, which Koe follows with a fresh session (the iPhone trace, 2026-10-22).
     * @param {string} modelId @param {Omit<import('./contract.js').LiveSetup, 'audioIn' | 'audioOut'> & Partial<import('./contract.js').LiveSetup>} setup
     * @param {{ scope?: string, wake?: string }} [o] @returns {Promise<import('../realtime/open.js').LiveSession>}
     */
    async live(modelId, setup, { scope = SYS, wake } = {}) {
      const { type, endpoint, model, key, secret } = await resolve(modelId);
      if (!type.realtime || !type.audio) throw new ProviderError('bad-request', `${model.name} isn't a live voice model.`);
      const trace = modelTrace(store, scope);
      if (secret) trace.secret(secret);
      const tunables = { ...endpoint.tunables, ...model.tunables, ...liveTunables.get(modelId) };
      const session = openLive({
        type, endpoint, model, key, tunables, setup, trace,
        registry: plugins.registry, wake, ...(openSocket ? { socket: openSocket } : {}),
      });
      session.ready.then(() => { if (session.tunables !== tunables) liveTunables.set(modelId, session.tunables); }, () => {});
      session.closed.then(({ kind }) => {
        if (kind === 'auth' || kind === 'rate' || kind === 'server' || (kind === 'not-found' && !setup.resume)) bench.bench(modelId, COOLDOWN_MS);
      });
      return session;
    },
    /**
     * Speech to text with one transcription model (spec §10.2), traced in scope.
     * @param {{ modelId: string, audio: { data: Uint8Array, mediaType: string, seconds?: number }, scope?: string, signal?: AbortSignal, wake?: string }} c
     */
    async transcribe({ modelId, audio, scope = SYS, signal, wake }) {
      return speechCall({ ...(await speechOf(modelId, 'in', scope)), audio, fetch: get, signal, registry: plugins.registry, wake });
    },
    /**
     * A voice clip of one text from one voice (spec §10.1), traced in scope. plays: what the device plays, for a format of 'auto';
     * stream: the caller plays a stream, which a voice that streams gives (G3).
     * @param {{ modelId: string, text: string, scope?: string, signal?: AbortSignal, wake?: string, plays?: string[], stream?: boolean }} c
     */
    async synthesize({ modelId, text, scope = SYS, signal, wake, plays, stream }) {
      return speechCall({ ...(await speechOf(modelId, 'out', scope)), text, fetch: get, signal, registry: plugins.registry, wake, plays, stream });
    },
    /**
     * The quick-decision gate (spec §10.4): one decision whose question may carry heard speech,
     * and no fallback to the main model: below the threshold the answer is 'unsure'.
     * @param {{ prompt: string, options: { id: string, label: string }[], parts?: import('./contract.js').Part[], speech?: Parameters<typeof callRole>[0]['speech'],
     *   scope?: string, threshold?: number }} c
     */
    async gate({ prompt, options, parts, speech, scope = SYS, threshold }) {
      const cfg = await readConfig(ws);
      const firstId = cfg.roles.decide?.models?.[0];
      const first = firstId && cfg.models[firstId] ? modelOf(cfg.models[firstId]) : null;
      const call = (/** @type {string} */ role, /** @type {any} */ request) => service.call({ role, request, scope, speech, record: { tag: 'gate' } });
      const r = await decideWith({ prompt, options, threshold, call, logprobs: Boolean(first?.logprobs), parts, fallback: false });
      await logEvent(store, scope, { type: 'decide', data: { prompt: prompt.slice(0, 500), options: options.map((o) => o.id), result: r.probabilities, by: r.by, gate: true } }).catch(() => {});
      return r;
    },
    /** Whether photos go to this model's provider by upload, so a request carries only their ids (spec §4.8, §6.5). @param {string} modelId */
    async uploading(modelId) {
      await ready;
      const cfg = await readConfig(ws);
      const rec = cfg.models[modelId];
      const pRec = rec ? cfg.providers[rec.provider] : null;
      const ability = rec && pRec ? providerOf(pRec).abilities[rec.ability] : null;
      const type = ability ? types().get(ability.type) : null;
      if (!rec || !pRec || !ability?.on || !type?.uploadRequest || !type.readUpload || !modelOf(rec).input.includes('image')) return false;
      const endpoint = endpointOf(pRec, rec.ability, type.tunables);
      return endpoint.tunables?.uploads !== false && !uploads.isOff(endpoint.id);
    },
    /**
     * The Test button for one model; what it found is recorded on the model (spec §9.8). What it
     * says may hold the provider's own words: shown with every key blanked (§9.9). A realtime model's
     * opens a live session that must answer aloud (K4); onAudio gets its voice, to play.
     * @param {string} modelId @param {{ onAudio?: (data: Uint8Array, format: import('./contract.js').AudioFormat) => void }} [o]
     */
    async test(modelId, { onAudio } = {}) {
      const { rec, type, endpoint, model, key } = await resolve(modelId, { install: true });
      // Test asks at the level of the first role that asks this model at one (fix pass).
      const { roles } = await readConfig(ws);
      const r = ['main', 'koe', 'utility'].find((x) => roles[x]?.models.includes(modelId) && roles[x].level !== 'off');
      const role = r ? { name: r[0].toUpperCase() + r.slice(1), level: roles[r].level } : undefined;
      const result = !type.realtime ? await testModel({ type, endpoint, model, key, fetch: get, probe, role })
        : await service.live(modelId, { instructions: 'This is a connection test. Answer in a word or two.', context: '', tools: [] })
          .then((s) => testLive(s, { onAudio: onAudio ? (d) => onAudio(d, s.audioOut) : undefined }), (e) => ({ ok: false, steps: [{ step: /** @type {const} */ ('access'), ok: false, detail: explain(e) }] }));
      const found = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
      if (found.access && found.key !== false) bench.clear(modelId); // reachable with a working key: no reason to rest
      await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), ...found, at: Date.now() } });
      return withoutSecretsIn(store, result);
    },
    /**
     * Puts a provider's models back in use after its settings or key change: the user may have
     * fixed what made them fail. @param {string} providerId
     */
    async unbench(providerId) {
      for (const m of Object.values((await readConfig(ws)).models)) if (m.provider === providerId) bench.clear(m.id);
    },
    /** Tries each reasoning level of one model, and records which work (spec §9.3). @param {string} modelId */
    async testLevels(modelId) {
      const { rec, type, endpoint, model, key } = await resolve(modelId, { install: true });
      const levels = await withoutSecretsIn(store, await testLevels({ type, endpoint, model, key, fetch: get }));
      await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), levels, levelsAt: Date.now() } });
      return levels;
    },
    /**
     * The models one of a provider's abilities offers: its "Fetch model list" (spec §9.2), a setup action.
     * @param {string} providerId @param {string} abilityId @returns {Promise<import('./contract.js').ListedModel[]>}
     */
    async listModels(providerId, abilityId) {
      const rec = (await readConfig(ws)).providers[providerId];
      const provider = rec ? providerOf(rec) : null;
      const ability = provider?.abilities[abilityId];
      if (!rec || !provider || !ability) throw new ProviderError('not-found', 'That provider or ability no longer exists.');
      await ensure(ability.type);
      const { type, endpoint, key } = /** @type {NonNullable<Awaited<ReturnType<typeof reach>>>} */ (await reach(rec, abilityId));
      /**
       * A list request: to the ability's address only, never following a redirect (fix pass). Failing, it says in
       * words, by host, whether the server doesn't allow web apps or can't be reached (spec §9.8). @param {string} url @param {RequestInit} [init]
       */
      const send = async (url, init = {}) => {
        sameOrigin(endpoint, url);
        /** @type {Response} */
        let res;
        try {
          res = await get(url, { ...init, redirect: 'manual' });
        } catch (e) {
          let host = 'this address';
          try {
            host = new URL(url).host;
          } catch {
            // not an address: the words say "this address"
          }
          if (await probe(url)) {
            throw new ProviderError('blocked', `${host} doesn't allow web apps like annai to call it (no CORS headers), so annai can't list or use its models from a browser. If the provider has another address, try it, or ask the provider to allow browser access.`, { cause: e });
          }
          throw new ProviderError('unreachable', `annai couldn't reach ${host}. Check the address and your connection.`, { cause: e });
        }
        noRedirect(res, endpoint);
        return res;
      };
      /** The protocol's own list. @returns {Promise<import('./contract.js').ListedModel[]>} */
      const protocolList = async () => {
        if (type.list) return type.list({ endpoint, key });
        if (!type.listRequest || !type.readList) throw new ProviderError('bad-request', `${ability.name} can't list its models here. Add them by id.`);
        const r = type.listRequest({ endpoint, key });
        const res = await send(r.url, { headers: r.headers });
        if (!res.ok) {
          throw typeError(type, res.status, await res.text().catch(() => ''), res.headers);
        }
        return type.readList(await res.json());
      };
      // A provider plugin's own list, in the protocol's place (decision 22); a bug in it counts against it.
      const list = setupOf(plugins.registry, rec.plugin)?.list;
      if (!list) return protocolList();
      try {
        const got = await list({ ability: abilityId, endpoint, key, fetch: send, protocolList });
        return (Array.isArray(got) ? got : []).filter((m) => typeof m?.providerId === 'string' && m.providerId);
      } catch (e) {
        if (!isPluginBug(e)) throw e;
        plugins.registry.fail(rec.plugin, 'provider list', e);
        return protocolList();
      }
    },
  };
  return service;
}
