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

/**
 * A package as annai reads it before installing (spec §5.2): a folder, zip or address holding
 * annai-plugin.json, or a bare skill in the Agent Skills format (§5.1). Nothing here stores anything.
 * @typedef {import('./skills.js').Skill} Skill
 * @typedef {{ name: string, description: string, folder: string }} SkillInfo  folder: '' for the package's top, else "skills/tides"
 * @typedef {{ id: string, kind: 'web' | 'knowledge', origins: string[], key?: { setting: string, url?: string, note?: string }, credit?: string }} SearchDesc
 *   a search provider's description (docs/plugins.md, "Search providers"): the id it registers, the origins its searches and key go to
 * @typedef {{ id: string, version: string, homepage?: string }} Requirement  version: "^N", the same major (milestone 1, decision 7)
 * @typedef {{ kind: 'plugin' | 'skill', id: string, name: string, version: string, shownVersion: string, manifest: any,
 *   files: Map<string, Uint8Array>, code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[],
 *   provider: import('./llm/provider-desc.js').ProviderDesc | null, search: SearchDesc | null, requires: Requirement[], category: string, keywords: string[], replaces: string[],
 *   description: string, author?: string, homepage?: string, license?: string, fingerprint: string }} Package
 *   files: by name inside the package (its top folder taken off); shownVersion: '' for a skill without a version;
 *   provider: a model provider's description (data); category: '' when the manifest gives none; replaces: names it means to replace
 */

export const API_VERSION = 1;
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
  },
};

/** @param {any} manifest */
export function checkManifest(manifest) {
  const id = typeof manifest?.id === 'string' ? manifest.id : 'plugin';
  const errors = validate(PLUGIN_MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new PluginError(id, `its ${MANIFEST_FILE} is not valid: ${errors.join('; ')}`);
  if (manifest.api !== API_VERSION) {
    throw new PluginError(id, `was made for plugin API ${manifest.api}; this version of annai supports API ${API_VERSION}`);
  }
  if (manifest.entry !== undefined && !insidePlugin(manifest.entry)) {
    throw new PluginError(id, `its entry "${manifest.entry}" isn't a file inside the plugin`);
  }
  if (manifest.templates !== undefined) throw new PluginError(id, 'Endpoint templates were replaced by `provider` (see docs/plugins.md)');
  if (manifest.requires?.some((/** @type {any} */ r) => r?.id === id)) throw new PluginError(id, 'requires itself: take its own id out of requires');
  if (manifest.provider !== undefined) {
    const wrong = checkProviderDesc(manifest.provider);
    if (wrong.length) throw new PluginError(id, `its provider isn't valid: ${wrong.join('; ')}`);
  }
  if (manifest.search !== undefined) {
    const wrong = checkSearchDesc(manifest.search, manifest);
    if (wrong.length) throw new PluginError(id, `its search isn't valid: ${wrong.join('; ')}`);
  }
}

const SEARCH_SCHEMA = {
  type: 'object',
  required: ['id', 'kind', 'origins'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
    kind: { enum: ['web', 'knowledge'] },
    origins: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
    key: { type: 'object', required: ['setting'], properties: { setting: { type: 'string' }, url: { type: 'string', pattern: '^https://', maxLength: 500 }, note: { type: 'string', maxLength: 300 } } },
    credit: { type: 'string', maxLength: 300 },
  },
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
      if (u.protocol !== 'https:' || u.origin !== o) errors.push(`$.origins: ${o} must be an https origin: the scheme and host, nothing after`);
    } catch {
      errors.push(`$.origins: ${o} isn't an address`);
    }
  }
  if (search.key && manifest.settings?.properties?.[search.key.setting]?.writeOnly !== true) errors.push(`$.key.setting: ${search.key.setting} must be a writeOnly setting of the plugin`);
  return errors;
}

