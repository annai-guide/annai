import { refuseUserinfo } from './address.js';
import { validate } from './schema.js';
import { text, utf8 } from './bytes.js';
import { normPath } from './paths.js';
import { sha256Hex } from './hash.js';
import { PluginError } from './registry.js';
import { parseSkill, skillVersion, skillLinks, frontMatter, SkillError, SKILL_FILE } from './skills.js';
import { answerBytes } from './answer.js';
import { readZip } from './zip.js';
import { checkProviderDesc, descOrigins, CATEGORIES } from './llm/provider-desc.js';
import { t, lang, sameLanguage } from './l10n.js';
import { EnglishError } from './errors.js';
import { size, sentences, list } from './intl.js';

/**
 * A package as annai reads it before installing (spec §5.2): a folder, zip or address holding
 * annai-plugin.json, or a bare skill in the Agent Skills format (§5.1). Nothing here stores anything.
 * @typedef {import('./skills.js').Skill} Skill
 * @typedef {{ name: string, description: string, folder: string }} SkillInfo  folder: '' for the package's top, else "skills/tides"
 * @typedef {{ id: string, kind: 'web', origins: string[], key?: { setting: string, url?: string, note?: string } }} SearchDesc
 *   a search provider's description (docs/plugins.md, "Search providers"): the id it registers, the origins its searches and key go to
 * @typedef {{ id: string, version: string, homepage?: string }} Requirement  version: "^N", the same major (milestone 1, decision 7)
 * @typedef {{ kind: 'plugin' | 'skill', id: string, name: string, version: string, shownVersion: string, manifest: any,
 *   files: Map<string, Uint8Array>, code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[],
 *   provider: import('./llm/provider-desc.js').ProviderDesc | null, search: SearchDesc | null, requires: Requirement[], category: string, keywords: string[], replaces: string[],
 *   description: string, author?: string, homepage?: string, license?: string, fingerprint: string, left: { tag: string, why: string }[] }} Package
 *   files: by name inside the package (its top folder taken off); shownVersion: '' for a skill without a version;
 *   provider: a model provider's description (data); category: '' when the manifest gives none; replaces: names it means to replace;
 *   left: the translations left out, and why (leftOut)
 */

/**
 * The newest plugin API this annai runs; it runs every older one too. 2 adds annai.l10n: a plugin that reads it says api 2, so an annai
 * from before refuses it in words ("was made for plugin API 2") instead of running it without its words.
 */
export const API_VERSION = 2;
export const MANIFEST_FILE = 'annai-plugin.json';
/** A plugin package may unpack to at most this much. */
export const PLUGIN_MAX_BYTES = 64 * 1024 * 1024;

export const PLUGIN_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'api'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$' },
    api: { type: 'integer', minimum: 1 },
    description: { type: 'string', maxLength: 500 },
    author: { type: 'string', maxLength: 200 },
    homepage: { type: 'string', maxLength: 500 },
    entry: { type: 'string', pattern: '^[^/].*\\.m?js$' },
    files: { type: 'array', items: { type: 'string' }, maxItems: 200 },
    skills: { type: 'array', items: { type: 'string' } },
    personalities: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object' },
    provider: { type: 'object' },
    search: { type: 'object' },
    requires: {
      type: 'array', maxItems: 10,
      items: { type: 'object', required: ['id', 'version'], properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,63}$' }, version: { type: 'string', pattern: '^\\^\\d+$' }, homepage: { type: 'string', pattern: '^https://', maxLength: 500 },
      } },
    },
    category: { enum: CATEGORIES },
    keywords: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
    replaces: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
    featured: { type: 'string', minLength: 1, maxLength: 200 },
    catchAll: { type: 'boolean' },
    language: { type: 'string', minLength: 1, maxLength: 35 },
    l10n: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 35 } },
  },
};

/**
 * What is wrong with a manifest, for the plugin's developer: in English, as schema errors are (localization design, section 1).
 * @param {any} manifest
 */
