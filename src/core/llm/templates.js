import { SYS_SETTINGS } from '../scopes.js';
import { readConfig, newEndpoint, newModel, saveEndpoint, saveModel, saveRoles, setKey, modelOf, SPEECH_ROLES, SPEECH_DEFAULTS, STAND_INS } from './config.js';

/**
 * Templates (spec §9.8): annai's catalog of endpoints and popular models, with their
 * capabilities, prices, reasoning maps and quirks. The user's settings are copies: a template's
 * values become the template layer of an endpoint or model, and a newer template is offered,
 * never applied silently.
 * @typedef {import('./config.js').ModelValues & { providerId: string }} TemplateModel
 * @typedef {{ id: string, version: number, type: string, name: string, baseUrl?: string, headers?: Record<string, string>,
 *   tunables?: Record<string, any>, extraBody?: Record<string, any>, keyUrl?: string, note?: string, signIn?: string,
 *   models?: TemplateModel[], roles?: Record<string, Record<string, string[]>>, from?: string }} EndpointTemplate
 *   from: the name of the package a template came from; none for annai's own (fix pass 8a-3)
 * @typedef {{ format: number, endpoints: EndpointTemplate[] }} TemplateCatalog
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./config.js').Roles} Roles
 */

const CACHE = '/llm/catalog/templates.json';
/** @type {TemplateCatalog} */
const EMPTY = Object.freeze({ format: 1, endpoints: [] });

/** @param {any} json @returns {json is TemplateCatalog} */
function valid(json) {
  return json?.format === 1 && Array.isArray(json.endpoints)
    && json.endpoints.every((/** @type {any} */ t) => typeof t?.id === 'string' && typeof t.type === 'string' && typeof t.name === 'string' && Number.isInteger(t.version));
}

/**
 * annai's templates, fetched when online and kept for offline use (spec §9.8), then extra ones (a package's, §5.2)
 * whose id annai's catalog lacks.
 * @param {{ ws: Workspace, fetch?: (url: string, init?: RequestInit) => Promise<Response>, base?: string, extra?: EndpointTemplate[] }} c
 * @returns {Promise<TemplateCatalog>}
 */
export async function loadTemplates({ ws, fetch: get = (url, init) => fetch(url, init), base = '', extra = [] }) {
  const catalog = await catalogTemplates({ ws, get, base });
  const ids = new Set(catalog.endpoints.map((t) => t.id));
  /** @type {EndpointTemplate[]} */
  const more = [];
  for (const t of extra) {
    if (!t || typeof t.id !== 'string' || ids.has(t.id)) continue;
    ids.add(t.id);
    more.push(t);
  }
  return more.length ? { ...catalog, endpoints: [...catalog.endpoints, ...more] } : catalog;
}

/** annai's own catalog of templates, or the copy from last time. @param {{ ws: Workspace, get: (url: string, init?: RequestInit) => Promise<Response>, base: string }} c @returns {Promise<TemplateCatalog>} */
async function catalogTemplates({ ws, get, base }) {
  try {
    const res = await get(`${base}/catalog/templates.json`, { cache: 'no-cache' });
    if (res.ok) {
      const json = await res.json();
      if (valid(json)) {
        await ws.write(SYS_SETTINGS, CACHE, json, { author: 'system' }).catch(() => {});
        return json;
      }
    }
  } catch {
    // offline: the copy from last time
  }
  const cached = await ws.readJSON(SYS_SETTINGS, CACHE).catch(() => null);
  return valid(cached) ? cached : EMPTY;
}

/** @param {EndpointTemplate} tpl @returns {import('./config.js').EndpointValues} */
function endpointValues(tpl) {
  /** @type {import('./config.js').EndpointValues} */
  const v = { name: tpl.name, baseUrl: tpl.baseUrl ?? '' };
  if (tpl.headers) v.headers = tpl.headers;
  if (tpl.tunables) v.tunables = tpl.tunables;
  if (tpl.extraBody) v.extraBody = tpl.extraBody;
  return v;
}

