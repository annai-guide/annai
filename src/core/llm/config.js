import { validate } from '../schema.js';
import { mergePatch, diffPatch } from '../patch.js';
import { ValidationError } from '../workspace.js';
import { SYS_SETTINGS, newId } from '../scopes.js';
import { LEVELS, ROLE_LEVELS } from './reasoning.js';

/**
 * Providers, their models and roles (spec §9.2, §9.6), as files in the settings scope; one API key per
 * provider, only in secrets (§9.9). A provider is one address and one key with abilities (chat,
 * transcription, voice, realtime voice), each through a protocol's endpoint type; a model belongs to one ability. Each
 * record has two layers, the description's (or a list's) and the user's: effective values are the
 * protocol's defaults, then the description, then the user's (§9.2), so an update never overwrites them.
 * @typedef {import('../workspace.js').Workspace} Workspace @typedef {import('../types.js').Store} Store
 * @typedef {import('./cost.js').Prices} Prices
 * @typedef {{ on?: boolean, kind?: string, type?: string, name?: string, baseUrl?: string, tunables?: Record<string, any>,
 *   extraBody?: Record<string, any>, modelDefaults?: ModelValues }} AbilityValues
 *   baseUrl: its own address, '' for the provider's; modelDefaults: what a model added by id or from a list starts with
 * @typedef {{ name?: string, baseUrl?: string, headers?: Record<string, string | null>, keyHeader?: string, abilities?: Record<string, AbilityValues>, free?: boolean, local?: boolean }} ProviderValues
 *   headers: null is a description's header the user removed; keyHeader: the key goes in this header (decision 25);
 *   free: the user's key is on the provider's free tier, so its calls cost nothing (offered when the description says freeTier);
 *   local: the description's own flag, a server of the user's (Ollama, llama.cpp): its models cost nothing
 * @typedef {{ name?: string, providerId?: string, input?: string[], tools?: boolean, contextWindow?: number | null, maxOutput?: number | null,
 *   prices?: Prices | null, cacheTtls?: string[], reasoning?: Record<string, any>, tunables?: Record<string, any>, extraBody?: Record<string, any>,
 *   providerTools?: ProviderTool[], logprobs?: boolean, images?: ImageLimits }} ModelValues
 * @typedef {{ formats?: string[], maxEdge?: number, maxBytes?: number, maxCount?: number }} ImageLimits
 *   what photos the model accepts (spec §9.2): from the template, then corrected by refusals (§4.8)
 * @typedef {{ id: string, name: string, kind: 'search' | 'fetch' | 'other', patch: Record<string, any>, pricePerCall?: number, usageKey?: string,
 *   paidOnly?: boolean, freePerMonth?: number, label?: string, note?: string, shows?: string }} ProviderTool
 *   a tool the provider runs itself (spec §9.5): the patch enables it; pricePerCall (USD) × the usage count named by usageKey is its cost.
 *   paidOnly: never on a key marked free tier; freePerMonth: calls a month that cost nothing (this device's count, G4);
 *   label and note: its switch's words on its provider's page, and a line under it (else its switch is only in Settings → Tools);
 *   shows: a reply that used it is shown to the user as written, under these words (Google Search's terms), and Shiori is told so
 * @typedef {{ id: string, plugin: string, template: { version: string, values: ProviderValues, models?: string[], added?: string[] } | null, user: ProviderValues,
 *   verified?: Record<string, any>, created: number }} ProviderRecord
 *   template.version: its plugin's; template.models: the description's, "<ability>/<id>", so a model the user removed
 *   isn't added again; template.added: abilities that version brought, which arrived switched off
 * @typedef {{ id: string, provider: string, ability: string, template: { id: string, version: string, values: ModelValues } | null, user: ModelValues,
 *   verified?: Record<string, any>, created: number }} ModelRecord
 *   template.id: "<plugin>/<ability>/<provider model id>" from a description, "list/<provider model id>" from a list (version '')
 * @typedef {{ id: string, kind: string, type: string, name: string, on: boolean, baseUrl: string, tunables: Record<string, any>,
 *   extraBody: Record<string, any>, modelDefaults: ModelValues }} Ability
 * @typedef {{ id: string, plugin: string, name: string, baseUrl: string, headers: Record<string, string>, keyHeader: string,
 *   abilities: Record<string, Ability>, free: boolean, local: boolean }} Provider
 * @typedef {{ id: string, provider: string, ability: string, type: string, name: string, baseUrl: string, headers: Record<string, string>,
 *   tunables: Record<string, any>, extraBody: Record<string, any>, free?: boolean }} Endpoint
 *   what a call to one ability sees, as protocol plugins get it: id "<provider>/<ability>", name the provider's; free: its calls cost nothing
 * @typedef {{ id: string, provider: string, ability: string, name: string, providerId: string, input: string[], tools: boolean, contextWindow: number | null,
 *   maxOutput: number | null, prices: Prices | null, cacheTtls: string[], reasoning: Record<string, any>, tunables: Record<string, any>,
 *   extraBody: Record<string, any>, providerTools: ProviderTool[], logprobs: boolean, images: ImageLimits }} Model
 * @typedef {Record<string, { models: string[], level: string, firstOutputSeconds?: number }>} Roles
 *   firstOutputSeconds: how long to wait for a model's first words before trying the next (spec §9.6)
 * @typedef {{ providers: Record<string, ProviderRecord>, models: Record<string, ModelRecord>, roles: Roles }} ModelConfig
 */