export function checkManifest(manifest) {
  const id = typeof manifest?.id === 'string' ? manifest.id : 'plugin';
  const errors = validate(PLUGIN_MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new PluginError(id, /* en */ `its ${MANIFEST_FILE} is not valid: ${errors.join('; ')}`);
  if (manifest.api > API_VERSION) {
    throw new PluginError(id, /* en */ `was made for plugin API ${manifest.api}; this version of annai supports API ${API_VERSION} and older`);
  }
  if (manifest.entry !== undefined && !insidePlugin(manifest.entry)) {
    throw new PluginError(id, /* en */ `its entry "${manifest.entry}" isn't a file inside the plugin`);
  }
  if (manifest.templates !== undefined) throw new PluginError(id, /* en */ 'Endpoint templates were replaced by `provider` (see docs/plugins.md)');
  if (manifest.requires?.some((/** @type {any} */ r) => r?.id === id)) throw new PluginError(id, /* en */ 'requires itself: take its own id out of requires');
  if (manifest.provider !== undefined) {
    const wrong = checkProviderDesc(manifest.provider);
    if (wrong.length) throw new PluginError(id, /* en */ `its provider isn't valid: ${wrong.join('; ')}`);
  }
  if (manifest.language !== undefined && !canonical(manifest.language)) /* en */ throw new PluginError(id, `its language "${manifest.language}" isn't a language tag, such as en, ja or zh-Hans`);
  if (manifest.search !== undefined) {
    const wrong = checkSearchDesc(manifest.search, manifest);
    if (wrong.length) throw new PluginError(id, /* en */ `its search isn't valid: ${wrong.join('; ')}`);
    if (manifest.entry === undefined) throw new PluginError(id, /* en */ 'describes a search provider but has no entry: a search provider is code that registers itself');
  }
}

/** A language tag as Intl writes it ("ja", "zh-Hans" for "zh-hans"), or '' for one that is none. @param {unknown} tag */
function canonical(tag) {
  try {
    return typeof tag === 'string' ? Intl.getCanonicalLocales(tag)[0] ?? '' : '';
  } catch {
    return '';
  }
}

export const L10N_MAX_BYTES = 256 * 1024;
/**
 * The fields a translation may give (localization design, section 8), by path (* any key or index), with their limits; keywords are
 * added to the English. A name is shown only for annai's own: a third party's is shown as written everywhere (decision 10). @type {[string, number][]}
 */
export const TRANSLATED = [['name', 80], ['description', 500], ['featured', 200], ['keywords', 40], ['provider.note', 1000], ['provider.abilities.*.name', 80],
  ['provider.abilities.*.note', 1000], ['provider.abilities.*.noWindowNote', 1000], ['search.key.note', 300], ['settings.properties.*.title', 200],
  ['settings.properties.*.description', 1000], ['settings.properties.*.oneOf.*.title', 200]];
/** The value at a path. @param {any} o @param {string[]} keys */
const at = (o, keys) => keys.reduce((x, k) => (x && typeof x === 'object' && Object.hasOwn(x, k) ? x[k] : undefined), o);
const object = (/** @type {any} */ o) => o && typeof o === 'object' && !Array.isArray(o);

/**
 * What is wrong with a plugin's l10n/<tag>.json, for its developer, or null: only manifest and messages; each manifest key a field
 * this manifest has that a translation may give, within its limit; each message text, or plural forms of the language, up to 2,000.
 * One with anything wrong is left out, never a reason to refuse the plugin (fail working); an empty text is no translation.
 * @param {any} manifest @param {string} tag as listed @param {Uint8Array | undefined} bytes
 */
export function checkTranslation(manifest, tag, bytes) {
  /* en */ const file = `its l10n/${tag}.json`;
  if (!canonical(tag)) /* en */ return `"${tag}" isn't a language tag, such as ja or zh-Hans`;
  if (!bytes) /* en */ return `${file}, listed in l10n, is missing`;
  if (bytes.byteLength > L10N_MAX_BYTES) /* en */ return `${file} is larger than 256 KiB`;
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(text(bytes));
  } catch {
    /* en */ return `${file} is not valid JSON`;
  }
  if (!object(json) || Object.keys(json).some((k) => k !== 'manifest' && k !== 'messages')) /* en */ return `${file} must be an object with only manifest and messages`;
  for (const [path, value] of Object.entries(json.manifest ?? {})) {
    const keys = path.split('.');
    const max = TRANSLATED.find(([p]) => p.split('.').every((x, i, all) => all.length === keys.length && (x === '*' || x === keys[i])))?.[1];
    if (!max) /* en */ return `${file} translates ${path}, which isn't a field a translation may give`;
    if (path !== 'keywords' && typeof at(manifest, keys) !== 'string') /* en */ return `${file} translates ${path}, which this manifest doesn't have`;
    const ok = (/** @type {unknown} */ x) => typeof x === 'string' && x.length <= max;
    if (path === 'keywords' ? !Array.isArray(value) || value.length > 20 || !value.every(ok) : !ok(value)) /* en */ return `${file}'s ${path} must be text of up to ${max} characters${path === 'keywords' ? ', up to 20' : ''}`;
  }
  const kinds = new Intl.PluralRules(canonical(tag)).resolvedOptions().pluralCategories;
  for (const [k, m] of Object.entries(json.messages ?? {})) {
    /** @type {[string, unknown][]} */
    const forms = typeof m === 'string' ? [['other', m]] : object(m) ? Object.entries(m) : [];
    if (!forms.length || forms.some(([c, x]) => typeof x !== 'string' || x.length > 2000 || !kinds.includes(/** @type {any} */ (c)))) {
      /* en */ return `${file}'s message ${k} must be text, or plural forms of ${tag} (${kinds.join(', ')}), of up to 2000 characters`;
    }
  }
  return null;
}

