import { validate } from '../schema.js';
import { mergePatch, diffPatch } from '../patch.js';
import { ValidationError } from '../workspace.js';
import { SYS_SETTINGS, newId } from '../scopes.js';
import { LEVELS, ROLE_LEVELS } from './reasoning.js';

/**
 * Endpoints, models and roles (spec §9.2, §9.6), kept as files in the settings scope, and API keys,
 * kept only in secrets (§9.9). Every endpoint and model stores two layers: what a template (or a
 * fetched model list) said, and what the user changed. Effective values are plugin defaults, then
 * the template, then the user's (§9.2: user setting > template > plugin default), so a template
 * update never overwrites the user's changes.
 * @typedef {import('../workspace.js').Workspace} Workspace @typedef {import('../types.js').Store} Store
 * @typedef {import('./cost.js').Prices} Prices
 * @typedef {{ name?: string, baseUrl?: string, headers?: Record<string, string>, tunables?: Record<string, any>, extraBody?: Record<string, any> }} EndpointValues
 * @typedef {{ name?: string, providerId?: string, input?: string[], tools?: boolean, contextWindow?: number | null, maxOutput?: number | null,
 *   prices?: Prices | null, cacheTtls?: string[], reasoning?: Record<string, any>, tunables?: Record<string, any>, extraBody?: Record<string, any>,
 *   providerTools?: ProviderTool[], logprobs?: boolean }} ModelValues
 * @typedef {{ id: string, name: string, kind: 'search' | 'fetch' | 'other', patch: Record<string, any>, pricePerCall?: number, usageKey?: string }} ProviderTool
 *   a tool the provider runs itself (spec §9.5): the patch enables it; pricePerCall (USD) × the usage count named by usageKey is its cost
 * @typedef {{ id: string, type: string, template: { id: string, version: number, values: EndpointValues } | null, user: EndpointValues,
 *   verified?: Record<string, any>, created: number }} EndpointRecord
 * @typedef {{ id: string, endpoint: string, template: { id: string, version: number, values: ModelValues } | null, user: ModelValues,
 *   verified?: Record<string, any>, created: number }} ModelRecord
 * @typedef {{ id: string, type: string, name: string, baseUrl: string, headers: Record<string, string>, tunables: Record<string, any>, extraBody: Record<string, any> }} Endpoint
 * @typedef {{ id: string, endpoint: string, name: string, providerId: string, input: string[], tools: boolean, contextWindow: number | null,
 *   maxOutput: number | null, prices: Prices | null, cacheTtls: string[], reasoning: Record<string, any>, tunables: Record<string, any>,
 *   extraBody: Record<string, any>, providerTools: ProviderTool[], logprobs: boolean }} Model
 * @typedef {Record<string, { models: string[], level: string, firstOutputSeconds?: number }>} Roles
 *   firstOutputSeconds: how long to wait for a model's first words before trying the next (spec §9.6)
 * @typedef {{ endpoints: Record<string, EndpointRecord>, models: Record<string, ModelRecord>, roles: Roles }} ModelConfig
 */

/** The roles that call chat models; an empty one uses the main list (spec §9.6). */
export const CHAT_ROLES = Object.freeze(['main', 'utility', 'decide']);

const endpointPath = (/** @type {string} */ id) => `/llm/endpoints/${id}.json`;
const modelPath = (/** @type {string} */ id) => `/llm/models/${id}.json`;
const ROLES_PATH = '/llm/roles.json';
const secretId = (/** @type {string} */ endpointId) => `llm:${endpointId}`;

const ENDPOINT_DEFAULTS = Object.freeze({ name: '', baseUrl: '', headers: {}, tunables: {}, extraBody: {} });
const MODEL_DEFAULTS = Object.freeze({
  name: '', providerId: '', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: null,
  cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false,
});

