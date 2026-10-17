import { validate } from './schema.js';
import { text, utf8 } from './bytes.js';
import { normPath } from './paths.js';
import { sha256Hex } from './hash.js';
import { PluginError } from './registry.js';
import { parseSkill, skillVersion, skillLinks, frontMatter, SkillError, SKILL_FILE } from './skills.js';
import { answerBytes } from './answer.js';
import { readZip } from './zip.js';

/**
 * A package as annai reads it before installing (spec §5.2): a folder, zip or address holding
 * annai-plugin.json, or a bare skill in the Agent Skills format (§5.1). Nothing here stores anything.
 * @typedef {import('./skills.js').Skill} Skill
 * @typedef {{ name: string, description: string, folder: string }} SkillInfo  folder: '' for the package's top, else "skills/tides"
 * @typedef {{ kind: 'plugin' | 'skill', id: string, name: string, version: string, shownVersion: string, manifest: any,
 *   files: Map<string, Uint8Array>, code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[],
 *   templates: any[], description: string, author?: string, homepage?: string, license?: string, fingerprint: string }} Package
 *   files: by name inside the package (its top folder taken off); shownVersion: '' for a skill without a version
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
    templates: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object' },
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
}

/** A relative path that stays inside the plugin's folder. @param {string} rel */
export function insidePlugin(rel) {
  try {
    return normPath(`/p/${rel}`) === `/p/${rel}`;
  } catch {
    return false;
  }
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

/** @param {any} t */
const isTemplate = (t) => t && typeof t === 'object' && typeof t.id === 'string' && typeof t.type === 'string' && typeof t.name === 'string' && Number.isInteger(t.version);

/**
 * Reads a package from its files (e.g. an unzipped one) and checks everything a later step needs:
 * the manifest or the skill, the files it names, its skills, personalities and templates.
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
      if (names.filter((n) => n === SKILL_FILE || n.endsWith(`/${SKILL_FILE}`)).length > 1) {
        throw new PluginError('skill', 'this zip holds several skills. Install each one on its own, or add an annai-plugin.json that lists them.');
      }
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
    skills: [{ name: skill.name, description: skill.description, folder: '' }], personalities: [], templates: [], description: skill.description,
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
  const templates = [];
  for (const t of manifest.templates ?? []) {
    const bytes = files.get(t);
    /** @type {any} */
    let json;
    try {
      if (!bytes) throw new Error('missing');
      json = JSON.parse(text(bytes));
    } catch {
      throw new PluginError(id, `its template file ${t} isn't valid JSON`);
    }
    if (!Array.isArray(json?.endpoints) || !json.endpoints.every(isTemplate)) throw new PluginError(id, `its template file ${t} doesn't hold endpoint templates annai can read`);
    templates.push(...json.endpoints);
  }
  return {
    kind: 'plugin', id, name: manifest.name, version: manifest.version, shownVersion: manifest.version, manifest, files, code: Boolean(manifest.entry),
    skills, personalities, templates, description: manifest.description ?? '',
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

/** Whether a name stays inside the package. @param {string} name */
const fileName = (name) => {
  try {
    return normPath(`/${name}`) === `/${name}`;
  } catch {
    return false;
  }
};

/**
 * A package's files from an address (choice 6): a zip, whatever the address ends with; an
 * annai-plugin.json and the files it names; or a SKILL.md and the files it links to inside its folder.
 * Nothing is stored. Every error is a plain Error that says what to do.
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
  let used = 0;
  const download = async (/** @type {URL} */ u) => {
    /** @type {Response} */
    let res;
    try {
      res = await get(u.href);
    } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      throw new Error(`annai couldn't reach ${u.host}. Check the address, and that the site lets web apps read it.`);
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
      if (files.has(name) || !fileName(name)) continue;
      if (files.size >= ADDRESS_MAX_FILES) throw tooMany();
      try {
        files.set(name, await download(new URL(name, base)));
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
    for (const f of [...(Array.isArray(manifest.personalities) ? manifest.personalities : []), ...(Array.isArray(manifest.templates) ? manifest.templates : [])]) add(f);
    names.delete(MANIFEST_FILE);
    if (names.size + 1 > ADDRESS_MAX_FILES) throw tooMany();
    for (const name of names) if (!fileName(name)) throw new Error(`The file name "${name}" isn't allowed.`);
    for (const name of names) files.set(name, await download(new URL(name, base)));
    for (const s of skillFiles) await linked(s.slice(0, -SKILL_FILE.length), /** @type {Uint8Array} */ (files.get(s)));
    return files;
  }
  if (body.startsWith('---') || url.pathname.endsWith(`/${SKILL_FILE}`)) {
    files.set(SKILL_FILE, first);
    await linked('', first);
    return files;
  }
  const hint = url.hostname === 'github.com' ? ' For a folder on GitHub, use the address of its SKILL.md or annai-plugin.json.' : '';
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
 * there was none, and skills, personalities and endpoint templates it didn't have. An update that
 * adds any of them asks the user first.
 * @typedef {{ code: boolean, skills: string[], personalities: string[], templates: string[] }} Parts what an installed package has, by name
 * @typedef {{ code: boolean, skills: SkillInfo[], personalities: { name: string, path: string }[], templates: any[] }} Added
 * @param {Parts} before @param {Package} pkg @returns {Added}
 */
export function addedParts(before, pkg) {
  return {
    code: !before.code && pkg.code,
    skills: pkg.skills.filter((s) => !before.skills.includes(s.name)),
    personalities: pkg.personalities.filter((p) => !before.personalities.includes(p.name)),
    templates: pkg.templates.filter((t) => !before.templates.includes(t.id)),
  };
}

/** Whether anything was added. @param {Added | null | undefined} a */
export const addsAnything = (a) => Boolean(a && (a.code || a.skills.length || a.personalities.length || a.templates.length));

/** Whether what the user agreed to covers what is added now. @param {Added | null | undefined} agreed @param {Added} added */
export function agreedTo(agreed, added) {
  if (!addsAnything(added)) return true;
  if (!agreed) return false;
  return (!added.code || agreed.code)
    && added.skills.every((s) => agreed.skills.some((x) => x.name === s.name))
    && added.personalities.every((p) => agreed.personalities.some((x) => x.name === p.name))
    && added.templates.every((t) => agreed.templates.some((x) => x.id === t.id));
}

/** What was added, in words. @param {Added} a */
export function addedWords(a) {
  return [
    ...(a.code ? ['code that runs in annai'] : []),
    ...a.skills.map((s) => `the skill ${s.name}`),
    ...a.personalities.map((p) => `the personality ${p.name}`),
    ...a.templates.map((t) => `the endpoint template ${t.name ?? t.id}`),
  ].join(', ');
}