/**
 * The translation the screens use: none when its own words are in their language, else the one listed for it, or for a tag of the
 * same language and script. @param {any} manifest @param {string} [tag] @returns {string | null}
 */
export function translationFor(manifest, tag = lang()) {
  const listed = sameLanguage(canonical(manifest?.language) || 'en', tag) ? [] : (manifest?.l10n ?? []).filter(canonical);
  return listed.find((/** @type {string} */ x) => canonical(x) === tag) ?? listed.find((/** @type {string} */ x) => sameLanguage(canonical(x), tag)) ?? null;
}

/**
 * The translations a package lists that are left out, each with why in its developer's English: no tag, a language listed twice,
 * or one that fails checkTranslation. The install screen says so; the rest are used. @param {any} manifest @param {(path: string) => Uint8Array | undefined} read
 * @returns {{ tag: string, why: string }[]}
 */
export function leftOut(manifest, read) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ tag: string, why: string }[]} */
  const out = [];
  for (const tag of manifest?.l10n ?? []) {
    const twice = seen.has(canonical(tag));
    seen.add(canonical(tag));
    /* en */ const why = twice ? `its l10n lists ${canonical(tag)} twice` : checkTranslation(manifest, tag, read(`l10n/${tag}.json`));
    if (why) out.push({ tag, why });
  }
  return out;
}

/**
 * A plugin's words for the screens: their language, its messages (annai.l10n), and its manifest as shown, a copy with the translated
 * fields and keywords added; its own words when it has none, or it can't be read. The manifest itself stays English (the shown rule).
 * tag: the translation to read, when it isn't the one the manifest lists for the screens (annai's own plugins list none: theirs come
 * from its catalog).
 * @param {any} manifest @param {(path: string) => Uint8Array | undefined} read @param {{ tag?: string | null }} [o]
 * @returns {{ lang: string, messages: Record<string, any> | null, manifest: any }}
 */
export function wordsOf(manifest, read, { tag = translationFor(manifest) } = {}) {
  const bytes = tag ? read(`l10n/${tag}.json`) : undefined;
  // One that fails a check is left out here too, as at install: a stored package may hold one.
  const json = tag && !checkTranslation(manifest, tag, bytes) ? JSON.parse(text(/** @type {Uint8Array} */ (bytes))) : null;
  if (!json) return { lang: canonical(manifest?.language) || 'en', messages: null, manifest };
  const shown = structuredClone(manifest);
  for (const [path, value] of Object.entries(json.manifest ?? {})) {
    const keys = path.split('.');
    const last = /** @type {string} */ (keys.pop());
    if (path === 'keywords') shown.keywords = [...new Set([...(shown.keywords ?? []), ...value.filter(Boolean)])];
    else if (value && typeof at(shown, [...keys, last]) === 'string') at(shown, keys)[last] = value;
  }
  return { lang: lang(), messages: json.messages ?? null, manifest: shown };
}

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['id', 'kind', 'origins'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
    kind: { enum: ['web'] },
    origins: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
    key: { type: 'object', required: ['setting'], properties: { setting: { type: 'string' }, url: { type: 'string', pattern: '^https://', maxLength: 500 }, note: { type: 'string', maxLength: 300 } } },
  },
  additionalProperties: false,
};

/**
 * A search provider's description (the manifest's search): its id, kind, the origins its searches and key go to (none: the address
 * the user gives it), and the setting that holds its key, which must be a write-only one so annai keeps it as a secret.
 * @param {any} search @param {any} manifest @returns {string[]} what is wrong, empty when nothing
 */
