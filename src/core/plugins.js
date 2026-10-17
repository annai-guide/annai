import { MANIFEST_FILE, PLUGIN_MAX_BYTES, checkManifest, inspectPackage, skillManifest, addedParts } from './packages.js';
import { parseSkill, SKILL_FILE } from './skills.js';
import { forget } from './forget.js';
import { checkSlot, checkCardType, checkComponent, checkScreen, checkTheme } from './ui-slots.js';
import { normPath, typeForPath } from './paths.js';
import { SYS, SYS_PLUGINS, SYS_SETTINGS } from './scopes.js';
import { tracedFetch } from './agent/net.js';
import { addressParts, KEY_BLANK } from './address.js';
import { record } from './agent/log.js';
import { readAppSettings, updateAppSettings } from './settings.js';
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
/** A package's secret holding the address it came from, keys and all (fix pass 8a-1); annai's alone, as a plugin's are plugin:<id>:… (Reset R1). @param {string} id */
const ADDRESS = (id) => `package:${id}:address`;
/** A plugin's settings file in sys:settings (spec §5.4). @param {string} id */
const SETTINGS = (id) => `/plugin-settings/${id}.json`;
/** Built-ins whose secrets are no settings: the MCP client's are its servers', which their own screen removes (spec §5.1). */
const NO_RESET = new Set(['mcp']);
/** What a settings schema gives a key nothing is saved for: its default, writeOnly ones aside (they are secrets). @param {any} schema */
function defaultsOf(schema) {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  return structuredClone(Object.fromEntries(Object.entries(props).filter(([, p]) => p?.default !== undefined && !p.writeOnly).map(([k, p]) => [k, p.default])));
}
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

