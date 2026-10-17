import { MANIFEST_FILE, PLUGIN_MAX_BYTES, checkManifest } from './packages.js';
import { text } from './bytes.js';
import { normPath, typeForPath } from './paths.js';
import { SYS, SYS_PLUGINS, SYS_SETTINGS } from './scopes.js';
import { tracedFetch } from './agent/net.js';
import { record } from './agent/log.js';
import { readAppSettings } from './settings.js';
import { logEvent } from './events.js';
import { readZip, ZipReader, ZipWriter } from './zip.js';
import { xmlElements, xmlText } from './xml.js';
import { TargetError, checkStorageType, backupFileName, parseBackupFileName, readAnswer } from './storage-types.js';
import { PluginError } from './registry.js';
import { ProviderError, errorFromResponse } from './llm/contract.js';
import { sse } from './llm/sse.js';
import { parsePartialJSON } from './llm/partial-json.js';
import { retry } from './llm/retry.js';
import { checkTool } from './agent/tools.js';
import { tsv } from './tsv.js';
import { mergePatch } from './patch.js';

/** @typedef {import('./registry.js').Registry} Registry @typedef {import('./workspace.js').Workspace} Workspace */

export { API_VERSION, MANIFEST_FILE, PLUGIN_MAX_BYTES, PLUGIN_MANIFEST_SCHEMA } from './packages.js';
/** How long a plugin's activate() may take before annai gives up on it. */
export const START_TIMEOUT = 10_000;
/** Launches in a row a plugin may fail to start on before annai turns it off. */
export const MAX_START_FAILURES = 3;
const STATE = '/installed.json';
/** Shared helpers every plugin gets (spec §5.4, §9.1). */
/** Errors that mean a plugin's code is broken, rather than a tool saying it can't do something. */
const BUGS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError];

const HELPERS = Object.freeze({ sse, parsePartialJSON, ProviderError, errorFromResponse, retry, tsv, mergePatch, TargetError, zip: Object.freeze({ ZipReader, ZipWriter }),
  backupFiles: Object.freeze({ name: backupFileName, parse: parseBackupFileName }), xml: Object.freeze({ elements: xmlElements, text: xmlText }), readAnswer });

/**
 * Whether an error is a bug in a plugin's code (spec §5.5) rather than its answer. A fetch the
 * browser couldn't make (offline: "Failed to fetch", Safari's "Load failed") is an answer (§17).
 * @param {unknown} e
 */