export function checkSearchDesc(search, manifest) {
  const errors = validate(SEARCH_SCHEMA, search);
  if (errors.length) return errors;
  for (const o of search.origins) {
    try {
      const u = new URL(o);
      if (u.protocol !== 'https:' || u.origin !== o) errors.push(/* en */ `$.origins: ${o} must be an https origin: the scheme and host, nothing after`);
    } catch {
      errors.push(/* en */ `$.origins: ${o} isn't an address`);
    }
  }
  if (search.key && manifest.settings?.properties?.[search.key.setting]?.writeOnly !== true) errors.push(/* en */ `$.key.setting: ${search.key.setting} must be a writeOnly setting of the plugin`);
  return errors;
}

/** The origins a package's search block names, sorted. @param {any} manifest @returns {string[]} */
export function searchOriginsOf(manifest) {
  return Array.isArray(manifest?.search?.origins) ? [...new Set(/** @type {string[]} */ (manifest.search.origins))].sort() : [];
}

/** Every origin a package's provider and search block send keys and searches to, sorted: what an update asks about when it brings a new one. @param {any} manifest @returns {string[]} */
export function originsOf(manifest) {
  return [...new Set([...(manifest?.provider ? descOrigins(manifest.provider) : []), ...searchOriginsOf(manifest)])].sort();
}

/** A path that starts with a scheme (http:, javascript:), which an address would read off the package's site, as skillLinks refuses (fix pass 8a-4). */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Whitespace, control characters and backslashes, which an address parser drops or reads as / (fix pass 8a-4). */
const UNSAFE = /[\s\u0000-\u001f\u007f-\u009f\\]/;

/**
 * A relative path that stays inside the package's folder, as it is and once percent-decoded as an
 * address would be (%2e%2e is ..), with no scheme, whitespace, control character or backslash (fix pass 8a-4).
 * @param {string} rel
 */
function plainPath(rel) {
  if (typeof rel !== 'string' || SCHEME.test(rel) || UNSAFE.test(rel)) return false;
  try {
    const decoded = decodeURIComponent(rel);
    return [rel, decoded].every((p) => normPath(`/p/${p}`) === `/p/${p}`);
  } catch {
    return false;
  }
}

/** A relative path that stays inside the plugin's folder (see plainPath). @param {string} rel */
export function insidePlugin(rel) {
  return plainPath(rel);
}

/** What zips carry that is no part of a package: macOS's and Windows' own files, and folder entries. @param {string} name */
export function isJunk(name) {
  if (name.endsWith('/')) return true;
  const parts = name.split('/');
  return parts.includes('__MACOSX') || /* en */ ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(parts[parts.length - 1]);
}

/** The SHA-256 of every file and its name: two packages with the same files have the same one. @param {Map<string, Uint8Array>} files */
export async function fingerprint(files) {
  /** @type {string[]} */
  const lines = [];
  for (const [name, bytes] of files) lines.push(`${name}\0${await sha256Hex(bytes)}\n`);
  return sha256Hex(utf8(lines.sort().join('')));
}

/** The manifest annai reads a bare skill as; nothing like it is stored (choice 2). @param {Skill} skill */
export function skillManifest(skill) {
  return {
    id: skill.name, name: skill.name, version: skillVersion(skill.metadata), api: 1, description: skill.description, skills: ['.'],
    ...(skill.metadata.author ? { author: skill.metadata.author } : {}),
  };
}

/** "" or "<top>/" when the file is at the top or in the one top folder everything is in, else null. @param {string[]} names @param {string} file */
function rootOf(names, file) {
  if (names.includes(file)) return '';
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size !== 1) return null;
  const [top] = tops;
  return names.includes(`${top}/${file}`) ? `${top}/` : null;
}

/**
 * Reads a package from its files (e.g. an unzipped one) and checks everything a later step needs:
 * the manifest or the skill, the files it names, its skills, personalities and provider description.
 * @param {Map<string, Uint8Array>} raw @param {{ maxBytes?: number }} [o] @returns {Promise<Package>}
 */
