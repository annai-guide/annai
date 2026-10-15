import { validate } from './schema.js';
import { text } from './bytes.js';
import { normPath, typeForPath } from './paths.js';
import { SYS_PLUGINS } from './scopes.js';
import { logEvent } from './events.js';
import { PluginError } from './registry.js';

/** @typedef {import('./registry.js').Registry} Registry @typedef {import('./workspace.js').Workspace} Workspace */

export const API_VERSION = 1;
export const MANIFEST_FILE = 'annai-plugin.json';
const STATE = '/installed.json';

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
    skills: { type: 'array', items: { type: 'string' } },
    personalities: { type: 'array', items: { type: 'string' } },
    templates: { type: 'array', items: { type: 'string' } },
    settings: { type: 'object' },
  },
};

/** @param {any} manifest */
function checkManifest(manifest) {
  const id = typeof manifest?.id === 'string' ? manifest.id : 'plugin';
  const errors = validate(PLUGIN_MANIFEST_SCHEMA, manifest);
  if (errors.length) throw new PluginError(id, `its ${MANIFEST_FILE} is not valid: ${errors.join('; ')}`);
  if (manifest.api !== API_VERSION) {
    throw new PluginError(id, `was made for plugin API ${manifest.api}; this version of annai supports API ${API_VERSION}`);
  }
}

/** The folder the package lives in: "" or "name/" when everything sits in one top folder. @param {Map<string, Uint8Array>} files */
function findRoot(files) {
  if (files.has(MANIFEST_FILE)) return '';
  const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
  if (tops.size === 1) {
    const [top] = tops;
    if (files.has(`${top}/${MANIFEST_FILE}`)) return `${top}/`;
  }
  return '';
}

/**
 * Installs, starts and stops plugins (spec §5). Installed plugin files live
 * in the sys:plugins scope under /<id>/…; the service worker serves them at
 * /plugins/<id>/… so they load as ordinary same-origin modules.
 */
export class PluginHost {
  /** @type {Map<string, { manifest: any, builtin: boolean, dispose: () => void }>} */
  active = new Map();
  /** @type {Map<string, any>} built-in manifests by id */
  builtins = new Map();

  /**
   * @param {{ registry: Registry, workspace: Workspace, importModule?: (url: string) => Promise<any>,
   *   pluginUrl?: (id: string, file: string) => string }} deps
   */
  constructor({ registry, workspace, importModule = (url) => import(url), pluginUrl = (id, file) => `/plugins/${encodeURIComponent(id)}/${file}` }) {
    this.registry = registry;
    this.ws = workspace;
    this.importModule = importModule;
    this.pluginUrl = pluginUrl;
  }

  /** Starts a plugin that ships with the app. @param {string} moduleUrl */
  async addBuiltin(moduleUrl) {
    const mod = await this.importModule(moduleUrl);
    checkManifest(mod.manifest);
    this.builtins.set(mod.manifest.id, mod.manifest);
    await this.#start(mod.manifest, mod, true);
    return mod.manifest;
  }

  /** @returns {Promise<Record<string, { version: string, name: string, enabled: boolean, installed: number, source: string }>>} */
  async installed() {
    return (await this.ws.readJSON(SYS_PLUGINS, STATE)) ?? {};
  }

  /**
   * Installs (or replaces) a plugin from its files, e.g. an unzipped package.
   * Everything is checked before anything is written.
   * @param {Map<string, Uint8Array>} files
   * @param {{ source?: string }} [opts]
   */
  async install(files, { source = 'file' } = {}) {
    const root = findRoot(files);
    const raw = files.get(root + MANIFEST_FILE);
    if (!raw) throw new PluginError('plugin', `there is no ${MANIFEST_FILE} in this package`);
    /** @type {any} */
    let manifest;
    try {
      manifest = JSON.parse(text(raw));
    } catch {
      throw new PluginError('plugin', `its ${MANIFEST_FILE} is not valid JSON`);
    }
    checkManifest(manifest);
    const id = manifest.id;
    if (this.builtins.has(id)) throw new PluginError(id, 'has the same id as a plugin built into annai');
    if (manifest.entry && !files.has(root + manifest.entry)) throw new PluginError(id, `its entry file ${manifest.entry} is missing`);
    /** @type {[string, Uint8Array][]} */
    const toWrite = [];
    for (const [name, bytes] of files) {
      if (!name.startsWith(root) || name.endsWith('/')) continue;
      const rel = name.slice(root.length);
      try {
        toWrite.push([normPath(`/${id}/${rel}`), bytes]);
      } catch {
        throw new PluginError(id, `the file name "${rel}" isn't allowed`);
      }
    }
    await this.stop(id);
    for (const f of await this.ws.list(SYS_PLUGINS, `/${id}/`)) await this.ws.delete(SYS_PLUGINS, f.path, { author: 'system' });
    for (const [path, bytes] of toWrite) await this.ws.write(SYS_PLUGINS, path, bytes, { author: 'system', type: typeForPath(path) });
    await this.#updateState(id, { version: manifest.version, name: manifest.name, enabled: true, installed: this.ws.now(), source });
    return manifest;
  }

