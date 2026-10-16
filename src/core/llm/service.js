import { SYS } from '../scopes.js';
import { readConfig, getKey, endpointOf, modelOf, saveModel } from './config.js';
import { testModel, testLevels } from './check.js';
import { endpointTypes, ProviderError, errorFromResponse } from './contract.js';
import { ensureType } from './official.js';
import { loadTemplates } from './templates.js';
import { callRole, Bench } from './fallback.js';
import { modelTrace } from './trace.js';

/**
 * Everything the UI needs to talk to models (spec §9): settings, endpoint types installed on
 * demand, templates, and role calls with fallback, traced.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, plugins: import('../plugins.js').PluginHost,
 *   fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, ready?: Promise<unknown>, pluginsCanLoad?: () => Promise<unknown>,
 *   probe?: (url: string) => Promise<boolean> }} c
 *   ready: settles once the installed plugins have started; pluginsCanLoad: settles when a plugin's files can be loaded
 *   (in browsers, once a service worker controls the page); probe: whether a server answers at an address at all, asked
 *   in no-cors mode, which a browser lets through to any server, to tell "blocks web apps" from "down" (spec §9.8)
 */
export function createLlm({
  store, ws, plugins, fetch: get = (url, init) => fetch(url, init), base = '', ready = Promise.resolve(), pluginsCanLoad = () => Promise.resolve(),
  probe = (/** @type {string} */ url) => get(url, { mode: 'no-cors', cache: 'no-store' }).then(() => true, () => false),
}) {
  const bench = new Bench();
  const types = () => endpointTypes(plugins.registry);
  /** @param {string} type */
  const ensure = async (type) => {
    await ready;
    if (types().has(type)) return;
    await pluginsCanLoad();
    await ensureType(plugins, type, { fetch: get, base });
  };
  /** @param {string} modelId */
  const resolve = async (modelId) => {
    const cfg = await readConfig(ws);
    const rec = cfg.models[modelId];
    const epRec = rec ? cfg.endpoints[rec.endpoint] : undefined;
    if (!rec || !epRec) throw new ProviderError('not-found', 'That model no longer exists.');
    await ensure(epRec.type);
    const type = /** @type {import('./contract.js').EndpointType} */ (types().get(epRec.type));
    return { rec, type, endpoint: endpointOf(epRec, type.tunables), model: modelOf(rec), key: await getKey(store, epRec.id) };
  };
  return {
    bench,
    ready,
    types,
    config: () => readConfig(ws),
    templates: () => loadTemplates({ ws, fetch: get, base }),
    /** @param {string} id */
    keyFor: (id) => getKey(store, id),
    ensureType: ensure,
    /**
     * A role call with fallback, traced in scope (spec §9.6).
     * @param {{ role?: string, request: import('./contract.js').Request, level?: string, onEvent?: (e: import('./contract.js').StreamEvent) => void,
     *   signal?: AbortSignal, scope?: string }} c
     */
    async call({ role = 'main', request, level, onEvent, signal, scope = SYS }) {
      await ready;
      return callRole({
        role, request, level, config: await readConfig(ws), types: types(), keyFor: (id) => getKey(store, id), bench,
        fetch: get, signal, onEvent, trace: modelTrace(store, scope), registry: plugins.registry,
      });
    },
    /** The Test button for one model; what it found is recorded on the model (spec §9.8). @param {string} modelId */
    async test(modelId) {
      const { rec, type, endpoint, model, key } = await resolve(modelId);
      const result = await testModel({ type, endpoint, model, key, fetch: get, probe });
      const found = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
      if (found.access && found.key !== false) bench.clear(modelId); // reachable with a working key: no reason to rest
      await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), ...found, at: Date.now() } });
      return result;
    },
    /**
     * Puts an endpoint's models back in use after its settings or key change: the user may
     * have fixed what made them fail. @param {string} endpointId
     */
    async unbench(endpointId) {
      for (const m of Object.values((await readConfig(ws)).models)) if (m.endpoint === endpointId) bench.clear(m.id);
    },
    /** Tries each reasoning level of one model, and records which work (spec §9.3). @param {string} modelId */
    async testLevels(modelId) {
      const { rec, type, endpoint, model, key } = await resolve(modelId);
      const levels = await testLevels({ type, endpoint, model, key, fetch: get });
      await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), levels, levelsAt: Date.now() } });
      return levels;
    },
    /** The models an endpoint offers: its "fetch model list" (spec §9.2). @param {string} endpointId @returns {Promise<import('./contract.js').ListedModel[]>} */
    async listModels(endpointId) {
      const rec = (await readConfig(ws)).endpoints[endpointId];
      if (!rec) throw new ProviderError('not-found', 'That endpoint no longer exists.');
      await ensure(rec.type);
      const type = /** @type {import('./contract.js').EndpointType} */ (types().get(rec.type));
      const endpoint = endpointOf(rec, type.tunables);
      const key = await getKey(store, endpointId);
      if (type.list) return type.list({ endpoint, key });
      if (!type.listRequest || !type.readList) throw new ProviderError('bad-request', "This endpoint type can't list its models. Add them by id.");
      const r = type.listRequest({ endpoint, key });
      /** @type {Response} */
      let res;
      try {
        res = await get(r.url, { headers: r.headers });
      } catch (e) {
        throw new ProviderError('unreachable', String(/** @type {any} */ (e)?.message ?? e));
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = errorFromResponse(res.status, text, res.headers);
        const sharper = type.classify?.(res.status, text);
        if (sharper) err.kind = sharper;
        throw err;
      }
      return type.readList(await res.json());
    },
  };
}