const OBJECT = { type: 'object' };
const VALUES = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 120 },
    baseUrl: { type: 'string', maxLength: 2000 },
    providerId: { type: 'string', maxLength: 300 },
    headers: { type: 'object', additionalProperties: { type: ['string', 'null'] } }, // null: a template's header the user removed
    tunables: OBJECT,
    extraBody: OBJECT,
    reasoning: OBJECT,
    input: { type: 'array', items: { enum: ['text', 'image', 'pdf', 'audio'] } },
    tools: { type: 'boolean' },
    contextWindow: { type: ['integer', 'null'], minimum: 1 },
    maxOutput: { type: ['integer', 'null'], minimum: 1 },
    prices: { type: ['object', 'null'] },
    providerTools: { type: 'array', items: { type: 'object', required: ['id', 'name', 'kind', 'patch'],
      properties: { id: { type: 'string', minLength: 1 }, name: { type: 'string' }, kind: { enum: ['search', 'fetch', 'other'] }, patch: OBJECT,
        pricePerCall: { type: 'number', minimum: 0 }, usageKey: { type: 'string' } } } },
    logprobs: { type: 'boolean' },
    cacheTtls: { type: 'array', items: { enum: ['5m', '1h'] } },
  },
};
const TEMPLATE = { type: ['object', 'null'], required: ['id', 'version', 'values'], properties: { id: { type: 'string' }, version: { type: 'integer', minimum: 0 }, values: VALUES } };
const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$' };
const ENDPOINT_SCHEMA = {
  type: 'object',
  required: ['id', 'type', 'template', 'user', 'created'],
  properties: { id: ID, type: { type: 'string', minLength: 1 }, template: TEMPLATE, user: VALUES, verified: OBJECT, created: { type: 'number' } },
};
const MODEL_SCHEMA = {
  type: 'object',
  required: ['id', 'endpoint', 'template', 'user', 'created'],
  properties: { id: ID, endpoint: { type: 'string', minLength: 1 }, template: TEMPLATE, user: VALUES, verified: OBJECT, created: { type: 'number' } },
};
const ROLES_SCHEMA = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    required: ['models', 'level'],
    properties: { models: { type: 'array', items: { type: 'string' } }, level: { enum: LEVELS }, firstOutputSeconds: { type: 'integer', minimum: 1, maximum: 600 } },
  },
};

/** @param {any} schema @param {any} value @param {string} path */
function check(schema, value, path) {
  const errors = validate(schema, value);
  if (errors.length) throw new ValidationError(path, errors);
}

/** @param {string} type @param {{ template?: EndpointRecord['template'], user?: EndpointValues }} [layers] @returns {EndpointRecord} */
export function newEndpoint(type, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('ep'), type, template, user, created: now };
}

/** @param {string} endpoint @param {{ template?: ModelRecord['template'], user?: ModelValues }} [layers] @returns {ModelRecord} */
export function newModel(endpoint, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('m'), endpoint, template, user, created: now };
}

/** The endpoint without the user's changes: plugin defaults, then the template. @param {EndpointRecord} rec @param {Record<string, any>} [tunableDefaults] */
export function endpointBase(rec, tunableDefaults = {}) {
  return { ...ENDPOINT_DEFAULTS, ...mergePatch({ ...ENDPOINT_DEFAULTS, tunables: tunableDefaults }, rec.template?.values ?? {}) };
}

/** The endpoint as calls see it. @param {EndpointRecord} rec @param {Record<string, any>} [tunableDefaults] @returns {Endpoint} */
export function endpointOf(rec, tunableDefaults = {}) {
  const v = { ...ENDPOINT_DEFAULTS, ...mergePatch(endpointBase(rec, tunableDefaults), rec.user ?? {}) };
  return { id: rec.id, type: rec.type, ...v, name: v.name || rec.type };
}

/** The model without the user's changes. @param {ModelRecord} rec */
export function modelBase(rec) {
  return { ...MODEL_DEFAULTS, ...mergePatch(MODEL_DEFAULTS, rec.template?.values ?? {}) };
}

/** The model as calls see it; it is named by its provider id until the user names it. @param {ModelRecord} rec @returns {Model} */
export function modelOf(rec) {
  const v = { ...MODEL_DEFAULTS, ...mergePatch(modelBase(rec), rec.user ?? {}) };
  return { id: rec.id, endpoint: rec.endpoint, ...v, name: v.name || v.providerId };
}

/**
 * The user layer that turns base into edited: only what differs, as a merge patch, so a header,
 * tunable or reasoning level the user deleted from a template's values stays deleted. Fields edited
 * doesn't have are left as they are.
 * @param {Record<string, any>} edited @param {Record<string, any>} base
 */
export function diffLayer(edited, base) {
  // Only the fields the screen edits: one it doesn't show is never removed.
  /** @type {Record<string, any>} */
  const shown = {};
  for (const k of Object.keys(edited)) if (base[k] !== undefined) shown[k] = base[k];
  return diffPatch(shown, edited);
}