/** A state record's kind: a bare skill, or a plugin (every record from before milestone 8). @param {any} s @returns {'skill' | 'plugin'} */
const kindOfState = (s) => (s?.kind === 'skill' ? 'skill' : 'plugin');
/** Where a package came from, read the same way for records from before milestone 8, whose source was the file's name. @param {any} s */
function sourceOf(s) {
  if (s?.source === 'official' || s?.source === 'url' || s?.source === 'file') return { source: s.source, file: s.file, url: s.url };
  return { source: 'file', file: typeof s?.source === 'string' && s.source ? s.source : undefined, url: undefined };
}
/** A skill folder as a manifest names it: '' for the package's top. @param {string} f */
const skillFolder = (f) => (f === '.' ? '' : f.replace(/\/+$/, ''));

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
  /** @type {Set<string>} ids being removed: their start's later writes are skipped, and they don't start again (fix pass 8a-2) */
  #removing = new Set();
  /** @type {{ state: Record<string, any>, names: Map<string, string[]> }} the installed packages and the skill names they claim, as of the last start */
  #claimed = { state: {}, names: new Map() };

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

  /**
   * Each installed package's record, by id. kind: 'skill' for a bare skill (absent before milestone 8: a plugin); source: 'official', 'url'
   * or 'file' (before milestone 8, the file's name); skills: the skill names it claims; tools: its tools' names as of its last start.
   * @returns {Promise<Record<string, { version: string, name: string, enabled: boolean, installed: number, source: string, kind?: string,
   *   file?: string, url?: string, fingerprint?: string, skills?: string[], tools?: string[], startFailures?: number }>>}
   */
  async installed() {
    return (await this.ws.readJSON(SYS_PLUGINS, STATE)) ?? {};
  }

  /** Installs (or replaces) a package from a zip file. @param {Uint8Array} bytes @param {{ source?: 'file' | 'url' | 'official', file?: string, url?: string }} [opts] */
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
   * Reads a package and checks that it can be installed here (spec §5.2, choice 1): not one of
   * annai's own names, not a package of the other kind, no skill name Shiori already has from
   * elsewhere. replaces: the installed version this package would replace.
   * @param {Map<string, Uint8Array>} files
   * @returns {Promise<import('./packages.js').Package & { replaces: { version: string, kind: string, added: import('./packages.js').Added } | null }>}
   */
  async inspect(files) {
    const pkg = await inspectPackage(files, { maxBytes: this.maxPackageBytes });
    const id = pkg.id;
    if (this.builtins.has(id)) {
      throw new PluginError(id, pkg.kind === 'skill' ? 'is a name annai uses for one of its own parts, so a skill can\'t have it.' : 'has the same id as a plugin built into annai');
    }
    const state = await this.installed();
    const had = state[id];
    if (had && kindOfState(had) !== pkg.kind) throw new PluginError(id, `is installed already as a ${kindOfState(had)}. Remove it first.`);
    // Every installed package's skills count, on or off, started or not, and annai's own (the coordinator's finding).
    const claims = await this.#claims(state);
    for (const s of pkg.skills) {
      if (this.#builtinSkill(s.name)) throw new PluginError(id, `Shiori already has a skill called ${s.name}, built into annai.`);
      const running = this.registry.entries('skill', { all: true }).find((e) => e.pluginId !== id && e.item?.name === s.name);
      const holder = running?.pluginId ?? [...claims].find(([other, names]) => other !== id && names.includes(s.name))?.[0];
      if (holder) throw new PluginError(id, `Shiori already has a skill called ${s.name}, from ${state[holder]?.name ?? holder}. Remove that one first.`);
    }
    return { ...pkg, replaces: had ? { version: String(had.version ?? ''), kind: kindOfState(had), added: addedParts(await this.installedParts(id), pkg) } : null };
  }

  /**
   * What an installed package has, read from its stored files (its record may be older than this):
   * code or not, and its skills', personalities' and endpoint templates' names. A package that can't be
   * read has nothing, so anything a new version brings counts as new.
   * @param {string} id @returns {Promise<import('./packages.js').Parts>}
   */
  async installedParts(id) {
    /** @type {import('./packages.js').Parts} */
    const none = { code: false, skills: [], personalities: [], templates: [] };
    const s = (await this.installed())[id];
    if (!s) return none;
    if (kindOfState(s) === 'skill') return { ...none, skills: [id] };
    try {
      const m = await this.#stored(id);
      const skills = (await this.#claims({ [id]: { kind: 'plugin' } })).get(id) ?? [];
      /** @type {string[]} */
      const templates = [];
      for (const t of Array.isArray(m.templates) ? m.templates : []) {
        const json = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${t}`).catch(() => null);
        for (const e of Array.isArray(json?.endpoints) ? json.endpoints : []) if (typeof e?.id === 'string') templates.push(e.id);
      }
      const personalities = (Array.isArray(m.personalities) ? m.personalities : []).map((p) => String(p).split('/').pop()?.replace(/\.md$/, '') ?? '');
      return { code: Boolean(m.entry), skills, personalities, templates };
    } catch {
      return none;
    }
  }

  /** Whether a skill name is annai's own: one its built-in plugins provide or have registered. @param {string} name */
  #builtinSkill(name) {
    for (const m of this.builtins.values()) if (Array.isArray(m.provides?.skill) && m.provides.skill.includes(name)) return true;
    return this.registry.entries('skill', { all: true }).some((e) => this.builtins.has(e.pluginId) && e.item?.name === name);
  }

  /**
   * The skill names each installed package claims, on or off: from its record, or, for a record from
   * before it was kept there, from its stored files.
   * @param {Record<string, any>} state @returns {Promise<Map<string, string[]>>}
   */
  async #claims(state) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const [id, s] of Object.entries(state)) {
      if (Array.isArray(s?.skills)) out.set(id, s.skills.map(String));
      else if (kindOfState(s) === 'skill') out.set(id, [id]);
      else {
        /** @type {string[]} */
        const names = [];
        try {
          const m = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${MANIFEST_FILE}`);
          for (const f of Array.isArray(m?.skills) ? m.skills : []) {
            const folder = skillFolder(String(f));
            const t = await this.ws.readText(SYS_PLUGINS, `/${id}/${folder ? `${folder}/` : ''}${SKILL_FILE}`);
            if (t !== undefined) names.push(parseSkill(t).name);
          }
        } catch {
          // a broken package claims nothing; it won't start anyway
        }
        out.set(id, names);
      }
    }
    return out;
  }

  /**
   * Who already has a skill name, for a plugin about to register one (the coordinator's finding): annai
   * itself, a plugin that registered it (on or off), or an installed package that comes first (installed
   * earlier; on the same moment, by id), whether or not it has started. So the order packages start in
   * never decides which one has a name. null: nobody.
   * @param {string} id @param {string} name @returns {string | null}
   */
  #skillHolder(id, name) {
    if (!this.builtins.has(id) && this.#builtinSkill(name)) return 'annai';
    const running = this.registry.entries('skill', { all: true }).find((e) => e.pluginId !== id && e.item?.name === name);
    if (running) return this.#nameOf(running.pluginId);
    if (this.builtins.has(id)) return null;
    const mine = this.#claimed.state[id];
    const first = (/** @type {string} */ a, /** @type {string} */ b) => {
      const ta = Number(this.#claimed.state[a]?.installed ?? 0);
      const tb = Number(this.#claimed.state[b]?.installed ?? 0);
      return ta !== tb ? ta < tb : a < b;
    };
    for (const [other, names] of this.#claimed.names) {
      if (other !== id && names.includes(name) && (!mine || first(other, id))) return this.#nameOf(other);
    }
    return null;
  }

  /** A plugin's name as the user knows it. @param {string} id */
  #nameOf(id) {
    return this.builtins.get(id)?.name ?? this.#claimed.state[id]?.name ?? id;
  }

  /** Refuses a skill whose name another plugin has (see #skillHolder). @param {string} id @param {string} name */
  #mayRegisterSkill(id, name) {
    const holder = this.#skillHolder(id, name);
    if (!holder) return;
    throw new PluginError(id, holder === 'annai'
      ? `its skill ${name} can't be used: annai has a skill by that name already. Ask the plugin's author to rename it.`
      : `its skill ${name} can't be used: ${holder} has a skill by that name already. Remove one of them.`);
  }

  /**
   * Installs (or replaces) a package from its files, e.g. an unzipped one. Everything is checked
   * first, then written in one transaction: all or nothing. A package's files keep no history
   * (choice 3): an install replaces them outright, and the space old versions took comes back.
   * @param {Map<string, Uint8Array>} files
   * @param {{ source?: 'file' | 'url' | 'official', file?: string, url?: string }} [opts]
   */
  async install(files, { source = 'file', file, url } = {}) {
    const pkg = await this.inspect(files);
    const id = pkg.id;
    /** @type {Map<string, Uint8Array>} */
    const toWrite = new Map([...pkg.files].map(([rel, bytes]) => [`/${id}/${rel}`, bytes]));
    await this.#settled(id);
    this.#removing.delete(id);
    await this.stop(id);
    const state = await this.installed();
    const before = state[id];
    // An address's keys go to the package's secret; installed.json and the log keep it with «key» in their places (fix pass 8a-1).
    const shown = await this.#keepAddress(id, url);
    state[id] = {
      // A new version of one that is off stays off (fix pass 8a-5).
      version: pkg.version, name: pkg.name, kind: pkg.kind, enabled: before ? before.enabled !== false : true, installed: this.ws.now(), source, fingerprint: pkg.fingerprint, skills: pkg.skills.map((x) => x.name),
      ...(file ? { file } : {}), ...(shown ? { url: shown } : {}), ...(before?.tools ? { tools: before.tools } : {}),
    };
    const gone = (await this.ws.list(SYS_PLUGINS, `/${id}/`)).filter((f) => !toWrite.has(f.path));
    try {
      await this.ws.writeMany(SYS_PLUGINS, [
        ...gone.map((f) => ({ path: f.path, content: null })),
        ...[...toWrite].map(([path, bytes]) => ({ path, content: bytes, type: typeForPath(path) })),
        { path: STATE, content: state },
      ], { author: 'system' });
    } catch (e) {
      if (!before) await this.#keepAddress(id, undefined).catch(() => {}); // nothing installed: nothing kept
      throw e;
    }
    // If this fails, the old versions only take space until the next install or removal.
    await forget(this.ws.store, SYS_PLUGINS, { history: (p) => p.startsWith(`/${id}/`) }).catch(() => {});
    await logEvent(this.ws.store, SYS, {
      type: before ? 'plugin.update' : 'plugin.install', actor: 'system',
      data: { plugin: id, name: pkg.name, version: pkg.version, kind: pkg.kind, from: source, ...(shown ? { url: shown } : {}) },
    }).catch(() => {});
    if (this.#loaded.has(id) && pkg.code) this.#stale.add(id);
    return pkg.manifest;
  }

  /**
   * Keeps the address a package came from: in its secret when the address holds a key, so annai can
   * look there for updates (fix pass 8a-1); none, without an address. Returns the address as
   * installed.json and the log keep it.
   * @param {string} id @param {string | undefined} url
   */
  async #keepAddress(id, url) {
    /** @type {{ shown: string, keys: string[] }} */
    let parts = { shown: url ?? '', keys: [] };
    try {
      if (url) parts = addressParts(url);
    } catch {
      // not an address annai can read: kept as it is
    }
    await this.ws.store.tx(['secrets'], 'readwrite', (/** @type {any} */ t) => (parts.keys.length
      ? t.putSecret(ADDRESS(id), { address: url, keys: parts.keys }) : t.deleteSecret(ADDRESS(id))));
    return parts.keys.length ? parts.shown : url || undefined;
  }

  /**
   * The address a package installed from one came from, keys and all, or null. One kept raw in
   * installed.json before fix pass 8a-1 moves into its secret now, and the old versions of
   * installed.json, which held it, are forgotten.
   * @param {string} id @returns {Promise<string | null>}
   */
  async address(id) {
    const s = (await this.installed())[id];
    if (s?.source !== 'url' || typeof s.url !== 'string') return null;
    const shownUrl = s.url;
    const kept = await this.ws.store.tx(['secrets'], 'readwrite', async (/** @type {any} */ t) => {
      const now = await t.getSecret(ADDRESS(id));
      if (typeof now?.address === 'string') return now.address;
      // Kept among the plugin's own before Reset R1 (or by a backup from then): moved when it is surely annai's.
      const old = await t.getSecret(`plugin:${id}:address`);
      if (!shownUrl.includes(KEY_BLANK) || typeof old?.address !== 'string' || !Array.isArray(old.keys) || !old.keys.every((k) => typeof k === 'string')) return null;
      await t.putSecret(ADDRESS(id), { address: old.address, keys: old.keys });
      await t.deleteSecret(`plugin:${id}:address`);
      return old.address;
    });
    if (kept) return kept;
    const shown = await this.#keepAddress(id, s.url);
    if (shown !== s.url) {
      await this.#updateState(id, { url: shown });
      await forget(this.ws.store, SYS_PLUGINS, { history: (p) => p === STATE });
    }
    return s.url;
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
    // An address kept raw before fix pass 8a-1 moves into its package's secret.
    for (const [id, s] of Object.entries(await this.installed())) if (s.source === 'url') await this.address(id).catch(() => {});
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
    if (this.#removing.has(id)) throw new PluginError(id, 'is being removed');
    if (this.#stale.has(id)) throw new PluginError(id, 'was updated. Restart annai to run the new version.');
    const manifest = await this.#stored(id);
    const state = await this.installed();
    this.#claimed = { state, names: await this.#claims(state) };
    if (manifest.entry) this.#loaded.add(id);
    const mod = manifest.entry ? await this.importModule(this.pluginUrl(id, manifest.entry)) : {};
    await this.#start(manifest, mod, false);
    // Its tools' names, kept so removing it removes their switches even while it is off (choice 4).
    const tools = this.registry.entries('tool').filter((e) => e.pluginId === id).map((e) => String(e.item?.name)).sort();
    const had = (await this.installed())[id]?.tools ?? [];
    if (JSON.stringify(had) !== JSON.stringify(tools)) await this.#updateState(id, { tools }).catch(() => {});
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

  /**
   * Removes a package and everything it stored (choice 4; the user's rule: removing means removing):
   * its files and their history, its settings file and its history, its secrets and the address it came
   * from, its tools' switches, and what it kept in the system log. What it wrote into a trip is the trip's, and stays. The space
   * comes back at once; the system log says how much.
   * @param {string} id @returns {Promise<{ bytes: number }>}
   */
  async uninstall(id) {
    this.#removing.add(id);
    await this.#settled(id);
    const tools = new Set(this.registry.entries('tool', { all: true }).filter((e) => e.pluginId === id).map((e) => String(e.item?.name)));
    await this.stop(id);
    const state = await this.installed();
    const was = state[id];
    for (const t of was?.tools ?? []) tools.add(t);
    delete state[id];
    const inPackage = (/** @type {string} */ p) => p.startsWith(`/${id}/`);
    const isSettings = (/** @type {string} */ p) => p === SETTINGS(id);
    // Its files first: should what follows fail, the record still shows it, and Remove can run again.
    let bytes = (await forget(this.ws.store, SYS_PLUGINS, { files: inPackage, history: inPackage })).bytes;
    await this.ws.write(SYS_PLUGINS, STATE, state, { author: 'system' });
    bytes += (await forget(this.ws.store, SYS_SETTINGS, { files: isSettings, history: isSettings })).bytes;
    bytes += (await forget(this.ws.store, SYS, { events: (e) => e.actor === `plugin:${id}` && Boolean(e.refs?.length) })).bytes;
    await this.ws.store.tx(['secrets'], 'readwrite', async (t) => {
      for (const s of await t.listSecretIds()) if (s.startsWith(`plugin:${id}:`)) await t.deleteSecret(s);
      await t.deleteSecret(ADDRESS(id));
    });
    const switches = (await readAppSettings(this.ws)).tools ?? {};
    const off = [...tools].filter((t) => Object.hasOwn(switches, t));
    if (off.length) await updateAppSettings(this.ws, { tools: Object.fromEntries(off.map((t) => [t, null])) });
    await logEvent(this.ws.store, SYS, { type: 'plugin.remove', actor: 'user', data: { plugin: id, name: was?.name ?? id, kind: kindOfState(was), bytes } }).catch(() => {});
    if (this.#loaded.has(id)) this.#stale.add(id);
    return { bytes };
  }

  /**
   * What Reset would clear: whether the plugin's settings file, or a version of it, is stored; the
   * file's keys; its secrets' names (the address it came from is annai's, R1). null for the MCP client.
   * @param {string} id @returns {Promise<{ file: boolean, keys: string[], secrets: string[] } | null>}
   */
  async saved(id) {
    if (NO_RESET.has(id)) return null;
    const now = await this.ws.readJSON(SYS_SETTINGS, SETTINGS(id)).catch(() => null);
    const file = now !== undefined || (await this.ws.history(SYS_SETTINGS, SETTINGS(id))).length > 0;
    const mine = `plugin:${id}:`;
    const ids = await this.ws.store.tx(['secrets'], 'readonly', (t) => t.listSecretIds());
    return {
      file, keys: now && typeof now === 'object' && !Array.isArray(now) ? Object.keys(now).sort() : [],
      secrets: ids.filter((s) => s.startsWith(mine)).map((s) => s.slice(mine.length)).sort(),
    };
  }

  /**
   * Reset on a plugin's page (the user's ask, 2026-10-18; removing means removing): its settings file
   * and that file's history, and all its secrets (the address it came from is annai's). Its package, its on/off
   * state, its tools' switches and what it wrote into trips stay. It keeps running, and what it reads
   * next is its schema's defaults and no secrets. The system log names what went, never its values.
   * @param {string} id @returns {Promise<{ file: boolean, keys: string[], secrets: string[], bytes: number }>}
   */
  async reset(id) {
    if (this.#removing.has(id)) throw new PluginError(id, 'is being removed');
    const had = await this.saved(id);
    if (!had) throw new PluginError(id, 'keeps MCP servers, not settings: remove a server on its own screen.');
    const isSettings = (/** @type {string} */ p) => p === SETTINGS(id);
    const bytes = had.file ? (await forget(this.ws.store, SYS_SETTINGS, { files: isSettings, history: isSettings })).bytes : 0;
    await this.ws.store.tx(['secrets'], 'readwrite', async (t) => {
      for (const s of had.secrets) await t.deleteSecret(`plugin:${id}:${s}`);
    });
    if (had.file || had.secrets.length) {
      const m = this.builtins.get(id) ?? (await this.#stored(id).catch(() => null));
      const props = m?.settings?.properties && typeof m.settings.properties === 'object' ? m.settings.properties : {};
      // Only names its schema gives; others are counted, since a plugin could name one after the user's data (M6).
      const settings = had.keys.filter((k) => Object.hasOwn(props, k));
      const secrets = had.secrets.filter((k) => Object.hasOwn(props, k) && props[k]?.writeOnly);
      await logEvent(this.ws.store, SYS, { type: 'plugin.reset', actor: 'user', data: {
        plugin: id, name: m?.name ?? (await this.installed())[id]?.name ?? id,
        settings, otherSettings: had.keys.length - settings.length, secrets, otherSecrets: had.secrets.length - secrets.length, bytes,
      } }).catch(() => {});
    }
    return { ...had, bytes };
  }

  /** Rows for the plugins screen. problem: why an installed plugin can't start, if it can't. */
  async describe() {
    const rows = [];
    const skillsOf = (/** @type {string} */ id) => this.registry.entries('skill').filter((e) => e.pluginId === id).map((e) => String(e.item?.name));
    for (const m of this.builtins.values()) {
      rows.push({
        id: m.id, name: m.name, version: m.version, shownVersion: m.version, description: m.description ?? '', builtin: true, enabled: true, active: this.active.has(m.id),
        failing: this.registry.isDisabled(m.id), problem: null, restart: false, kind: 'plugin', source: 'builtin', skills: skillsOf(m.id), code: true, settings: null,
      });
    }
    for (const [id, s] of Object.entries(await this.installed())) {
      /** @type {any} */
      let m = null;
      /** @type {string | null} */
      let problem = null;
      let shownVersion = String(s.version ?? '');
      try {
        if (kindOfState(s) === 'skill') {
          const skill = await this.#storedSkill(id);
          m = skillManifest(skill);
          shownVersion = skill.metadata.version ?? '';
        } else {
          m = await this.#stored(id);
          shownVersion = m.version;
        }
      } catch (e) {
        problem = String(/** @type {any} */ (e)?.message ?? e);
      }
      const active = this.active.has(id);
      rows.push({
        id, name: m?.name ?? s.name ?? id, version: m?.version ?? s.version, shownVersion, description: m?.description ?? '', builtin: false,
        enabled: Boolean(s.enabled), active, failing: this.registry.isDisabled(id), problem, restart: this.#stale.has(id),
        kind: kindOfState(s), ...sourceOf(s), author: m?.author, homepage: m?.homepage, code: Boolean(m?.entry), settings: m?.settings ?? null,
        // Off, the skills it claims (minors 18).
        skills: active ? skillsOf(id) : (await this.#claims({ [id]: s })).get(id) ?? [],
      });
    }
    return rows;
  }

  /** A bare skill's SKILL.md as stored, read again (choice 2). @param {string} id */
  async #storedSkill(id) {
    const t = await this.ws.readText(SYS_PLUGINS, `/${id}/${SKILL_FILE}`).catch(() => undefined);
    if (t === undefined) throw new PluginError(id, 'is not installed');
    /** @type {import('./skills.js').Skill} */
    let skill;
    try {
      skill = parseSkill(t);
    } catch (e) {
      throw new PluginError(id, String(/** @type {any} */ (e)?.message ?? e));
    }
    if (skill.name !== id) throw new PluginError(id, `its ${SKILL_FILE} names "${skill.name}", not the folder it is installed in`);
    return skill;
  }

  /**
   * What a package brings besides code, registered under its id once it has started: its skills,
   * read fresh from storage each time Shiori loads one; its personalities; its endpoint templates.
   * @param {string} id @param {any} manifest
   */
  async #content(id, manifest) {
    for (const f of manifest.skills ?? []) {
      const folder = skillFolder(f);
      const dir = `/${id}/${folder ? `${folder}/` : ''}`;
      const read = async () => {
        const t = await this.ws.readText(SYS_PLUGINS, `${dir}${SKILL_FILE}`);
        if (t === undefined) throw new PluginError(id, `its skill folder ${f} has no ${SKILL_FILE}`);
        try {
          return parseSkill(t);
        } catch (e) {
          throw new PluginError(id, `its skill ${f}: ${/** @type {any} */ (e)?.message ?? e}`);
        }
      };
      const skill = await read();
      this.#mayRegisterSkill(id, skill.name);
      this.registry.add(id, 'skill', {
        name: skill.name, description: skill.description,
        text: async () => (await read()).body.trim(),
        files: async () => (await this.ws.list(SYS_PLUGINS, dir)).map((x) => x.path.slice(dir.length)).filter((p) => p !== SKILL_FILE).sort(),
        read: async (/** @type {string} */ file) => {
          const path = `${dir}${file}`;
          try {
            if (!file || normPath(path) !== path) return null;
          } catch {
            return null;
          }
          const got = await this.ws.read(SYS_PLUGINS, path);
          return got ? { bytes: got.bytes, type: got.entry.type } : null;
        },
      });
    }
    for (const p of manifest.personalities ?? []) {
      const t = await this.ws.readText(SYS_PLUGINS, `/${id}/${p}`);
      if (t === undefined) throw new PluginError(id, `its personality ${p} is missing`);
      this.registry.add(id, 'personality', { name: String(p).split('/').pop()?.replace(/\.md$/, ''), text: t, plugin: manifest.name });
    }
    for (const t of manifest.templates ?? []) {
      /** @type {any} */
      let json;
      try {
        json = await this.ws.readJSON(SYS_PLUGINS, `/${id}/${t}`);
      } catch {
        json = null;
      }
      if (!Array.isArray(json?.endpoints)) throw new PluginError(id, `its template file ${t} isn't valid`);
      // Named by the package it came from, so the model picker never shows it as annai's own (fix pass 8a-3).
      for (const tpl of json.endpoints) this.registry.add(id, 'template', { ...tpl, from: String(manifest.name ?? id) });
    }
  }

  /** The stored manifest, checked again: storage can hold one that was never installed through install(). @param {string} id */
  async #stored(id) {
    if (kindOfState((await this.installed())[id]) === 'skill') return skillManifest(await this.#storedSkill(id));
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
        const r = await this.registry.guard(id, 'starting', (/** @type {any} */ api) => this.#inTime(id, () => mod.activate(api)))(this.#api(id, manifest));
        if (typeof r === 'function') dispose = r;
      } else if (manifest.entry) {
        throw new PluginError(id, 'its module has no activate() function');
      }
      if (!builtin) await this.#content(id, manifest);
    } catch (e) {
      try {
        dispose();
      } catch {
        // it failed already; what it registered goes below
      }
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

  /** The object a plugin's activate() receives (milestone 1 subset of spec §5.4). @param {string} id @param {any} manifest */
  #api(id, manifest) {
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
      { decide: (/** @type {any} */ c) => need('llm').decide({ ...c, scope: SYS, tag: `plugin:${id}` }) },
    );
    return Object.freeze({
      id,
      register: (/** @type {string} */ kind, /** @type {any} */ item) => {
        if (kind === 'skill') this.#mayRegisterSkill(id, String(item?.name ?? ''));
        return registry.add(id, kind, item);
      },
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
      /** Log appends, as frozen copies, never this plugin's own (spec §5.4: read-only in v1). */
      hooks: Object.freeze({
        on: (/** @type {any} */ fn, /** @type {{ types?: string[] }} */ o = {}) => {
          if (typeof fn !== 'function') throw new PluginError(id, 'hooks.on needs a function');
          return registry.add(id, 'hook', { fn, ...(Array.isArray(o?.types) ? { types: o.types.map(String) } : {}) });
        },
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
        // What a plugin adds to annai's screens (spec §16.4), checked first; it goes when the plugin stops.
        slot: (/** @type {string} */ slot, /** @type {any} */ item) => {
          const wrong = checkSlot(slot, item);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, `ui:${slot}`, item);
        },
        cardType: (/** @type {any} */ item) => {
          const wrong = checkCardType(item);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'ui:card-type', item);
        },
        component: (/** @type {string} */ name, /** @type {any} */ impl) => {
          const wrong = checkComponent(name, impl);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'ui:component', { ...impl, name });
        },
        screen: (/** @type {any} */ item) => {
          const wrong = checkScreen(item);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'ui:screen', item);
        },
        theme: (/** @type {string} */ file) => {
          const wrong = checkTheme(file);
          if (wrong) throw new PluginError(id, wrong);
          return registry.add(id, 'ui:theme', { file, href: this.pluginUrl(id, file) });
        },
      }),
      cache: Object.freeze({ state: () => need('agent').cacheState() }),
      settings: Object.freeze({
        /** What is saved, over the schema's defaults: what the form shows (plugin reset, choice 2). */
        get: async () => ({ ...defaultsOf(manifest.settings), ...(await this.ws.readJSON(SYS_SETTINGS, SETTINGS(id))) }),
        set: (/** @type {Record<string, any>} */ changes) => this.ws.patch(SYS_SETTINGS, SETTINGS(id), changes, { author: `plugin:${id}`, create: true }),
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
        get: async (/** @type {string} */ name) => (await this.ws.store.tx(['secrets'], 'readonly', (/** @type {any} */ t) => t.getSecret(`plugin:${id}:${name}`))) ?? null,
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

  /** A plugin's start, when one is under way, over (whether it worked or not). @param {string} id */
  async #settled(id) {
    await this.#starting.get(id)?.catch(() => {});
  }

  /** Changes a plugin's record; one removed meanwhile gets none back (fix pass 8a-2). @param {string} id @param {Record<string, any>} changes */
  async #updateState(id, changes) {
    if (this.#removing.has(id) || !(await this.installed())[id]) return;
    await this.ws.patch(SYS_PLUGINS, STATE, { [id]: changes }, { author: 'system', create: true });
  }
}