/** The roles that call chat models; an empty one uses the main list (spec §9.6). */
export const CHAT_ROLES = Object.freeze(['main', 'utility', 'decide']);
/** Koe's list (the Koe and Kokoro design): chat and realtime models, in order; empty, there is no Koe, never Main. */
export const KOE_ROLE = 'koe';
/** The speech roles (spec §9.6, §10). Their lists hold stand-in entries besides models. */
export const SPEECH_ROLES = Object.freeze(['speech-in', 'speech-out']);
/** @type {Readonly<Record<string, { role: string, name: string }>>} */
export const STAND_INS = Object.freeze({
  'send-audio': { role: 'speech-in', name: 'Send audio to the model' },
  dictation: { role: 'speech-in', name: 'Phone dictation' },
  'browser-voice': { role: 'speech-out', name: 'Browser voice' },
});
/** "Send audio to the model", then phone dictation (§10.3); speech-out ends with the browser voice (§9.6). @type {Readonly<Record<string, readonly string[]>>} */
export const SPEECH_DEFAULTS = Object.freeze({ 'speech-in': Object.freeze(['send-audio', 'dictation']), 'speech-out': Object.freeze(['browser-voice']) });

const providerPath = (/** @type {string} */ id) => `/llm/providers/${id}.json`;
const modelPath = (/** @type {string} */ id) => `/llm/models/${id}.json`;
const ROLES_PATH = '/llm/roles.json';
const UPLOADS_PATH = '/llm/uploads.json';
const secretId = (/** @type {string} */ providerId) => `llm:${providerId}`;
/** What each kind of ability is called, when its description gives no name. @type {Record<string, string>} */
const KIND_NAMES = { chat: 'Chat', transcription: 'Transcription', voice: 'Voice', realtime: 'Live voice' };
const MODEL_DEFAULTS = Object.freeze({
  name: '', providerId: '', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: null,
  cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {},
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
        pricePerCall: { type: 'number', minimum: 0 }, usageKey: { type: 'string' }, paidOnly: { type: 'boolean' }, freePerMonth: { type: 'integer', minimum: 0 },
        label: { type: 'string', maxLength: 120 }, note: { type: 'string', maxLength: 1000 }, shows: { type: 'string', maxLength: 120 } } } },
    logprobs: { type: 'boolean' },
    images: { type: 'object', properties: { formats: { type: 'array', items: { type: 'string' } }, maxEdge: { type: 'integer', minimum: 16 }, maxBytes: { type: 'integer', minimum: 1 }, maxCount: { type: 'integer', minimum: 1 } } },
    cacheTtls: { type: 'array', items: { enum: ['5m', '1h'] } },
  },
};
const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,80}$' };
const ABILITY_VALUES = {
  type: 'object',
  properties: {
    on: { type: 'boolean' }, kind: { enum: ['chat', 'transcription', 'voice', 'realtime'] }, type: { type: 'string', maxLength: 41 }, name: { type: 'string', maxLength: 80 },
    baseUrl: { type: 'string', maxLength: 2000 }, tunables: OBJECT, extraBody: OBJECT, modelDefaults: VALUES,
  },
};
const PROVIDER_VALUES = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 120 }, baseUrl: { type: 'string', maxLength: 2000 }, keyHeader: { type: 'string', maxLength: 80 },
    headers: { type: 'object', additionalProperties: { type: ['string', 'null'] } }, // null: a description's header the user removed
    abilities: { type: 'object', additionalProperties: ABILITY_VALUES }, free: { type: 'boolean' }, local: { type: 'boolean' },
  },
};
const PROVIDER_SCHEMA = {
  type: 'object',
  required: ['id', 'plugin', 'template', 'user', 'created'],
  properties: {
    id: ID, plugin: { type: 'string', minLength: 1, maxLength: 64 }, user: PROVIDER_VALUES, verified: OBJECT, created: { type: 'number' },
    template: { type: ['object', 'null'], required: ['version', 'values'], properties: {
      version: { type: 'string' }, values: PROVIDER_VALUES, models: { type: 'array', items: { type: 'string' } }, added: { type: 'array', items: { type: 'string' } },
    } },
  },
};
const MODEL_SCHEMA = {
  type: 'object',
  required: ['id', 'provider', 'ability', 'template', 'user', 'created'],
  properties: {
    id: ID, provider: { type: 'string', minLength: 1 }, ability: { type: 'string', minLength: 1 }, user: VALUES, verified: OBJECT, created: { type: 'number' },
    template: { type: ['object', 'null'], required: ['id', 'version', 'values'], properties: { id: { type: 'string' }, version: { type: 'string' }, values: VALUES } },
  },
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

/** @param {string} plugin @param {{ template?: ProviderRecord['template'], user?: ProviderValues }} [layers] @returns {ProviderRecord} */
export function newProvider(plugin, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('pv'), plugin, template, user, created: now };
}

