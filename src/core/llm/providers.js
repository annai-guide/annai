import { readConfig, newProvider, newModel, saveProvider, saveModel, saveRoles, setKey, modelOf, providerOf, SPEECH_ROLES, SPEECH_DEFAULTS, STAND_INS } from './config.js';
import { ROLE_KIND } from './provider-desc.js';

/**
 * Providers made from provider plugins' descriptions (spec §9.8). The user's settings are copies:
 * a description's values become the template layer of a provider and its models, and when the
 * plugin updates, the template layer follows while the user's layer stays (§9.2).
 * @typedef {{ plugin: string, name: string, version: string, provider: import('./provider-desc.js').ProviderDesc }} ProviderSource
 *   what a started provider plugin registers: its id, name and version, and its description
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./config.js').Roles} Roles
 * @typedef {import('./config.js').ModelRecord} ModelRecord
 * @typedef {import('./config.js').ProviderValues} ProviderValues
 * @typedef {{ key?: string | null, roles?: 'recommended' | 'free' | null, name?: string, baseUrl?: string,
 *   abilities?: Record<string, { on: boolean, baseUrl?: string }> }} AddOptions
 *   roles: which suggestion fills the chat roles still empty, or none; abilities: switched on or off, and an address of their own
 */

/** The template layer of a provider, from its plugin's description: notes, keyUrl and models stay in the description. @param {ProviderSource} src @returns {ProviderValues} */
export function providerValues(src) {
  const d = src.provider;
  /** @type {ProviderValues} */
  const v = { name: src.name, baseUrl: d.baseUrl ?? '' };
  if (d.headers) v.headers = d.headers;
  if (d.keyHeader) v.keyHeader = d.keyHeader;
  v.abilities = Object.fromEntries(Object.entries(d.abilities).map(([id, a]) => [id, {
    kind: a.kind, type: a.type, on: a.on !== false,
    ...(a.name ? { name: a.name } : {}), ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}), ...(a.tunables ? { tunables: a.tunables } : {}),
    ...(a.extraBody ? { extraBody: a.extraBody } : {}), ...(a.modelDefaults ? { modelDefaults: a.modelDefaults } : {}),
  }]));
  return v;
}

/** The description's models, by "<ability>/<provider model id>". @param {ProviderSource} src */
const descModels = (src) => Object.entries(src.provider.abilities).flatMap(([ability, a]) => (a.models ?? []).map((m) => ({ ability, key: `${ability}/${m.providerId}`, values: m })));

