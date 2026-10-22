import { CHAT_ROLES, readConfig, newProvider, newModel, saveProvider, saveModel, saveRoles, setKey, modelOf, providerOf, SPEECH_ROLES, SPEECH_DEFAULTS, STAND_INS, KOE_ROLE } from './config.js';
import { ROLE_KINDS } from './provider-desc.js';

/**
 * Providers made from provider plugins' descriptions (spec §9.8): its values are the template layer of
 * a provider and its models, which follows the plugin's updates while the user's layer stays (§9.2).
 * @typedef {{ plugin: string, name: string, version: string, provider: import('./provider-desc.js').ProviderDesc }} ProviderSource
 *   what a started provider plugin registers
 * @typedef {import('../workspace.js').Workspace} Workspace
 * @typedef {import('../types.js').Store} Store
 * @typedef {import('./config.js').Roles} Roles
 * @typedef {import('./config.js').ModelRecord} ModelRecord
 * @typedef {import('./config.js').ProviderValues} ProviderValues
 * @typedef {{ key?: string | null, roles?: 'recommended' | 'free' | null, name?: string, baseUrl?: string,
 *   abilities?: Record<string, { on: boolean, baseUrl?: string }>, filled?: string[], costs?: Record<string, string>, free?: boolean }} AddOptions
 *   roles: the suggestion for chat roles still empty (by default "free": nothing that costs money goes in a role by itself, §9.8);
 *   abilities: on or off, and an address of their own; filled: gets the roles the add changed; free: the key is on the provider's free tier, so its models cost nothing; costs: gets, for each of them filled with a model that costs money, that model's name
 */

/** A provider's template layer: notes, keyUrl and models stay in the description. @param {ProviderSource} src @returns {ProviderValues} */
export function providerValues(src) {
  const d = src.provider;
  /** @type {ProviderValues} */
  const v = { name: src.name, baseUrl: d.baseUrl ?? '' };
  if (d.headers) v.headers = d.headers;
  if (d.keyHeader) v.keyHeader = d.keyHeader;
  if (d.local) v.local = true;
  v.abilities = Object.fromEntries(Object.entries(d.abilities).map(([id, a]) => [id, {
    kind: a.kind, type: a.type, on: a.on !== false,
    ...(a.name ? { name: a.name } : {}), ...(a.baseUrl ? { baseUrl: a.baseUrl } : {}), ...(a.tunables ? { tunables: a.tunables } : {}),
    ...(a.extraBody ? { extraBody: a.extraBody } : {}), ...(a.modelDefaults ? { modelDefaults: a.modelDefaults } : {}),
  }]));
  return v;
}

/** The description's models, by "<ability>/<provider model id>". @param {ProviderSource} src */
const descModels = (src) => Object.entries(src.provider.abilities).flatMap(([ability, a]) => (a.models ?? []).map((m) => ({ ability, key: `${ability}/${m.providerId}`, values: m })));

