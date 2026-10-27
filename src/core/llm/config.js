import { validate } from '../schema.js';
import { t } from '../l10n.js';
import { mergePatch, diffPatch } from '../patch.js';
import { ValidationError, NotFoundError } from '../workspace.js';
import { SYS_SETTINGS, newId } from '../scopes.js';
import { LEVELS, ROLE_LEVELS } from './reasoning.js';
import { kindWords } from './contract.js';

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
 * @typedef {{ id: string, kind: string, type: string, name: string, named: boolean, on: boolean, baseUrl: string, tunables: Record<string, any>,
 *   extraBody: Record<string, any>, modelDefaults: ModelValues }} Ability
 *   name: its description's, else its kind's in annai's English (what a model and the log read); named: its description gives it one
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
 * @typedef {'realtime' | 'classic'} KoeMode
 * @typedef {{ providers: Record<string, ProviderRecord>, models: Record<string, ModelRecord>, roles: Roles, koeMode?: KoeMode, koeChosen?: KoeMode | null }} ModelConfig
 *   koeMode: which of Koe's lists leads (the voice chip's switch); koeChosen: the one the user chose (or an old list implied), else null and
 *   koeMode follows the lists
 */

/** The roles that call chat models; an empty one uses the main list (spec §9.6). */
export const CHAT_ROLES = Object.freeze(['main', 'utility', 'decide']);
/**
 * Koe's two lists (the user, 2026-10-22: "Two lists + a switch", named "Realtime / Classic"): realtime models that hear and
 * speak, and chat models used with the speech lists. Neither ever uses Main.
 */
export const KOE_REALTIME = 'koe-realtime';
export const KOE_CLASSIC = 'koe-classic';
export const KOE_ROLES = Object.freeze([KOE_REALTIME, KOE_CLASSIC]);
/** Which of the two Koe uses, as the user chose on the voice chip. @type {readonly KoeMode[]} */
export const KOE_MODES = Object.freeze(['realtime', 'classic']);
/** Where the choice is kept: in roles.json, beside the lists, so a backup carries both. */
const MODE_KEY = 'koe-mode';
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

const providerPath = (/** @type {string} */ id) => /* en */ `/llm/providers/${id}.json`;
const modelPath = (/** @type {string} */ id) => /* en */ `/llm/models/${id}.json`;
const ROLES_PATH = '/llm/roles.json';
const UPLOADS_PATH = '/llm/uploads.json';
const secretId = (/** @type {string} */ providerId) => `llm:${providerId}`;
/** What each kind of ability is called when its description gives no name, in annai's English: a model and the log read it. */
/* en */
const KIND_NAMES = /** @type {Record<string, string>} */ ({ chat: 'Chat', transcription: 'Transcription', voice: 'Voice', realtime: 'Live voice' });

/**
 * An ability's name as a screen shows it: its description's, in its plugin's words for the screens where they have it (shown: the
 * description as the screens show it, PluginHost.shownOf), else its kind's, annai's own descriptive name in the screens' words
 * (decision 10), as the Add screen names them. @param {Pick<Ability, 'id' | 'name' | 'named' | 'kind'>} a @param {{ shown?: any }} [o]
 */
export const abilityName = (a, { shown } = {}) => (a.named ? shown?.abilities?.[a.id]?.name ?? a.name : kindWords(a.kind) ?? a.name);
const MODEL_DEFAULTS = Object.freeze({
  name: '', providerId: '', input: ['text'], tools: true, contextWindow: null, maxOutput: null, prices: null,
  cacheTtls: [], reasoning: {}, tunables: {}, extraBody: {}, providerTools: [], logprobs: false, images: {},
});