export async function inspectPackage(raw, { maxBytes = PLUGIN_MAX_BYTES } = {}) {
  const all = [...raw].filter(([n]) => !isJunk(n));
  const names = all.map(([n]) => n);
  /** @type {'plugin' | 'skill'} */
  let kind = 'plugin';
  let root = rootOf(names, MANIFEST_FILE);
  if (root === null) {
    kind = 'skill';
    root = rootOf(names, SKILL_FILE);
    if (root === null) {
      // Deeper than annai reads (minors 20): the shallowest annai-plugin.json, else the one SKILL.md.
      const deep = (/** @type {string} */ file) => names.filter((n) => n.endsWith(`/${file}`)).sort((a, b) => a.split('/').length - b.split('/').length);
      const [plugin] = deep(MANIFEST_FILE);
      const skills = deep(SKILL_FILE);
      if (!plugin && skills.length > 1) {
        throw new PluginError('skill', /* en */ 'this zip holds several skills. Install each one on its own, or add an annai-plugin.json that lists them.',
          { shown: t`this zip holds several skills. Install each one on its own, or add an annai-plugin.json that lists them.` });
      }
      const file = plugin ? MANIFEST_FILE : SKILL_FILE;
      const at = plugin ?? skills[0];
      const folder = at?.slice(0, -file.length);
      if (at) {
        const deeper = at.split('/').length > 2;
        throw new PluginError(plugin ? 'plugin' : 'skill', /* en */ `its ${file} is in ${folder}, ${deeper ? 'nested too deep' : 'beside other files'}: annai reads it at the top of the zip or inside its one folder. Zip that folder alone.`, { shown: deeper
          ? t`its ${file} is in ${folder}, nested too deep: annai reads it at the top of the zip or inside its one folder. Zip that folder alone.`
          : t`its ${file} is in ${folder}, beside other files: annai reads it at the top of the zip or inside its one folder. Zip that folder alone.` });
      }
      throw new PluginError('plugin', /* en */ `there is no ${MANIFEST_FILE} or ${SKILL_FILE} in this package`, { shown: t`there is no ${MANIFEST_FILE} or ${SKILL_FILE} in this package` });
    }
  }
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [n, b] of all) if (n.startsWith(root)) files.set(n.slice(root.length), b);
  const checkNames = (/** @type {string} */ id) => {
    let total = 0;
    for (const [name, b] of files) {
      let ok = false;
      try {
        ok = normPath(`/${name}`) === `/${name}`;
      } catch {
        ok = false;
      }
      if (!ok) throw new PluginError(id, /* en */ `the file name "${name}" isn't allowed`);
      total += b.byteLength;
    }
    if (total > maxBytes) throw new PluginError(id, /* en */ `is too large: it unpacks to more than ${size(maxBytes)}`, { shown: t`is too large: it unpacks to more than ${size(maxBytes)}` });
  };
  return kind === 'skill' ? skillPackage(files, checkNames) : pluginPackage(files, checkNames);
}

/** @param {Map<string, Uint8Array>} files @param {(id: string) => void} checkNames @returns {Promise<Package>} */
async function skillPackage(files, checkNames) {
  /** @type {Skill} */
  let skill;
  try {
    skill = parseSkill(text(/** @type {Uint8Array} */ (files.get(SKILL_FILE))));
  } catch (e) {
    throw new PluginError('skill', e instanceof SkillError ? e.message : String(e));
  }
  if (skill.name.length < 2) throw new PluginError('skill', /* en */ `A skill's name needs at least 2 characters to install: ${skill.name}`);
  checkNames(skill.name);
  const manifest = skillManifest(skill);
  return {
    kind: 'skill', id: skill.name, name: skill.name, version: manifest.version, shownVersion: skill.metadata.version ?? '', manifest, files, code: false,
    skills: [{ name: skill.name, description: skill.description, folder: '' }], personalities: [], provider: null, search: null, requires: [], category: '', keywords: [], replaces: [], description: skill.description, left: [],
    ...(skill.metadata.author ? { author: skill.metadata.author } : {}), ...(skill.license ? { license: skill.license } : {}),
    fingerprint: await fingerprint(files),
  };
}