/** @param {string} provider @param {string} ability @param {{ template?: ModelRecord['template'], user?: ModelValues }} [layers] @returns {ModelRecord} */
export function newModel(provider, ability, { template = null, user = {} } = {}, now = Date.now()) {
  return { id: newId('m'), provider, ability, template, user, created: now };
}

/** @param {any} v */
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A provider as settings and calls see it: the description's layer, then the user's (none for its
 * base). Each ability's tunables start from its type's defaults; its address is its own, else the provider's.
 * @param {ProviderRecord} rec @param {(type: string) => Record<string, any>} tunablesFor @param {boolean} withUser @returns {Provider}
 */
function build(rec, tunablesFor, withUser) {
  const tpl = rec.template?.values ?? {};
  const usr = withUser ? rec.user ?? {} : {};
  /** @type {ProviderValues} */
  const v = mergePatch(tpl, usr);
  /** @type {Record<string, Ability>} */
  const abilities = {};
  for (const [id, a] of Object.entries(v.abilities ?? {})) {
    if (!isObject(a)) continue;
    const type = String(a.type ?? '');
    /** @type {AbilityValues} */
    const eff = mergePatch(mergePatch({ tunables: tunablesFor(type) }, tpl.abilities?.[id] ?? {}), usr.abilities?.[id] ?? {});
    const kind = String(eff.kind ?? '');
    if (!type || !KIND_NAMES[kind]) continue; // what is left of an ability a description no longer has
    abilities[id] = {
      id, kind, type, name: eff.name || KIND_NAMES[kind], on: eff.on !== false, baseUrl: eff.baseUrl || v.baseUrl || '',
      tunables: eff.tunables ?? {}, extraBody: eff.extraBody ?? {}, modelDefaults: eff.modelDefaults ?? {},
    };
  }
  const headers = /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(v.headers ?? {}).filter(([, x]) => typeof x === 'string')));
  return { id: rec.id, plugin: rec.plugin, name: v.name || rec.plugin, baseUrl: v.baseUrl ?? '', headers, keyHeader: v.keyHeader ?? '', abilities, free: v.free === true, local: v.local === true };
}

/** The provider as settings and calls see it. @param {ProviderRecord} rec @param {(type: string) => Record<string, any>} [tunablesFor] the type's tunable defaults @returns {Provider} */
export function providerOf(rec, tunablesFor = () => ({})) {
  return build(rec, tunablesFor, true);
}

/** The provider without the user's changes, for diffLayer. @param {ProviderRecord} rec @param {(type: string) => Record<string, any>} [tunablesFor] @returns {Provider} */
export function providerBase(rec, tunablesFor = () => ({})) {
  return build(rec, tunablesFor, false);
}

/**
 * What a call to one of a provider's abilities sees, in the shape protocol plugins get (spec §9.1).
 * @param {ProviderRecord} rec @param {string} abilityId @param {Record<string, any>} [tunableDefaults] its type's @returns {Endpoint}
 */
