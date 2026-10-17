import { SYS } from '../scopes.js';
import { readConfig, getKey, endpointOf, modelOf, saveModel } from './config.js';
import { decide as decideWith } from './decide.js';
import { logEvent } from '../events.js';
import { testModel, testLevels } from './check.js';
import { endpointTypes, ProviderError, errorFromResponse } from './contract.js';
import { ensureType } from './official.js';
import { loadTemplates } from './templates.js';
import { callRole, Bench, candidates } from './fallback.js';
import { modelTrace } from './trace.js';
import { Uploads } from './uploads.js';
import { speechCall } from './speech.js';
import { withoutSecretsIn } from '../agent/net.js';

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
  /** Photos uploaded to providers, by endpoint (spec §4.8). */
  const uploads = new Uploads(ws);
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
  /**
   * A speech model with what calling it needs, and its role's time limit (spec §9.6: configurable).
   * @param {string} modelId @param {'in' | 'out'} dir
   */
  const speechOf = async (modelId, dir) => {
    const { type, endpoint, model, key } = await resolve(modelId);
    if (type.speech !== dir) throw new ProviderError('bad-request', dir === 'in' ? `${model.name} isn't a transcription model.` : `${model.name} isn't a voice.`);
    const role = (await readConfig(ws)).roles[dir === 'in' ? 'speech-in' : 'speech-out'];
    return { type, endpoint, model, key, timeoutMs: (role?.firstOutputSeconds ?? (dir === 'in' ? 15 : 10)) * 1000 };
  };
  const service = {
    bench,
    ready,
    types,
    config: () => readConfig(ws),
    // Packages' endpoint templates join annai's (milestone 8a, choice 12).
    templates: () => loadTemplates({ ws, fetch: get, base, extra: plugins.registry.list('template') }),
    /** @param {string} id */
    keyFor: (id) => getKey(store, id),
    ensureType: ensure,
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
      return callRole({
        role, request, level, config: await readConfig(ws), types: types(), keyFor: (id) => getKey(store, id), bench,
        fetch: get, signal, onEvent, trace: modelTrace(store, scope), registry: plugins.registry, record, prefer, repairImages, uploads, speech, firstOutputMs,
      });
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
     * Speech to text with one transcription model (spec §10.2), traced in scope.
     * @param {{ modelId: string, audio: { data: Uint8Array, mediaType: string, seconds?: number }, scope?: string, signal?: AbortSignal, wake?: string }} c
     */
    async transcribe({ modelId, audio, scope = SYS, signal, wake }) {
      return speechCall({ ...(await speechOf(modelId, 'in')), audio, fetch: get, signal, trace: modelTrace(store, scope), registry: plugins.registry, wake });
    },
    /**
     * A voice clip of one text from one voice (spec §10.1), traced in scope.
     * @param {{ modelId: string, text: string, scope?: string, signal?: AbortSignal, wake?: string }} c
     */
    async synthesize({ modelId, text, scope = SYS, signal, wake }) {
      return speechCall({ ...(await speechOf(modelId, 'out')), text, fetch: get, signal, trace: modelTrace(store, scope), registry: plugins.registry, wake });
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
      const epRec = rec ? cfg.endpoints[rec.endpoint] : null;
      const type = epRec ? types().get(epRec.type) : null;
      if (!rec || !epRec || !type?.uploadRequest || !type.readUpload || !modelOf(rec).input.includes('image')) return false;
      return endpointOf(epRec, type.tunables).tunables?.uploads !== false && !uploads.isOff(epRec.id);
    },
    /**
     * The Test button for one model; what it found is recorded on the model (spec §9.8). What it
     * says may hold the provider's own words: shown with every key blanked (§9.9). @param {string} modelId
     */
    async test(modelId) {
      const { rec, type, endpoint, model, key } = await resolve(modelId);
      const result = await testModel({ type, endpoint, model, key, fetch: get, probe });
      const found = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
      if (found.access && found.key !== false) bench.clear(modelId); // reachable with a working key: no reason to rest
      await saveModel(ws, { ...rec, verified: { ...(rec.verified ?? {}), ...found, at: Date.now() } });
      return withoutSecretsIn(store, result);
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
      const levels = await withoutSecretsIn(store, await testLevels({ type, endpoint, model, key, fetch: get }));
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
  return service;
}