/** Every origin a package's provider or search sends keys and searches to, sorted: what an update asks about when it brings a new one. @param {any} manifest @returns {string[]} */
export function originsOf(manifest) {
  if (manifest?.provider) return descOrigins(manifest.provider);
  return Array.isArray(manifest?.search?.origins) ? [...new Set(/** @type {string[]} */ (manifest.search.origins))].sort() : [];
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
  return parts.includes('__MACOSX') || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(parts[parts.length - 1]);
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
    id: skill.name, name: skill.name, version: skillVersion(skill.metadata), api: API_VERSION, description: skill.description, skills: ['.'],
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

/** @param {number} n */
const sizeWords = (n) => (n >= 1048576 ? `${Math.floor(n / 1048576)} MB` : `${n} bytes`);

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
        throw new PluginError('skill', 'this zip holds several skills. Install each one on its own, or add an annai-plugin.json that lists them.');
      }
      const file = plugin ? MANIFEST_FILE : SKILL_FILE;
      const at = plugin ?? skills[0];
      const why = at?.split('/').length > 2 ? 'nested too deep' : 'beside other files';
      if (at) throw new PluginError(plugin ? 'plugin' : 'skill', `its ${file} is in ${at.slice(0, -file.length)}, ${why}: annai reads it at the top of the zip or inside its one folder. Zip that folder alone.`);
      throw new PluginError('plugin', `there is no ${MANIFEST_FILE} or ${SKILL_FILE} in this package`);
    }
  }
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  for (const [n, b] of all) if (n.startsWith(root)) files.set(n.slice(root.length), b);
  const checkNames = (/** @type {string} */ id) => {
    let size = 0;
    for (const [name, b] of files) {
      let ok = false;
      try {
        ok = normPath(`/${name}`) === `/${name}`;
      } catch {
        ok = false;
      }
      if (!ok) throw new PluginError(id, `the file name "${name}" isn't allowed`);
      size += b.byteLength;
    }
    if (size > maxBytes) throw new PluginError(id, `is too large: it unpacks to more than ${sizeWords(maxBytes)}`);
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
  if (skill.name.length < 2) throw new PluginError('skill', `A skill's name needs at least 2 characters to install: ${skill.name}`);
  checkNames(skill.name);
  const manifest = skillManifest(skill);
  return {
    kind: 'skill', id: skill.name, name: skill.name, version: manifest.version, shownVersion: skill.metadata.version ?? '', manifest, files, code: false,
    skills: [{ name: skill.name, description: skill.description, folder: '' }], personalities: [], provider: null, search: null, requires: [], category: '', keywords: [], replaces: [], description: skill.description,
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
    throw new PluginError('plugin', `its ${MANIFEST_FILE} is not valid JSON`);
  }
  checkManifest(manifest);
  const id = manifest.id;
  if (manifest.entry && !files.has(manifest.entry)) throw new PluginError(id, `its entry file ${manifest.entry} is missing`);
  checkNames(id);
  for (const f of manifest.files ?? []) if (!files.has(f)) throw new PluginError(id, `its file ${f}, listed in files, is missing`);
  const props = manifest.settings?.properties;
  if (manifest.settings !== undefined && (!props || typeof props !== 'object' || Array.isArray(props))) throw new PluginError(id, 'its settings must be a JSON Schema object with properties');
  /** @type {SkillInfo[]} */
  const skills = [];
  for (const f of manifest.skills ?? []) {
    const folder = f === '.' ? '' : f.replace(/\/+$/, '');
    if (folder && !insidePlugin(folder)) throw new PluginError(id, `its skill folder ${f} isn't a folder inside the package`);
    const path = folder ? `${folder}/${SKILL_FILE}` : SKILL_FILE;
    const bytes = files.get(path);
    if (!bytes) throw new PluginError(id, `its skill folder ${f} has no ${SKILL_FILE}`);
    /** @type {Skill} */
    let s;
    try {
      s = parseSkill(text(bytes));
    } catch (e) {
      throw new PluginError(id, `its skill ${f}: ${/** @type {any} */ (e)?.message ?? e}`);
    }
    if (skills.some((x) => x.name === s.name)) throw new PluginError(id, `it has two skills called ${s.name}`);
    skills.push({ name: s.name, description: s.description, folder });
  }
  /** @type {{ name: string, path: string }[]} */
  const personalities = [];
  for (const p of manifest.personalities ?? []) {
    if (!p.endsWith('.md') || !files.has(p)) throw new PluginError(id, `its personality ${p} must be a .md file in the package`);
    const name = p.split('/').pop().slice(0, -3);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new PluginError(id, `its personality's file name ${p} must be lowercase letters, digits and dashes, like ranger.md`);
    personalities.push({ name, path: p });
  }
  return {
    kind: 'plugin', id, name: manifest.name, version: manifest.version, shownVersion: manifest.version, manifest, files, code: Boolean(manifest.entry),
    skills, personalities, provider: manifest.provider ?? null, search: manifest.search ?? null, requires: manifest.requires ?? [], category: manifest.category ?? '', keywords: manifest.keywords ?? [], replaces: manifest.replaces ?? [],
    description: manifest.description ?? '',
    ...(manifest.author ? { author: manifest.author } : {}), ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    fingerprint: await fingerprint(files),
  };
}