export function endpointOf(rec, abilityId, tunableDefaults = {}) {
  const p = providerOf(rec, () => tunableDefaults);
  const a = p.abilities[abilityId];
  return {
    id: `${rec.id}/${abilityId}`, provider: rec.id, ability: abilityId, type: a?.type ?? '', name: p.name,
    baseUrl: a?.baseUrl ?? p.baseUrl, headers: p.headers, tunables: a?.tunables ?? {}, extraBody: a?.extraBody ?? {}, ...(p.free ? { free: true } : {}),
  };
}

/**
 * The endpoint and key a protocol gets: with a keyHeader, the key goes in that header and the
 * protocol gets none, so the protocol contract doesn't change (decision 25).
 * @param {Endpoint} endpoint @param {string | null} key @param {string} [keyHeader] @returns {{ endpoint: Endpoint, key: string | null }}
 */
export function sendKey(endpoint, key, keyHeader) {
  if (!keyHeader || !key) return { endpoint, key: keyHeader ? null : key };
  return { endpoint: { ...endpoint, headers: { ...endpoint.headers, [keyHeader]: key } }, key: null };
}

/** The model without the user's changes. @param {ModelRecord} rec */
export function modelBase(rec) {
  return { ...MODEL_DEFAULTS, ...mergePatch(MODEL_DEFAULTS, rec.template?.values ?? {}) };
}