/** A model under its name, or "name (2)", "name (3)"…: the first no other model has. @param {ModelRecord} rec @param {Set<string>} taken lower-case names */
function named(rec, taken) {
  const name = modelOf(rec).name;
  let unique = name;
  for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${name} (${i})`;
  taken.add(unique.toLowerCase());
  if (unique !== name) rec.user = { ...rec.user, name: unique };
  return rec;
}

/**
 * A speech list with models added (spec §10.3): transcription after "Send audio to the model", a voice
 * ahead of the browser voice. Models already in it stay. @param {readonly string[]} list @param {string[]} add @param {string} role @returns {string[]}
 */
export function withSpeech(list, add, role) {
  const fresh = add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i);
  const at = role === 'speech-in' ? list.indexOf('send-audio') + 1 : list.includes('browser-voice') ? list.indexOf('browser-voice') : list.length;
  return [...list.slice(0, at), ...fresh, ...list.slice(at)];
}

/** A speech list with one entry the user added: a model where withSpeech puts it, a stand-in last. @param {readonly string[]} list @param {string} id @param {string} role @returns {string[]}
 */
export function speechAdd(list, id, role) {
  return STAND_INS[id] ? [...list.filter((x) => x !== id), id] : withSpeech(list, [id], role);
}

/**
 * A speech list with models added behind everything in it, the stand-ins too, so the free path stays
 * first (decision 6; the user, 2026-10-18: "Add, behind phone"). A list the user emptied stays empty. @param {readonly string[]} list @param {string[]} add @returns {string[]}
 */
export function speechBehind(list, add) {
  return list.length ? [...list, ...add.filter((id, i) => !list.includes(id) && add.indexOf(id) === i)] : [...list];
}

/**
 * Roles with a suggestion filled in. onlyEmpty keeps chat roles the user set; speech models move ahead
 * of the stand-ins (withSpeech), or, behind, join the end. Koe's list is filled only when koe is
 * asked (the tap on "Use the recommended models"): the split is opt-in, so adding a provider never turns it on.
 * @param {Roles} roles @param {(role: string, providerModelId: string) => string | undefined} pick the model id
 * @param {Record<string, string[]> | undefined} suggestion @param {{ onlyEmpty: boolean, behind: boolean, speech: boolean, chat: boolean, koe?: boolean }} o
 */
function suggested(roles, pick, suggestion, o) {
  const next = structuredClone(roles);
  for (const [role, ids] of Object.entries(suggestion ?? {})) {
    if (role === KOE_ROLE && !o.koe) continue;
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

/** Whether a model costs nothing: its provider is a local server or its key is on the free tier, or its prices are all zero (a model with no price on another provider is not free). @param {import('./config.js').ModelConfig} cfg @param {string} id */
function free(cfg, id) {
  const m = cfg.models[id];
  if (!m) return false;
  const owner = providerOf(cfg.providers[m.provider]);
  if (owner.free || owner.local) return true;
  const prices = modelOf(m).prices;
  return Boolean(prices) && Object.keys(prices ?? {}).length > 0 && Object.values(prices ?? {}).every((v) => v === 0);
}

/** A provider's model for a role: the first switched-on ability of the role's kind with that id. @param {import('./config.js').ModelConfig} cfg @param {string} providerId
 */
function picker(cfg, providerId) {
  const rec = cfg.providers[providerId];
  const abilities = rec ? Object.values(providerOf(rec).abilities).filter((a) => a.on) : [];
  const mine = Object.values(cfg.models).filter((m) => m.provider === providerId);
  return (/** @type {string} */ role, /** @type {string} */ pid) => {
    for (const a of abilities) {
      if (!ROLE_KINDS[role]?.includes(a.kind)) continue;
      const m = mine.find((x) => x.ability === a.id && modelOf(x).providerId === pid);
      if (m) return m.id;
    }
    return undefined;
  };
}

/**
 * Adds a provider from its description (spec §9.8): it, every ability's models, its one key, and the
 * suggestion for chat roles still empty (by default only its free models: an empty chat role falls back to Main, so
 * a model that costs money there would go ahead of something free); speech models go behind (decision 6), the recommended
 * suggestion's when the chosen one has none, so "free" still brings a voice. @param {{ ws: Workspace, store: Store }} c @param {ProviderSource} src @param {AddOptions} [o]
 * @returns {Promise<string>} the provider's id
 */
export async function addProvider({ ws, store }, src, { key = null, roles = 'free', name, baseUrl, abilities = {}, filled, costs, free: onFree } = {}) {
  const cfg = await readConfig(ws);
  const taken = new Set(Object.values(cfg.models).map((m) => modelOf(m).name.toLowerCase()));
  const values = providerValues(src);
  /** @type {ProviderValues} */
  const user = {};
  if (name) user.name = name;
  if (baseUrl) user.baseUrl = baseUrl;
  if (onFree) user.free = true;
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
    if (roles === 'free') {
      // Still empty: nothing here is free. An empty role that would fall back to a free Main stays empty; any other, Main
      // above all, gets the provider's recommended model, so Shiori can answer, and the page says it costs money (spec §9.8).
      for (const role of CHAT_ROLES) {
        if (next[role]?.models.length) continue;
        const main = next.main?.models[0];
        if (role !== 'main' && main && free(after, main)) continue;
        const got = suggested(next, pick, { [role]: all.recommended?.[role] ?? [] }, { onlyEmpty: true, behind: true, speech: false, chat: true });
        const id = got[role]?.models[0];
        if (!id || next[role]?.models.length === got[role].models.length) continue;
        next = got;
        if (costs && !free(after, id)) costs[role] = modelOf(after.models[id]).name;
      }
    }
    await saveRoles(ws, next);
    filled?.push(...Object.keys(next).filter((r) => JSON.stringify(next[r]?.models) !== JSON.stringify(cfg.roles[r]?.models)));
  }
  return rec.id;
}

/**
 * Brings providers up to date when their plugin's version changed (decision 4): new template layers,
 * models new to the description (in no role), and new abilities switched off (decision 5). The user's
 * layers stay; models gone from the description, or removed by the user, stay as they are. @param {{ ws: Workspace }} c @param {ProviderSource[]} sources @returns {Promise<number>} the providers refreshed
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

/** A suggestion ("free", "recommended") put in its roles on the user's tap, speech models ahead of the stand-ins. @param {{ ws: Workspace }} c @param {string} providerId @param {ProviderSource} src @param {string} which
 */
export async function useSuggestion({ ws }, providerId, src, which) {
  const cfg = await readConfig(ws);
  await saveRoles(ws, suggested(cfg.roles, picker(cfg, providerId), src.provider.roles?.[which], { onlyEmpty: false, behind: false, speech: true, chat: true, koe: true }));
}

/** What a model added by id or from a list starts with: its ability's modelDefaults. @param {import('./config.js').ModelConfig} cfg @param {string} providerId @param {string} abilityId */
function startFor(cfg, providerId, abilityId) {
  const rec = cfg.providers[providerId];
  const a = rec ? providerOf(rec).abilities[abilityId] : undefined;
  if (!a) throw new Error(`That provider has no ability called ${abilityId}.`);
  return structuredClone(a.modelDefaults ?? {});
}

/** Adds a model from an ability's list: what the list said, over modelDefaults, is its template layer. @param {{ ws: Workspace }} c @param {string} providerId @param {string} abilityId @param {import('./contract.js').ListedModel} listed
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