/** name, or "name (2)", "name (3)"…: the first no other model has. @param {string} name @param {Set<string>} taken lower-case names */
function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const n = `${name} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** A model under a name no other model has, which it then takes. @param {ModelRecord} rec @param {Set<string>} taken */
function named(rec, taken) {
  const name = modelOf(rec).name;
  const unique = uniqueName(name, taken);
  taken.add(unique.toLowerCase());
  if (unique !== name) rec.user = { ...rec.user, name: unique };
  return rec;
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
 * A speech list with one entry the user added (spec §10.3): a model goes where a suggestion would put
 * it, so phone dictation stays last; a stand-in added back goes last.
 * @param {readonly string[]} list @param {string} id @param {string} role @returns {string[]}
 */
export function speechAdd(list, id, role) {
  return STAND_INS[id] ? [...list.filter((x) => x !== id), id] : withSpeech(list, [id], role);
}

/**
 * A speech list with models added at its end, behind everything in it, the stand-ins too: how a
 * provider's speech models join when it is added, so the free path stays first (decision 6; the user,
 * 2026-10-18: "Add, behind phone"). A list the user emptied stays empty.
 * @param {readonly string[]} list @param {string[]} add @returns {string[]}
 */
export function speechBehind(list, add) {
  return list.length ? [...list, ...add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i)] : [...list];
}

/**
 * Roles with a suggestion filled in, from one provider's models. A role takes the models of the
 * abilities its kind fits, the first that has the id in ability order. With onlyEmpty, chat roles the
 * user has set are kept. A speech list keeps its stand-ins: the suggested models move ahead of them
 * (withSpeech), or, behind, join its end, the rest keeping the user's order.
 * @param {Roles} roles @param {(role: string, providerModelId: string) => string | undefined} pick the model id
 * @param {Record<string, string[]> | undefined} suggestion @param {{ onlyEmpty: boolean, behind: boolean, speech: boolean, chat: boolean }} o
 */
function suggested(roles, pick, suggestion, o) {
  const next = structuredClone(roles);
  for (const [role, ids] of Object.entries(suggestion ?? {})) {
    const models = ids.map((p) => pick(role, p)).filter((x) => typeof x === 'string');
    if (!models.length) continue;
    if (SPEECH_ROLES.includes(role)) {
      if (!o.speech) continue;
      const list = next[role]?.models ?? SPEECH_DEFAULTS[role] ?? [];
      next[role] = { ...next[role], level: next[role]?.level ?? 'off', models: o.behind ? speechBehind(list, models) : withSpeech(list.filter((x) => !models.includes(x)), models, role) };
      continue;
    }
    if (!o.chat || (o.onlyEmpty && next[role]?.models.length)) continue;
    next[role] = { ...next[role], models, level: next[role]?.level ?? 'off' };
  }
  return next;
}

/**
 * Finds a provider's model for a role's suggestion: among the abilities whose kind the role takes,
 * switched on, the first in order with that provider model id. @param {import('./config.js').ModelConfig} cfg @param {string} providerId
 */
function picker(cfg, providerId) {
  const rec = cfg.providers[providerId];
  const abilities = rec ? Object.values(providerOf(rec).abilities).filter((a) => a.on) : [];
  const mine = Object.values(cfg.models).filter((m) => m.provider === providerId);
  return (/** @type {string} */ role, /** @type {string} */ pid) => {
    for (const a of abilities) {
      if (a.kind !== ROLE_KIND[role]) continue;
      const m = mine.find((x) => x.ability === a.id && modelOf(x).providerId === pid);
      if (m) return m.id;
    }
    return undefined;
  };
}

/**
 * Adds a provider from its plugin's description (spec §9.8): the provider, the models of every
 * ability (each under a name no other model has), its one key, and the suggestion: chat roles that
 * are still empty, and speech models behind everything in their lists (decision 6). A suggestion
 * without speech models leaves the recommended one's to go behind, so "free" chat still adds a voice.
 * @param {{ ws: Workspace, store: Store }} c @param {ProviderSource} src @param {AddOptions} [o]
 * @returns {Promise<string>} the provider's id
 */
export async function addProvider({ ws, store }, src, { key = null, roles = 'recommended', name, baseUrl, abilities = {} } = {}) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const values = providerValues(src);
  /** @type {ProviderValues} */
  const user = {};
  if (name) user.name = name;
  if (baseUrl) user.baseUrl = baseUrl;
  for (const [id, a] of Object.entries(abilities)) {
    if (!values.abilities?.[id]) continue;
    const mine = { ...(a.on !== values.abilities[id].on ? { on: a.on } : {}), ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}) };
    if (Object.keys(mine).length) user.abilities = { ...user.abilities, [id]: mine };
  }
  const listed = descModels(src);
  const rec = newProvider(src.plugin, { template: { version: src.version, values, models: listed.map((m) => m.key) }, user });
  const models = listed.map((m) => named(newModel(rec.id, m.ability, { template: { id: `${src.plugin}/${m.key}`, version: src.version, values: m.values } }), taken));
  await saveProvider(ws, rec, models);
  if (key) await setKey(store, rec.id, key);
  const all = src.provider.roles ?? {};
  if (roles) {
    const after = { ...cfg, providers: { ...cfg.providers, [rec.id]: rec }, models: { ...cfg.models, ...Object.fromEntries(models.map((m) => [m.id, m])) } };
    const pick = picker(after, rec.id);
    const speechIn = (/** @type {Record<string, string[]> | undefined} */ s) => Object.keys(s ?? {}).some((r) => SPEECH_ROLES.includes(r));
    let next = suggested(cfg.roles, pick, all[roles], { onlyEmpty: true, behind: true, speech: true, chat: true });
    if (!speechIn(all[roles]) && roles !== 'recommended') next = suggested(next, pick, all.recommended, { onlyEmpty: true, behind: true, speech: true, chat: false });
    await saveRoles(ws, next);
  }
  return rec.id;
}

/**
 * Brings providers up to date with their plugins' descriptions (decision 4): for each provider whose
 * plugin's version differs from the one it was made with, a new template layer for it and its models,
 * the models new to the description added (in no role), and an ability new to it added switched off
 * (decision 5: it is never put to use by itself). The user's layers are never touched; models gone from
 * the description, and models the user removed, stay as they are.
 * @param {{ ws: Workspace }} c @param {ProviderSource[]} sources @returns {Promise<number>} the providers refreshed
 */
export async function syncProviders({ ws }, sources) {
  const bySrc = new Map(sources.map((s) => [s.plugin, s]));
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  let n = 0;
  for (const rec of Object.values(cfg.providers)) {
    const src = bySrc.get(rec.plugin);
    if (!src || !rec.template || rec.template.version === src.version) continue;
    const values = providerValues(src);
    const user = structuredClone(rec.user ?? {});
    /** @type {string[]} */
    const added = [];
    for (const id of Object.keys(values.abilities ?? {})) {
      if (rec.template.values.abilities?.[id]) continue;
      added.push(id);
      if (user.abilities?.[id]?.on === undefined) user.abilities = { ...user.abilities, [id]: { ...user.abilities?.[id], on: false } };
    }
    const listed = descModels(src);
    const known = new Set(rec.template.models ?? []);
    const mine = Object.values(cfg.models).filter((m) => m.provider === rec.id);
    /** @type {ModelRecord[]} */
    const changed = [];
    for (const m of mine) {
      const d = listed.find((x) => m.template?.id === `${src.plugin}/${x.key}`);
      if (d && m.template) changed.push({ ...m, template: { id: m.template.id, version: src.version, values: d.values } });
    }
    for (const d of listed) {
      if (known.has(d.key) || mine.some((m) => m.template?.id === `${src.plugin}/${d.key}`)) continue;
      changed.push(named(newModel(rec.id, d.ability, { template: { id: `${src.plugin}/${d.key}`, version: src.version, values: d.values } }), taken));
    }
    await saveProvider(ws, { ...rec, template: { version: src.version, values, models: listed.map((d) => d.key), ...(added.length ? { added } : {}) }, user }, changed);
    n++;
  }
  return n;
}

/**
 * Puts a suggestion ("free", "recommended") in the roles it names, on the user's tap, replacing what
 * the chat roles had; speech models go ahead of the stand-ins, as the button's words say.
 * @param {{ ws: Workspace }} c @param {string} providerId @param {ProviderSource} src @param {string} which
 */
export async function useSuggestion({ ws }, providerId, src, which) {
  const cfg = await readConfig(ws);
  await saveRoles(ws, suggested(cfg.roles, picker(cfg, providerId), src.provider.roles?.[which], { onlyEmpty: false, behind: false, speech: true, chat: true }));
}

/** What a model added to an ability by id or from a list starts with: the ability's modelDefaults. @param {import('./config.js').ModelConfig} cfg @param {string} providerId @param {string} abilityId */
function startFor(cfg, providerId, abilityId) {
  const rec = cfg.providers[providerId];
  const a = rec ? providerOf(rec).abilities[abilityId] : undefined;
  if (!a) throw new Error(`That provider has no ability called ${abilityId}.`);
  return structuredClone(a.modelDefaults ?? {});
}

/**
 * Adds a model from an ability's fetched list: what the list said is its template layer, over the
 * ability's modelDefaults, under a name no other model has.
 * @param {{ ws: Workspace }} c @param {string} providerId @param {string} abilityId @param {import('./contract.js').ListedModel} listed
 * @returns {Promise<string>} the model's id
 */
export async function addListedModel({ ws }, providerId, abilityId, listed) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const rec = named(newModel(providerId, abilityId, { template: { id: `list/${listed.providerId}`, version: '', values: { ...startFor(cfg, providerId, abilityId), ...listed } } }), taken);
  await saveModel(ws, rec);
  return rec.id;
}

/** Adds a model to an ability by its provider id. @param {{ ws: Workspace }} c @param {string} providerId @param {string} abilityId @param {string} providerModelId @returns {Promise<string>} its id */
export async function addModelById({ ws }, providerId, abilityId, providerModelId) {
  const rec = newModel(providerId, abilityId, { user: { ...startFor(await readConfig(ws), providerId, abilityId), providerId: providerModelId } });
  await saveModel(ws, rec);
  return rec.id;
}
