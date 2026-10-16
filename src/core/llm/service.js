import { SYS } from '../scopes.js';
import { readConfig, getKey, endpointOf } from './config.js';
import { endpointTypes, ProviderError, errorFromResponse } from './contract.js';
import { ensureType } from './official.js';
import { loadTemplates } from './templates.js';
import { callRole, Bench } from './fallback.js';
import { modelTrace } from './trace.js';

/**
 * Everything the UI needs to talk to models (spec §9): settings, endpoint types installed on
 * demand, templates, and role calls with fallback, traced.
 * @param {{ store: import('../types.js').Store, ws: import('../workspace.js').Workspace, plugins: import('../plugins.js').PluginHost,
 *   fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, ready?: Promise<unknown>, pluginsCanLoad?: () => Promise<unknown> }} c
 *   ready: settles once the installed plugins have started; pluginsCanLoad: settles when a plugin's files can be loaded
 *   (in browsers, once a service worker controls the page)
 */
export function createLlm({ store, ws, plugins, fetch: get = (url, init) => fetch(url, init), base = '', ready = Promise.resolve(), pluginsCanLoad = () => Promise.resolve() }) {
  const bench = new Bench();
  const types = () => endpointTypes(plugins.registry);
  /** @param {string} type */
  const ensure = async (type) => {
    await ready;
    if (types().has(type)) return;
    await pluginsCanLoad();
    await ensureType(plugins, type, { fetch: get, base });
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