/** Every endpoint, model and role. Records that aren't valid are skipped. @param {Workspace} ws @returns {Promise<ModelConfig>} */
export async function readConfig(ws) {
  /** @type {ModelConfig} */
  const cfg = { endpoints: {}, models: {}, roles: {} };
  for (const f of await ws.list(SYS_SETTINGS, '/llm/endpoints/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(ENDPOINT_SCHEMA, rec).length) cfg.endpoints[rec.id] = rec;
  }
  for (const f of await ws.list(SYS_SETTINGS, '/llm/models/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(MODEL_SCHEMA, rec).length && cfg.endpoints[rec.endpoint]) cfg.models[rec.id] = rec;
  }
  cfg.roles = rolesFrom(await ws.readJSON(SYS_SETTINGS, ROLES_PATH).catch(() => null), cfg.models);
  return cfg;
}

/** Every chat role with its level, keeping only models that exist. @param {any} saved @param {Record<string, ModelRecord>} models @returns {Roles} */
function rolesFrom(saved, models) {
  const s = saved && typeof saved === 'object' ? saved : {};
  /** @type {Roles} */
  const out = {};
  for (const role of new Set([...CHAT_ROLES, ...Object.keys(s)])) {
    const r = s[role] ?? {};
    out[role] = {
      models: (Array.isArray(r.models) ? r.models : []).filter((/** @type {any} */ id) => typeof id === 'string' && models[id]),
      level: LEVELS.includes(r.level) ? r.level : /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off',
      ...(Number.isInteger(r.firstOutputSeconds) && r.firstOutputSeconds >= 1 ? { firstOutputSeconds: r.firstOutputSeconds } : {}),
    };
  }
  return out;
}

/** Saves an endpoint, and any of its models given, in one transaction. @param {Workspace} ws @param {EndpointRecord} rec @param {ModelRecord[]} [models] */
export async function saveEndpoint(ws, rec, models = []) {
  check(ENDPOINT_SCHEMA, rec, endpointPath(rec.id));
  for (const m of models) check(MODEL_SCHEMA, m, modelPath(m.id));
  await ws.writeMany(SYS_SETTINGS, [{ path: endpointPath(rec.id), content: rec }, ...models.map((m) => ({ path: modelPath(m.id), content: m }))], { author: 'user' });
}

/** Saves a model. Its endpoint must exist, and no other model may have its name. @param {Workspace} ws @param {ModelRecord} rec */
export async function saveModel(ws, rec) {
  const path = modelPath(rec.id);
  check(MODEL_SCHEMA, rec, path);
  const cfg = await readConfig(ws);
  if (!cfg.endpoints[rec.endpoint]) throw new ValidationError(path, ['$.endpoint: that endpoint no longer exists']);
  const name = modelOf(rec).name;
  if (!name) throw new ValidationError(path, ["$.providerId: give the provider's model id"]);
  for (const other of Object.values(cfg.models)) {
    if (other.id !== rec.id && modelOf(other).name.toLowerCase() === name.toLowerCase()) {
      throw new ValidationError(path, [`$.name: "${name}" is already used by another model`]);
    }
  }
  await ws.write(SYS_SETTINGS, path, rec, { author: 'user' });
}

/** @param {Workspace} ws @param {Roles} roles */
export async function saveRoles(ws, roles) {
  check(ROLES_SCHEMA, roles, ROLES_PATH);
  await ws.write(SYS_SETTINGS, ROLES_PATH, roles, { author: 'user' });
}

/** @param {Roles} roles @param {Set<string>} gone @returns {Roles} */
function without(roles, gone) {
  return Object.fromEntries(Object.entries(roles).map(([role, r]) => [role, { ...r, models: r.models.filter((id) => !gone.has(id)) }]));
}

/** Removes an endpoint with its models, their places in roles, and its key. @param {Workspace} ws @param {Store} store @param {string} id */
export async function removeEndpoint(ws, store, id) {
  const cfg = await readConfig(ws);
  const gone = new Set(Object.values(cfg.models).filter((m) => m.endpoint === id).map((m) => m.id));
  await ws.writeMany(SYS_SETTINGS, [
    { path: endpointPath(id), content: null },
    ...[...gone].map((m) => ({ path: modelPath(m), content: null })),
    { path: ROLES_PATH, content: without(cfg.roles, gone) },
  ], { author: 'user' });
  await setKey(store, id, null);
}

/** Removes a model and its places in roles. @param {Workspace} ws @param {string} id */
export async function removeModel(ws, id) {
  const cfg = await readConfig(ws);
  await ws.writeMany(SYS_SETTINGS, [{ path: modelPath(id), content: null }, { path: ROLES_PATH, content: without(cfg.roles, new Set([id])) }], { author: 'user' });
}

/** Stores an endpoint's API key, or removes it (null or empty), only in secrets. @param {Store} store @param {string} endpointId @param {string | null} key */
export async function setKey(store, endpointId, key) {
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (key) await t.putSecret(secretId(endpointId), key);
    else await t.deleteSecret(secretId(endpointId));
  });
}

/** @param {Store} store @param {string} endpointId @returns {Promise<string | null>} */
export async function getKey(store, endpointId) {
  const v = await store.tx(['secrets'], 'readonly', (t) => t.getSecret(secretId(endpointId)));
  return typeof v === 'string' && v ? v : null;
}