/** @param {Map<string, Uint8Array>} files @param {(id: string) => void} checkNames @returns {Promise<Package>} */
async function pluginPackage(files, checkNames) {
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(text(/** @type {Uint8Array} */ (files.get(MANIFEST_FILE))));
  } catch {
    throw new PluginError('plugin', /* en */ `its ${MANIFEST_FILE} is not valid JSON`);
  }
  checkManifest(manifest);
  const id = manifest.id;
  if (manifest.entry && !files.has(manifest.entry)) throw new PluginError(id, /* en */ `its entry file ${manifest.entry} is missing`);
  checkNames(id);
  for (const f of manifest.files ?? []) if (!files.has(f)) throw new PluginError(id, /* en */ `its file ${f}, listed in files, is missing`);
  const props = manifest.settings?.properties;
  if (manifest.settings !== undefined && (!props || typeof props !== 'object' || Array.isArray(props))) throw new PluginError(id, /* en */ 'its settings must be a JSON Schema object with properties');
  /** @type {SkillInfo[]} */
  const skills = [];
  for (const f of manifest.skills ?? []) {
    const folder = f === '.' ? '' : f.replace(/\/+$/, '');
    if (folder && !insidePlugin(folder)) throw new PluginError(id, /* en */ `its skill folder ${f} isn't a folder inside the package`);
    const path = folder ? `${folder}/${SKILL_FILE}` : SKILL_FILE;
    const bytes = files.get(path);
    if (!bytes) throw new PluginError(id, /* en */ `its skill folder ${f} has no ${SKILL_FILE}`);
    /** @type {Skill} */
    let s;
    try {
      s = parseSkill(text(bytes));
    } catch (e) {
      throw new PluginError(id, /* en */ `its skill ${f}: ${/** @type {any} */ (e)?.message ?? e}`);
    }
    if (skills.some((x) => x.name === s.name)) throw new PluginError(id, /* en */ `it has two skills called ${s.name}`);
    skills.push({ name: s.name, description: s.description, folder });
  }
  /** @type {{ name: string, path: string }[]} */
  const personalities = [];
  for (const p of manifest.personalities ?? []) {
    if (!p.endsWith('.md') || !files.has(p)) throw new PluginError(id, /* en */ `its personality ${p} must be a .md file in the package`);
    const name = p.split('/').pop().slice(0, -3);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new PluginError(id, /* en */ `its personality's file name ${p} must be lowercase letters, digits and dashes, like ranger.md`);
    personalities.push({ name, path: p });
  }
  return {
    kind: 'plugin', id, name: manifest.name, version: manifest.version, shownVersion: manifest.version, manifest, files, code: Boolean(manifest.entry),
    skills, personalities, provider: manifest.provider ?? null, search: manifest.search ?? null, requires: manifest.requires ?? [], category: manifest.category ?? '', keywords: manifest.keywords ?? [], replaces: manifest.replaces ?? [],
    description: manifest.description ?? '', left: leftOut(manifest, (f) => files.get(f)),
    ...(manifest.author ? { author: manifest.author } : {}), ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    fingerprint: await fingerprint(files),
  };
}

/** The most files a package installed from an address may have (choice 6). */
export const ADDRESS_MAX_FILES = 200;
/** The most files a SKILL.md's links bring along from an address. */
export const SKILL_MAX_LINKS = 50;
const NOT_AN_ADDRESS = t`That isn't a web address. Paste the address of a zip file, an annai-plugin.json or a SKILL.md.`;

/** A GitHub page's address as GitHub's raw files serve it, which web apps may read; any other as it is. @param {string} address */
export function rawAddress(address) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(address);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : address;
}

/** Whether a name stays inside the package (see plainPath). @param {string} name */
const fileName = (name) => plainPath(name);

/** The answers that say a file isn't there: S3 answers 403 for a missing object it won't list. */
const MISSING = new Set([403, 404, 410]);

/**
 * A package's files from an address (choice 6): a zip, whatever the address ends with; an
 * annai-plugin.json and the files it names; or a SKILL.md and the files it links to inside its folder.
 * Nothing is stored. Every error is a plain Error that says what to do. Each file is asked for with
 * the browser's cache revalidated (minors 17): the browser sends the ETag or date it kept, so an update
 * check downloads only what changed, never a stale copy. annai sends no such header itself: GitHub's
 * raw files refuse the CORS preflight one would need.
 * @param {string} address
 * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response>, max?: number }} o
 * @returns {Promise<Map<string, Uint8Array>>} files by name inside the package (a zip's as it has them)
 */