/** name, or "name (2)", "name (3)"…: the first no other model has. @param {string} name @param {Set<string>} taken lower-case names */
function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/**
 * A speech list with models added (spec §10.3): a transcription model goes after "Send audio to
 * the model" (or first), a voice ahead of the browser voice (or last). Models already in it stay where they are.
 * @param {readonly string[]} list @param {string[]} add @param {string} role @returns {string[]}
 */
export function withSpeech(list, add, role) {
  const fresh = add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i);
  const at = role === 'speech-in' ? list.indexOf('send-audio') + 1 : list.includes('browser-voice') ? list.indexOf('browser-voice') : list.length;
  return [...list.slice(0, at), ...fresh, ...list.slice(at)];
}

/**
 * A speech list with one entry the user added (spec §10.3): a model goes where a template would put
 * it, so phone dictation stays last; a stand-in added back goes last.
 * @param {readonly string[]} list @param {string} id @param {string} role @returns {string[]}
 */
export function speechAdd(list, id, role) {
  return STAND_INS[id] ? [...list.filter((x) => x !== id), id] : withSpeech(list, [id], role);
}

/**
 * A speech list with models added at its end, behind everything in it, the stand-ins too: how Sign
 * in with OpenRouter adds its transcription and voice, so the free path stays first (the user,
 * 2026-10-18: "Add, behind phone"). A list the user emptied stays empty.
 * @param {readonly string[]} list @param {string[]} add @returns {string[]}
 */
export function speechBehind(list, add) {
  return list.length ? [...list, ...add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i)] : [...list];
}

/**
 * Roles with a template's suggestion filled in. With onlyEmpty, chat roles the user has set are
 * kept. A speech list keeps its stand-ins and the user's order: the suggested models join it,
 * where a template's go (withSpeech), or behind everything in it.
 * @param {Roles} roles @param {Map<string, string>} byProvider provider model id → model id
 * @param {Record<string, string[]> | undefined} suggestion @param {boolean} onlyEmpty @param {boolean} [behind]
 */
function suggested(roles, byProvider, suggestion, onlyEmpty, behind = false) {
  const next = structuredClone(roles);
  for (const [role, providers] of Object.entries(suggestion ?? {})) {
    const models = providers.map((p) => byProvider.get(p)).filter((x) => typeof x === 'string');
    if (!models.length) continue;
    if (SPEECH_ROLES.includes(role)) {
      const list = next[role]?.models ?? SPEECH_DEFAULTS[role] ?? [];
      next[role] = { ...next[role], level: next[role]?.level ?? 'off', models: behind ? speechBehind(list, models) : withSpeech(list, models, role) };
      continue;
    }
    if (onlyEmpty && next[role]?.models.length) continue;
    next[role] = { models, level: next[role]?.level ?? 'off' };
  }
  return next;
}

/**
 * Adds an endpoint from a template: the endpoint, its models (each under a name no other model
 * has), its key, and the template's suggested models for roles that are still empty.
 * @param {{ ws: Workspace, store: Store }} c @param {EndpointTemplate} tpl
 * @param {{ key?: string | null, roles?: string | null, behind?: boolean }} [opts] roles: which suggestion ("recommended", "free"), or none;
 *   behind: its speech models go at the end of their lists (speechBehind)
 * @returns {Promise<string>} the endpoint's id
 */
export async function addFromTemplate({ ws, store }, tpl, { key = null, roles = 'recommended', behind = false } = {}) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const endpoint = newEndpoint(tpl.type, { template: { id: tpl.id, version: tpl.version, values: endpointValues(tpl) } });
  const models = (tpl.models ?? []).map((m) => {
    const rec = newModel(endpoint.id, { template: { id: `${tpl.id}/${m.providerId}`, version: tpl.version, values: m } });
    const name = modelOf(rec).name;
    const unique = uniqueName(name, taken);
    taken.add(unique.toLowerCase());
    if (unique !== name) rec.user = { name: unique };
    return rec;
  });
  await saveEndpoint(ws, endpoint, models);
  if (key) await setKey(store, endpoint.id, key);
  const suggestion = roles ? tpl.roles?.[roles] : undefined;
  if (suggestion) {
    const byProvider = new Map(models.map((m) => [modelOf(m).providerId, m.id]));
    await saveRoles(ws, suggested(cfg.roles, byProvider, suggestion, true, behind));
  }
  return endpoint.id;
}