  /** Starts every enabled installed plugin; returns the ones that failed. */
  async startInstalled() {
    /** @type {{ id: string, error: unknown }[]} */
    const failures = [];
    for (const [id, s] of Object.entries(await this.installed())) {
      if (!s.enabled) continue;
      try {
        await this.start(id);
      } catch (error) {
        failures.push({ id, error });
      }
    }
    return failures;
  }

  /** @param {string} id */
  async start(id) {
    if (this.active.has(id)) return;
    const manifest = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
    if (!manifest) throw new PluginError(id, 'is not installed');
    const mod = manifest.entry ? await this.importModule(this.pluginUrl(id, manifest.entry)) : {};
    await this.#start(manifest, mod, false);
  }

  /** @param {string} id */
  async stop(id) {
    const a = this.active.get(id);
    if (a) {
      this.active.delete(id);
      try {
        a.dispose();
      } catch (e) {
        console.warn(`plugin ${id} failed to stop cleanly`, e);
      }
    }
    this.registry.removePlugin(id);
  }

  /** @param {string} id @param {boolean} enabled */
  async setEnabled(id, enabled) {
    await this.#updateState(id, { enabled });
    if (enabled) {
      this.registry.enable(id);
      await this.start(id);
    } else {
      await this.stop(id);
    }
  }

  /** @param {string} id */
  async uninstall(id) {
    await this.stop(id);
    for (const f of await this.ws.list(SYS_PLUGINS, `/${id}/`)) await this.ws.delete(SYS_PLUGINS, f.path, { author: 'system' });
    const state = await this.installed();
    delete state[id];
    await this.ws.write(SYS_PLUGINS, STATE, state, { author: 'system' });
  }

  /** Rows for the plugins screen. */
  async describe() {
    const rows = [];
    for (const m of this.builtins.values()) {
      rows.push({ id: m.id, name: m.name, version: m.version, description: m.description ?? '', builtin: true, enabled: true, active: this.active.has(m.id), failing: this.registry.isDisabled(m.id) });
    }
    for (const [id, s] of Object.entries(await this.installed())) {
      const m = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
      rows.push({ id, name: m?.name ?? s.name ?? id, version: m?.version ?? s.version, description: m?.description ?? '', builtin: false, enabled: Boolean(s.enabled), active: this.active.has(id), failing: this.registry.isDisabled(id) });
    }
    return rows;
  }

  /** @param {any} manifest @param {any} mod @param {boolean} builtin */
  async #start(manifest, mod, builtin) {
    const id = manifest.id;
    let dispose = () => {};
    if (typeof mod?.activate === 'function') {
      const r = await this.registry.guard(id, 'starting', mod.activate)(this.#api(id));
      if (typeof r === 'function') dispose = r;
    } else if (manifest.entry) {
      throw new PluginError(id, 'its module has no activate() function');
    }
    this.active.set(id, { manifest, builtin, dispose });
  }

  /** The object a plugin's activate() receives (milestone 1 subset of spec §5.4). @param {string} id */
  #api(id) {
    const registry = this.registry;
    return Object.freeze({
      id,
      register: (/** @type {string} */ kind, /** @type {any} */ item) => registry.add(id, kind, item),
      schemas: Object.freeze({ register: (/** @type {any} */ entry) => registry.add(id, 'schema', entry) }),
      tools: Object.freeze({
        register: (/** @type {any} */ tool) => registry.add(id, 'tool', { ...tool, run: registry.guard(id, `tool ${tool.name}`, tool.run) }),
      }),
      events: Object.freeze({
        append: (/** @type {string} */ scope, /** @type {string} */ type, /** @type {any} */ data) => logEvent(this.ws.store, scope, { type, actor: `plugin:${id}`, data }),
      }),
      files: this.ws,
    });
  }

  /** @param {string} id @param {Record<string, any>} changes */
  async #updateState(id, changes) {
    const state = await this.installed();
    state[id] = { ...state[id], ...changes };
    await this.ws.write(SYS_PLUGINS, STATE, state, { author: 'system' });
  }
}