const OBJECT = { type: 'object' };
const PRICE = { type: 'number', minimum: 0 };
/** Prices that start on a date: each entry a `from` (YYYY-MM-DD) and the price fields that change from then. */
const PRICE_SCHEDULE = { type: 'array', items: { type: 'object', required: ['from'], properties: {
  from: { type: 'string', format: 'date' }, input: PRICE, output: PRICE, cacheRead: PRICE, cacheWrite: PRICE, cacheWrite1h: PRICE, audioIn: PRICE, audioOut: PRICE, image: PRICE,
  cacheReadAudio: PRICE, cacheReadImage: PRICE, perMinute: PRICE, perMillionChars: PRICE, minSeconds: PRICE, tiers: { type: 'array' } } } };
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
    prices: { type: ['object', 'null'], properties: { schedule: { ...PRICE_SCHEDULE, type: ['array', 'null'] } } }, // null on the user layer: the description's schedule removed
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
  properties: { [MODE_KEY]: { enum: KOE_MODES } },
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
      id, kind, type, name: eff.name || KIND_NAMES[kind], named: Boolean(eff.name), on: eff.on !== false, baseUrl: eff.baseUrl || v.baseUrl || '',
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
  // A price the user set stays theirs: the description's schedule does not change that field from its date (a typed input price must
  // not become Google's on 2027-01-01). A schedule of the user's own was made with those prices (the Prices box takes the fields
  // typed out of it as they are typed). A schedule left with no entry, or emptied (`[]`, or null, which older builds read as the
  // schedule removed), is no schedule.
  if (v.prices && Array.isArray(v.prices.schedule)) {
    const own = rec.user?.prices;
    const set = own && typeof own === 'object' && !('schedule' in own) ? Object.keys(own) : [];
    const entries = (set.length ? v.prices.schedule.map((/** @type {any} */ e) => (e && typeof e === 'object' ? Object.fromEntries(Object.entries(e).filter(([k]) => k === 'from' || !set.includes(k))) : e)).filter((/** @type {any} */ e) => !e || typeof e !== 'object' || Object.keys(e).length > 1) : v.prices.schedule);
    const { schedule: _, ...rest } = v.prices;
    v.prices = entries.length ? { ...rest, schedule: entries } : rest;
  }
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
  const { roles, chosen } = rolesFrom(await ws.readJSON(SYS_SETTINGS, ROLES_PATH).catch(() => null), cfg);
  cfg.roles = roles;
  cfg.koeChosen = chosen;
  cfg.koeMode = chosen ?? (roles[KOE_REALTIME]?.models.length ? 'realtime' : 'classic');
  return cfg;
}

/**
 * Every chat, Koe and speech role with its level, keeping only models that exist and, in a speech
 * list, its own stand-ins. A speech list never saved holds the defaults; one the user emptied stays empty.
 * chosen: the Koe mode saved, or the one an old Koe list implies.
 * @param {any} saved @param {ModelConfig} cfg @returns {{ roles: Roles, chosen: KoeMode | null }}
 */
function rolesFrom(saved, cfg) {
  const { models } = cfg;
  const { 'koe-talk': talk, 'koe-type': type, koe: one, [MODE_KEY]: mode, ...s } = saved && typeof saved === 'object' ? saved : {};
  /** @type {KoeMode | null} */
  let chosen = KOE_MODES.includes(mode) ? mode : null;
  // Koe's two lists before they were one (2026-10-19): the talking list's models, then the typing list's, and its wait, else
  // the typing list's. Not their level: old files hold an explicit 'off', the old default, which would defeat the new 'low'.
  const old = one ?? (talk || type ? { models: [...new Set([talk?.models, type?.models].flatMap((m) => (Array.isArray(m) ? m : [])))], firstOutputSeconds: talk?.firstOutputSeconds ?? type?.firstOutputSeconds } : undefined);
  // The one list before it was two again (the user, 2026-10-22): its realtime models make Realtime, the rest Classic, each in its
  // order, Classic keeping the list's level and wait; the mode is the kind of its first model that could answer (its ability on).
  if (old) {
    const ids = (Array.isArray(old.models) ? old.models : []).filter((/** @type {any} */ id) => typeof id === 'string' && models[id]);
    const live = (/** @type {string} */ id) => abilityOf(cfg, id)?.kind === 'realtime';
    if (!s[KOE_REALTIME] && !s[KOE_CLASSIC]) {
      s[KOE_REALTIME] = { models: ids.filter(live) };
      s[KOE_CLASSIC] = { models: ids.filter((/** @type {string} */ id) => !live(id)), level: old.level, firstOutputSeconds: old.firstOutputSeconds };
      const first = ids.find((/** @type {string} */ id) => abilityOf(cfg, id)?.on) ?? ids[0];
      chosen ??= first ? (live(first) ? 'realtime' : 'classic') : null;
    } else {
      // Left beside the new lists (an old tab's save): what isn't in either joins them by kind, at the end; their settings stay.
      const has = new Set([s[KOE_REALTIME]?.models, s[KOE_CLASSIC]?.models].flatMap((m) => (Array.isArray(m) ? m : [])));
      for (const id of ids.filter((/** @type {string} */ x) => !has.has(x))) {
        const r = live(id) ? KOE_REALTIME : KOE_CLASSIC;
        s[r] = { ...s[r], models: [...(Array.isArray(s[r]?.models) ? s[r].models : []), id] };
      }
    }
  }
  /** @type {Roles} */
  const out = {};
  for (const role of new Set([...CHAT_ROLES, ...KOE_ROLES, ...SPEECH_ROLES, ...Object.keys(s)])) {
    const r = s[role] ?? {};
    const speech = SPEECH_ROLES.includes(role);
    const kept = (/** @type {any} */ id) => typeof id === 'string' && (Boolean(models[id]) || (speech && STAND_INS[id]?.role === role));
    out[role] = {
      models: Array.isArray(r.models) ? r.models.filter(kept) : speech ? [...SPEECH_DEFAULTS[role]] : [],
      level: LEVELS.includes(r.level) ? r.level : /** @type {Record<string, string>} */ (ROLE_LEVELS)[role] ?? 'off',
      ...(Number.isInteger(r.firstOutputSeconds) && r.firstOutputSeconds >= 1 ? { firstOutputSeconds: r.firstOutputSeconds } : {}),
    };
  }
  return { roles: out, chosen };
}