export async function fetchPackage(address, { fetch: get, max = PLUGIN_MAX_BYTES }) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(rawAddress(String(address ?? '').trim()));
  } catch {
    throw new Error(NOT_AN_ADDRESS);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(NOT_AN_ADDRESS);
  refuseUserinfo(url);
  // github.com's pages can't be read by web apps; its raw files can (minors 19).
  const hint = url.hostname === 'github.com' ? t`For a folder on GitHub, use the address of its SKILL.md or annai-plugin.json.` : '';
  let used = 0;
  const download = async (/** @type {URL} */ u) => {
    /** @type {Response} */
    let res;
    try {
      res = await get(u.href, { cache: 'no-cache' });
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      throw Object.assign(new Error(sentences(t`annai couldn't reach ${u.host}. Check the address, and that the site lets web apps read it.`, hint)), { unreachable: true });
    }
    const bytes = await answerBytes(res, u.host, max - used);
    used += bytes.byteLength;
    return bytes;
  };
  const first = await download(url);
  if (first[0] === 0x50 && first[1] === 0x4b && first[2] === 0x03 && first[3] === 0x04) {
    try {
      return await readZip(first, { maxTotal: max });
    } catch (e) {
      // What is wrong with the zip is a developer's detail, in English (zip.js).
      const why = String(/** @type {any} */ (e)?.message ?? e);
      throw Object.assign(new Error(t`${url.host} sent a zip annai can't open: ${why}`), { en: why });
    }
  }
  const body = text(first).replace(/^﻿/, '');
  const base = url;
  const home = new URL('.', base); // the package's folder
  /**
   * Where a file of the package is: an address on the same site, inside the package's folder; null for a
   * name that would lead anywhere else (fix pass 8a-4).
   * @param {string} name
   */
  const fileUrl = (name) => {
    if (!fileName(name)) return null;
    const u = new URL(name, base);
    return u.origin === home.origin && u.pathname.startsWith(home.pathname) ? u : null;
  };
  const tooMany = () => new Error(t`That package has more than ${ADDRESS_MAX_FILES} files; annai installs packages of up to ${ADDRESS_MAX_FILES} from an address. Use a zip instead.`);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /**
   * Why a file of the package couldn't be had, naming it; null when it may be left out (optional) and the site answers it hasn't it: a
   * 404, a 410, or a 403 as S3 answers for a missing object. A busy site (503, 429) or no answer is no answer that it isn't there, and
   * fails. No answer names the file: a 404 without CORS headers looks the same, and annai has just read the package from that site.
   * @param {unknown} e @param {string} name @param {URL} u @param {string} from the file that names it @param {boolean} optional
   */
  const failed = (e, name, u, from, optional) => {
    const status = /** @type {any} */ (e)?.status;
    if (optional && MISSING.has(status)) return null;
    if (status) return new Error(t`${u.host} answered ${status} for ${name}, a file its ${from} names.`);
    // A connection that dropped mid-file is no answer either.
    if (/** @type {any} */ (e)?.unreachable || /** @type {any} */ (e)?.said?.code === 'cut') return new Error(t`annai couldn't read ${name} from ${u.host}, a file its ${from} names. Check that it is there, and that the site lets web apps read it.`);
    return e;
  };
  /** The files a SKILL.md links to, in its folder; one the site answers it hasn't is left out (failed). @param {string} folder '' or "skills/x/" @param {Uint8Array} skill */
  const linked = async (folder, skill) => {
    let links = skillLinks(text(skill));
    try {
      links = skillLinks(frontMatter(text(skill)).body);
    } catch {
      // not front matter annai reads: inspecting it says so later
    }
    for (const link of links.slice(0, SKILL_MAX_LINKS)) {
      const name = `${folder}${link}`;
      const at = files.has(name) ? null : fileUrl(name);
      if (!at) continue;
      if (files.size >= ADDRESS_MAX_FILES) throw tooMany();
      try {
        files.set(name, await download(at));
      } catch (e) {
        const why = failed(e, name, at, SKILL_FILE, true);
        if (why) throw why;
      }
    }
  };
  const manifest = asManifest(url, body);
  if (manifest) {
    files.set(MANIFEST_FILE, first);
    /** @type {Set<string>} */
    const names = new Set();
    const add = (/** @type {unknown} */ f) => { if (typeof f === 'string' && f) names.add(f); };
    for (const f of Array.isArray(manifest.files) ? manifest.files : []) add(f);
    add(manifest.entry);
    /** @type {string[]} */
    const skillFiles = [];
    for (const f of Array.isArray(manifest.skills) ? manifest.skills : []) {
      if (typeof f !== 'string') continue;
      const folder = f === '.' ? '' : `${f.replace(/\/+$/, '')}/`;
      skillFiles.push(`${folder}${SKILL_FILE}`);
      add(`${folder}${SKILL_FILE}`);
    }
    for (const f of Array.isArray(manifest.personalities) ? manifest.personalities : []) add(f);
    // Its translations, each left out when the site answers it hasn't one (fail working).
    const l10n = new Set((Array.isArray(manifest.l10n) ? manifest.l10n : []).filter((x) => typeof x === 'string' && fileName(`l10n/${x}.json`)).map((x) => `l10n/${x}.json`));
    for (const f of l10n) add(f);
    names.delete(MANIFEST_FILE);
    if (names.size + 1 > ADDRESS_MAX_FILES) throw tooMany();
    /** @type {Map<string, URL>} */
    const at = new Map();
    for (const name of names) {
      const u = fileUrl(name);
      if (!u) throw new EnglishError(/* en */ `The file name "${name}" isn't allowed.`);
      at.set(name, u);
    }
    for (const [name, u] of at) {
      try {
        files.set(name, await download(u));
      } catch (e) {
        // Which file the site lacks (minors 21); a translation it answers it hasn't is left out.
        const why = failed(e, name, u, MANIFEST_FILE, l10n.has(name));
        if (why) throw why;
      }
    }
    for (const s of skillFiles) await linked(s.slice(0, -SKILL_FILE.length), /** @type {Uint8Array} */ (files.get(s)));
    return files;
  }
  if (body.startsWith('---') || url.pathname.endsWith(`/${SKILL_FILE}`)) {
    files.set(SKILL_FILE, first);
    await linked('', first);
    return files;
  }
  throw new Error(sentences(t`There's no annai plugin or skill at that address. annai looks for a zip file, an annai-plugin.json or a SKILL.md.`, hint));
}

