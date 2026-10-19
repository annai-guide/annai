import { validate } from '../schema.js';

/**
 * A provider description (spec §5.2, §9.1): what a provider plugin's annai-plugin.json says of one
 * provider, as data. One address and one key, and its abilities: chat, transcription and voice, each
 * through a protocol plugin's endpoint type, with the models annai knows and the roles it suggests.
 * @typedef {import('./config.js').ModelValues} ModelValues
 * @typedef {{ kind: 'chat' | 'transcription' | 'voice', type: string, name?: string, on?: boolean, baseUrl?: string,
 *   tunables?: Record<string, any>, extraBody?: Record<string, any>, note?: string, modelDefaults?: ModelValues,
 *   models?: (ModelValues & { providerId: string })[] }} AbilityDesc
 *   on: whether it starts switched on (default true); baseUrl: its own address, else the provider's;
 *   modelDefaults: what a model added by id or from a list starts with
 * @typedef {{ baseUrl: string, key: 'required' | 'optional' | 'none', keyHeader?: string, keyUrl?: string, note?: string,
 *   headers?: Record<string, string>, local?: boolean, abilities: Record<string, AbilityDesc>,
 *   roles?: Record<string, Record<string, string[]>> }} ProviderDesc
 *   key none: no key field; keyHeader: the key goes in this header, not the protocol's way; roles: "recommended" | "free" → role → provider model ids
 */

export const ABILITY_KINDS = Object.freeze(['chat', 'transcription', 'voice']);
/** A plugin's kind in the catalog and on the Plugins page (spec §16.2). */
export const CATEGORIES = Object.freeze(['providers', 'speech', 'backup', 'tools', 'skills', 'developer']);
/** Which ability's models each role takes. @type {Readonly<Record<string, string>>} */
export const ROLE_KIND = Object.freeze({ main: 'chat', utility: 'chat', decide: 'chat', 'speech-in': 'transcription', 'speech-out': 'voice' });

const ABILITY_ID = /^[a-z][a-z0-9-]{0,30}$/;
/** The tunables protocols join onto an ability's address. */
const PATH_TUNABLES = ['path', 'listPath'];
const OBJECT = { type: 'object' };
const MODEL = { type: 'object', required: ['providerId'], properties: { providerId: { type: 'string', minLength: 1, maxLength: 300 }, name: { type: 'string', maxLength: 120 } } };
const ABILITY = {
  type: 'object',
  required: ['kind', 'type'],
  properties: {
    kind: { enum: ABILITY_KINDS }, type: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' }, name: { type: 'string', maxLength: 80 }, on: { type: 'boolean' },
    baseUrl: { type: 'string', maxLength: 2000 }, tunables: OBJECT, extraBody: OBJECT, note: { type: 'string', maxLength: 1000 }, modelDefaults: OBJECT,
    models: { type: 'array', maxItems: 200, items: MODEL },
  },
};
const DESC = {
  type: 'object',
  required: ['baseUrl', 'key', 'abilities'],
  properties: {
    baseUrl: { type: 'string', maxLength: 2000 }, key: { enum: ['required', 'optional', 'none'] }, keyHeader: { type: 'string', pattern: '^[A-Za-z0-9-]{1,80}$' },
    keyUrl: { type: 'string', pattern: '^https://', maxLength: 500 }, note: { type: 'string', maxLength: 1000 },
    headers: { type: 'object', additionalProperties: { type: 'string' } }, local: { type: 'boolean' },
    abilities: { type: 'object', additionalProperties: ABILITY },
    roles: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } },
  },
};

/**
 * What is wrong with a provider description, each as "$.where: what", or nothing. A role suggestion
 * must name a model of an ability whose kind the role takes (a chat model can't be a voice).
 * @param {any} desc @returns {string[]}
 */
export function checkProviderDesc(desc) {
  const errors = validate(DESC, desc);
  if (errors.length) return errors;
  const abilities = Object.entries(desc.abilities);
  if (!abilities.length) errors.push('$.abilities: a provider needs at least one ability');
  // Every address a key may go to must be one (security review): none is dropped, and none is plain http to another machine.
  /** @param {string} at @param {string} url */
  const address = (at, url) => {
    const wrong = addressProblem(url);
    if (wrong) errors.push(`${at}: ${wrong}`);
  };
  if (desc.baseUrl) address('$.baseUrl', desc.baseUrl);
  for (const [id, a] of abilities) {
    if (!ABILITY_ID.test(id)) errors.push(`$.abilities.${id}: an ability id is lowercase letters, digits and dashes, starting with a letter`);
    if (a.baseUrl !== undefined) address(`$.abilities.${id}.baseUrl`, a.baseUrl);
    // A protocol joins these onto the address: each must be a path from it (fix pass, Critical).
    const paths = (/** @type {string} */ at, /** @type {any} */ t) => {
      for (const k of PATH_TUNABLES) {
        const v = t?.[k];
        if (v !== undefined && (typeof v !== 'string' || !v.startsWith('/') || v.includes('//') || v.includes('@'))) errors.push(`${at}.tunables.${k}: a path from the address, starting with / (no // or @)`);
      }
    };
    paths(`$.abilities.${id}`, a.tunables);
    paths(`$.abilities.${id}.modelDefaults`, a.modelDefaults?.tunables);
    (a.models ?? []).forEach((/** @type {any} */ m, /** @type {number} */ i) => paths(`$.abilities.${id}.models[${i}]`, m.tunables));
  }
  for (const [which, roles] of Object.entries(desc.roles ?? {})) {
    for (const [role, ids] of Object.entries(/** @type {Record<string, string[]>} */ (roles))) {
      const kind = ROLE_KIND[role];
      if (!kind) {
        errors.push(`$.roles.${which}.${role}: there is no such role`);
        continue;
      }
      const have = new Set(abilities.filter(([, a]) => a.kind === kind).flatMap(([, a]) => (a.models ?? []).map((/** @type {any} */ m) => m.providerId)));
      for (const p of ids) if (!have.has(p)) errors.push(`$.roles.${which}.${role}: ${p} isn't a ${kind} model of this provider`);
    }
  }
  return errors;
}

/**
 * Why an address can't be one a key is sent to, in words, or null: it must parse, and be https, or http
 * only for localhost and 127.0.0.1, as annai's security policy allows (spec §15, connect-src). The
 * provider's page checks a typed address with it too (fix pass). @param {string} url @returns {string | null}
 */
export function addressProblem(url) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return `${url} isn't a web address: give it with https:// in front.`;
  }
  if ((u.protocol === 'https:' && u.hostname) || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null;
  return 'An address must start with https:// (http:// only for localhost or 127.0.0.1).';
}

/** An address's origin (scheme, host and port); one that doesn't parse is kept as it is, never dropped. @param {string} url */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Every origin (scheme, host and port) a key given to this provider may be sent to: its address and
 * each ability's own, sorted, once each. An update that names a new one asks first, so a change of
 * scheme or port does too (decision 11; security review). An address the user must give is none.
 * @param {ProviderDesc} desc @returns {string[]}
 */
export function descOrigins(desc) {
  const all = [desc?.baseUrl ?? '', ...Object.values(desc?.abilities ?? {}).map((a) => a?.baseUrl ?? '')];
  return [...new Set(all.filter((x) => typeof x === 'string' && x).map(originOf))].sort();
}