/** The most files a package installed from an address may have (choice 6). */
export const ADDRESS_MAX_FILES = 200;
/** The most files a SKILL.md's links bring along from an address. */
export const SKILL_MAX_LINKS = 50;
const NOT_AN_ADDRESS = "That isn't a web address. Paste the address of a zip file, an annai-plugin.json or a SKILL.md.";

/** A GitHub page's address as GitHub's raw files serve it, which web apps may read; any other as it is. @param {string} address */
export function rawAddress(address) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(address);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : address;
}

/** Whether a name stays inside the package (see plainPath). @param {string} name */
const fileName = (name) => plainPath(name);

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
  const hint = url.hostname === 'github.com' ? ' For a folder on GitHub, use the address of its SKILL.md or annai-plugin.json.' : '';
  let used = 0;
  const download = async (/** @type {URL} */ u) => {
    /** @type {Response} */
    let res;
    try {
      res = await get(u.href, { cache: 'no-cache' });
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      throw new Error(`annai couldn't reach ${u.host}. Check the address, and that the site lets web apps read it.${hint}`);
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
      throw new Error(`${url.host} sent a zip annai can't open: ${/** @type {any} */ (e)?.message ?? e}`);
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
  const tooMany = () => new Error(`That package has more than ${ADDRESS_MAX_FILES} files; annai installs packages of up to ${ADDRESS_MAX_FILES} from an address. Use a zip instead.`);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  /** The files a SKILL.md links to, in its folder; one that can't be downloaded is left out. @param {string} folder '' or "skills/x/" @param {Uint8Array} skill */
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
        if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
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
    names.delete(MANIFEST_FILE);
    if (names.size + 1 > ADDRESS_MAX_FILES) throw tooMany();
    /** @type {Map<string, URL>} */
    const at = new Map();
    for (const name of names) {
      const u = fileUrl(name);
      if (!u) throw new Error(`The file name "${name}" isn't allowed.`);
      at.set(name, u);
    }
    for (const [name, u] of at) {
      try {
        files.set(name, await download(u));
      } catch (e) {
        // Which file the site lacks (minors 21).
        const status = /** @type {any} */ (e)?.status;
        throw status ? new Error(`${u.host} answered ${status} for ${name}, a file its ${MANIFEST_FILE} names.`) : e;
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
  throw new Error(`There's no annai plugin or skill at that address. annai looks for a zip file, an annai-plugin.json or a SKILL.md.${hint}`);
}

/** The manifest an address holds: a path ending in annai-plugin.json, or a JSON object with an api. @param {URL} url @param {string} body */
function asManifest(url, body) {
  if (!url.pathname.endsWith(`/${MANIFEST_FILE}`) && !/^\s*\{/.test(body)) return null;
  try {
    const json = JSON.parse(body);
    if (json && typeof json === 'object' && !Array.isArray(json) && ('api' in json || url.pathname.endsWith(`/${MANIFEST_FILE}`))) return json;
  } catch {
    if (url.pathname.endsWith(`/${MANIFEST_FILE}`)) throw new Error(`The ${MANIFEST_FILE} at ${url.host} isn't valid JSON.`);
  }
  return null;
}

/**
 * What a package brings that an installed one didn't (the coordinator's second finding): code where
 * there was none, skills and personalities it didn't have, and origins (scheme, host and port) its
 * provider description sends keys to that the installed one didn't (milestone 1, decision 11; the
 * security review: a change of scheme or port is new too). An update that adds any of them asks the user first.
 * @typedef {{ code: boolean, skills: string[], personalities: string[], origins: string[] }} Parts what an installed package has, by name
 * @typedef {{ code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[], origins: string[] }} Added
 * @param {Parts} before @param {Package} pkg @returns {Added}
 */
export function addedParts(before, pkg) {
  return {
    code: !before.code && pkg.code,
    skills: pkg.skills.filter((s) => !before.skills.includes(s.name)),
    personalities: pkg.personalities.filter((p) => !before.personalities.includes(p.name)),
    origins: originsOf(pkg.manifest).filter((o) => !(before.origins ?? []).includes(o)),
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

/** What was added, in words. @param {Added} a */
export function addedWords(a) {
  return [
    ...(a.code ? ['code that runs in annai'] : []),
    ...a.skills.map((s) => `the skill ${s.name}`),
    ...a.personalities.map((p) => `the personality ${p.name}`),
    ...(a.origins ?? []).map((o) => `a provider that sends keys to ${o}`),
  ].join(', ');
}