/** The manifest an address holds: a path ending in annai-plugin.json, or a JSON object with an api. @param {URL} url @param {string} body */
function asManifest(url, body) {
  if (!url.pathname.endsWith(`/${MANIFEST_FILE}`) && !/^\s*\{/.test(body)) return null;
  try {
    const json = JSON.parse(body);
    if (json && typeof json === 'object' && !Array.isArray(json) && ('api' in json || url.pathname.endsWith(`/${MANIFEST_FILE}`))) return json;
  } catch {
    if (url.pathname.endsWith(`/${MANIFEST_FILE}`)) throw new Error(t`The ${MANIFEST_FILE} at ${url.host} isn't valid JSON.`);
  }
  return null;
}

/**
 * What a package brings that an installed one didn't (the coordinator's second finding): code where
 * there was none, skills and personalities it didn't have, and origins (scheme, host and port) its
 * provider description sends keys to that the installed one didn't (milestone 1, decision 11; the
 * security review: a change of scheme or port is new too). An update that adds any of them asks the user first.
 * @typedef {{ code: boolean, skills: string[], personalities: string[], origins: string[] }} Parts what an installed package has, by name
 * @typedef {{ code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[], origins: string[], searchOrigins?: string[] }} Added
 * @param {Parts} before @param {Package} pkg @returns {Added}
 */
export function addedParts(before, pkg) {
  const searchNew = searchOriginsOf(pkg.manifest).filter((o) => !(before.origins ?? []).includes(o));
  return {
    code: !before.code && pkg.code,
    skills: pkg.skills.filter((s) => !before.skills.includes(s.name)),
    personalities: pkg.personalities.filter((p) => !before.personalities.includes(p.name)),
    origins: originsOf(pkg.manifest).filter((o) => !(before.origins ?? []).includes(o)),
    ...(searchNew.length ? { searchOrigins: searchNew } : {}),
  };
}

/** Whether anything was added. @param {Added | null | undefined} a */
export const addsAnything = (a) => Boolean(a && (a.code || a.skills.length || a.personalities.length || a.origins?.length));

/** Whether what the user agreed to covers what is added now. @param {Added | null | undefined} agreed @param {Added} added */
export function agreedTo(agreed, added) {
  if (!addsAnything(added)) return true;
  if (!agreed) return false;
  return (!added.code || agreed.code)
    && added.skills.every((s) => agreed.skills.some((x) => x.name === s.name))
    && added.personalities.every((p) => agreed.personalities.some((x) => x.name === p.name))
    && (added.origins ?? []).every((o) => (agreed.origins ?? []).includes(o));
}

/** What was added, in the screens' words, a list of whole labels for package-updates.js's sentence. @param {Added} a */
export function addedWords(a) {
  return list([
    ...(a.code ? [t`code that runs in annai`] : []),
    ...a.skills.map((s) => t`the skill ${s.name}`),
    ...a.personalities.map((p) => t`the personality ${p.name}`),
    ...(a.origins ?? []).map((o) => (a.searchOrigins?.includes(o) ? t`an address your searches are sent to: ${o}` : t`a provider that sends keys to ${o}`)),
  ], 'plain');
}