/** Saves a provider, and any of its models given, in one transaction. @param {Workspace} ws @param {ProviderRecord} rec @param {ModelRecord[]} [models] */
export async function saveProvider(ws, rec, models = []) {
  check(PROVIDER_SCHEMA, rec, providerPath(rec.id));
  for (const m of models) check(MODEL_SCHEMA, m, modelPath(m.id));
  await ws.writeMany(SYS_SETTINGS, [{ path: providerPath(rec.id), content: rec }, ...models.map((m) => ({ path: modelPath(m.id), content: m }))], { author: 'user' });
}

/** What makes a model record unsaveable: its provider must exist with its ability, and no other model may have its name. @param {Workspace} ws @param {ModelRecord} rec */
async function checkModel(ws, rec) {
  const path = modelPath(rec.id);
  check(MODEL_SCHEMA, rec, path);
  const cfg = await readConfig(ws);
  const provider = cfg.providers[rec.provider];
  // Each refusal by the shown rule: the record's English for the log, the screens' words for the model's page.
  /* en */
  if (!provider) throw Object.assign(new ValidationError(path, ['$.provider: that provider no longer exists']), { shown: t`That provider no longer exists.` });
  /* en */
  if (!providerOf(provider).abilities[rec.ability]) throw Object.assign(new ValidationError(path, [`$.ability: that provider has no ability called ${rec.ability}`]), { shown: t`That provider has no ability called ${rec.ability}.` });
  const name = modelOf(rec).name;
  /* en */
  if (!name) throw Object.assign(new ValidationError(path, ["$.providerId: give the provider's model id"]), { shown: t`Give the provider's model id.` });
  for (const other of Object.values(cfg.models)) {
    if (other.id !== rec.id && modelOf(other).name.toLowerCase() === name.toLowerCase()) {
      /* en */
      throw Object.assign(new ValidationError(path, [`$.name: "${name}" is already used by another model`]), { shown: t`"${name}" is already used by another model` });
    }
  }
}

/** Saves a model. Its provider must exist with its ability, and no other model may have its name. @param {Workspace} ws @param {ModelRecord} rec */
export async function saveModel(ws, rec) {
  await checkModel(ws, rec);
  await ws.write(SYS_SETTINGS, modelPath(rec.id), rec, { author: 'user' });
}