export function isPluginBug(e) {
  if (!(e instanceof Error)) return true;
  const offline = e instanceof TypeError && /fetch|load failed|network/i.test(e.message);
  // An address the user typed that isn't one is the user's to fix, not a bug.
  const address = e instanceof TypeError && /invalid url|failed to parse url/i.test(e.message);
  return !offline && !address && BUGS.some((B) => e instanceof B);
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
  /** Plugins whose code was imported in this session. The browser keeps a module by its URL until annai restarts. */
  #loaded = new Set();
  /** Plugins installed or removed after their code was imported: only a restart runs the new code. */
  #stale = new Set();
  /** @type {{ llm?: any, agent?: any, notices?: any, fetch?: any }} what plugins reach through annai once the app has it */
  #services = {};
  /** @type {Map<string, Promise<void>>} plugins starting now, so a second start waits instead of activating twice */
  #starting = new Map();

  /**
   * @param {{ registry: Registry, workspace: Workspace, importModule?: (url: string) => Promise<any>,
   *   pluginUrl?: (id: string, file: string) => string, startTimeout?: number, maxPackageBytes?: number }} deps
   */
  constructor({ registry, workspace, importModule = (url) => import(url), pluginUrl = (id, file) => `/plugins/${encodeURIComponent(id)}/${file}`,
    startTimeout = START_TIMEOUT, maxPackageBytes = PLUGIN_MAX_BYTES }) {
    this.registry = registry;
    this.ws = workspace;
    this.importModule = importModule;
    this.pluginUrl = pluginUrl;
    this.startTimeout = startTimeout;
    this.maxPackageBytes = maxPackageBytes;
  }

  /** Starts a plugin that ships with the app. @param {string} moduleUrl */
  async addBuiltin(moduleUrl) {
    const mod = await this.importModule(moduleUrl);
    checkManifest(mod.manifest);
    this.builtins.set(mod.manifest.id, mod.manifest);
    await this.#start(mod.manifest, mod, true);
    return mod.manifest;
  }

  /** @returns {Promise<Record<string, { version: string, name: string, enabled: boolean, installed: number, source: string, startFailures?: number }>>} */
  async installed() {
    return (await this.ws.readJSON(SYS_PLUGINS, STATE)) ?? {};
  }

  /** Installs (or replaces) a plugin from a zip file. @param {Uint8Array} bytes @param {{ source?: string }} [opts] */
  async installZip(bytes, opts) {
    /** @type {Map<string, Uint8Array>} */
    let files;
    try {
      files = await readZip(bytes, { maxTotal: this.maxPackageBytes });
    } catch (e) {
      throw new PluginError('plugin', `this file isn't a plugin package annai can open: ${/** @type {any} */ (e)?.message ?? e}`);
    }
    return this.install(files, opts);
  }

  /**
   * Installs (or replaces) a plugin from its files, e.g. an unzipped package.
   * Everything is checked first, then written in one transaction: all or nothing.
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
    /** @type {Map<string, Uint8Array>} */
    const toWrite = new Map();
    for (const [name, bytes] of files) {
      if (!name.startsWith(root) || name.endsWith('/')) continue;
      const rel = name.slice(root.length);
      try {
        toWrite.set(normPath(`/${id}/${rel}`), bytes);
      } catch {
        throw new PluginError(id, `the file name "${rel}" isn't allowed`);
      }
    }
    await this.stop(id);
    const state = await this.installed();
    state[id] = { version: manifest.version, name: manifest.name, enabled: true, installed: this.ws.now(), source };
    const gone = (await this.ws.list(SYS_PLUGINS, `/${id}/`)).filter((f) => !toWrite.has(f.path));
    await this.ws.writeMany(SYS_PLUGINS, [
      ...gone.map((f) => ({ path: f.path, content: null })),
      ...[...toWrite].map(([path, bytes]) => ({ path, content: bytes, type: typeForPath(path) })),
      { path: STATE, content: state },
    ], { author: 'system' });
    if (this.#loaded.has(id)) this.#stale.add(id);
    return manifest;
  }

  /**
   * Whether a plugin's stored files are exactly the ones annai's catalog lists for it (spec §5.3:
   * official plugins are checked against the catalog's SHA-256s). A copy that came any other way,
   * such as a restored backup's, isn't official until it matches.
   * @param {string} id @param {{ files: Record<string, string> }} entry
   */
  async verifyOfficial(id, entry) {
    const stored = await this.ws.list(SYS_PLUGINS, `/${id}/`);
    const want = Object.entries(entry.files ?? {});
    if (stored.length !== want.length) return false;
    return want.every(([name, hash]) => stored.some((f) => f.path === `/${id}/${name}` && f.hash === hash));
  }

  /** Whether annai must restart before this plugin's current code can run. @param {string} id */
  needsRestart(id) {
    return this.#stale.has(id);
  }

  /**
   * Starts every enabled installed plugin and returns the ones that failed. A plugin that
   * fails on MAX_START_FAILURES launches in a row is turned off (disabled: true).
   * @returns {Promise<{ id: string, error: unknown, disabled: boolean }[]>}
   */
  async startInstalled() {
    const failures = [];
    for (const [id, s] of Object.entries(await this.installed())) {
      if (!s.enabled) continue;
      try {
        await this.start(id);
        if (s.startFailures) await this.#updateState(id, { startFailures: 0 }).catch(() => {});
      } catch (error) {
        const n = (s.startFailures ?? 0) + 1;
        const disabled = n >= MAX_START_FAILURES;
        await this.#updateState(id, { startFailures: n, ...(disabled ? { enabled: false } : {}) }).catch(() => {});
        if (disabled) this.#log({ type: 'plugin.disabled', actor: 'system', data: { plugin: id, reason: `didn't start on ${n} launches in a row` } });
        failures.push({ id, error, disabled });
      }
    }
    return failures;
  }

  /** Starts an installed plugin; a second call while it is starting waits for the first. @param {string} id */
  start(id) {
    const had = this.#starting.get(id);
    if (had) return had;
    const work = this.#startNow(id).finally(() => this.#starting.delete(id));
    this.#starting.set(id, work);
    return work;
  }

  /** @param {string} id */
  async #startNow(id) {
    if (this.active.has(id)) return;
    if (this.#stale.has(id)) throw new PluginError(id, 'was updated. Restart annai to run the new version.');
    const manifest = await this.#stored(id);
    this.#loaded.add(id);
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
    await this.#updateState(id, enabled ? { enabled, startFailures: 0 } : { enabled });
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
    const state = await this.installed();
    delete state[id];
    await this.ws.writeMany(SYS_PLUGINS, [
      ...(await this.ws.list(SYS_PLUGINS, `/${id}/`)).map((f) => ({ path: f.path, content: null })),
      { path: STATE, content: state },
    ], { author: 'system' });
    if (this.#loaded.has(id)) this.#stale.add(id);
  }

  /** Rows for the plugins screen. problem: why an installed plugin can't start, if it can't. */
  async describe() {
    const rows = [];
    for (const m of this.builtins.values()) {
      rows.push({ id: m.id, name: m.name, version: m.version, description: m.description ?? '', builtin: true, enabled: true, active: this.active.has(m.id), failing: this.registry.isDisabled(m.id), problem: null, restart: false });
    }
    for (const [id, s] of Object.entries(await this.installed())) {
      /** @type {any} */
      let m = null;
      /** @type {string | null} */
      let problem = null;
      try {
        m = await this.#stored(id);
      } catch (e) {
        problem = String(/** @type {any} */ (e)?.message ?? e);
      }
      rows.push({
        id, name: m?.name ?? s.name ?? id, version: m?.version ?? s.version, description: m?.description ?? '', builtin: false,
        enabled: Boolean(s.enabled), active: this.active.has(id), failing: this.registry.isDisabled(id), problem, restart: this.#stale.has(id),
      });
    }
    return rows;
  }

  /** The stored manifest, checked again: storage can hold one that was never installed through install(). @param {string} id */
  async #stored(id) {
    /** @type {any} */
    let manifest;
    try {
      manifest = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
    } catch {
      throw new PluginError(id, `its ${MANIFEST_FILE} is not valid JSON`);
    }
    if (!manifest) throw new PluginError(id, 'is not installed');
    checkManifest(manifest);
    if (manifest.id !== id) throw new PluginError(id, `its ${MANIFEST_FILE} names "${manifest.id}", not the folder it is installed in`);
    return manifest;
  }

  /** @param {any} manifest @param {any} mod @param {boolean} builtin */
  async #start(manifest, mod, builtin) {
    const id = manifest.id;
    let dispose = () => {};
    try {
      if (typeof mod?.activate === 'function') {
        const r = await this.registry.guard(id, 'starting', (/** @type {any} */ api) => this.#inTime(id, () => mod.activate(api)))(this.#api(id));
        if (typeof r === 'function') dispose = r;
      } else if (manifest.entry) {
        throw new PluginError(id, 'its module has no activate() function');
      }
    } catch (e) {
      this.registry.removePlugin(id); // whatever it registered before failing
      throw e;
    }
    this.active.set(id, { manifest, builtin, dispose });
  }

  /**
   * Runs activate(), giving up after startTimeout so one plugin can't keep annai from
   * starting. If it finishes later, whatever it set up is taken down again.
   * @param {string} id @param {() => any} activate
   */
  #inTime(id, activate) {
    const work = Promise.resolve().then(activate);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`it didn't finish starting within ${Math.round(this.startTimeout / 100) / 10} seconds`));
        work.then((r) => {
          if (this.active.has(id)) return;
          try {
            if (typeof r === 'function') r();
          } finally {
            this.registry.removePlugin(id);
          }
        }).catch(() => {});
      }, this.startTimeout);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  }

  /** The services plugins reach through annai once the app has them (spec §5.4). @param {{ llm?: any, agent?: any, notices?: any, fetch?: any }} services */
  connect(services) {
    this.#services = { ...this.#services, ...services };
  }

  /** The object a plugin's activate() receives (milestone 1 subset of spec §5.4). @param {string} id */
  #api(id) {
    const registry = this.registry;
    const need = (/** @type {'llm' | 'agent' | 'notices'} */ what) => {
      const svc = this.#services[what];
      if (!svc) throw new PluginError(id, `${what} isn't ready yet; use it after annai has started`);
      return svc;
    };
    /** @type {string[]} */
    let searchOrder = [];
    const ordered = () => {
      const all = registry.list('search');
      return [...searchOrder.map((sid) => all.find((p) => p.id === sid)).filter(Boolean), ...all.filter((p) => !searchOrder.includes(p.id))];
    };
    const llm = Object.assign(
      async (/** @type {string} */ role, /** @type {any} */ request) => (await need('llm').call({ role, request, scope: SYS, record: { tag: `plugin:${id}` } })).reply,
      { decide: (/** @type {any} */ c) => need('llm').decide({ ...c, scope: SYS }) },
    );
    return Object.freeze({
      id,
      register: (/** @type {string} */ kind, /** @type {any} */ item) => registry.add(id, kind, item),
      schemas: Object.freeze({ register: (/** @type {any} */ entry) => registry.add(id, 'schema', entry) }),
      tools: Object.freeze({
        register: (/** @type {any} */ tool) => {
          const wrong = checkTool(tool);
          if (wrong) throw new PluginError(id, wrong);
          const run = tool.run.bind(tool);
          return registry.add(id, 'tool', {
            ...tool,
            run: async (/** @type {any} */ input, /** @type {any} */ call) => {
              try {
                const out = await run(input, call);
                registry.succeeded(id);
                return out;
              } catch (e) {
                // A tool's own error is its answer: Shiori sees it and adapts (spec §6.7). Only a crash counts
                // against the plugin, which is switched off when it keeps crashing (§5.5).
                // A fetch the browser couldn't make (offline: "Failed to fetch", Safari's "Load failed") is an answer too (§17).
                if (!isPluginBug(e)) throw e;
                registry.fail(id, `tool ${tool.name}`, e);
                throw new PluginError(id, `the tool ${tool.name} failed: ${/** @type {any} */ (e)?.message ?? e}`, e);
              }
            },
          });
        },
      }),
      events: Object.freeze({
        /** An entry in a scope's log, signed plugin:<id>; content it keeps is stored and named in its refs (spec §5.4). */
        append: (/** @type {string} */ scope, /** @type {string} */ type, /** @type {any} */ data, /** @type {any} */ keep = {}) =>
          record(this.ws.store, scope, { type, actor: `plugin:${id}`, data: data ?? {}, texts: keep.texts ?? [], blobs: keep.blobs ?? [] }),
      }),
      llm,
      wake: (/** @type {string} */ reason) => need('agent').wake({ kind: 'plugin', plugin: id, text: String(reason) }),
      net: Object.freeze({
        /** A web request, in the trace as plugin:<id> (spec §5.4). */
        fetch: (/** @type {string} */ url, /** @type {RequestInit} */ init) => tracedFetch(this.ws.store, SYS, { tool: `plugin:${id}` }, this.#services.fetch)(url, init),
      }),
      ui: Object.freeze({
        card: (/** @type {any} */ c) => need('notices').card({ title: String(c?.title ?? ''), body: c?.body, tone: c?.tone, actions: c?.actions }),
        toast: (/** @type {string} */ text) => need('notices').toast(String(text)),
      }),
      cache: Object.freeze({ state: () => need('agent').cacheState() }),
      settings: Object.freeze({
        get: async () => (await this.ws.readJSON(SYS_SETTINGS, `/plugin-settings/${id}.json`)) ?? {},
        set: (/** @type {Record<string, any>} */ changes) => this.ws.patch(SYS_SETTINGS, `/plugin-settings/${id}.json`, changes, { author: `plugin:${id}`, create: true }),
      }),
      searchProviders: ordered,
      searchProvidersAsync: async () => {
        searchOrder = (await readAppSettings(this.ws)).web?.search ?? [];
        return ordered();
      },
      providers: Object.freeze({
        /** An endpoint type (spec §9.1): build() and read(), or run() for types that need no network. */
        register: (/** @type {any} */ type) => {
          if (typeof type?.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(type.type)) {
            throw new PluginError(id, 'an endpoint type needs a "type" id of lowercase letters, digits and dashes');
          }
          const chat = typeof type.run === 'function' || (typeof type.build === 'function' && typeof type.read === 'function');
          const hears = type.speech === 'in' && typeof type.transcribeRequest === 'function' && typeof type.readTranscript === 'function';
          const speaks = type.speech === 'out' && typeof type.speechRequest === 'function' && typeof type.readSpeech === 'function';
          if (!chat && !hears && !speaks) {
            throw new PluginError(id, `the endpoint type "${type.type}" needs build() and read(), or run(); a speech type needs transcribeRequest() and readTranscript(), or speechRequest() and readSpeech()`);
          }
          return registry.add(id, 'endpoint-type', Object.freeze({ ...type, name: String(type.name ?? type.type), pluginId: id }));
        },
      }),
      storage: Object.freeze({
        /** A kind of place to back up to (spec §12.4); storage-types.js says what it must have. */
        register: (/** @type {any} */ type) => {
          const wrong = checkStorageType(type);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'storage-type', Object.freeze({ ...type, name: String(type.name).trim(), fields: type.fields ?? [], secret: type.secret ?? [], pluginId: id }));
        },
      }),
      helpers: HELPERS,
      files: this.ws,
      secrets: Object.freeze({
        /** A secret of this plugin's own, such as a key; never in files or the trace (spec §9.9). */
        get: (/** @type {string} */ name) => this.ws.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`plugin:${id}:${name}`)),
        /** null removes it. */
        set: (/** @type {string} */ name, /** @type {any} */ value) => this.ws.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => (value === null || value === undefined
          ? t.deleteSecret(`plugin:${id}:${name}`) : t.putSecret(`plugin:${id}:${name}`, value))),
      }),
    });
  }

  /** @param {{ type: string, actor: string, data: any }} ev */
  #log(ev) {
    try {
      Promise.resolve(this.registry.log(ev)).catch(() => {});
    } catch {
      // logging must never break the caller
    }
  }

  /** @param {string} id @param {Record<string, any>} changes */
  async #updateState(id, changes) {
    await this.ws.patch(SYS_PLUGINS, STATE, { [id]: changes }, { author: 'system', create: true });
  }
}