/**
 * Puts a template's suggestion ("free", "recommended") in the roles it names, replacing what
 * they had, using this endpoint's models.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {EndpointTemplate} tpl @param {string} which
 */
export async function useSuggestion({ ws }, endpointId, tpl, which) {
  const cfg = await readConfig(ws);
  const byProvider = new Map(Object.values(cfg.models).filter((m) => m.endpoint === endpointId).map((m) => [modelOf(m).providerId, m.id]));
  await saveRoles(ws, suggested(cfg.roles, byProvider, tpl.roles?.[which], false));
}

/**
 * Endpoints made from a template that annai's catalog now has a newer version of.
 * @param {import('./config.js').ModelConfig} cfg @param {TemplateCatalog} catalog
 * @returns {{ endpoint: string, template: EndpointTemplate }[]}
 */
export function templateUpdates(cfg, catalog) {
  const byId = new Map(catalog.endpoints.map((t) => [t.id, t]));
  /** @type {{ endpoint: string, template: EndpointTemplate }[]} */
  const out = [];
  for (const e of Object.values(cfg.endpoints)) {
    const t = e.template ? byId.get(e.template.id) : undefined;
    if (t && e.template && t.version > e.template.version) out.push({ endpoint: e.id, template: t });
  }
  return out;
}

/**
 * Applies a newer template to an endpoint and to the models it made: only their template layers
 * change, so the user's own changes stay.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {EndpointTemplate} tpl
 */
export async function applyTemplate({ ws }, endpointId, tpl) {
  const cfg = await readConfig(ws);
  const endpoint = cfg.endpoints[endpointId];
  const byProvider = new Map((tpl.models ?? []).map((m) => [m.providerId, m]));
  const models = Object.values(cfg.models)
    .filter((m) => m.endpoint === endpointId && m.template?.id.startsWith(`${tpl.id}/`))
    .map((m) => {
      const values = byProvider.get(modelOf(m).providerId);
      return values && m.template ? { ...m, template: { id: m.template.id, version: tpl.version, values } } : m;
    });
  await saveEndpoint(ws, { ...endpoint, template: { id: tpl.id, version: tpl.version, values: endpointValues(tpl) } }, models);
}

/** What a model added by id or from a list starts with, by endpoint type: Claude models take both cache lifetimes. @type {Readonly<Record<string, import('./config.js').ModelValues>>} */
const START = Object.freeze({ 'anthropic-messages': { cacheTtls: ['5m', '1h'] } });
/** @param {import('./config.js').ModelConfig} cfg @param {string} endpointId */
const startFor = (cfg, endpointId) => structuredClone(START[cfg.endpoints[endpointId]?.type] ?? {});

/**
 * Adds a model from an endpoint's fetched list: what the list said is its template layer.
 * @param {{ ws: Workspace }} c @param {string} endpointId @param {import('./contract.js').ListedModel} listed
 * @returns {Promise<string>} the model's id
 */
export async function addListedModel({ ws }, endpointId, listed) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const rec = newModel(endpointId, { template: { id: `list/${listed.providerId}`, version: 0, values: { ...startFor(cfg, endpointId), ...listed } } });
  const name = modelOf(rec).name;
  const unique = uniqueName(name, taken);
  if (unique !== name) rec.user = { name: unique };
  await saveModel(ws, rec);
  return rec.id;
}

/** Adds a model by its provider id. @param {{ ws: Workspace }} c @param {string} endpointId @param {string} providerId @returns {Promise<string>} its id */
export async function addModelById({ ws }, endpointId, providerId) {
  const rec = newModel(endpointId, { user: { ...startFor(await readConfig(ws), endpointId), providerId } });
  await saveModel(ws, rec);
  return rec.id;
}