/**
 * Changes a model as it is stored: fn gets the record and gives the new one, read and written in the file's lock, so what is
 * recorded between (a Test's result, a field saved from another page) is not lost. The checks that look at other records (its
 * provider, its name) are made on the record fn gives first, before the lock, so an autosave does not hold the lock across a scan of
 * every provider and model; in the lock the record is checked on its own, and in full again if its provider, ability or name came
 * out otherwise. fn is called more than once, so it makes its answer from the record alone.
 * @param {Workspace} ws @param {string} id @param {(rec: ModelRecord) => ModelRecord} fn @returns {Promise<ModelRecord>} the record as saved
 */
export async function updateModel(ws, id, fn) {
  const path = modelPath(id);
  const seen = await ws.readJSON(SYS_SETTINGS, path);
  if (seen === undefined) throw new NotFoundError(path);
  const checked = fn(seen);
  await checkModel(ws, checked);
  const key = (/** @type {ModelRecord} */ r) => JSON.stringify([r.provider, r.ability, modelOf(r).name.toLowerCase()]);
  return ws.update(SYS_SETTINGS, path, async (/** @type {ModelRecord} */ rec) => {
    const next = fn(rec);
    if (key(next) === key(checked)) check(MODEL_SCHEMA, next, path);
    else await checkModel(ws, next);
    return next;
  }, { author: 'user' });
}

/**
 * Records what a Test found on a model: only `verified`, changed in the model's file lock, so a field the user saved while the Test
 * ran (it can take seconds) is not written back as it was. What it names replaces what was there under that name (a level no longer
 * tried is no longer listed). A model removed meanwhile stays removed.
 * @param {Workspace} ws @param {string} id @param {Record<string, any>} verified
 */
export async function markVerified(ws, id, verified) {
  await ws.update(SYS_SETTINGS, modelPath(id), (/** @type {ModelRecord} */ rec) => ({ ...rec, verified: { ...(rec.verified ?? {}), ...verified } }), { author: 'user' }).catch((/** @type {unknown} */ e) => {
    if (!(e instanceof NotFoundError)) throw e;
  });
}

/**
 * Saves the roles, with Koe's mode as chosen (koeMode, else the one saved, or that an old Koe list implied).
 * @param {Workspace} ws @param {Roles} roles @param {{ koeMode?: KoeMode }} [o]
 */
export async function saveRoles(ws, roles, { koeMode } = {}) {
  const file = rolesFile(roles, koeMode ?? (await readConfig(ws)).koeChosen);
  check(ROLES_SCHEMA, file, ROLES_PATH);
  await ws.write(SYS_SETTINGS, ROLES_PATH, file, { author: 'user' });
}

/**
 * Writes the split of Koe's old list once, at start-up and after a restore, while the file still holds it (koe, or koe-talk and
 * koe-type): until then the mode it implied is worked out at each read, from abilities that may change meanwhile.
 * @param {Workspace} ws @returns {Promise<boolean>} whether it wrote
 */
export async function splitOldKoe(ws) {
  const saved = await ws.readJSON(SYS_SETTINGS, ROLES_PATH).catch(() => null);
  if (!saved || typeof saved !== 'object' || !['koe', 'koe-talk', 'koe-type'].some((k) => k in saved)) return false;
  await saveRoles(ws, (await readConfig(ws)).roles);
  return true;
}

/** Chooses Koe's mode (the voice chip's switch); the lists stay as they are. @param {Workspace} ws @param {KoeMode} mode */
export async function saveKoeMode(ws, mode) {
  if (!KOE_MODES.includes(mode)) /* en */ throw new ValidationError(ROLES_PATH, [`$.${MODE_KEY}: realtime or classic`]);
  await saveRoles(ws, (await readConfig(ws)).roles, { koeMode: mode });
}

/** roles.json's content: the roles, and Koe's mode when one is chosen. @param {Roles} roles @param {KoeMode | null | undefined} mode */
const rolesFile = (roles, mode) => (mode ? { ...roles, [MODE_KEY]: mode } : roles);

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
    { path: ROLES_PATH, content: rolesFile(without(cfg.roles, gone), cfg.koeChosen) },
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
  await ws.writeMany(SYS_SETTINGS, [{ path: modelPath(id), content: null }, { path: ROLES_PATH, content: rolesFile(without(cfg.roles, new Set([id])), cfg.koeChosen) }], { author: 'user' });
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