/** The model as calls see it; it is named by its provider id until the user names it. @param {ModelRecord} rec @returns {Model} */
export function modelOf(rec) {
  const v = { ...MODEL_DEFAULTS, ...mergePatch(modelBase(rec), rec.user ?? {}) };
  return { id: rec.id, provider: rec.provider, ability: rec.ability, ...v, name: v.name || v.providerId };
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

/**
 * Every provider, model and role. Records that aren't valid are skipped, and a model only counts
 * while its provider has its ability. @param {Workspace} ws @returns {Promise<ModelConfig>}
 */
export async function readConfig(ws) {
  /** @type {ModelConfig} */
  const cfg = { providers: {}, models: {}, roles: {} };
  for (const f of await ws.list(SYS_SETTINGS, '/llm/providers/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(PROVIDER_SCHEMA, rec).length) cfg.providers[rec.id] = rec;
  }
  /** @type {Map<string, Set<string>>} */
  const has = new Map(Object.values(cfg.providers).map((p) => [p.id, new Set(Object.keys(providerOf(p).abilities))]));
  for (const f of await ws.list(SYS_SETTINGS, '/llm/models/')) {
    const rec = await ws.readJSON(SYS_SETTINGS, f.path).catch(() => null);
    if (rec && !validate(MODEL_SCHEMA, rec).length && has.get(rec.provider)?.has(rec.ability)) cfg.models[rec.id] = rec;
  }
  cfg.roles = rolesFrom(await ws.readJSON(SYS_SETTINGS, ROLES_PATH).catch(() => null), cfg.models);
  return cfg;
}

/**
 * Every chat, Koe and speech role with its level, keeping only models that exist and, in a speech
 * list, its own stand-ins. A speech list never saved holds the defaults; one the user emptied stays empty.
 * @param {any} saved @param {Record<string, ModelRecord>} models @returns {Roles}
 */
function rolesFrom(saved, models) {
  const { 'koe-talk': talk, 'koe-type': type, ...s } = saved && typeof saved === 'object' ? saved : {};
  // Koe's two lists before they were one (2026-10-19): the talking list's models, then the typing list's, and its wait, else
  // the typing list's. Not their level: old files hold an explicit 'off', the old default, which would defeat the new 'low'.
  s.koe ??= talk || type ? { models: [...new Set([talk?.models, type?.models].flatMap((m) => (Array.isArray(m) ? m : [])))], firstOutputSeconds: talk?.firstOutputSeconds ?? type?.firstOutputSeconds } : undefined;
  /** @type {Roles} */
  const out = {};
  for (const role of new Set([...CHAT_ROLES, KOE_ROLE, ...SPEECH_ROLES, ...Object.keys(s)])) {
    const r = s[role] ?? {};
    const speech = SPEECH_ROLES.includes(role);
    const kept = (/** @type {any} */ id) => typeof id === 'string' && (Boolean(models[id]) || (speech && STAND_INS[id]?.role === role));
    out[role] = {
      models: Array.isArray(r.models) ? r.models.filter(kept) : speech ? [...SPEECH_DEFAULTS[role]] : [],
      level: LEVELS.includes(r.level) ? r.level : /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off',
      ...(Number.isInteger(r.firstOutputSeconds) && r.firstOutputSeconds >= 1 ? { firstOutputSeconds: r.firstOutputSeconds } : {}),
    };
  }
  return out;
}

/** Saves a provider, and any of its models given, in one transaction. @param {Workspace} ws @param {ProviderRecord} rec @param {ModelRecord[]} [models] */
export async function saveProvider(ws, rec, models = []) {
  check(PROVIDER_SCHEMA, rec, providerPath(rec.id));
  for (const m of models) check(MODEL_SCHEMA, m, modelPath(m.id));
  await ws.writeMany(SYS_SETTINGS, [{ path: providerPath(rec.id), content: rec }, ...models.map((m) => ({ path: modelPath(m.id), content: m }))], { author: 'user' });
}

/** Saves a model. Its provider must exist with its ability, and no other model may have its name. @param {Workspace} ws @param {ModelRecord} rec */
export async function saveModel(ws, rec) {
  const path = modelPath(rec.id);
  check(MODEL_SCHEMA, rec, path);
  const cfg = await readConfig(ws);
  const provider = cfg.providers[rec.provider];
  if (!provider) throw new ValidationError(path, ['$.provider: that provider no longer exists']);
  if (!providerOf(provider).abilities[rec.ability]) throw new ValidationError(path, [`$.ability: that provider has no ability called ${rec.ability}`]);
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

/**
 * Removes a provider with its models and their places in roles, in one transaction, then its key
 * and the photos uploaded to its abilities (spec §4.9: removing means removing).
 * @param {Workspace} ws @param {Store} store @param {string} id @returns {Promise<string[]>} the models removed
 */
export async function removeProviderRecords(ws, store, id) {
  const cfg = await readConfig(ws);
  const gone = new Set(Object.values(cfg.models).filter((m) => m.provider === id).map((m) => m.id));
  await ws.writeMany(SYS_SETTINGS, [
    { path: providerPath(id), content: null },
    ...[...gone].map((m) => ({ path: modelPath(m), content: null })),
    { path: ROLES_PATH, content: without(cfg.roles, gone) },
  ], { author: 'user' });
  await setKey(store, id, null);
  const uploads = await ws.readJSON(SYS_SETTINGS, UPLOADS_PATH).catch(() => null);
  if (isObject(uploads) && Object.keys(uploads).some((k) => k.startsWith(`${id}/`))) {
    await ws.write(SYS_SETTINGS, UPLOADS_PATH, Object.fromEntries(Object.entries(uploads).filter(([k]) => !k.startsWith(`${id}/`))), { author: 'system' });
  }
  return [...gone];
}

/** Removes a model and its places in roles. @param {Workspace} ws @param {string} id */
export async function removeModel(ws, id) {
  const cfg = await readConfig(ws);
  await ws.writeMany(SYS_SETTINGS, [{ path: modelPath(id), content: null }, { path: ROLES_PATH, content: without(cfg.roles, new Set([id])) }], { author: 'user' });
}

/** Stores a provider's one API key, or removes it (null or empty), only in secrets. @param {Store} store @param {string} providerId @param {string | null} key */
export async function setKey(store, providerId, key) {
  await store.tx(['secrets'], 'readwrite', async (t) => {
    if (key) await t.putSecret(secretId(providerId), key);
    else await t.deleteSecret(secretId(providerId));
  });
}

/** @param {Store} store @param {string} providerId @returns {Promise<string | null>} */
export async function getKey(store, providerId) {
  const v = await store.tx(['secrets'], 'readonly', (t) => t.getSecret(secretId(providerId)));
  return typeof v === 'string' && v ? v : null;
}

/** The ability a model belongs to, as calls see it, or null. @param {ModelConfig} cfg @param {string} modelId @returns {Ability | null} */
export function abilityOf(cfg, modelId) {
  const rec = cfg.models?.[modelId];
  const p = rec ? cfg.providers?.[rec.provider] : undefined;
  return (rec && p && providerOf(p).abilities[rec.ability]) || null;
}

/**
 * Whether a model transcribes ('in') or speaks ('out'), from its ability's kind; null for a chat
 * model, or one whose ability is off or whose type isn't running.
 * @param {ModelConfig} cfg @param {Map<string, { speech?: string }>} types @param {string} id @returns {'in' | 'out' | null}
 */
export function speechKind(cfg, types, id) {
  const a = abilityOf(cfg, id);
  if (!a?.on || !types.has(a.type)) return null;
  return a.kind === 'transcription' ? 'in' : a.kind === 'voice' ? 'out' : null;
}
